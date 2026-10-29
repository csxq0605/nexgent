/**
 * `costCaps.perProject` across every Nexgent instance that runs on the same
 * project (`permissions.md` §费用上限): two CLI runs, the desktop app and a
 * CLI run, or two SDKs in one process. Before an agent sends a request under
 * a per-project cap it takes the project's spend lock (a file created
 * exclusively in the ledgers directory), reads the ledger again, adds the
 * requests other instances reserved but whose `llm.request.start` is not in
 * the ledger yet, checks the cap and, still holding the lock, writes its own
 * reservation. So the check and the count are one step on disk, and a cap
 * of n requests sends at most n however the sessions interleave.
 *
 * A reservation is an empty file named by the request id under
 * `reservations/`; it is removed once the request has ended (its ledger
 * records count from then on). One left by a crash is no longer counted
 * after {@link RESERVATION_TTL_MS}: its request had long been written to the
 * ledger or was never sent.
 */
import { mkdir, open, readdir, stat, unlink } from 'node:fs/promises'
import * as nodePath from 'node:path'
import { NexgentError } from './contracts/errors.js'

/** How long a reservation without its ledger records still counts. */
export const RESERVATION_TTL_MS = 10 * 60_000
/** A lock file older than this was left by an instance that stopped while holding it. */
export const SPEND_LOCK_STALE_MS = 15_000
/** How long an agent waits for the lock before the request is not sent. */
export const SPEND_LOCK_WAIT_MS = 30_000

const LOCK_FILE = '.spend.lock'
const RESERVATIONS_DIR = 'reservations'
const REQUEST_ID = /^[A-Za-z0-9_-]{1,128}$/

function code(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | undefined)?.code
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/** The project's spend lock and request reservations, in its ledgers directory. */
export class ProjectSpendGate {
  private readonly lock: string
  private readonly reservations: string
  /** Agents of this instance take the lock one at a time (no spinning against each other). */
  private queue: Promise<unknown> = Promise.resolve()

  constructor(readonly dir: string) {
    this.lock = nodePath.join(dir, LOCK_FILE)
    this.reservations = nodePath.join(dir, RESERVATIONS_DIR)
  }

  /** Run `fn` holding the project's spend lock. */
  exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(async () => {
      await this.acquire()
      try {
        return await fn()
      } finally {
        await unlink(this.lock).catch(() => undefined)
      }
    })
    this.queue = run.catch(() => undefined)
    return run
  }

  /** Request ids reserved and not yet released, newer than {@link RESERVATION_TTL_MS} (older ones are removed). */
  async pending(now = Date.now()): Promise<Set<string>> {
    let names: string[]
    try {
      names = await readdir(this.reservations)
    } catch (error) {
      if (code(error) === 'ENOENT') return new Set()
      throw error
    }
    const out = new Set<string>()
    for (const name of names) {
      if (!REQUEST_ID.test(name)) continue
      const file = nodePath.join(this.reservations, name)
      const info = await stat(file).catch(() => undefined)
      if (info === undefined) continue
      if (now - info.mtimeMs > RESERVATION_TTL_MS) await unlink(file).catch(() => undefined)
      else out.add(name)
    }
    return out
  }

  /** Reserve a request about to be sent (call while holding the lock). */
  async reserve(requestId: string): Promise<void> {
    if (!REQUEST_ID.test(requestId)) throw new NexgentError('internal', `not a request id: ${requestId}`)
    await mkdir(this.reservations, { recursive: true })
    const handle = await open(nodePath.join(this.reservations, requestId), 'w')
    await handle.close()
  }

  /** The request has ended: its ledger records count from now on. */
  async release(requestId: string): Promise<void> {
    if (!REQUEST_ID.test(requestId)) return
    await unlink(nodePath.join(this.reservations, requestId)).catch(() => undefined)
  }

  private async acquire(): Promise<void> {
    await mkdir(this.dir, { recursive: true })
    const deadline = Date.now() + SPEND_LOCK_WAIT_MS
    for (;;) {
      try {
        const handle = await open(this.lock, 'wx')
        await handle.close()
        return
      } catch (error) {
        // EPERM: Windows, while another instance deletes the file.
        if (code(error) !== 'EEXIST' && code(error) !== 'EPERM') throw error
      }
      const info = await stat(this.lock).catch(() => undefined)
      if (info !== undefined && Date.now() - info.mtimeMs > SPEND_LOCK_STALE_MS) {
        await unlink(this.lock).catch(() => undefined)
        continue
      }
      if (Date.now() > deadline) {
        throw new NexgentError('internal', `the project's spend lock (${this.lock}) stayed taken for ${SPEND_LOCK_WAIT_MS / 1000}s`)
      }
      await sleep(5 + Math.floor(Math.random() * 20))
    }
  }
}
