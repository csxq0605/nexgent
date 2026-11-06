/**
 * Organization redo: the collaboration log of a coordinator's threads, in
 * the project (`<root>/.nexgent/collab/<coordinatorSessionId>.jsonl`, one
 * {@link CollabEntry} per line, append-only; never tracked by git).
 *
 * Threads (and the coordinator) write it with dedicated tools; the host
 * writes `merged` entries when a thread's turn brings files into the
 * project, and a `task` entry when the user starts a new task. Before each
 * model request of a thread, the host delivers the entries it has not seen
 * ({@link collabDelivery}): those for it or about its paths in full, the
 * rest as a count. What each session has seen (its cursor) is kept beside
 * the log (`<coordinatorSessionId>.cursors.json`), so nothing is lost or
 * delivered twice across restarts.
 */
import {
  COLLAB_DELIVERY_LEAD,
  THREAD_LIMITS,
  type CollabEntry,
  type CollaborationConfig,
} from '@nexgent/kernel'
import { mkdir, open, readdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { withinOwns } from '@nexgent/workflow'

/** The text of the log directory's `.gitignore`: the logs are the agents' working state, never the project's history. */
export const COLLAB_GITIGNORE = '# Written by Nexgent: the threads\' collaboration logs are not part of the project.\n*\n'

/** Pure: the seq of the current task's `task` entry (0 when the log has none: every entry is the current task's). */
export function taskStartSeq(entries: readonly CollabEntry[]): number {
  return entries.findLast(entry => entry.kind === 'task')?.seq ?? 0
}

/** Pure: the entries of the current task (after its `task` entry). */
export function currentTaskEntries(entries: readonly CollabEntry[]): CollabEntry[] {
  const start = taskStartSeq(entries)
  return entries.filter(entry => entry.seq > start)
}

/** Pure: whether two path lists may touch the same file (a list that is absent may touch anything). */
function pathsOverlap(left: readonly string[] | undefined, right: readonly string[] | undefined): boolean {
  if (left === undefined || left.length === 0 || right === undefined || right.length === 0) return true
  return left.some(path => withinOwns(path, right)) || right.some(path => withinOwns(path, left))
}

function quoted(entry: CollabEntry, coordinatorSessionId: string): string {
  return entry.from === coordinatorSessionId ? 'the coordinator' : `"${entry.fromTitle}"`
}

function statText(entry: CollabEntry): string {
  return (entry.stat ?? []).map(item => `${item.path} +${item.added} −${item.removed}`).join(', ')
}

/**
 * Pure: one entry as a line. `self`: the reading session (a message to it reads
 * "to you"); `coordinatorSessionId`: the only writer shown as the coordinator
 * (a thread titled "coordinator" is not one). Host entries (`merged`, `release`,
 * `stopped`, `task`) are written under the thread's id and rendered by kind.
 */
export function renderCollabEntry(entry: CollabEntry, self: string | undefined, coordinatorSessionId: string): string {
  const paths = entry.paths === undefined || entry.paths.length === 0 ? '' : ` [${entry.paths.join(', ')}]`
  const who = quoted(entry, coordinatorSessionId)
  const re = entry.re === undefined ? '' : ` (re #${entry.re})`
  const head = `#${entry.seq} ${who}`
  switch (entry.kind) {
    case 'note': return `${head} notes${paths}${re}: ${entry.text}`
    case 'claim': return `${head} claims${paths}: ${entry.text}`
    case 'handoff': return `${head} hands off${paths}: ${entry.text}`
    case 'blocker': return `${head} is blocked${paths}: ${entry.text}`
    case 'message': {
      const to = entry.to === self ? 'you' : entry.to === coordinatorSessionId ? 'the coordinator' : `"${entry.toTitle ?? entry.to}"`
      return `${head} to ${to}${re}: ${entry.text}`
    }
    case 'ask': return `${head} asks the coordinator${re}: ${entry.text}`
    case 'merged': {
      const statted = new Set((entry.stat ?? []).map(item => item.path))
      const listed = [statText(entry), ...(entry.paths ?? []).filter(path => !statted.has(path))].filter(item => item !== '').join(', ')
      const files = listed === '' ? '' : ` [${listed}]`
      const hint = entry.paths !== undefined && entry.paths.length > 0 ? ' (your copy may still hold older versions of these files: read_merged shows the project\'s current ones)' : ''
      return `${head}'s turn merged into the project${files}${entry.text === '' ? '' : `: ${entry.text}`}${hint}`
    }
    case 'release': return `${head} ended its turn${paths === '' ? '' : `; its claims${paths} no longer stand`}`
    case 'stopped': return `${head} was stopped${entry.text === '' ? '' : `: ${entry.text}`}`
    case 'task': return `#${entry.seq} (the user started a new task)`
  }
}

/** Who is reading, for {@link collabDelivery}. */
export interface CollabReader {
  readonly sessionId: string
  /** The paths its part was given (`owns`). */
  readonly owns?: readonly string[]
  /** Coordinator mode: the reader is the coordinator conversation, which hears what the threads write (not host entries, asks or tasks). */
  readonly coordinator?: true
  /** Files the thread read or wrote this turn; counted among its paths. */
  readonly touched?: readonly string[]
}

/** Input of {@link collabDelivery}. */
export interface CollabDeliveryInput {
  readonly entries: readonly CollabEntry[]
  readonly reader: CollabReader
  /** The coordinator conversation of the log: the only writer treated as the coordinator. */
  readonly coordinatorSessionId: string
  /** The last seq the reader has seen. */
  readonly cursor: number
  readonly collaboration: Pick<CollaborationConfig, 'mode' | 'handoff'>
  /** The reader's history was compacted: re-send what still holds from the current task. */
  readonly compacted: boolean
  /** Whether a thread still works on its part (running, or waiting for an answer); its claims and blockers hold while it does. */
  readonly working: (sessionId: string) => boolean
}

const COORDINATOR_HEARS = new Set<CollabEntry['kind']>(['message', 'note', 'handoff', 'blocker', 'claim', 'stopped'])

/**
 * Pure: whether an entry reaches the reader in full (`full`), as a count
 * (`count`), or not at all (`skip`). The coordinator reader gets what threads
 * write (messages, notes, handoffs, blockers, claims, stops). A thread gets a
 * message to it, the coordinator's notes, and (with `hybrid`) notes and
 * blockers (in full when without paths, about its paths, or naming it), and
 * claims, handoffs and merges about its paths; with handoff `changed`, every
 * `merged` entry. With `central`, threads hear only from the coordinator.
 */
export function collabRelevance(entry: CollabEntry, reader: CollabReader, myPaths: readonly string[] | undefined, collaboration: Pick<CollaborationConfig, 'mode' | 'handoff'>, coordinatorSessionId: string): 'full' | 'count' | 'skip' {
  if (entry.from === reader.sessionId || entry.kind === 'task' || entry.kind === 'ask') return 'skip'
  if (reader.coordinator === true) return entry.from !== coordinatorSessionId && COORDINATOR_HEARS.has(entry.kind) ? 'full' : 'skip'
  const hybrid = collaboration.mode === 'hybrid'
  // The coordinator's message already reached the thread as its message or turn; the log entry is for the windows and the measures.
  if (entry.kind === 'message' && entry.from === coordinatorSessionId) return 'skip'
  if (entry.kind === 'message') return entry.to === reader.sessionId ? 'full' : hybrid ? 'count' : 'skip'
  if (entry.from === coordinatorSessionId && entry.kind === 'note') return 'full'
  if (entry.kind === 'stopped' && entry.to === reader.sessionId) return 'full'
  if (entry.kind === 'merged' && collaboration.handoff === 'changed') return 'full'
  if (!hybrid) return 'skip'
  if (entry.kind === 'release') return entry.paths !== undefined && entry.paths.length > 0 && pathsOverlap(entry.paths, myPaths) ? 'full' : 'skip'
  if ((entry.kind === 'note' || entry.kind === 'blocker') && (entry.waitsFor === reader.sessionId || entry.to === reader.sessionId)) return 'full'
  return pathsOverlap(entry.paths, myPaths) ? 'full' : 'count'
}

/** Pure: the reader's paths: its `owns`, the files it touched this turn, and the paths of its own claims in the current task (absent: it may touch anything). */
export function readerPaths(entries: readonly CollabEntry[], reader: CollabReader): readonly string[] | undefined {
  const paths = new Set([...(reader.owns ?? []), ...(reader.touched ?? [])])
  for (const entry of currentTaskEntries(entries)) if (entry.kind === 'claim' && entry.from === reader.sessionId) for (const path of entry.paths ?? []) paths.add(path)
  return paths.size === 0 ? undefined : [...paths]
}

/** The latest of `lines`' tail that fits {@link THREAD_LIMITS.collabDelivered} entries and `chars` characters (at least the last one, cut if need be). */
function fitTail(lines: readonly string[], chars: number): { readonly kept: string[]; readonly used: number } {
  const kept: string[] = []
  let used = 0
  for (let index = lines.length - 1; index >= 0 && kept.length < THREAD_LIMITS.collabDelivered; index--) {
    const line = lines[index]!
    if (used + line.length + 1 > chars) {
      if (kept.length === 0 && chars > 0) {
        kept.unshift(line.length > chars ? `${line.slice(0, Math.max(0, chars - 1))}…` : line)
        used += kept[0]!.length + 1
      }
      break
    }
    kept.unshift(line)
    used += line.length + 1
  }
  return { kept, used }
}

/**
 * Pure: what to deliver before a session's next model request: the relevant
 * entries after its cursor in full (the latest {@link THREAD_LIMITS.collabDelivered}
 * and within {@link THREAD_LIMITS.collabDeliveredChars} characters), the
 * others as a count; after a compaction, also what still holds from earlier
 * in the task (the coordinator's notes, messages to it, and the claims and
 * blockers of threads still working). `undefined` when there is nothing to say.
 */
export function collabDelivery(input: CollabDeliveryInput): string | undefined {
  const { entries, reader, cursor, collaboration, coordinatorSessionId } = input
  const myPaths = readerPaths(entries, reader)
  const start = taskStartSeq(entries)
  const full: CollabEntry[] = []
  let counted = 0
  for (const entry of entries) {
    if (entry.seq <= cursor) continue
    const relevance = collabRelevance(entry, reader, myPaths, collaboration, coordinatorSessionId)
    if (relevance === 'full') full.push(entry)
    else if (relevance === 'count') counted += 1
  }
  const held: CollabEntry[] = []
  if (input.compacted) {
    for (const entry of entries) {
      if (entry.seq <= start || entry.seq > cursor) continue
      if (collabRelevance(entry, reader, myPaths, collaboration, coordinatorSessionId) !== 'full') continue
      // A claim or blocker holds while its thread works on; the rest (notes, messages, handoffs, merges) stay true.
      if ((entry.kind === 'claim' || entry.kind === 'blocker') && !input.working(entry.from)) continue
      held.push(entry)
    }
  }
  if (full.length === 0 && counted === 0 && held.length === 0) return undefined
  const render = (entry: CollabEntry): string => renderCollabEntry(entry, reader.sessionId, coordinatorSessionId)
  // The new entries come first in the budget; what was held fills what is left.
  const fresh = fitTail(full.map(render), THREAD_LIMITS.collabDeliveredChars)
  const earlier = held.length === 0 ? { kept: [] as string[], used: 0 } : fitTail(held.map(render), Math.max(0, THREAD_LIMITS.collabDeliveredChars - fresh.used))
  const more = 'read_collab shows them'
  const lines = [`${COLLAB_DELIVERY_LEAD}:`]
  if (held.length > 0) {
    lines.push('Still in force from earlier in this task (your history was compacted):')
    if (held.length > earlier.kept.length) lines.push(`(${held.length - earlier.kept.length} earlier entries left out: ${more})`)
    lines.push(...earlier.kept)
    if (full.length > 0) lines.push('New:')
  }
  if (full.length > fresh.kept.length) lines.push(`(${full.length - fresh.kept.length} earlier new entries left out: ${more})`)
  lines.push(...fresh.kept)
  if (counted > 0) lines.push(`${counted} other new entr${counted === 1 ? 'y is' : 'ies are'} not about your paths (read_collab shows ${counted === 1 ? 'it' : 'them'}).`)
  return lines.join('\n')
}

/**
 * Pure: the hops a message answering entry `re` carries: one more than the
 * entry's (an entry without hops counts as 1); a message that answers nothing
 * known is 1.
 */
export function hopsOf(entries: readonly CollabEntry[], re: number | undefined): number {
  if (re === undefined) return 1
  const answered = entries.find(entry => entry.seq === re)
  return answered === undefined ? 1 : (answered.hops ?? 1) + 1
}

/**
 * Pure: the waiting chain a new blocker of `from` on `waitsFor` would close,
 * as session ids (`waitsFor` first, ending at `from`), or `undefined` when it
 * closes none. Each link is a thread's latest blocker of the current task
 * naming the thread it waits for, standing while the thread works
 * (`working`) and has not ended a turn since (`release`).
 */
export function waitCycle(entries: readonly CollabEntry[], from: string, waitsFor: string, working: (sessionId: string) => boolean): string[] | undefined {
  const waits = new Map<string, string>()
  for (const entry of currentTaskEntries(entries)) {
    if (entry.kind === 'release') waits.delete(entry.from)
    else if (entry.kind === 'blocker') {
      if (entry.waitsFor === undefined) waits.delete(entry.from)
      else waits.set(entry.from, entry.waitsFor)
    }
  }
  const chain = [waitsFor]
  const seen = new Set<string>([waitsFor])
  let current = waitsFor
  while (current !== from) {
    const next = waits.get(current)
    if (next === undefined || !working(current)) return undefined
    if (seen.has(next)) return undefined
    seen.add(next)
    chain.push(next)
    current = next
  }
  return chain
}

/** Input of {@link logEvents}. */
export interface LogEventsInput {
  readonly coordinatorSessionId: string
  /** Whether a thread's last turn ended waiting (for `idle`). */
  readonly lastTurnWaiting?: (sessionId: string) => boolean
}

/** What {@link logEvents} counts. */
export interface LogEvents {
  /** Messages between threads that got no reply, and questions to the coordinator it did not answer, in the current task. */
  readonly unanswered: number
  /** Threads whose last turn ended waiting and that posted a blocker naming another thread. */
  readonly idle: number
}

/**
 * Pure: collaboration events read from the current task's entries. A thread's
 * message is unanswered when its receiver neither messaged the sender
 * afterwards nor answered it (`re`); a thread's `ask` is, when the coordinator
 * sent that thread no message afterwards. Messages from the coordinator and replies need no reply.
 */
export function logEvents(entries: readonly CollabEntry[], input: LogEventsInput): LogEvents {
  const task = currentTaskEntries(entries)
  const coordinator = input.coordinatorSessionId
  let unanswered = 0
  for (const entry of task) {
    if (entry.kind === 'message' && entry.from !== coordinator && entry.to !== undefined && entry.to !== coordinator) {
      // A reply (it carries `re`, or answers an earlier message from its receiver) needs no reply itself.
      const isReply = entry.re !== undefined || task.some(other => other.seq < entry.seq && other.kind === 'message' && other.from === entry.to && other.to === entry.from)
      const answered = task.some(other => other.seq > entry.seq && ((other.kind === 'message' && other.from === entry.to && other.to === entry.from) || other.re === entry.seq))
      if (!isReply && !answered) unanswered += 1
    } else if (entry.kind === 'ask') {
      const answered = task.some(other => other.seq > entry.seq && ((other.kind === 'message' && other.from === coordinator && other.to === entry.from) || other.re === entry.seq))
      if (!answered) unanswered += 1
    }
  }
  const blocked = new Set<string>()
  for (const entry of task) if (entry.kind === 'blocker' && entry.waitsFor !== undefined) blocked.add(entry.from)
  const waiting = input.lastTurnWaiting
  const idle = waiting === undefined ? 0 : [...blocked].filter(id => waiting(id)).length
  return { unanswered, idle }
}

interface Cached {
  /** Bytes of the file read so far (up to the last complete line). */
  offset: number
  /** The file's identity when read: an archive replaces the file, which invalidates the cache. */
  ino: number
  entries: CollabEntry[]
}

/** Options of {@link CollabLog}. */
export interface CollabLogOptions {
  /** Called after an entry is written (also a `task` entry), with the coordinator whose log it is. A throwing callback is ignored. */
  readonly onAppend?: (coordinatorSessionId: string, entry: CollabEntry) => void
}

const LOCK_STALE_MS = 10_000
const LOCK_RETRY_MS = 20
const LOCK_WAIT_MS = 15_000

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

/**
 * The collaboration logs of one project, and each session's cursor. Writes
 * run one at a time per process and, across processes, under a lock file
 * (`<coordinatorSessionId>.lock`, created exclusively with the pid and time;
 * one older than 10 seconds is taken as left behind). A log longer than
 * {@link THREAD_LIMITS.collabArchiveAt} entries moves the tasks before the
 * current one to `<coordinatorSessionId>.<n>.jsonl`.
 */
export class CollabLog {
  private queue: Promise<unknown> = Promise.resolve()
  private readonly cache = new Map<string, Cached>()
  private readonly cursors = new Map<string, Map<string, number>>()
  /** Per coordinator: the read in progress (reads of one log run one at a time, so the cache is read once). */
  private readonly reading = new Map<string, Promise<readonly CollabEntry[]>>()

  /** `dir`: the project's log directory (`<root>/.nexgent/collab`). */
  constructor(private readonly dir: () => string, private readonly options: CollabLogOptions = {}) {}

  private file(coordinatorSessionId: string): string {
    return join(this.dir(), `${coordinatorSessionId}.jsonl`)
  }

  private cursorFile(coordinatorSessionId: string): string {
    return join(this.dir(), `${coordinatorSessionId}.cursors.json`)
  }

  private lockFile(coordinatorSessionId: string): string {
    return join(this.dir(), `${coordinatorSessionId}.lock`)
  }

  /**
   * Every entry of a coordinator's log, oldest first, as a snapshot (reads only
   * what was appended since the last read). The current file holds the current
   * task (and the one before it, until the next archive); `all` adds the archived ones.
   */
  async entries(coordinatorSessionId: string, all = false): Promise<readonly CollabEntry[]> {
    const previous = this.reading.get(coordinatorSessionId) ?? Promise.resolve([])
    const next = previous.catch(() => []).then(() => this.readNew(coordinatorSessionId)).then(entries => entries.slice())
    this.reading.set(coordinatorSessionId, next)
    void next.finally(() => {
      if (this.reading.get(coordinatorSessionId) === next) this.reading.delete(coordinatorSessionId)
    }).catch(() => undefined)
    const current = await next
    if (!all) return current
    const archived: CollabEntry[] = []
    for (const { file } of await this.archives(coordinatorSessionId)) archived.push(...parseLines(await readFile(file, 'utf8').catch(() => '')))
    // A crash between an archive's two writes leaves entries in both: keep the first of each seq.
    const seen = new Set<number>()
    return [...archived, ...current].filter(entry => !seen.has(entry.seq) && seen.add(entry.seq))
  }

  /** The archive files of a coordinator, oldest first. */
  private async archives(coordinatorSessionId: string): Promise<{ readonly n: number; readonly file: string }[]> {
    const pattern = new RegExp(`^${coordinatorSessionId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.(\\d+)\\.jsonl$`)
    const names = await readdir(this.dir()).catch(() => [] as string[])
    const found: { n: number; file: string }[] = []
    for (const name of names) {
      const match = pattern.exec(name)
      if (match !== null) found.push({ n: Number(match[1]), file: join(this.dir(), name) })
    }
    return found.sort((a, b) => a.n - b.n)
  }

  private async readNew(coordinatorSessionId: string): Promise<readonly CollabEntry[]> {
    const file = this.file(coordinatorSessionId)
    let info: { size: number; ino: number }
    try {
      info = await stat(file)
    } catch {
      this.cache.delete(coordinatorSessionId)
      return []
    }
    const { size, ino } = info
    let cached = this.cache.get(coordinatorSessionId)
    if (cached === undefined || size < cached.offset || ino !== cached.ino) {
      cached = { offset: 0, ino, entries: [] }
      this.cache.set(coordinatorSessionId, cached)
    }
    if (size === cached.offset) return cached.entries
    const handle = await open(file, 'r')
    try {
      const buffer = Buffer.alloc(size - cached.offset)
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, cached.offset)
      const chunk = buffer.subarray(0, bytesRead)
      // Only complete lines: a line still being written is read next time.
      const end = chunk.lastIndexOf(0x0a)
      if (end < 0) return cached.entries
      cached.entries.push(...parseLines(chunk.subarray(0, end).toString('utf8')))
      cached.offset += end + 1
    } finally {
      await handle.close()
    }
    return cached.entries
  }

  /** Run `body` holding the log's lock file (and this process's write queue). */
  private locked<T>(coordinatorSessionId: string, body: () => Promise<T>): Promise<T> {
    const run = this.queue.then(async () => {
      await this.ensureDir()
      const lock = this.lockFile(coordinatorSessionId)
      const deadline = Date.now() + LOCK_WAIT_MS
      const token = `${process.pid} ${Date.now()} ${Math.random().toString(36).slice(2)}\n`
      for (;;) {
        try {
          const handle = await open(lock, 'wx')
          try {
            await handle.writeFile(token)
          } finally {
            await handle.close()
          }
          break
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
          const modified = await stat(lock).then(info => info.mtimeMs, () => undefined)
          if (modified !== undefined && Date.now() - modified > LOCK_STALE_MS) {
            // Take over by renaming the stale lock away: one waiter wins the rename; one that grabbed a fresh lock puts it back.
            const taken = `${lock}.${process.pid}.${Date.now()}.stale`
            if (await rename(lock, taken).then(() => true, () => false)) {
              const grabbed = await stat(taken).then(info => info.mtimeMs, () => undefined)
              if (grabbed !== undefined && Date.now() - grabbed <= LOCK_STALE_MS) await rename(taken, lock).catch(() => unlink(taken).catch(() => undefined))
              else await unlink(taken).catch(() => undefined)
            }
            continue
          }
          if (Date.now() > deadline) throw new Error(`collaboration log lock ${lock} is held`)
          await sleep(LOCK_RETRY_MS)
        }
      }
      try {
        return await body()
      } finally {
        // Only the holder's own lock: one taken over as stale now belongs to another process.
        if (await readFile(lock, 'utf8').then(text => text === token, () => false)) await unlink(lock).catch(() => undefined)
      }
    })
    this.queue = run.catch(() => undefined)
    return run
  }

  private emit(coordinatorSessionId: string, entry: CollabEntry): void {
    try {
      this.options.onAppend?.(coordinatorSessionId, entry)
    } catch {
      // a listener must not break the write
    }
  }

  /** Append one entry. `make` sees the log as it stands (to refuse a write, it throws); `seq` and `at` are filled in. */
  async append(coordinatorSessionId: string, make: (entries: readonly CollabEntry[]) => Omit<CollabEntry, 'seq' | 'at'> | Promise<Omit<CollabEntry, 'seq' | 'at'>>): Promise<CollabEntry> {
    const entry = await this.locked(coordinatorSessionId, async () => {
      // Read under the lock: another process may have appended or archived since.
      const entries = await this.entries(coordinatorSessionId)
      const body = await make(entries)
      const written: CollabEntry = { ...body, seq: (entries.at(-1)?.seq ?? 0) + 1, at: new Date().toISOString() }
      await this.write(coordinatorSessionId, written)
      await this.archive(coordinatorSessionId, [...entries, written]).catch(() => undefined)
      return written
    })
    this.emit(coordinatorSessionId, entry)
    return entry
  }

  /**
   * The user started a new task: a `task` entry ends the previous one
   * (nothing when the log is empty or already ends with one: a log that
   * does not exist yet has no earlier task).
   */
  async markTask(coordinatorSessionId: string): Promise<void> {
    const entry = await this.locked(coordinatorSessionId, async () => {
      const entries = await this.entries(coordinatorSessionId)
      if (entries.length === 0 || entries.at(-1)!.kind === 'task') return undefined
      const written: CollabEntry = { seq: entries.at(-1)!.seq + 1, at: new Date().toISOString(), from: coordinatorSessionId, fromTitle: 'coordinator', kind: 'task', text: '' }
      await this.write(coordinatorSessionId, written)
      await this.archive(coordinatorSessionId, [...entries, written]).catch(() => undefined)
      return written
    })
    if (entry !== undefined) this.emit(coordinatorSessionId, entry)
  }

  private async write(coordinatorSessionId: string, entry: CollabEntry): Promise<void> {
    const file = this.file(coordinatorSessionId)
    // A file that does not end in a newline holds a partial line: start the entry on its own line.
    const handle = await open(file, 'a+')
    try {
      const { size } = await handle.stat()
      let prefix = ''
      if (size > 0) {
        const last = Buffer.alloc(1)
        await handle.read(last, 0, 1, size - 1)
        if (last[0] !== 0x0a) prefix = '\n'
      }
      await handle.appendFile(`${prefix}${JSON.stringify(entry)}\n`, 'utf8')
    } finally {
      await handle.close()
    }
  }

  /** Under the lock: with more than the archive limit, move the entries before the last `task` entry to the next `<coordinator>.<n>.jsonl`. */
  private async archive(coordinatorSessionId: string, entries: readonly CollabEntry[]): Promise<void> {
    if (entries.length <= THREAD_LIMITS.collabArchiveAt) return
    const split = entries.findLastIndex(entry => entry.kind === 'task')
    if (split <= 0) return
    const archives = await this.archives(coordinatorSessionId)
    const n = (archives.at(-1)?.n ?? 0) + 1
    const lines = (list: readonly CollabEntry[]): string => list.map(entry => `${JSON.stringify(entry)}\n`).join('')
    // The archive is complete before the current file shrinks, so a crash between the two duplicates entries and loses none.
    await this.replaceFile(join(this.dir(), `${coordinatorSessionId}.${n}.jsonl`), lines(entries.slice(0, split)))
    await this.replaceFile(this.file(coordinatorSessionId), lines(entries.slice(split)))
    this.cache.delete(coordinatorSessionId)
  }

  private async replaceFile(file: string, content: string): Promise<void> {
    const temporary = `${file}.${process.pid}.${Date.now()}.tmp`
    await writeFile(temporary, content, 'utf8')
    await rename(temporary, file)
  }

  private async ensureDir(): Promise<void> {
    const dir = this.dir()
    await mkdir(dir, { recursive: true })
    const ignore = join(dir, '.gitignore')
    await writeFile(ignore, COLLAB_GITIGNORE, { encoding: 'utf8', flag: 'wx' }).catch(() => undefined)
  }

  private async readCursors(coordinatorSessionId: string): Promise<Map<string, number>> {
    const cursors = new Map<string, number>()
    try {
      const parsed = JSON.parse(await readFile(this.cursorFile(coordinatorSessionId), 'utf8')) as Record<string, unknown>
      for (const [sessionId, seq] of Object.entries(parsed)) if (typeof seq === 'number' && Number.isInteger(seq) && seq >= 0) cursors.set(sessionId, seq)
    } catch {
      // none yet
    }
    return cursors
  }

  private async loadCursors(coordinatorSessionId: string): Promise<Map<string, number>> {
    let cursors = this.cursors.get(coordinatorSessionId)
    if (cursors !== undefined) return cursors
    cursors = await this.readCursors(coordinatorSessionId)
    this.cursors.set(coordinatorSessionId, cursors)
    return cursors
  }

  /** The last seq a session has seen (`undefined` before its first delivery). */
  async cursor(coordinatorSessionId: string, sessionId: string): Promise<number | undefined> {
    return (await this.loadCursors(coordinatorSessionId)).get(sessionId)
  }

  /** Record what a session has seen (merged into the file under the lock, written to a temporary file, then renamed). */
  setCursor(coordinatorSessionId: string, sessionId: string, seq: number): Promise<void> {
    return this.locked(coordinatorSessionId, async () => {
      const cursors = await this.readCursors(coordinatorSessionId)
      this.cursors.set(coordinatorSessionId, cursors)
      if (cursors.get(sessionId) === seq) return
      cursors.set(sessionId, seq)
      await this.replaceFile(this.cursorFile(coordinatorSessionId), `${JSON.stringify(Object.fromEntries(cursors))}\n`)
    })
  }
}

function parseLines(text: string): CollabEntry[] {
  const entries: CollabEntry[] = []
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    try {
      entries.push(JSON.parse(line) as CollabEntry)
    } catch {
      // a damaged line is skipped
    }
  }
  return entries
}
