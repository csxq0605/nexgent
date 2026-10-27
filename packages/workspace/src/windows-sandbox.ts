/**
 * The Windows system sandbox for `pwsh` commands and program processes
 * (`permissions.md` §系统沙箱, Windows), after Codex
 * `windows-sandbox-rs` (`token.rs`, `acl.rs`, `cap.rs`):
 *
 * - every directory a command may write (project or member copy, session
 *   temp directory, directories approved for the session) has its own
 *   capability SID, a random `S-1-5-21-…` kept in
 *   `<NEXGENT_HOME>/sandbox/windows-capabilities.json`;
 * - that SID gets an inheritable Modify ACE on the directory (`icacls
 *   /grant`, once per directory), and an inheritable deny of writing,
 *   deleting and changing permissions on the write-protected paths below it
 *   (`.nexgent/`, `.git/hooks`, `.git/config`, the Nexgent home);
 * - the command starts with a write-restricted token whose restricting SIDs
 *   are the capabilities of its directories, the logon SID and Everyone
 *   (`windows-job.ts`), so a write passes only where one of them is allowed.
 *
 * Reads are not restricted (a write-restricted token is checked only for
 * writes) and neither is the network. When the trial launch fails the probe
 * reports `none`; when the ACLs of one command cannot be set, that command
 * is not run (`fatal`), never started without the restriction.
 */
import { execFile } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdir, readFile, realpath, rename, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import * as nodePath from 'node:path'
import { NexgentError, nexgentHome } from '@nexgent/kernel'
import { VIOLATION_HINT, type OsSandbox, type OsSandboxPolicy, type OsSandboxStatus, type OsSandboxWrap } from './os-sandbox.js'
import { LocalProcessRunner } from './process.js'

/** Where the capability SIDs are kept, under the Nexgent home. */
export const WINDOWS_CAPABILITIES_FILE = nodePath.join('sandbox', 'windows-capabilities.json')

/** The persisted record: one capability SID per write directory. */
export interface CapabilityRecord {
  readonly version: 1
  readonly roots: Readonly<Record<string, { readonly sid: string }>>
}

const EMPTY: CapabilityRecord = { version: 1, roots: {} }

/** Pure: a random SID in the `S-1-5-21-a-b-c-d` form Codex uses for capabilities. */
export function randomCapabilitySid(bytes: Buffer = randomBytes(16)): string {
  const parts = [0, 4, 8, 12].map(offset => bytes.readUInt32LE(offset))
  return `S-1-5-21-${parts.join('-')}`
}

/** Pure: whether `text` is a capability SID this module makes. */
export function isCapabilitySid(text: string): boolean {
  return /^S-1-5-21-\d{1,10}-\d{1,10}-\d{1,10}-\d{1,10}$/.test(text)
}

/** Pure: the key of a directory in the record (Windows paths compare without case and trailing separators). */
export function rootKey(path: string): string {
  return nodePath.win32.resolve(path).replace(/[\\/]+$/, '').toLowerCase()
}

/** Pure: the record with a SID for each of `roots` (new ones made by `make`), and the SIDs in order. */
export function assignCapabilities(record: CapabilityRecord, roots: readonly string[], make: () => string = randomCapabilitySid): { record: CapabilityRecord; sids: string[] } {
  const next: Record<string, { sid: string }> = { ...record.roots }
  const sids = roots.map(root => {
    const key = rootKey(root)
    const known = next[key]
    if (known !== undefined && isCapabilitySid(known.sid)) return known.sid
    const sid = make()
    next[key] = { sid }
    return sid
  })
  return { record: { version: 1, roots: next }, sids }
}

/** Pure: whether `path` is `root` or below it (Windows comparison). */
export function isBelow(root: string, path: string): boolean {
  const a = rootKey(root)
  const b = rootKey(path)
  return b === a || b.startsWith(`${a}\\`)
}

/** Rights a capability loses on a write-protected path: write data, append, attributes, delete, delete child, permissions, owner. */
export const DENIED_RIGHTS = '(WD,AD,WEA,WA,DE,DC,WDAC,WO)'

/** Pure: `icacls` arguments that let `sid` modify everything below `root` (inherited by files and folders). */
export function grantArgs(root: string, sid: string): string[] {
  return [root, '/grant', `*${sid}:(OI)(CI)M`, '/Q']
}

/** Pure: `icacls` arguments that keep `sid` from changing `path` (inherited below it when it is a directory). */
export function denyArgs(path: string, sid: string, directory: boolean): string[] {
  return [path, '/deny', `*${sid}:${directory ? '(OI)(CI)' : ''}${DENIED_RIGHTS}`, '/Q']
}

/** One protected path and the capabilities whose directory contains it. */
export interface DenyPlan {
  readonly path: string
  readonly sids: readonly string[]
}

/** Pure: for each write-protected path, the capabilities of the write directories that contain it. */
export function planDenies(roots: readonly string[], sids: readonly string[], denyWrite: readonly string[]): DenyPlan[] {
  const plans: DenyPlan[] = []
  for (const path of denyWrite) {
    const owners = roots.flatMap((root, index) => (isBelow(root, path) ? [sids[index]!] : []))
    if (owners.length > 0) plans.push({ path, sids: owners })
  }
  return plans
}

/** Runs `icacls`; tests inject a fake. Resolves the exit code and stderr. */
export type IcaclsRunner = (args: readonly string[]) => Promise<{ readonly code: number; readonly output: string }>

/** A trial restricted launch; resolves `undefined` when it worked, else the reason. */
export type SandboxTrial = (capability: string) => Promise<string | undefined>

/** Options of {@link createWindowsSandbox}. */
export interface WindowsSandboxOptions {
  /** Nexgent home holding the capability record (default `$NEXGENT_HOME` or `~/.nexgent`). */
  readonly home?: string
  /** Default: the real `icacls`. */
  readonly icacls?: IcaclsRunner
  /** Default: `cmd.exe /d /c exit 0` through the job launcher with a restricted token. */
  readonly trial?: SandboxTrial
  /** Default `process.platform`. */
  readonly platform?: NodeJS.Platform
}

const realIcacls: IcaclsRunner = args => new Promise(resolve => {
  execFile('icacls', [...args], { windowsHide: true }, (error, stdout, stderr) => {
    const code = error === null ? 0 : typeof (error as { code?: unknown }).code === 'number' ? (error as { code: number }).code : 1
    resolve({ code, output: `${stdout}${stderr}`.trim() })
  })
})

const realTrial: SandboxTrial = async capability => {
  try {
    const result = await new LocalProcessRunner().run({ command: 'cmd.exe', args: ['/d', '/c', 'exit 0'], cwd: tmpdir(), timeoutMs: 60_000, capabilities: [capability] })
    return result.exitCode === 0 ? undefined : `the trial command exited with ${String(result.exitCode)}: ${result.stderr.trim().slice(0, 300)}`
  } catch (error) {
    return error instanceof NexgentError || error instanceof Error ? error.message : String(error)
  }
}

async function realOrSelf(path: string): Promise<string> {
  try {
    return await realpath(path)
  } catch {
    return nodePath.resolve(path)
  }
}

async function kindOf(path: string): Promise<'directory' | 'file' | undefined> {
  try {
    return (await stat(path)).isDirectory() ? 'directory' : 'file'
  } catch {
    return undefined
  }
}

/** Build the Windows sandbox. Cheap until {@link OsSandbox.probe} or {@link OsSandbox.wrap}. */
export function createWindowsSandbox(options: WindowsSandboxOptions = {}): OsSandbox {
  const platform = options.platform ?? process.platform
  const icacls = options.icacls ?? realIcacls
  const trial = options.trial ?? realTrial
  const file = nodePath.join(options.home ?? nexgentHome(), WINDOWS_CAPABILITIES_FILE)
  let status: Promise<OsSandboxStatus> | undefined
  let record: Promise<CapabilityRecord> | undefined
  // One record update at a time; ACEs being applied, by `<sid> <path>`.
  let saving: Promise<unknown> = Promise.resolve()
  const applying = new Map<string, Promise<void>>()
  const sandboxed = new Set<string>()

  const load = (): Promise<CapabilityRecord> => {
    record ??= readFile(file, 'utf8').then(text => {
      const parsed = JSON.parse(text) as CapabilityRecord
      return parsed?.version === 1 && typeof parsed.roots === 'object' && parsed.roots !== null ? parsed : EMPTY
    }, () => EMPTY)
    return record
  }

  const save = (update: (current: CapabilityRecord) => CapabilityRecord): Promise<CapabilityRecord> => {
    const next = saving.then(async () => {
      const updated = update(await load())
      record = Promise.resolve(updated)
      await mkdir(nodePath.dirname(file), { recursive: true })
      const temp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
      await writeFile(temp, `${JSON.stringify(updated, null, 2)}\n`)
      await rename(temp, file)
      return updated
    })
    saving = next.catch(() => undefined)
    return next
  }

  const once = (key: string, work: () => Promise<void>): Promise<void> => {
    let running = applying.get(key)
    if (running === undefined) {
      running = work()
      applying.set(key, running)
      // A failure is tried again by the next command.
      running.catch(() => applying.delete(key))
    }
    return running
  }

  const run = async (args: string[]): Promise<void> => {
    const result = await icacls(args)
    if (result.code !== 0) throw new Error(`icacls ${args[1]} on ${args[0]} failed: ${result.output.slice(0, 300)}`)
  }

  async function prepare(policy: OsSandboxPolicy): Promise<string[]> {
    const roots = await Promise.all(policy.writeRoots.map(realOrSelf))
    let sids: string[] = []
    const current = await load()
    const assigned = assignCapabilities(current, roots)
    if (assigned.sids.some((sid, index) => current.roots[rootKey(roots[index]!)]?.sid !== sid)) {
      // Another process may have assigned SIDs meanwhile: assign against the saved record.
      const saved = await save(latest => assignCapabilities(latest, roots).record)
      sids = assignCapabilities(saved, roots).sids
    } else {
      sids = assigned.sids
    }
    await Promise.all(roots.map((root, index) => {
      const sid = sids[index]!
      return once(`${sid} ${rootKey(root)}`, async () => {
        // A directory made again (a new member copy at the same path) has lost its ACE: look, do not remember.
        const shown = await icacls([root])
        if (shown.code === 0 && shown.output.includes(sid)) return
        await run(grantArgs(root, sid))
      })
    }))
    const denies = planDenies(roots, sids, await Promise.all(policy.denyWrite.map(realOrSelf)))
    await Promise.all(denies.map(async plan => {
      const kind = await kindOf(plan.path)
      // A path that does not exist yet is protected once it does, from the next command on.
      if (kind === undefined) return
      await Promise.all(plan.sids.map(sid => once(`${sid} deny ${rootKey(plan.path)}`, () => run(denyArgs(plan.path, sid, kind === 'directory')))))
    }))
    return sids
  }

  return {
    probe() {
      status ??= (async (): Promise<OsSandboxStatus> => {
        if (platform !== 'win32') return { kind: 'none', reason: `the Windows sandbox does not run on ${platform}` }
        const reason = await trial(randomCapabilitySid())
        return reason === undefined ? { kind: 'active', platform: 'windows' } : { kind: 'none', reason: `the Windows sandbox could not start a restricted process: ${reason}` }
      })()
      return status
    },
    async wrap(script, policy): Promise<OsSandboxWrap> {
      const current = await this.probe()
      if (current.kind === 'none') return { kind: 'unavailable', reason: current.reason }
      let capabilities: string[]
      try {
        capabilities = await prepare(policy)
      } catch (error) {
        return { kind: 'unavailable', reason: `cannot set up the Windows sandbox for this command: ${(error as Error).message}`, fatal: true }
      }
      sandboxed.add(policy.commandId)
      return { kind: 'wrapped', program: policy.shell ?? 'pwsh', args: ['-NoProfile', '-NonInteractive', '-Command', script], capabilities }
    },
    annotate(commandId, stderr, exitCode) {
      if (!sandboxed.has(commandId) || exitCode === null || exitCode === 0) return stderr
      if (!/Access to the path .*is denied|Access is denied|UnauthorizedAccess|Access denied/i.test(stderr)) return stderr
      return `${stderr.replace(/\n$/, '')}\n<sandbox_violations>\n${VIOLATION_HINT}\n</sandbox_violations>`
    },
    release(commandId) {
      sandboxed.delete(commandId)
    },
    async dispose() {
      await saving
    },
  }
}
