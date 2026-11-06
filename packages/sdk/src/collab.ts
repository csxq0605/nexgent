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
import { mkdir, open, readFile, rename, stat, writeFile } from 'node:fs/promises'
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

function quoted(entry: CollabEntry): string {
  return entry.fromTitle === 'coordinator' ? 'the coordinator' : `"${entry.fromTitle}"`
}

/** Pure: one entry as a line (`self`: the reading thread, so a message to it reads "to you"). */
export function renderCollabEntry(entry: CollabEntry, self?: string): string {
  const paths = entry.paths === undefined || entry.paths.length === 0 ? '' : ` [${entry.paths.join(', ')}]`
  const who = quoted(entry)
  switch (entry.kind) {
    case 'note': return `#${entry.seq} ${who} notes${paths}: ${entry.text}`
    case 'claim': return `#${entry.seq} ${who} claims${paths}: ${entry.text}`
    case 'handoff': return `#${entry.seq} ${who} hands off${paths}: ${entry.text}`
    case 'blocker': return `#${entry.seq} ${who} is blocked${paths}: ${entry.text}`
    case 'message': return `#${entry.seq} ${who} to ${entry.to === self ? 'you' : `"${entry.toTitle ?? entry.to}"`}: ${entry.text}`
    case 'ask': return `#${entry.seq} ${who} asks the coordinator: ${entry.text}`
    case 'merged': return `#${entry.seq} ${who}'s turn merged into the project${paths}${entry.text === '' ? '' : `: ${entry.text}`}`
    case 'task': return `#${entry.seq} (the user started a new task)`
  }
}

/** Who is reading, for {@link collabDelivery}. */
export interface CollabReader {
  readonly sessionId: string
  /** The paths its part was given (`owns`). */
  readonly owns?: readonly string[]
}

/** Input of {@link collabDelivery}. */
export interface CollabDeliveryInput {
  readonly entries: readonly CollabEntry[]
  readonly reader: CollabReader
  /** The last seq the reader has seen. */
  readonly cursor: number
  readonly collaboration: Pick<CollaborationConfig, 'mode' | 'handoff'>
  /** The reader's history was compacted: re-send what still holds from the current task. */
  readonly compacted: boolean
  /** Whether a thread still works on its part (running, or waiting for an answer); its claims and blockers hold while it does. */
  readonly working: (sessionId: string) => boolean
}

/**
 * Pure: whether an entry reaches the reader in full (`full`), as a count
 * (`count`), or not at all (`skip`). In full: a message to it, the
 * coordinator's notes, and (with `hybrid`) blockers, notes, and claims,
 * handoffs and merges about its paths; with handoff `changed`, every
 * `merged` entry. With `central`, threads hear only from the coordinator.
 */
export function collabRelevance(entry: CollabEntry, reader: CollabReader, myPaths: readonly string[] | undefined, collaboration: Pick<CollaborationConfig, 'mode' | 'handoff'>): 'full' | 'count' | 'skip' {
  if (entry.from === reader.sessionId || entry.kind === 'task' || entry.kind === 'ask') return 'skip'
  if (entry.kind === 'message') return entry.to === reader.sessionId ? 'full' : collaboration.mode === 'hybrid' ? 'count' : 'skip'
  if (entry.fromTitle === 'coordinator' && entry.kind === 'note') return 'full'
  if (entry.kind === 'merged' && collaboration.handoff === 'changed') return 'full'
  if (collaboration.mode !== 'hybrid') return 'skip'
  if (entry.kind === 'note' || entry.kind === 'blocker') return 'full'
  return pathsOverlap(entry.paths, myPaths) ? 'full' : 'count'
}

/** Pure: the reader's paths: its `owns` and the paths of its own claims in the current task (absent: it may touch anything). */
export function readerPaths(entries: readonly CollabEntry[], reader: CollabReader): readonly string[] | undefined {
  const paths = new Set(reader.owns ?? [])
  for (const entry of currentTaskEntries(entries)) if (entry.kind === 'claim' && entry.from === reader.sessionId) for (const path of entry.paths ?? []) paths.add(path)
  return paths.size === 0 ? undefined : [...paths]
}

/**
 * Pure: what to deliver to a thread before its next model request: the
 * relevant entries after its cursor in full (the latest
 * {@link THREAD_LIMITS.collabDelivered}), the others as a count; after a
 * compaction, also what still holds from earlier in the task (the
 * coordinator's notes, messages to it, and the claims and blockers of
 * threads still working). `undefined` when there is nothing to say.
 */
export function collabDelivery(input: CollabDeliveryInput): string | undefined {
  const { entries, reader, cursor, collaboration } = input
  const myPaths = readerPaths(entries, reader)
  const start = taskStartSeq(entries)
  const full: CollabEntry[] = []
  let counted = 0
  for (const entry of entries) {
    if (entry.seq <= cursor) continue
    const relevance = collabRelevance(entry, reader, myPaths, collaboration)
    if (relevance === 'full') full.push(entry)
    else if (relevance === 'count') counted += 1
  }
  const held: CollabEntry[] = []
  if (input.compacted) {
    for (const entry of entries) {
      if (entry.seq <= start || entry.seq > cursor) continue
      if (collabRelevance(entry, reader, myPaths, collaboration) !== 'full') continue
      // A claim or blocker holds while its thread works on; the rest (notes, messages, handoffs, merges) stay true.
      if ((entry.kind === 'claim' || entry.kind === 'blocker') && !input.working(entry.from)) continue
      held.push(entry)
    }
  }
  if (full.length === 0 && counted === 0 && held.length === 0) return undefined
  const limit = THREAD_LIMITS.collabDelivered
  // Only hybrid threads have read_collab.
  const more = collaboration.mode === 'hybrid' ? ': read_collab shows them' : ''
  const lines = [`${COLLAB_DELIVERY_LEAD}:`]
  if (held.length > 0) {
    lines.push('Still in force from earlier in this task (your history was compacted):')
    if (held.length > limit) lines.push(`(${held.length - limit} earlier entries left out${more})`)
    for (const entry of held.slice(-limit)) lines.push(renderCollabEntry(entry, reader.sessionId))
    if (full.length > 0) lines.push('New:')
  }
  if (full.length > limit) lines.push(`(${full.length - limit} earlier new entries left out${more})`)
  for (const entry of full.slice(-limit)) lines.push(renderCollabEntry(entry, reader.sessionId))
  if (counted > 0) lines.push(`${counted} other new entr${counted === 1 ? 'y is' : 'ies are'} not about your paths (read_collab shows ${counted === 1 ? 'it' : 'them'}).`)
  return lines.join('\n')
}

interface Cached {
  /** Bytes of the file read so far (up to the last complete line). */
  offset: number
  entries: CollabEntry[]
}

/** The collaboration logs of one project, and each session's cursor. Writes run one at a time per process. */
export class CollabLog {
  private queue: Promise<unknown> = Promise.resolve()
  private readonly cache = new Map<string, Cached>()
  private readonly cursors = new Map<string, Map<string, number>>()
  /** Per coordinator: the read in progress (reads of one log run one at a time, so the cache is read once). */
  private readonly reading = new Map<string, Promise<readonly CollabEntry[]>>()

  /** `dir`: the project's log directory (`<root>/.nexgent/collab`). */
  constructor(private readonly dir: () => string) {}

  private file(coordinatorSessionId: string): string {
    return join(this.dir(), `${coordinatorSessionId}.jsonl`)
  }

  private cursorFile(coordinatorSessionId: string): string {
    return join(this.dir(), `${coordinatorSessionId}.cursors.json`)
  }

  /** Every entry of a coordinator's log, oldest first, as a snapshot (reads only what was appended since the last read). */
  entries(coordinatorSessionId: string): Promise<readonly CollabEntry[]> {
    const previous = this.reading.get(coordinatorSessionId) ?? Promise.resolve([])
    const next = previous.catch(() => []).then(() => this.readNew(coordinatorSessionId)).then(entries => entries.slice())
    this.reading.set(coordinatorSessionId, next)
    void next.finally(() => {
      if (this.reading.get(coordinatorSessionId) === next) this.reading.delete(coordinatorSessionId)
    }).catch(() => undefined)
    return next
  }

  private async readNew(coordinatorSessionId: string): Promise<readonly CollabEntry[]> {
    const file = this.file(coordinatorSessionId)
    let size: number
    try {
      size = (await stat(file)).size
    } catch {
      this.cache.delete(coordinatorSessionId)
      return []
    }
    let cached = this.cache.get(coordinatorSessionId)
    if (cached === undefined || size < cached.offset) {
      cached = { offset: 0, entries: [] }
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
      for (const line of chunk.subarray(0, end).toString('utf8').split('\n')) {
        if (line.trim() === '') continue
        try {
          cached.entries.push(JSON.parse(line) as CollabEntry)
        } catch {
          // a damaged line is skipped
        }
      }
      cached.offset += end + 1
    } finally {
      await handle.close()
    }
    return cached.entries
  }

  /** Append one entry. `make` sees the log as it stands (to refuse a write, it throws); `seq` and `at` are filled in. */
  append(coordinatorSessionId: string, make: (entries: readonly CollabEntry[]) => Omit<CollabEntry, 'seq' | 'at'> | Promise<Omit<CollabEntry, 'seq' | 'at'>>): Promise<CollabEntry> {
    const write = this.queue.then(async () => {
      const entries = await this.entries(coordinatorSessionId)
      const body = await make(entries)
      const entry: CollabEntry = { ...body, seq: (entries.at(-1)?.seq ?? 0) + 1, at: new Date().toISOString() }
      await this.write(coordinatorSessionId, entry)
      return entry
    })
    this.queue = write.catch(() => undefined)
    return write
  }

  /**
   * The user started a new task: a `task` entry ends the previous one
   * (nothing when the log is empty or already ends with one: a log that
   * does not exist yet has no earlier task).
   */
  markTask(coordinatorSessionId: string): Promise<void> {
    const write = this.queue.then(async () => {
      const entries = await this.entries(coordinatorSessionId)
      if (entries.length === 0 || entries.at(-1)!.kind === 'task') return
      await this.write(coordinatorSessionId, { seq: entries.at(-1)!.seq + 1, at: new Date().toISOString(), from: coordinatorSessionId, fromTitle: 'coordinator', kind: 'task', text: '' })
    })
    this.queue = write.catch(() => undefined)
    return write
  }

  private async write(coordinatorSessionId: string, entry: CollabEntry): Promise<void> {
    await this.ensureDir()
    await writeFile(this.file(coordinatorSessionId), `${JSON.stringify(entry)}\n`, { encoding: 'utf8', flag: 'a' })
  }

  private async ensureDir(): Promise<void> {
    const dir = this.dir()
    await mkdir(dir, { recursive: true })
    const ignore = join(dir, '.gitignore')
    await writeFile(ignore, COLLAB_GITIGNORE, { encoding: 'utf8', flag: 'wx' }).catch(() => undefined)
  }

  private async loadCursors(coordinatorSessionId: string): Promise<Map<string, number>> {
    let cursors = this.cursors.get(coordinatorSessionId)
    if (cursors !== undefined) return cursors
    cursors = new Map()
    try {
      const parsed = JSON.parse(await readFile(this.cursorFile(coordinatorSessionId), 'utf8')) as Record<string, unknown>
      for (const [sessionId, seq] of Object.entries(parsed)) if (typeof seq === 'number' && Number.isInteger(seq) && seq >= 0) cursors.set(sessionId, seq)
    } catch {
      // none yet
    }
    this.cursors.set(coordinatorSessionId, cursors)
    return cursors
  }

  /** The last seq a session has seen (`undefined` before its first delivery). */
  async cursor(coordinatorSessionId: string, sessionId: string): Promise<number | undefined> {
    return (await this.loadCursors(coordinatorSessionId)).get(sessionId)
  }

  /** Record what a session has seen (written to a temporary file, then renamed). */
  setCursor(coordinatorSessionId: string, sessionId: string, seq: number): Promise<void> {
    const write = this.queue.then(async () => {
      const cursors = await this.loadCursors(coordinatorSessionId)
      if (cursors.get(sessionId) === seq) return
      cursors.set(sessionId, seq)
      await this.ensureDir()
      const file = this.cursorFile(coordinatorSessionId)
      const temporary = `${file}.${process.pid}.${Date.now()}.tmp`
      await writeFile(temporary, `${JSON.stringify(Object.fromEntries(cursors))}\n`, 'utf8')
      await rename(temporary, file)
    })
    this.queue = write.catch(() => undefined)
    return write
  }
}
