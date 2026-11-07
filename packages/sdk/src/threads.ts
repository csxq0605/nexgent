/**
 * Coordinator step two: threads. {@link SdkThreadHost} implements the
 * kernel's `ThreadHost` (`ctx.threads`) over the SDK's sessions, and
 * {@link threadsPlugin} (profile row `@nexgent/threads`) provides it and
 * registers the four thread tools (`start_thread`, `message_thread`,
 * `read_thread`, `list_threads`).
 *
 * A thread is a root session (`session.start.thread`) with its own copy of
 * the project, merged back when each of its turns ends. A turn the
 * coordinator gives it (its first task, or `message_thread` while it is
 * idle) runs in the background and is recorded in the coordinator as a
 * member run (`subagent.start` / `subagent.end`, `executionForm: thread`,
 * under the coordinator's turn that started it). When that turn ends the
 * coordinator is woken: the note joins its running turn, or starts its next
 * turn (`user.message.source: thread`). A turn the user stopped, or one
 * stopped at the cost cap, does not wake it (the stop is the user's word;
 * `list_threads` shows the thread stopped). Turns the user starts in a
 * thread are the user's: not recorded in the coordinator, no wake.
 *
 * Once every thread run a coordinator turn started has ended (and that turn
 * has too), the host measures the turn again with the threads in it and
 * hands the profile to the organization library (`noteProfile`), which
 * judges its collaboration.
 *
 * Organization redo (user, 2026-11-06):
 * - The user can start a thread themselves (`startByUser`; its first turn
 *   is the user's message, and its end wakes the coordinator), or name the
 *   threads of a task with the message (`setPlan`: with `exact`, the host
 *   starts only those, with the user's words for each). The plan is kept in
 *   the project (`<coordinator>.plan.json`) and binds after a restart.
 * - The user's own words reach the threads word for word (`relay`): the
 *   words of the task, those the user adds in the middle of a coordinator
 *   turn ({@link SdkThreadHost.coordinatorTurnEnded}), and the user's words
 *   for a planned part.
 * - A thread may be given `owns` (the paths its part changes). Its wake
 *   note says which files it brought in outside them, and which files
 *   another thread of the task also brought in.
 * - Threads running at once are limited (`ThreadRuntime.maxRunning`); a turn
 *   over the limit, or (with `overlap: sequence`) one whose paths overlap a
 *   running thread's, waits in a queue (`<coordinator>.queue.json`) and
 *   starts when a thread's turn ends ({@link SdkThreadHost.turnEnded}).
 *   `stop` ends a running or waiting turn.
 * - The task's arrangement (`CollaborationConfig` on the coordinator turn's
 *   decision) is enforced here: `overlap: sequence`; `handoff: changed`
 *   delivers every thread of the task each `merged` entry of the
 *   collaboration log; `wake: named` lets a message wake an idle thread (a
 *   few times per task); `check` decides who runs the final check of the
 *   whole project, which the host starts once every thread has ended and two
 *   or more merged files.
 * - The coordinator's threads share a collaboration log in the project
 *   (`<root>/.nexgent/collab/<coordinator>.jsonl`, `collab.ts`). The host
 *   writes `merged` and `release` entries when a thread's turn ends; threads
 *   message each other and ask the coordinator in either mode, and with
 *   collaboration `hybrid` (the project's setting) they also post notes,
 *   claims, handoffs and blockers; the coordinator posts notes. Before each
 *   model request, the host delivers what the session has not seen yet
 *   ({@link SdkThreadHost.deliver}): a thread what is for it, the coordinator
 *   what its threads wrote. {@link SdkThreadHost.collabFor} gives the entries
 *   that concern a conversation, for its history.
 * - Counts of what the arrangement's values did (`<coordinator>.triggers.json`)
 *   and the events read from the log go to the organization library with the
 *   task's profile.
 */
import {
  addUsage,
  ASK_COORDINATOR_TOOL,
  COLLAB_POST_KINDS,
  DEFAULT_COLLABORATION,
  MAX_PLANNED_THREADS,
  NO_COLLABORATION_EVENTS,
  MESSAGE_PEER_TOOL,
  POST_COLLAB_TOOL,
  READ_COLLAB_TOOL,
  READ_MERGED_TOOL,
  STOP_THREAD_TOOL,
  LIST_THREADS_TOOL,
  MESSAGE_THREAD_TOOL,
  NexgentError,
  READ_THREAD_TOOL,
  START_THREAD_TOOL,
  THREAD_LIMITS,
  threadWakeNote,
  toErrorInfo,
  ZERO_USAGE,
  type Context,
  type DeliverableVersionRef,
  type HostRecordInput,
  type LLMUsage,
  type MemberDenial,
  type MemberResult,
  type OrganizationMemory,
  type ProjectObservation,
  type TaskFacts,
  type SessionRecord,
  type Step2ToolSpec,
  type ThreadCaller,
  type ThreadHost,
  type ThreadInfo,
  type ThreadOrigin,
  type ThreadStartInput,
  type ThreadStopInput,
  type ThreadStatus,
  type ThreadView,
  type Tool,
  type ToolContext,
  type ToolOutput,
  type TurnResult,
  type WorkdirMerge,
  type ContextProvider,
  type SystemPromptSection,
  UPDATE_PROJECT_NOTES_TOOL,
  type CollabEntry,
  type CollabPostKind,
  type CollaborationConfig,
  type CollaborationMode,
  type RequestContextInput,
  type ThreadPeers,
  type ThreadPlan,
  type ThreadRunEvents,
} from '@nexgent/kernel'
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { mkdir, open, readFile, realpath, rename, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { COLLAB_GITIGNORE, CollabLog, collabDelivery, currentTaskEntries, hopsOf, logEvents, readerPaths, renderCollabEntry, taskStartSeq, waitCycle, type CollabReader } from './collab.js'
import { toMemberResult } from '@nexgent/subagent'
import { loopNote, observationLines, taskFacts } from './memory.js'
import { MEMBER_REPORT_INSTRUCTION, buildOrganizationProfile, parseMemberReport, reportBlocker, withinOwns } from '@nexgent/workflow'

/** What the host needs from the SDK, for one project. */
export interface ThreadRuntime {
  /** Create a thread session (open and tracked); returns its id. */
  create(input: { readonly title: string; readonly thread: ThreadOrigin }): Promise<string>
  /** Open a root session when it is not (reopening runs its recoveries). */
  ensureOpen(sessionId: string): Promise<void>
  /** A session's records (`session/not-found` when it has none). */
  records(sessionId: string): Promise<readonly SessionRecord[]>
  /** Append a host record to a root session (opened when it is not). */
  append(sessionId: string, record: HostRecordInput): Promise<void>
  /**
   * Start a turn with `source: thread` (`user`: the user's own message);
   * `done` settles after the SDK's bookkeeping. `relay` (D1): the user's own
   * words passed on with it, recorded right after it as
   * `user.message { source: 'relay' }`.
   */
  startTurn(sessionId: string, text: string, materialIds?: readonly string[], source?: 'thread' | 'user', relay?: readonly string[]): Promise<{ readonly turn: number; readonly done: Promise<TurnResult> }>
  /** Join the session's running turn (`source: thread`, with the user's words `relay` after it); `false` when no turn takes it. */
  steer(sessionId: string, text: string, relay?: readonly string[]): Promise<boolean>
  /** D9: stop the session's running turn (cause `user`); settles once it has ended. */
  cancel(sessionId: string): Promise<void>
  /** A5: how many threads of a coordinator may run at once (`config.json` `threads.maxRunning`, default `THREAD_LIMITS.maxRunning`). */
  maxRunning(): Promise<number>
  /** Absolute project root (B14 `read_merged` reads the merged project there). */
  projectRoot(): string
  /** D7: `false` when the session's copy of the project could not be made (it works in the project itself); `undefined` when not known (not open). */
  isolated(sessionId: string): boolean | undefined | Promise<boolean | undefined>
  /** Whether a turn runs in the session. */
  running(sessionId: string): boolean
  /** Settles once the session's running turn has finished (at once when none runs). */
  turnDone(sessionId: string): Promise<void>
  /** Wake a coordinator: the note joins its running turn or starts its next one. */
  wake(sessionId: string, text: string): Promise<void>
  /** The threads of a coordinator, oldest first. */
  threadIds(coordinatorSessionId: string): Promise<readonly string[]>
  /** What merging the thread's copy did at the end of its last turn in this process. */
  lastMerge(sessionId: string): WorkdirMerge | undefined
  /** Price of a usage in USD, when the model's prices are known. */
  costOf(usage: LLMUsage, model: string | undefined): number | undefined
  organizations(): OrganizationMemory | undefined
  /** The project is closing: no more wakes or measurements. */
  closed(): boolean
  /** Report a failure that must not stop anything (an `error` event). */
  report(sessionId: string, error: unknown): void
  /** Coordinator step three: a tool call in the session (or one of its members) waits for the user to allow it. */
  needsApproval(sessionId: string): boolean
  /** Coordinator step three: whether the session is the project's coordinator conversation. */
  isCoordinator(sessionId: string): Promise<boolean>
  /** Coordinator step three: the project notes file (`<dataDir>/coordinator-notes.md`). */
  notesFile(): string
  /** Organization redo: the directory of the coordinators' collaboration logs (`<root>/.nexgent/collab`). */
  collabDir(): string
  /** Organization redo: the project's collaboration setting (`config.json` `collaboration`). */
  collaborationMode(): Promise<CollaborationMode>
}

/** Options of {@link SdkThreadHost}. */
export interface SdkThreadHostOptions {
  readonly onCollab?: (coordinatorSessionId: string, entry: CollabEntry) => void
  /** Project memory: a coordinator task ended; its facts. */
  readonly onTaskFacts?: (facts: TaskFacts) => Promise<void>
  /** Project memory: the project's observations (the coordinator is told about hotspots and splits). */
  readonly observations?: () => Promise<readonly ProjectObservation[]>
}

/** Coordinator step three: the project notes, in the project's data directory. */
export const COORDINATOR_NOTES_FILE = 'coordinator-notes.md'

/** Pure: the member name a thread's runs carry in the coordinator (`thread-<n>`, or a slug of an ASCII title). */
export function threadRunName(title: string, index: number): string {
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').replace(/^[^a-z]+/, '').slice(0, 32).replace(/-+$/, '')
  return slug.length >= 3 ? slug : `thread-${index}`
}

function at(records: readonly SessionRecord[]): string {
  return records.at(-1)?.ts ?? ''
}

function lastTurn(records: readonly SessionRecord[]): number {
  let turn = 0
  for (const record of records) if (record.type === 'turn.start') turn = record.turn
  return turn
}

/** The text of a turn's last assistant message. */
function replyOf(records: readonly SessionRecord[], turn: number): string {
  let text = ''
  for (const record of records) if (record.type === 'assistant.message' && record.turn === turn) text = record.content
  return text
}

/** Pure: a thread's status from its records (`running` comes from the host). */
export function threadStatusOf(records: readonly SessionRecord[], running: boolean): { readonly status: ThreadStatus; readonly blocker?: string } {
  if (running) return { status: 'running' }
  const turn = lastTurn(records)
  const end = records.findLast(record => record.type === 'turn.end' && record.turn === turn)
  if (turn === 0 || end === undefined || end.type !== 'turn.end') return { status: 'stopped' }
  switch (end.reason.kind) {
    case 'completed': {
      const blocker = reportBlocker(replyOf(records, turn))
      return blocker === undefined ? { status: 'done' } : { status: 'waiting', blocker }
    }
    case 'error':
    case 'max-tokens':
      return { status: 'failed' }
    default:
      return { status: 'stopped' }
  }
}

/** Pure: a thread as the tools and the interface see it (`needsApproval` counts only while it runs). */
export function threadInfoOf(threadId: string, records: readonly SessionRecord[], running: boolean, needsApproval = false): ThreadInfo {
  const start = records[0]
  if (start?.type !== 'session.start' || start.thread === undefined) throw new NexgentError('session/not-found', `session ${threadId} is not a thread`)
  const { status, blocker } = threadStatusOf(records, running)
  return {
    threadId,
    title: start.thread.title,
    coordinatorSessionId: start.thread.coordinatorSessionId,
    status,
    turns: records.filter(record => record.type === 'turn.start').length,
    createdAt: start.ts,
    updatedAt: at(records),
    ...(blocker === undefined ? {} : { blocker }),
    ...(running && needsApproval ? { needsApproval: true as const } : {}),
    ...(start.thread.origin === undefined ? {} : { origin: start.thread.origin }),
    ...(start.thread.owns === undefined || start.thread.owns.length === 0 ? {} : { owns: [...start.thread.owns] }),
  }
}

/** Pure: whether two `owns` lists may touch the same file (a list that is absent may touch anything). */
export function ownsOverlap(left: readonly string[] | undefined, right: readonly string[] | undefined): boolean {
  if (left === undefined || left.length === 0 || right === undefined || right.length === 0) return true
  return left.some(path => withinOwns(path, right)) || right.some(path => withinOwns(path, left))
}

/** Pure: a title as plans compare it. */
function titleKey(title: string): string {
  return title.trim().replace(/\s+/g, ' ').toLowerCase()
}

/** Pure: the arrangement of the coordinator's current task, from its records (its latest user turn's decision). */
export function taskCollaboration(records: readonly SessionRecord[]): CollaborationConfig | undefined {
  const turn = records.findLast(record => record.type === 'user.message' && record.source === 'user')
  if (turn === undefined || turn.type !== 'user.message') return undefined
  const start = records.find(record => record.type === 'turn.start' && record.turn === turn.turn)
  return start?.type === 'turn.start' ? start.organization?.collaboration : undefined
}

/** One thread run of the coordinator's current task, from its records. */
interface TaskThreadRun {
  readonly threadId: string
  readonly childTurn: number
  readonly name: string
  readonly ended: boolean
  /** Files its merge brought into the project. */
  readonly applied: readonly string[]
}

/** Pure: the thread runs of the coordinator's current task (since the user's latest message), in order. */
export function taskThreadRuns(records: readonly SessionRecord[]): TaskThreadRun[] {
  const since = records.findLast(record => record.type === 'user.message' && record.source === 'user')?.seq ?? 0
  const out: TaskThreadRun[] = []
  for (const record of records) {
    if (record.seq < since || record.type !== 'subagent.start' || record.executionForm !== 'thread') continue
    const end = records.find(item => item.type === 'subagent.end' && item.childSessionId === record.childSessionId && item.childTurn === record.childTurn)
    const merge = end?.type === 'subagent.end' ? end.result.merge : undefined
    out.push({
      threadId: record.childSessionId,
      childTurn: record.childTurn,
      name: record.name,
      ended: end !== undefined,
      applied: merge === undefined || merge.held === true ? [] : merge.applied.filter(path => !merge.conflicts.some(conflict => conflict.path === path)),
    })
  }
  return out
}

/** What a thread turn produced, from its records (as a member runner counts it). */
function turnFacts(records: readonly SessionRecord[], turn: number) {
  const deliverables: DeliverableVersionRef[] = []
  const denied: MemberDenial[] = []
  let requestCount = 0
  for (const record of records) {
    if (!('turn' in record) || record.turn !== turn) continue
    if (record.type === 'deliverable.presented') deliverables.push(record.deliverable)
    if (record.type === 'assistant.message') requestCount += 1
    if (record.type === 'tool.result') {
      const code = record.error?.code
      if ((code === 'approval/denied' || code === 'sandbox/denied') && !denied.some(item => item.tool === record.name)) denied.push({ tool: record.name, code })
    }
  }
  return { deliverables, requestCount, denied }
}

function model(records: readonly SessionRecord[]): string | undefined {
  const start = records[0]
  return start?.type === 'session.start' ? start.model : undefined
}

/**
 * Pure: the coordinator turns of the task `turn` belongs to: the turn the
 * user started (`owner`, the one the organization library records) and the
 * turns threads woke the coordinator for after it, up to the user's next
 * message. `undefined` before the first turn the user started.
 */
export function taskTurns(records: readonly SessionRecord[], turn: number): { readonly owner: number; readonly turns: ReadonlySet<number> } | undefined {
  const woken = new Map<number, boolean>()
  for (const record of records) {
    if (record.type !== 'user.message' || record.source === 'inject' || woken.has(record.turn)) continue
    woken.set(record.turn, record.source === 'thread')
  }
  let owner: number | undefined
  for (const [at, byThread] of woken) if (!byThread && at <= turn && (owner === undefined || at > owner)) owner = at
  if (owner === undefined) return undefined
  const turns = new Set<number>()
  for (const [at, byThread] of [...woken].sort((a, b) => a[0] - b[0])) {
    if (at < owner) continue
    if (at > owner && !byThread) break
    turns.add(at)
  }
  return { owner, turns }
}

/** Pure: the thread runs (coordinator step two) started in `turns`, in order. */
function threadRuns(records: readonly SessionRecord[], turns: ReadonlySet<number>) {
  return records.flatMap(record => (record.type === 'subagent.start' && record.executionForm === 'thread' && turns.has(record.turn) ? [record] : []))
}

/** Pure: the thread runs started in `turns` that have not ended yet. */
function openThreadRuns(records: readonly SessionRecord[], turns: ReadonlySet<number>): number {
  const ended = new Set(records.flatMap(record => (record.type === 'subagent.end' ? [`${record.childSessionId}:${record.childTurn}`] : [])))
  return threadRuns(records, turns).filter(run => !ended.has(`${run.childSessionId}:${run.childTurn}`)).length
}

/** Pure: a thread's `owns` as given (trimmed, no empty paths, at most {@link THREAD_LIMITS.maxOwns}). */
function cleanOwns(owns: readonly string[] | undefined): string[] | undefined {
  if (owns === undefined) return undefined
  const paths = [...new Set(owns.map(path => path.trim().replace(/\\/g, '/').replace(/^\.\//, '')).filter(path => path !== ''))]
  if (paths.length > THREAD_LIMITS.maxOwns) throw new NexgentError('tool/invalid-input', `"owns" lists ${paths.length} paths (at most ${THREAD_LIMITS.maxOwns}): name directories instead of single files`)
  return paths.length === 0 ? undefined : paths
}

function cleanTitle(value: string): string {
  const title = value.trim().replace(/\s+/g, ' ')
  if (title === '' || title.length > THREAD_LIMITS.titleChars) throw new NexgentError('tool/invalid-input', `"title" must be 1 to ${THREAD_LIMITS.titleChars} characters`)
  return title
}

/** Check a plan the user sent (titles, at most {@link MAX_PLANNED_THREADS} threads, no title twice). @throws `tool/invalid-input`. */
export function checkPlan(plan: ThreadPlan): ThreadPlan {
  if (plan === null || typeof plan !== 'object' || !Array.isArray(plan.threads) || plan.threads.length === 0 || plan.threads.length > MAX_PLANNED_THREADS) {
    throw new NexgentError('tool/invalid-input', `threads must list 1 to ${MAX_PLANNED_THREADS} threads`)
  }
  const seen = new Set<string>()
  const threads = plan.threads.map((item, index) => {
    if (item === null || typeof item !== 'object' || typeof item.title !== 'string') throw new NexgentError('tool/invalid-input', `threads[${index}].title must be a string`)
    const title = cleanTitle(item.title)
    if (seen.has(titleKey(title))) throw new NexgentError('tool/invalid-input', `two threads are titled "${title}"`)
    seen.add(titleKey(title))
    if (item.task !== undefined && typeof item.task !== 'string') throw new NexgentError('tool/invalid-input', `threads[${index}].task must be a string`)
    return { title, ...(item.task === undefined || item.task.trim() === '' ? {} : { task: item.task.trim() }) }
  })
  return { threads, exact: plan.exact !== false }
}

/** The user's plan of a coordinator's current task, and the planned threads started so far (kept in `<collabDir>/<coordinator>.plan.json`). */
interface PlanState {
  readonly plan: ThreadPlan
  readonly started: Set<string>
}

/** A thread turn waiting for a free slot, or for the paths it overlaps to be free (kept in `<collabDir>/<coordinator>.queue.json`). */
interface QueuedTurn {
  readonly threadId: string
  readonly title: string
  readonly name: string
  text: string
  materialIds?: string[]
  relay?: string[]
  /** `user`: the user's own turn (not recorded in the coordinator). */
  readonly source: 'thread' | 'user'
  /** The coordinator turn the run is recorded under (absent for the user's own turns). */
  readonly turn?: number
  readonly toolCallId?: string
  /** `check`: a run of the final whole-project check. */
  readonly role?: 'check'
  /** Counted once as a `sequence` trigger. */
  sequenceCounted?: true
}

/** What the arrangement's values did in the coordinator's current task (kept in `<collabDir>/<coordinator>.triggers.json`). */
interface TaskCounters {
  /** The task: the coordinator turn the user started. */
  task: string
  sequence: number
  changed: number
  named: number
  separate: number
  checkFailed: number
}

type CounterName = Exclude<keyof TaskCounters, 'task'>

function emptyCounters(task: string): TaskCounters {
  return { task, sequence: 0, changed: 0, named: 0, separate: 0, checkFailed: 0 }
}

/** The collaboration log directory's `.gitignore` is written beside the host's own state files. */
function writeAtomicSync(file: string, text: string): void {
  mkdirSync(dirname(file), { recursive: true })
  try {
    writeFileSync(join(dirname(file), '.gitignore'), COLLAB_GITIGNORE, { encoding: 'utf8', flag: 'wx' })
  } catch {
    // already there
  }
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`
  writeFileSync(temporary, text, 'utf8')
  renameSync(temporary, file)
}

async function writeAtomic(file: string, text: string): Promise<void> {
  writeAtomicSync(file, text)
}

async function readJson(file: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(file, 'utf8')) as unknown
  } catch {
    return undefined
  }
}

/** Pure: the task of the coordinator's records (the coordinator turn the user started). */
function taskKeyOf(records: readonly SessionRecord[]): string {
  return String(taskTurns(records, lastTurn(records))?.owner ?? 0)
}

/**
 * Pure: the user's own words in the coordinator's task: every
 * `source: 'user'` message of its turns, with the turn and whether it joined
 * a turn already running (`mid`).
 */
export function taskUserWords(records: readonly SessionRecord[], turns: ReadonlySet<number>): { readonly content: string; readonly turn: number; readonly mid: boolean }[] {
  const out: { content: string; turn: number; mid: boolean }[] = []
  const seen = new Set<number>()
  for (const record of records) {
    if (record.type !== 'user.message' || record.source === 'inject') continue
    const first = !seen.has(record.turn)
    seen.add(record.turn)
    if (record.source === 'user' && turns.has(record.turn) && record.content.trim() !== '') out.push({ content: record.content, turn: record.turn, mid: !first })
  }
  return out
}

/** Pure: the words a thread was given as `relay` (the user's own words the host passed on), in order. */
function relayedTo(records: readonly SessionRecord[]): string[] {
  const out: string[] = []
  for (const record of records) if (record.type === 'user.message' && record.source === 'relay') out.push(record.content)
  return out
}

/** Pure: of the user's `words`, those not yet given; each given text covers one occurrence, so a repeated message is passed on again. */
function unseenOf(words: readonly string[], given: readonly string[]): string[] {
  const left = new Map<string, number>()
  for (const text of given) left.set(text, (left.get(text) ?? 0) + 1)
  const out: string[] = []
  for (const word of words) {
    const n = left.get(word) ?? 0
    if (n > 0) left.set(word, n - 1)
    else out.push(word)
  }
  return out
}

/** Pure: the arguments of a tool call as an object. */
function callArgs(call: { readonly arguments: string }): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(call.arguments)
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
  } catch {
    return {}
  }
}

/** Pure (D4): one line per tool call of a thread turn: the tool, its main argument (a path or command, 80 characters) and how it went; the latest {@link THREAD_LIMITS.trajectorySteps}. */
export function threadTrajectory(records: readonly SessionRecord[], turn: number): string[] {
  const results = new Map<string, { readonly isError: boolean; readonly code?: string }>()
  for (const record of records) {
    if (record.type === 'tool.result' && record.turn === turn) results.set(record.toolCallId, { isError: record.isError, ...(record.error?.code === undefined ? {} : { code: record.error.code }) })
  }
  const lines: string[] = []
  for (const record of records) {
    if (record.type !== 'assistant.message' || record.turn !== turn) continue
    for (const call of record.toolCalls ?? []) {
      const input = callArgs(call)
      const main = [input.path, input.file_path, input.command, input.query, input.pattern, input.url, ...Object.values(input)].find(value => typeof value === 'string' && value !== '')
      const shown = typeof main === 'string' ? main.replace(/\s+/g, ' ').trim().slice(0, 80) : ''
      const result = results.get(call.id)
      lines.push(`${call.name}${shown === '' ? '' : ` ${shown}`}: ${result === undefined ? 'no result' : result.isError ? `failed${result.code === undefined ? '' : ` (${result.code})`}` : 'ok'}`)
    }
  }
  return lines.slice(-THREAD_LIMITS.trajectorySteps)
}

/** Pure: the paths a thread's tool calls named in a turn (what it read or wrote). */
function touchedPaths(records: readonly SessionRecord[], turn: number): string[] {
  const out = new Set<string>()
  for (const record of records) {
    if (record.type !== 'assistant.message' || record.turn !== turn) continue
    for (const call of record.toolCalls ?? []) {
      const input = callArgs(call)
      for (const value of [input.path, input.file_path]) if (typeof value === 'string' && value !== '') out.add(value.replace(/\\/g, '/').replace(/^\.\//, ''))
    }
  }
  return [...out]
}

function notNone(value: string | undefined): boolean {
  return value !== undefined && value.trim() !== '' && !/^(none|nothing|n\/a|no|-|—|无|没有)\W*$/i.test(value.trim())
}

/** The name prefix of the runs of the final whole-project check. */
const CHECK_NAME_PREFIX = 'check'

/** Thrown inside a log write that turned out to have nothing to write. */
class NothingToRelease extends Error {}

/** What the host asks of the final whole-project check (general: it names no project or task). */
export const FINAL_CHECK_TASK = 'Check the whole project as it is now: every thread of this task has merged its part into it, and each thread checked only its own copy. '
  + 'Run the project\'s own tests, build or program, whatever it has; where something fails, find out which change broke it and fix it. Do not redo the threads\' parts. '
  + `When you read a file, read it from the project, not from your copy (read_merged shows the project's current version).\n${MEMBER_REPORT_INSTRUCTION}`

/** The title of the thread the host starts for a `separate` final check. */
export const FINAL_CHECK_TITLE = 'Check the whole project'

/** The most bytes `read_merged` returns. */
const READ_MERGED_BYTES = 200 * 1024

/** The kernel's `ThreadHost` over the SDK's sessions of one project. */
export class SdkThreadHost implements ThreadHost, ThreadPeers {
  /** Per coordinator: measurements run one at a time. */
  private readonly measuring = new Map<string, Promise<void>>()
  /** Per coordinator: the user's plan for the current task (`null`: none; read from the plan file once). */
  private readonly plans = new Map<string, PlanState | null>()
  /** Per thread: questions to the coordinator in its current turn. */
  private readonly asked = new Map<string, { readonly turn: number; readonly count: number }>()
  /** Per session: its thread origin (`null`: not a thread); a session's start record never changes. */
  private readonly origins = new Map<string, ThreadOrigin | null>()
  /** Per coordinator: the turns waiting to start (read from the queue file once). */
  private readonly queues = new Map<string, QueuedTurn[]>()
  /** Per coordinator: the task counters. */
  private readonly counters = new Map<string, TaskCounters>()
  /** Coordinators whose threads were resumed in this process. */
  private readonly resumed = new Set<string>()
  /** Threads whose turn has ended (the SDK told {@link turnEnded}) but may still be marked running for a moment. */
  private readonly settled = new Set<string>()
  /** Work that must not overlap, by key (`queue:<coordinator>`, `state:<coordinator>`, `check:<coordinator>`). */
  private readonly chains = new Map<string, Promise<unknown>>()
  /** The project's collaboration logs. */
  readonly collab: CollabLog

  /** Project memory: where a task's facts go once it ended, and the observations the coordinator is told about. */
  private readonly memory: SdkThreadHostOptions

  /** Per session: the last loop the model was told about (the seq of its last failed call). */
  private readonly loopsNoted = new Map<string, number>()

  constructor(private readonly rt: ThreadRuntime, options: SdkThreadHostOptions = {}) {
    this.collab = new CollabLog(() => rt.collabDir(), options.onCollab === undefined ? {} : { onAppend: options.onCollab })
    this.memory = options
  }

  /** Project memory: the observations the coordinator sees (none when they cannot be read). */
  async observations(): Promise<readonly ProjectObservation[]> {
    return (await this.memory.observations?.().catch(() => undefined)) ?? []
  }

  /** Project memory: hand a task's facts on (a failure is reported, never thrown). */
  private async noteFacts(coordinatorSessionId: string, facts: TaskFacts): Promise<void> {
    if (this.memory.onTaskFacts === undefined || this.rt.closed()) return
    await this.memory.onTaskFacts(facts).catch(error => this.rt.report(coordinatorSessionId, error))
  }

  /**
   * Project memory: a coordinator task that started no thread ended with
   * the turn: its facts are the coordinator's alone. A task with threads is
   * noted when it is measured.
   */
  private async noteSoloTask(coordinatorSessionId: string, turn: number): Promise<void> {
    if (this.memory.onTaskFacts === undefined) return
    const records = await this.rt.records(coordinatorSessionId).catch(() => [] as readonly SessionRecord[])
    const task = taskTurns(records, turn)
    if (task === undefined || task.owner !== turn || threadRuns(records, task.turns).length > 0) return
    if ((await this.queueOf(coordinatorSessionId)).length > 0) return
    const end = records.findLast(record => record.type === 'turn.end' && record.turn === turn)
    if (end?.type !== 'turn.end' || end.reason.kind === 'cancelled' || end.reason.kind === 'interrupted') return
    const facts = taskFacts({ coordinatorSessionId, owner: task.owner, turns: task.turns, records, children: new Map(), completed: end.reason.kind === 'completed' ? 'unknown' : false, checkFailed: false, idle: 0, unanswered: 0, at: end.ts })
    await this.noteFacts(coordinatorSessionId, facts)
  }

  /**
   * Project memory: before a model request of the coordinator or a thread,
   * a note when its latest calls are the same call failing the same way
   * again and again (once per such loop).
   */
  async loopCheck(input: Pick<RequestContextInput, 'sessionId'>): Promise<readonly string[] | undefined> {
    if ((await this.origin(input.sessionId)) === undefined && !(await this.rt.isCoordinator(input.sessionId).catch(() => false))) return undefined
    const records = await this.rt.records(input.sessionId).catch(() => [] as readonly SessionRecord[])
    const found = loopNote(records)
    if (found === undefined || this.loopsNoted.get(input.sessionId) === found.at) return undefined
    this.loopsNoted.set(input.sessionId, found.at)
    return [found.note]
  }

  private serial<T>(key: string, body: () => Promise<T>): Promise<T> {
    const previous = this.chains.get(key) ?? Promise.resolve()
    const next = previous.catch(() => undefined).then(body)
    const tail = next.catch(() => undefined)
    this.chains.set(key, tail)
    void tail.then(() => {
      if (this.chains.get(key) === tail) this.chains.delete(key)
    })
    return next
  }

  private file(coordinatorSessionId: string, suffix: string): string {
    return join(this.rt.collabDir(), `${coordinatorSessionId}.${suffix}`)
  }

  // -------------------------------------------------------------------------
  // the user's plan (kept in the project: it binds after a restart)
  // -------------------------------------------------------------------------

  private loadPlan(coordinatorSessionId: string): PlanState | undefined {
    const known = this.plans.get(coordinatorSessionId)
    if (known !== undefined) return known ?? undefined
    let state: PlanState | null = null
    try {
      const parsed = JSON.parse(readFileSync(this.file(coordinatorSessionId, 'plan.json'), 'utf8')) as { plan?: ThreadPlan; started?: unknown }
      if (parsed.plan !== undefined) state = { plan: checkPlan(parsed.plan), started: new Set(Array.isArray(parsed.started) ? parsed.started.filter((item): item is string => typeof item === 'string') : []) }
    } catch {
      // no plan (or an unreadable one: none binds)
    }
    this.plans.set(coordinatorSessionId, state)
    return state ?? undefined
  }

  private savePlan(coordinatorSessionId: string, state: PlanState | undefined): void {
    this.plans.set(coordinatorSessionId, state ?? null)
    const file = this.file(coordinatorSessionId, 'plan.json')
    try {
      if (state === undefined) rmSync(file, { force: true })
      else writeAtomicSync(file, `${JSON.stringify({ plan: state.plan, started: [...state.started] })}\n`)
    } catch (error) {
      this.rt.report(coordinatorSessionId, error)
    }
  }

  /**
   * Organization redo: the user sent the coordinator a new message: a new
   * task starts. `plan`: the threads the user named for it (replaces the
   * previous plan; absent: none). The counters of the previous task end.
   */
  newTask(coordinatorSessionId: string, plan?: ThreadPlan): void {
    void this.collab.markTask(coordinatorSessionId).catch(error => this.rt.report(coordinatorSessionId, error))
    this.savePlan(coordinatorSessionId, plan === undefined ? undefined : { plan: checkPlan(plan), started: new Set() })
  }

  /** The user named (more) threads in the middle of the task: their plan replaces the previous one; the threads started so far stay started. */
  setPlan(coordinatorSessionId: string, plan: ThreadPlan): void {
    const started = this.loadPlan(coordinatorSessionId)?.started ?? new Set<string>()
    this.savePlan(coordinatorSessionId, { plan: checkPlan(plan), started })
  }

  /** The user's plan of the coordinator's current task, if any. */
  plan(coordinatorSessionId: string): ThreadPlan | undefined {
    return this.loadPlan(coordinatorSessionId)?.plan
  }

  // -------------------------------------------------------------------------
  // the task's counters (what the arrangement's values did)
  // -------------------------------------------------------------------------

  /** The counters of `task`; `current: false` reads those of an earlier task without making them the held ones. */
  private async taskCounters(coordinatorSessionId: string, task: string, current = true): Promise<TaskCounters> {
    const held = this.counters.get(coordinatorSessionId)
    if (held?.task === task) return held
    const stored = await readJson(this.file(coordinatorSessionId, 'triggers.json')) as Partial<TaskCounters> | undefined
    const loaded = stored?.task === task ? { ...emptyCounters(task), ...stored } : emptyCounters(task)
    if (current) this.counters.set(coordinatorSessionId, loaded)
    return loaded
  }

  private bump(coordinatorSessionId: string, name: CounterName, by = 1): Promise<void> {
    return this.serial(`state:${coordinatorSessionId}`, async () => {
      const records = await this.rt.records(coordinatorSessionId).catch(() => [] as readonly SessionRecord[])
      const counters = await this.taskCounters(coordinatorSessionId, taskKeyOf(records))
      counters[name] += by
      await writeAtomic(this.file(coordinatorSessionId, 'triggers.json'), `${JSON.stringify(counters)}\n`)
    }).catch(error => this.rt.report(coordinatorSessionId, error))
  }

  // -------------------------------------------------------------------------
  // the queue (threads running at once are limited; overlap: sequence holds turns back)
  // -------------------------------------------------------------------------

  private async queueOf(coordinatorSessionId: string): Promise<QueuedTurn[]> {
    const known = this.queues.get(coordinatorSessionId)
    if (known !== undefined) return known
    const stored = await readJson(this.file(coordinatorSessionId, 'queue.json'))
    const queue = Array.isArray(stored) ? (stored as QueuedTurn[]).filter(item => typeof item?.threadId === 'string' && typeof item.text === 'string') : []
    // Another call may have loaded it meanwhile.
    const raced = this.queues.get(coordinatorSessionId)
    if (raced !== undefined) return raced
    this.queues.set(coordinatorSessionId, queue)
    return queue
  }

  private async saveQueue(coordinatorSessionId: string): Promise<void> {
    const queue = this.queues.get(coordinatorSessionId) ?? []
    await writeAtomic(this.file(coordinatorSessionId, 'queue.json'), `${JSON.stringify(queue)}\n`)
  }

  private isRunning(threadId: string): boolean {
    return this.rt.running(threadId) && !this.settled.has(threadId)
  }

  /**
   * Start what the queue can, oldest first: while fewer than the allowed
   * number of the coordinator's threads run, and (with `overlap: sequence`)
   * a turn whose paths overlap no running thread's. Runs inside the
   * coordinator's queue lock.
   */
  private async pump(coordinatorSessionId: string): Promise<void> {
    const queue = await this.queueOf(coordinatorSessionId)
    if (queue.length === 0 || this.rt.closed()) return
    const limit = await this.rt.maxRunning()
    const records = await this.rt.records(coordinatorSessionId).catch(() => [] as readonly SessionRecord[])
    const collaboration = taskCollaboration(records) ?? DEFAULT_COLLABORATION
    let changed = false
    for (const item of [...queue]) {
      // A thread whose turn has not quite ended takes it when that turn's end drains the queue.
      if (this.isRunning(item.threadId)) continue
      const infos = await this.list({ coordinatorSessionId })
      const running = infos.filter(thread => thread.status === 'running' && thread.threadId !== item.threadId)
      if (running.length >= limit) break
      if (collaboration.overlap === 'sequence' && running.length > 0) {
        const own = infos.find(thread => thread.threadId === item.threadId)?.owns
        if (running.some(thread => ownsOverlap(thread.owns, own))) {
          if (item.sequenceCounted !== true) {
            item.sequenceCounted = true
            changed = true
            await this.bump(coordinatorSessionId, 'sequence')
          }
          continue
        }
      }
      queue.splice(queue.indexOf(item), 1)
      await this.saveQueue(coordinatorSessionId)
      changed = false
      try {
        await this.launch(coordinatorSessionId, item)
      } catch (error) {
        this.rt.report(coordinatorSessionId, error)
      }
    }
    if (changed) await this.saveQueue(coordinatorSessionId)
  }

  private drain(coordinatorSessionId: string): Promise<void> {
    return this.serial(`queue:${coordinatorSessionId}`, () => this.pump(coordinatorSessionId))
  }

  /** Put a turn in the queue and start what can start; `true` when this turn still waits. */
  private enqueue(coordinatorSessionId: string, item: QueuedTurn): Promise<boolean> {
    return this.serial(`queue:${coordinatorSessionId}`, async () => {
      const queue = await this.queueOf(coordinatorSessionId)
      const waiting = queue.find(other => other.threadId === item.threadId)
      if (waiting === undefined) queue.push(item)
      else {
        // The thread's next turn already waits: what is sent now joins it.
        waiting.text = `${waiting.text}\n\n${item.text}`
        if (item.relay !== undefined) waiting.relay = [...new Set([...(waiting.relay ?? []), ...item.relay])]
        if (item.materialIds !== undefined) waiting.materialIds = [...new Set([...(waiting.materialIds ?? []), ...item.materialIds])]
      }
      await this.saveQueue(coordinatorSessionId)
      await this.pump(coordinatorSessionId)
      return queue.some(other => other.threadId === item.threadId)
    })
  }

  // -------------------------------------------------------------------------
  // starting threads
  // -------------------------------------------------------------------------

  /** The user's own words of the coordinator's task (up to its turn `turn`) that the thread has not been given. */
  private async unseenWords(coordinatorSessionId: string, turn: number, thread: readonly SessionRecord[], pending: readonly string[] = []): Promise<string[]> {
    const records = await this.rt.records(coordinatorSessionId).catch(() => [] as readonly SessionRecord[])
    const task = taskTurns(records, turn)
    if (task === undefined) return []
    return unseenOf(taskUserWords(records, task.turns).map(item => item.content), [...relayedTo(thread), ...pending])
  }

  async start(input: ThreadStartInput): Promise<ThreadInfo> {
    const requested = cleanTitle(input.title)
    if (input.task.trim() === '') throw new NexgentError('tool/invalid-input', '"task" must not be empty')
    const owns = cleanOwns(input.owns)
    const threads = await this.list({ coordinatorSessionId: input.coordinatorSessionId })
    if (threads.length >= THREAD_LIMITS.maxThreads) {
      throw new NexgentError('tool/denied', `this conversation already has ${threads.length} threads (at most ${THREAD_LIMITS.maxThreads}): give an existing thread the work with message_thread`, { details: { collab: 'limit' } })
    }
    const running = threads.filter(thread => thread.status === 'running' || thread.status === 'queued')
    // The user's plan: with `exact`, only the threads the user named, each once, with the user's words.
    const planned = this.loadPlan(input.coordinatorSessionId)
    const item = planned?.plan.threads.find(thread => titleKey(thread.title) === titleKey(requested))
    if (planned?.plan.exact === true) {
      const open = planned.plan.threads.filter(thread => !planned.started.has(titleKey(thread.title))).map(thread => `"${thread.title}"`)
      if (item === undefined || planned.started.has(titleKey(requested))) {
        throw new NexgentError('tool/denied', open.length === 0
          ? 'the user asked for exactly the threads already started for this task: give more work to one of them with message_thread, or ask the user'
          : `the user asked for exactly these threads, with these titles: ${open.join(', ')} (not started yet). Start only those; give other work to one of them with message_thread, or ask the user`)
      }
    }
    // A thread the plan names carries the user's own title.
    const title = item === undefined ? requested : item.title
    const records = await this.rt.records(input.coordinatorSessionId).catch(() => [] as readonly SessionRecord[])
    const collaboration = taskCollaboration(records) ?? DEFAULT_COLLABORATION
    const lines = [input.task.trim()]
    if (owns !== undefined) lines.push('', `Your part changes only these paths: ${owns.join(', ')}. Change nothing else; when another file must change, say so in your report.`)
    if (collaboration.mode === 'hybrid') {
      const others = running.map(thread => `"${thread.title}"${thread.owns === undefined ? '' : ` (${thread.owns.join(', ')})`}`)
      lines.push('', `You work beside the other threads of this task${others.length === 0 ? '' : ` (running now: ${others.join(', ')})`}. What they write to the collaboration log for you or about your paths reaches you on its own before each step. `
        + 'Claim the paths you will change (post_collab kind claim), post what others can build on (note, handoff) or what blocks you, message a thread directly when only it needs to know, and ask the coordinator when a decision is outside your part.')
    }
    // The user's own words: for this part (the plan) and from the coordinator's task, passed on word for word.
    const relay = [...new Set([...(item?.task === undefined || item.task.trim() === '' ? [] : [item.task.trim()]), ...(await this.unseenWords(input.coordinatorSessionId, input.turn, []))])]
    const threadId = await this.rt.create({ title, thread: { coordinatorSessionId: input.coordinatorSessionId, title, ...(item === undefined ? {} : { origin: 'plan' as const }), ...(owns === undefined ? {} : { owns }) } })
    if (planned !== undefined && item !== undefined) {
      planned.started.add(titleKey(title))
      this.savePlan(input.coordinatorSessionId, planned)
    }
    await this.enqueue(input.coordinatorSessionId, {
      threadId,
      title,
      name: threadRunName(title, threads.length + 1),
      text: lines.join('\n'),
      source: 'thread',
      turn: input.turn,
      ...(input.toolCallId === undefined ? {} : { toolCallId: input.toolCallId }),
      ...(input.materialIds === undefined || input.materialIds.length === 0 ? {} : { materialIds: [...input.materialIds] }),
      ...(relay.length === 0 ? {} : { relay }),
    })
    return this.info(threadId)
  }

  /**
   * Organization redo: the user starts a thread of the coordinator
   * themselves. Its first turn is the user's message (kept word for word),
   * runs in the background (it waits for a free slot like any thread's), and
   * wakes the coordinator when it ends so the coordinator can follow it up.
   * It is the user's, not part of the coordinator's organization (not
   * recorded there, not measured).
   */
  async startByUser(input: { readonly coordinatorSessionId: string; readonly title: string; readonly task: string; readonly materialIds?: readonly string[]; readonly owns?: readonly string[] }): Promise<ThreadInfo> {
    const title = cleanTitle(input.title)
    if (input.task.trim() === '') throw new NexgentError('tool/invalid-input', '"task" must not be empty')
    const owns = cleanOwns(input.owns)
    if (!(await this.rt.isCoordinator(input.coordinatorSessionId))) {
      const start = (await this.rt.records(input.coordinatorSessionId))[0]
      if (start?.type !== 'session.start' || start.thread !== undefined || start.parentSessionId !== undefined) throw new NexgentError('tool/invalid-input', 'threads belong to a top-level conversation')
    }
    const threads = await this.list({ coordinatorSessionId: input.coordinatorSessionId })
    if (threads.length >= THREAD_LIMITS.maxThreads) throw new NexgentError('tool/denied', `this conversation already has ${threads.length} threads (at most ${THREAD_LIMITS.maxThreads})`, { details: { collab: 'limit' } })
    const threadId = await this.rt.create({ title, thread: { coordinatorSessionId: input.coordinatorSessionId, title, origin: 'user', ...(owns === undefined ? {} : { owns }) } })
    await this.enqueue(input.coordinatorSessionId, {
      threadId,
      title,
      name: threadRunName(title, threads.length + 1),
      text: input.task,
      source: 'user',
      ...(input.materialIds === undefined || input.materialIds.length === 0 ? {} : { materialIds: [...input.materialIds] }),
    })
    return this.info(threadId)
  }

  private async userThreadEnded(coordinatorSessionId: string, threadId: string, title: string, turn: number): Promise<void> {
    if (this.rt.closed()) return
    const records = await this.rt.records(threadId).catch(() => [] as readonly SessionRecord[])
    const end = records.findLast(record => record.type === 'turn.end' && record.turn === turn)
    // A turn the user stopped stays stopped.
    if (end?.type === 'turn.end' && end.reason.kind === 'cancelled') return
    const { status } = threadStatusOf(records, false)
    const merge = this.rt.lastMerge(threadId)
    const events = await this.runEvents(coordinatorSessionId, threadId, merge)
    const note = threadWakeNote({ title, threadId, status, reply: replyOf(records, turn), ...(merge === undefined ? {} : { merge }), ...(events === undefined ? {} : { events }) })
    await this.rt.wake(coordinatorSessionId, `The user started thread "${title}" themselves; follow it up like your own threads (do not redo its work).\n${note}`)
  }

  async message(input: ThreadCaller & { readonly threadId: string; readonly text: string }): Promise<ThreadInfo> {
    if (input.text.trim() === '') throw new NexgentError('tool/invalid-input', '"text" must not be empty')
    const info = await this.own(input.coordinatorSessionId, input.threadId)
    const thread = await this.rt.records(input.threadId)
    const relay = await this.unseenWords(input.coordinatorSessionId, input.turn, thread)
    if (!(await this.rt.steer(input.threadId, input.text, relay.length === 0 ? undefined : relay))) {
      const index = (await this.rt.threadIds(input.coordinatorSessionId)).indexOf(input.threadId) + 1
      await this.enqueue(input.coordinatorSessionId, {
        threadId: input.threadId,
        title: info.title,
        name: threadRunName(info.title, index),
        text: input.text,
        source: 'thread',
        turn: input.turn,
        ...(input.toolCallId === undefined ? {} : { toolCallId: input.toolCallId }),
        ...(relay.length === 0 ? {} : { relay }),
      })
    }
    // The coordinator's message is in the log (it answers the thread's latest open ask), so the windows show the exchange.
    await this.append(input.coordinatorSessionId, entries => {
      const task = currentTaskEntries(entries)
      const ask = task.findLast(entry => entry.kind === 'ask' && entry.from === input.threadId)
      const answered = ask !== undefined && task.some(entry => entry.seq > ask.seq && (entry.re === ask.seq || (entry.kind === 'message' && entry.from === input.coordinatorSessionId && entry.to === input.threadId)))
      return { from: input.coordinatorSessionId, fromTitle: 'coordinator', kind: 'message', text: input.text.trim().slice(0, THREAD_LIMITS.peerChars), to: input.threadId, toTitle: info.title, ...(ask === undefined || answered ? {} : { re: ask.seq }) }
    }).catch(error => this.rt.report(input.coordinatorSessionId, error))
    return this.info(input.threadId)
  }

  /** D9: stop a thread's running turn, or take its waiting turn out of the queue; the stop is written to the log and does not wake the coordinator. */
  async stop(input: ThreadStopInput): Promise<ThreadInfo> {
    const info = await this.own(input.coordinatorSessionId, input.threadId)
    const reason = input.reason?.trim() ?? ''
    if (info.status !== 'running' && info.status !== 'queued') return info
    await this.append(input.coordinatorSessionId, () => ({
      from: info.threadId,
      fromTitle: info.title,
      kind: 'stopped',
      text: reason.slice(0, THREAD_LIMITS.peerChars),
      to: info.threadId,
      toTitle: info.title,
    })).catch(error => this.rt.report(input.coordinatorSessionId, error))
    // A turn waiting in the queue goes, also when the thread's current turn still runs (it would start when that one ends).
    await this.serial(`queue:${input.coordinatorSessionId}`, async () => {
      const queue = await this.queueOf(input.coordinatorSessionId)
      const at = queue.findIndex(item => item.threadId === input.threadId)
      if (at >= 0) queue.splice(at, 1)
      await this.saveQueue(input.coordinatorSessionId)
    })
    if (info.status === 'running') await this.rt.cancel(input.threadId)
    return this.info(input.threadId)
  }

  async read(input: { readonly coordinatorSessionId: string; readonly threadId: string; readonly steps?: boolean }): Promise<ThreadView> {
    await this.own(input.coordinatorSessionId, input.threadId)
    const records = await this.rt.records(input.threadId)
    const info = await this.info(input.threadId)
    const turn = lastTurn(records)
    const reply = replyOf(records, turn)
    const merge = this.rt.lastMerge(input.threadId) ?? (await this.recordedMerge(input.coordinatorSessionId, input.threadId, turn))
    let usage: LLMUsage | undefined
    for (const record of records) if (record.type === 'assistant.message' && record.turn === turn) usage = usage === undefined ? record.usage : addUsage(usage, record.usage)
    return {
      ...info,
      reply: reply.length > THREAD_LIMITS.replyChars ? reply.slice(0, THREAD_LIMITS.replyChars) : reply,
      ...(reply.length > THREAD_LIMITS.replyChars ? { cut: reply.length - THREAD_LIMITS.replyChars } : {}),
      applied: [...(merge?.applied ?? [])],
      conflicts: (merge?.conflicts ?? []).map(conflict => ({ path: conflict.path, ...(conflict.copy === undefined ? {} : { copy: conflict.copy }) })),
      ...(usage === undefined ? {} : { usage }),
      ...(input.steps === true ? { trajectory: threadTrajectory(records, turn) } : {}),
    }
  }

  async list(input: { readonly coordinatorSessionId: string }): Promise<readonly ThreadInfo[]> {
    const out: ThreadInfo[] = []
    for (const threadId of await this.rt.threadIds(input.coordinatorSessionId)) {
      try {
        out.push(await this.info(threadId))
      } catch {
        // an unreadable thread is left out; opening it reports why
      }
    }
    return out
  }

  private async info(threadId: string): Promise<ThreadInfo> {
    const base = threadInfoOf(threadId, await this.rt.records(threadId), this.isRunning(threadId), this.rt.needsApproval(threadId))
    const queued = base.status !== 'running' && (await this.queueOf(base.coordinatorSessionId)).some(item => item.threadId === threadId)
    return { ...base, ...(queued ? { status: 'queued' as const } : {}), ...((await this.rt.isolated(threadId)) === false ? { isolated: false as const } : {}) }
  }

  // -------------------------------------------------------------------------
  // coordinator step three: the coordinator's notes and prompt
  // -------------------------------------------------------------------------

  isCoordinator(sessionId: string): Promise<boolean> {
    return this.rt.isCoordinator(sessionId)
  }

  /** The coordinator conversation a session's collaboration log belongs to (a thread's coordinator, or the coordinator itself); `undefined` for any other session. */
  async coordinatorOf(sessionId: string): Promise<string | undefined> {
    const origin = await this.origin(sessionId)
    if (origin !== undefined) return origin.coordinatorSessionId
    return (await this.rt.isCoordinator(sessionId)) ? sessionId : undefined
  }

  /** The project notes (empty when there are none yet). */
  async readNotes(): Promise<string> {
    try {
      return await readFile(this.rt.notesFile(), 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return ''
      throw error
    }
  }

  /** Replace the project notes (written to a temporary file, then renamed). */
  async writeNotes(text: string): Promise<void> {
    if (text.length > THREAD_LIMITS.notesChars) throw new NexgentError('tool/invalid-input', `the notes are ${text.length} characters (at most ${THREAD_LIMITS.notesChars}): keep what stays true across tasks and drop the rest`)
    const file = this.rt.notesFile()
    await mkdir(dirname(file), { recursive: true })
    const temporary = `${file}.${process.pid}.${Date.now()}.tmp`
    await writeFile(temporary, text.trim() === '' ? '' : `${text.trim()}\n`, 'utf8')
    await rename(temporary, file)
  }

  /** A thread of this coordinator, or `session/not-found`. */
  private async own(coordinatorSessionId: string, threadId: string): Promise<ThreadInfo> {
    let info: ThreadInfo
    try {
      info = await this.info(threadId)
    } catch {
      throw new NexgentError('session/not-found', `no thread ${threadId} in this conversation (list_threads lists them)`)
    }
    if (info.coordinatorSessionId !== coordinatorSessionId) throw new NexgentError('session/not-found', `no thread ${threadId} in this conversation (list_threads lists them)`)
    return info
  }

  /** The merge of a thread run the coordinator recorded, for a thread whose last turn ended in an earlier process. */
  private async recordedMerge(coordinatorSessionId: string, threadId: string, turn: number): Promise<WorkdirMerge | undefined> {
    const records = await this.rt.records(coordinatorSessionId).catch(() => [] as readonly SessionRecord[])
    const end = records.findLast(record => record.type === 'subagent.end' && record.childSessionId === threadId && record.childTurn === turn)
    return end?.type === 'subagent.end' ? end.result.merge : undefined
  }

  /** Start a queued turn: the thread's turn, and (for the coordinator's own runs) its record in the coordinator. */
  private async launch(coordinatorSessionId: string, item: QueuedTurn): Promise<void> {
    this.settled.delete(item.threadId)
    // The user may have spoken while the turn waited: it starts with every word of the task the thread has not been given.
    let relay = item.relay
    if (item.turn !== undefined) {
      const thread = await this.rt.records(item.threadId).catch(() => [] as readonly SessionRecord[])
      const more = await this.unseenWords(coordinatorSessionId, item.turn, thread, item.relay)
      if (more.length > 0) relay = [...(item.relay ?? []), ...more]
    }
    const started = await this.rt.startTurn(item.threadId, item.text, item.materialIds, item.source, relay)
    if (item.turn === undefined) {
      void started.done
        .then(() => this.userThreadEnded(coordinatorSessionId, item.threadId, item.title, started.turn))
        .catch(error => this.rt.report(coordinatorSessionId, error))
      return
    }
    const caller: ThreadCaller = { coordinatorSessionId, turn: item.turn, ...(item.toolCallId === undefined ? {} : { toolCallId: item.toolCallId }) }
    const recorded = await this.rt.append(coordinatorSessionId, {
      type: 'subagent.start',
      turn: item.turn,
      ...(item.toolCallId === undefined ? {} : { toolCallId: item.toolCallId }),
      childSessionId: item.threadId,
      childTurn: started.turn,
      name: item.name,
      executionForm: 'thread',
      task: item.text.slice(0, 500),
      ...(item.materialIds === undefined || item.materialIds.length === 0 ? {} : { materialIds: [...item.materialIds] }),
    }).then(() => true, (error: unknown) => {
      this.rt.report(coordinatorSessionId, error)
      return false
    })
    void started.done
      .then(result => ({ result }), (error: unknown) => ({ error }))
      .then(settled => this.ended(caller, item.threadId, item.title, started.turn, item.role === 'check', settled, recorded))
      .catch(error => this.rt.report(coordinatorSessionId, error))
  }

  private async ended(
    caller: ThreadCaller,
    threadId: string,
    title: string,
    childTurn: number,
    isCheck: boolean,
    settled: { readonly result: TurnResult } | { readonly error: unknown },
    recorded: boolean,
  ): Promise<void> {
    if (this.rt.closed()) return
    const records = await this.rt.records(threadId).catch(() => [] as readonly SessionRecord[])
    const facts = turnFacts(records, childTurn)
    const result: MemberResult = 'result' in settled
      ? toMemberResult(settled.result, facts)
      : { status: 'failed', text: '', deliverables: facts.deliverables, usage: ZERO_USAGE, requestCount: facts.requestCount, error: toErrorInfo(settled.error) }
    if (recorded) {
      await this.rt.ensureOpen(caller.coordinatorSessionId)
      const coordinator = await this.rt.records(caller.coordinatorSessionId).catch(() => [] as readonly SessionRecord[])
      // Recovery may already have closed the run (the coordinator was reopened meanwhile).
      const closed = coordinator.some(record => record.type === 'subagent.end' && record.childSessionId === threadId && record.childTurn === childTurn)
      if (!closed) await this.rt.append(caller.coordinatorSessionId, { type: 'subagent.end', turn: caller.turn, childSessionId: threadId, childTurn, result })
    }
    const cause = 'result' in settled && settled.result.reason.kind === 'cancelled' ? settled.result.reason.cause : undefined
    if (cause === 'shutdown') return
    if (this.rt.closed()) return
    if (isCheck) {
      const report = parseMemberReport(result.text)
      if (result.status !== 'completed' || notNone(report.notDone) || notNone(report.blockers)) await this.bump(caller.coordinatorSessionId, 'checkFailed')
    }
    // A thread the user stopped, or one stopped at the cost cap, stays stopped: the coordinator is not woken to pick it up again.
    if (cause !== 'user' && cause !== 'cost-cap') {
      const { status } = threadStatusOf(records, false)
      const events = await this.runEvents(caller.coordinatorSessionId, threadId, result.merge)
      const note = threadWakeNote({
        title,
        threadId,
        status,
        reply: result.text,
        ...(result.merge === undefined ? {} : { merge: result.merge }),
        ...(events === undefined ? {} : { events }),
      })
      const extra: string[] = []
      const merged = (await this.collab.entries(caller.coordinatorSessionId).catch(() => [] as readonly CollabEntry[])).findLast(entry => entry.kind === 'merged' && entry.from === threadId && entry.turn === childTurn)
      if (merged !== undefined) extra.push(`(collaboration log #${merged.seq}: what this turn merged into the project)`)
      if (isCheck) extra.push('This was the final whole-project check the host ran after the threads merged; its report above says what it found and fixed.')
      else {
        const due = await this.checkDue(caller.coordinatorSessionId)
        if (due !== undefined) {
          extra.push(`All threads have ended, and the changes of ${due.merged} threads are merged into the project; each thread checked only its own copy. The host starts one final check of the whole project as soon as you end your turn (${due.kind === 'merged' ? `by "${due.title}", the thread that merged last` : `by a new thread "${FINAL_CHECK_TITLE}"`}): do not start one yourself, and report the task as done only after its report.`)
        }
      }
      await this.rt.wake(caller.coordinatorSessionId, [note, ...extra].join('\n'))
    }
    if (recorded) await this.measure(caller.coordinatorSessionId, caller.turn)
    await this.maybeCheck(caller.coordinatorSessionId, false)
  }

  /**
   * D3: the project opened again under this coordinator: threads left in the
   * queue start (as slots allow), and so do the coordinator's threads whose
   * turn the last process cut short (shutdown, or a crash): each gets a new
   * turn that carries its original task and says it was interrupted.
   */
  async resume(coordinatorSessionId: string): Promise<void> {
    if (this.resumed.has(coordinatorSessionId) || this.rt.closed()) return
    this.resumed.add(coordinatorSessionId)
    const records = await this.rt.records(coordinatorSessionId).catch(() => [] as readonly SessionRecord[])
    const turn = lastTurn(records)
    const queue = await this.queueOf(coordinatorSessionId)
    for (const threadId of await this.rt.threadIds(coordinatorSessionId)) {
      if (this.isRunning(threadId) || queue.some(item => item.threadId === threadId)) continue
      const thread = await this.rt.records(threadId).catch(() => [] as readonly SessionRecord[])
      const start = thread[0]
      if (start?.type !== 'session.start' || start.thread?.origin === 'user') continue
      const childTurn = lastTurn(thread)
      if (childTurn === 0) continue
      const end = thread.findLast(record => record.type === 'turn.end' && record.turn === childTurn)
      // A crash leaves the turn without a `turn.end`; a stop by shutdown or interruption wrote one.
      if (end !== undefined && !(end.type === 'turn.end' && (end.reason.kind === 'interrupted' || (end.reason.kind === 'cancelled' && end.reason.cause === 'shutdown')))) continue
      const run = records.findLast(record => record.type === 'subagent.start' && record.childSessionId === threadId && record.childTurn === childTurn)
      if (run?.type !== 'subagent.start') continue
      // The thread's own record holds the whole task (the coordinator's keeps 500 characters); the words relayed with it are already in the thread.
      const original = thread.find(record => record.type === 'user.message' && record.turn === childTurn && record.source !== 'relay' && record.source !== 'inject')
      const task = original?.type === 'user.message' ? original.content : run.task
      const index = (await this.rt.threadIds(coordinatorSessionId)).indexOf(threadId) + 1
      await this.enqueue(coordinatorSessionId, {
        threadId,
        title: start.thread!.title,
        name: threadRunName(start.thread!.title, index),
        text: `Your last turn was interrupted when the program stopped. Continue where it left off and finish it. The task of that turn was:\n${task}`,
        source: 'thread',
        turn,
        ...(run.task.startsWith(FINAL_CHECK_TASK.slice(0, 80)) ? { role: 'check' as const } : {}),
      })
    }
    await this.drain(coordinatorSessionId)
  }

  /**
   * The SDK tells the host that a coordinator turn ended (a turn the user
   * started or a thread woke): the user's words that joined the turn reach the
   * running threads of the task that have not been given them (D5), threads
   * waiting in the queue start when a slot is free, and the final check of the
   * whole project starts once every thread ended.
   */
  async coordinatorTurnEnded(coordinatorSessionId: string, turn: number): Promise<void> {
    if (this.rt.closed()) return
    await this.relayMidTurn(coordinatorSessionId, turn).catch(error => this.rt.report(coordinatorSessionId, error))
    await this.drain(coordinatorSessionId).catch(error => this.rt.report(coordinatorSessionId, error))
    await this.maybeCheck(coordinatorSessionId, true)
    await this.noteSoloTask(coordinatorSessionId, turn).catch(error => this.rt.report(coordinatorSessionId, error))
  }

  private async relayMidTurn(coordinatorSessionId: string, turn: number): Promise<void> {
    const records = await this.rt.records(coordinatorSessionId).catch(() => [] as readonly SessionRecord[])
    const task = taskTurns(records, turn)
    if (task === undefined) return
    const words = taskUserWords(records, task.turns)
    const mid = new Set(words.filter(item => item.mid && item.turn === turn).map(item => item.content))
    if (mid.size === 0) return
    const ids = new Set(threadRuns(records, task.turns).map(run => run.childSessionId))
    for (const threadId of ids) {
      if (!this.isRunning(threadId)) continue
      const given = relayedTo(await this.rt.records(threadId).catch(() => [] as readonly SessionRecord[]))
      const unseen = unseenOf(words.map(item => item.content), given).filter(content => mid.has(content))
      if (unseen.length === 0) continue
      await this.rt.steer(threadId, 'The user added the following in the coordinator conversation while you work (their own words, kept as they wrote them); take it into account.', unseen)
    }
  }

  /**
   * The SDK tells the host that a thread's turn ended (whoever started it,
   * whether or not it was stopped): the host writes what the turn brought into
   * the project (`merged`) and ends the claims the thread made (`release`),
   * then starts the turns that were waiting for a slot.
   */
  async turnEnded(sessionId: string, result: TurnResult): Promise<void> {
    if (this.rt.closed()) return
    const origin = await this.origin(sessionId)
    if (origin === undefined) return
    const coordinatorSessionId = origin.coordinatorSessionId
    this.settled.add(sessionId)
    await this.noteMerged(coordinatorSessionId, sessionId, origin.title, result.merge, result.turn).catch(error => this.rt.report(coordinatorSessionId, error))
    await this.noteRelease(coordinatorSessionId, sessionId, origin.title, result.turn).catch(error => this.rt.report(coordinatorSessionId, error))
    // The queue starts after the turn's own promise settled: this call is part of what that promise waits for, so a queued turn of this thread cannot start inside it.
    void this.rt.turnDone(sessionId)
      .then(() => undefined, () => undefined)
      .then(() => {
        this.settled.delete(sessionId)
        return this.drain(coordinatorSessionId)
      })
      .catch(error => this.rt.report(coordinatorSessionId, error))
  }

  /**
   * Organization redo: what the host saw between a thread's run and the
   * task's other threads: files outside its `owns`, files another thread of
   * the task also brought in, and messages waiting for threads not running.
   */
  private async runEvents(coordinatorSessionId: string, threadId: string, merge: WorkdirMerge | undefined): Promise<ThreadRunEvents | undefined> {
    const applied = merge === undefined || merge.held === true ? [] : merge.applied.filter(path => !merge.conflicts.some(conflict => conflict.path === path))
    const info = await this.info(threadId).catch(() => undefined)
    const outside = info?.owns === undefined ? [] : applied.filter(path => !withinOwns(path, info.owns!))
    const records = await this.rt.records(coordinatorSessionId).catch(() => [] as readonly SessionRecord[])
    const titles = new Map<string, string>()
    for (const id of await this.rt.threadIds(coordinatorSessionId).catch(() => [] as readonly string[])) {
      const other = await this.info(id).catch(() => undefined)
      if (other !== undefined) titles.set(id, other.title)
    }
    const overlap: { path: string; thread: string }[] = []
    for (const run of taskThreadRuns(records)) {
      if (run.threadId === threadId) continue
      for (const path of run.applied) if (applied.includes(path) && !overlap.some(item => item.path === path)) overlap.push({ path, thread: titles.get(run.threadId) ?? run.name })
    }
    // Messages in the log for a thread that is not running and has not read them yet.
    const waiting: { from: string; to: string }[] = []
    const log = await this.collab.entries(coordinatorSessionId).catch(() => [] as readonly CollabEntry[])
    for (const entry of currentTaskEntries(log)) {
      if (entry.kind !== 'message' || entry.to === undefined || !titles.has(entry.to) || this.isRunning(entry.to)) continue
      const cursor = Math.max((await this.collab.cursor(coordinatorSessionId, entry.to).catch(() => undefined)) ?? 0, taskStartSeq(log))
      const to = titles.get(entry.to)!
      if (entry.seq > cursor && !waiting.some(item => item.from === entry.fromTitle && item.to === to)) waiting.push({ from: entry.fromTitle, to })
    }
    if (outside.length === 0 && overlap.length === 0 && waiting.length === 0) return undefined
    return { ...(outside.length === 0 ? {} : { outside }), ...(overlap.length === 0 ? {} : { overlap }), ...(waiting.length === 0 ? {} : { waiting }) }
  }

  // -------------------------------------------------------------------------
  // the final check of the whole project
  // -------------------------------------------------------------------------

  /**
   * The final whole-project check, when it is due: the task's thread runs
   * have all ended (none waits in the queue, none of the coordinator's threads
   * runs), two or more threads merged files, and no check ran in this task.
   */
  private async checkDue(coordinatorSessionId: string): Promise<{ readonly kind: 'merged' | 'separate'; readonly merged: number; readonly threadId: string; readonly title: string } | undefined> {
    const records = await this.rt.records(coordinatorSessionId).catch(() => [] as readonly SessionRecord[])
    const task = taskTurns(records, lastTurn(records))
    if (task === undefined) return undefined
    const runs = threadRuns(records, task.turns)
    if (runs.length === 0 || openThreadRuns(records, task.turns) > 0) return undefined
    if (runs.some(run => records.some(record => record.type === 'subagent.start' && record.childSessionId === run.childSessionId && record.childTurn === run.childTurn && record.task.startsWith(FINAL_CHECK_TASK.slice(0, 80))))) return undefined
    if ((await this.queueOf(coordinatorSessionId)).length > 0) return undefined
    const threads = await this.list({ coordinatorSessionId })
    if (threads.some(thread => thread.status === 'running' || thread.status === 'queued')) return undefined
    const merged = await this.mergedThreads(coordinatorSessionId)
    if (merged === undefined || merged < 2) return undefined
    const since = records.findLast(record => record.type === 'user.message' && record.source === 'user')?.seq ?? 0
    const ids = new Set(runs.map(run => run.childSessionId))
    const last = records.findLast(record => record.type === 'subagent.end' && record.seq > since && ids.has(record.childSessionId) && (record.result.merge?.applied.length ?? 0) > 0)
    if (last?.type !== 'subagent.end') return undefined
    const mode = (taskCollaboration(records) ?? DEFAULT_COLLABORATION).check ?? 'merged'
    const lastThread = threads.find(thread => thread.threadId === last.childSessionId)
    if (mode === 'merged' && lastThread !== undefined) return { kind: 'merged', merged, threadId: lastThread.threadId, title: lastThread.title }
    if (threads.length >= THREAD_LIMITS.maxThreads) return lastThread === undefined ? undefined : { kind: 'merged', merged, threadId: lastThread.threadId, title: lastThread.title }
    return { kind: 'separate', merged, threadId: '', title: FINAL_CHECK_TITLE }
  }

  /** Start the final check when it is due (`coordinatorEnding`: called as the coordinator's turn ends, so its running flag does not count). */
  private maybeCheck(coordinatorSessionId: string, coordinatorEnding: boolean): Promise<void> {
    return this.serial(`check:${coordinatorSessionId}`, async () => {
      if (this.rt.closed() || (!coordinatorEnding && this.rt.running(coordinatorSessionId))) return
      const due = await this.checkDue(coordinatorSessionId)
      if (due === undefined) return
      const records = await this.rt.records(coordinatorSessionId)
      const turn = lastTurn(records)
      let threadId = due.threadId
      let title = due.title
      let name = `${CHECK_NAME_PREFIX}-${threadRunName(title, 0)}`.slice(0, 32).replace(/-+$/, '')
      if (due.kind === 'separate') {
        title = FINAL_CHECK_TITLE
        threadId = await this.rt.create({ title, thread: { coordinatorSessionId, title } })
        name = CHECK_NAME_PREFIX
        await this.bump(coordinatorSessionId, 'separate')
      }
      await this.enqueue(coordinatorSessionId, { threadId, title, name, text: FINAL_CHECK_TASK, source: 'thread', turn, role: 'check' })
    }).catch(error => this.rt.report(coordinatorSessionId, error))
  }

  // -------------------------------------------------------------------------
  // organization redo: the collaboration log (`ThreadPeers`) and its delivery
  // -------------------------------------------------------------------------

  /** A session's thread origin (`undefined`: not a thread), cached. */
  private async origin(sessionId: string): Promise<ThreadOrigin | undefined> {
    const known = this.origins.get(sessionId)
    if (known !== undefined) return known ?? undefined
    let origin: ThreadOrigin | null = null
    try {
      const start = (await this.rt.records(sessionId))[0]
      if (start?.type === 'session.start' && start.thread !== undefined) origin = start.thread
    } catch {
      // not a root session of this project (a member, or none): never a thread
    }
    this.origins.set(sessionId, origin)
    return origin ?? undefined
  }

  private append(coordinatorSessionId: string, make: Parameters<CollabLog['append']>[1]): Promise<CollabEntry> {
    return this.collab.append(coordinatorSessionId, make)
  }

  /** Lines added per file the turn added (a modified or deleted file has no pre-turn copy to compare with, so it has no stat); best effort. */
  private async mergedStat(threadId: string, turn: number, paths: readonly string[]): Promise<{ path: string; added: number; removed: number }[] | undefined> {
    try {
      const records = await this.rt.records(threadId)
      const files = records.findLast(record => record.type === 'turn.files' && record.turn === turn)
      if (files?.type !== 'turn.files') return undefined
      const out: { path: string; added: number; removed: number }[] = []
      for (const change of files.changes) {
        if (change.change !== 'added' || !paths.includes(change.path)) continue
        const text = await this.readProjectFile(change.path, READ_MERGED_BYTES).catch(() => undefined)
        if (text !== undefined) out.push({ path: change.path, added: text.text === '' ? 0 : text.text.split('\n').length - (text.text.endsWith('\n') ? 1 : 0), removed: 0 })
      }
      return out.length === 0 ? undefined : out
    } catch {
      return undefined
    }
  }

  /** The host's `merged` entry for a thread turn that brought files into the project (a held merge brought nothing). */
  private async noteMerged(coordinatorSessionId: string, threadId: string, title: string, merge: WorkdirMerge | undefined, turn: number): Promise<void> {
    if (merge === undefined || merge.held === true) return
    const conflicts = merge.conflicts.map(conflict => conflict.path)
    const applied = merge.applied.filter(path => !conflicts.includes(path))
    if (applied.length === 0 && conflicts.length === 0) return
    const text = conflicts.length === 0 ? '' : `in conflict, kept as the project has it: ${conflicts.join(', ')}`
    const stat = await this.mergedStat(threadId, turn, applied)
    await this.append(coordinatorSessionId, () => ({ from: threadId, fromTitle: title, kind: 'merged', text, paths: applied, turn, ...(stat === undefined ? {} : { stat }) }))
  }

  /** The host's `release` entry: a thread's turn ended, so the claims it made no longer stand (written when it has claims since its last release). */
  private async noteRelease(coordinatorSessionId: string, threadId: string, title: string, turn: number): Promise<void> {
    const claimsOf = (entries: readonly CollabEntry[]) => {
      const mine = currentTaskEntries(entries).filter(entry => entry.from === threadId)
      const lastRelease = mine.findLast(entry => entry.kind === 'release')?.seq ?? 0
      return mine.filter(entry => entry.kind === 'claim' && entry.seq > lastRelease)
    }
    if (claimsOf(await this.collab.entries(coordinatorSessionId)).length === 0) return
    await this.append(coordinatorSessionId, entries => {
      const claims = claimsOf(entries)
      if (claims.length === 0) throw new NothingToRelease()
      return { from: threadId, fromTitle: title, kind: 'release', text: '', paths: [...new Set(claims.flatMap(entry => entry.paths ?? []))], turn }
    }).catch(error => {
      if (!(error instanceof NothingToRelease)) throw error
    })
  }

  /** A thread of the project, or `tool/denied`. */
  private async thread(threadId: string): Promise<ThreadInfo> {
    try {
      return await this.info(threadId)
    } catch {
      throw new NexgentError('tool/denied', 'only threads and their coordinator use the collaboration log')
    }
  }

  async post(input: { readonly sessionId: string; readonly kind: CollabPostKind; readonly text: string; readonly paths?: readonly string[]; readonly waitsFor?: string; readonly re?: number }): Promise<CollabEntry> {
    if (!(COLLAB_POST_KINDS as readonly string[]).includes(input.kind)) throw new NexgentError('tool/invalid-input', `"kind" must be one of ${COLLAB_POST_KINDS.join(', ')}`)
    const text = input.text.trim()
    if (text === '' || text.length > THREAD_LIMITS.peerChars) throw new NexgentError('tool/invalid-input', `"text" must be 1 to ${THREAD_LIMITS.peerChars} characters`)
    const paths = cleanOwns(input.paths)
    const re = input.re === undefined ? {} : { re: input.re }
    if (await this.rt.isCoordinator(input.sessionId)) {
      if (input.kind !== 'note') throw new NexgentError('tool/denied', 'the coordinator posts notes (kind note) for its threads; claims, handoffs and blockers are the threads\'')
      return this.append(input.sessionId, () => ({ from: input.sessionId, fromTitle: 'coordinator', kind: 'note', text, ...(paths === undefined ? {} : { paths }), ...re }))
    }
    const info = await this.thread(input.sessionId)
    if (input.kind === 'claim' && paths === undefined) throw new NexgentError('tool/invalid-input', 'a claim names the paths you will change ("paths")')
    const coordinatorSessionId = info.coordinatorSessionId
    // A blocker may name the thread it waits for (its title or id).
    let waitsFor: ThreadInfo | undefined
    const statuses = new Map<string, ThreadStatus>()
    for (const other of await this.list({ coordinatorSessionId })) statuses.set(other.threadId, other.status)
    if (input.waitsFor !== undefined && input.waitsFor.trim() !== '') {
      if (input.kind !== 'blocker') throw new NexgentError('tool/invalid-input', '"waitsFor" belongs to a blocker')
      const wanted = input.waitsFor.trim()
      const others = (await this.list({ coordinatorSessionId })).filter(thread => thread.threadId !== info.threadId)
      waitsFor = others.find(thread => thread.threadId === wanted) ?? others.find(thread => titleKey(thread.title) === titleKey(wanted))
      if (waitsFor === undefined) throw new NexgentError('tool/invalid-input', `no other thread "${wanted}"${others.length === 0 ? '' : ` (threads: ${others.map(thread => `"${thread.title}"`).join(', ')})`}`)
    }
    const working = (id: string) => statuses.get(id) === 'running' || statuses.get(id) === 'queued'
    return this.append(coordinatorSessionId, async entries => {
      if (input.kind === 'claim') {
        // A claim of the current task stands while its thread works (running, or waiting for an answer), until the thread's turn ends (`release`).
        const task = currentTaskEntries(entries)
        for (const entry of task) {
          if (entry.kind !== 'claim' || entry.from === input.sessionId) continue
          if (task.some(other => other.kind === 'release' && other.from === entry.from && other.seq > entry.seq)) continue
          const status = statuses.get(entry.from)
          if (status !== 'running' && status !== 'waiting') continue
          if (ownsOverlap(entry.paths, paths)) {
            throw new NexgentError('tool/denied', `"${entry.fromTitle}" has claimed ${entry.paths?.join(', ') ?? 'these paths'} and is still working on them: take other paths, or message_peer it to agree who changes what`, { details: { collab: 'claim' } })
          }
        }
      }
      if (input.kind === 'blocker' && waitsFor !== undefined) {
        const chain = waitCycle(entries, info.threadId, waitsFor.threadId, working)
        if (chain !== undefined) {
          const names = [info.title, ...chain.map(id => entries.findLast(entry => entry.from === id)?.fromTitle ?? id)]
          throw new NexgentError('tool/denied', `waiting for "${waitsFor.title}" would close a circle of threads waiting for each other (${names.map(name => `"${name}"`).join(' -> ')}): ask the coordinator (ask_coordinator) to decide instead`, { details: { collab: 'cycle' } })
        }
      }
      return { from: input.sessionId, fromTitle: info.title, kind: input.kind, text, ...(paths === undefined ? {} : { paths }), ...(waitsFor === undefined ? {} : { waitsFor: waitsFor.threadId }), ...re }
    })
  }

  async log(input: { readonly sessionId: string; readonly all?: boolean }): Promise<readonly CollabEntry[]> {
    const origin = await this.origin(input.sessionId)
    const entries = await this.collab.entries(origin?.coordinatorSessionId ?? input.sessionId, input.all === true)
    return (input.all === true ? entries : currentTaskEntries(entries)).slice(-THREAD_LIMITS.collabShown)
  }

  /**
   * What of the coordinator's collaboration log concerns a session, for its
   * conversation: a thread: what it wrote, what was written to it, every note
   * and blocker, and the merges, handoffs and claims about its paths; the
   * coordinator: everything its threads wrote and the host wrote about them.
   * Every task, oldest first.
   */
  async collabFor(sessionId: string): Promise<readonly CollabEntry[]> {
    const origin = await this.origin(sessionId)
    if (origin === undefined) {
      if (!(await this.rt.isCoordinator(sessionId))) return []
      const entries = await this.collab.entries(sessionId, true)
      return entries.filter(entry => entry.kind !== 'task' && entry.from !== sessionId)
    }
    const entries = await this.collab.entries(origin.coordinatorSessionId, true)
    const mine = readerPaths(entries, { sessionId, ...(origin.owns === undefined ? {} : { owns: origin.owns }) })
    return entries.filter(entry => {
      if (entry.from === sessionId || entry.to === sessionId) return entry.kind !== 'task'
      switch (entry.kind) {
        case 'note':
        case 'blocker': return true
        case 'merged':
        case 'handoff':
        case 'claim': return ownsOverlap(entry.paths, mine)
        default: return false
      }
    })
  }

  async messagePeer(input: { readonly threadId: string; readonly to: string; readonly text: string; readonly re?: number }): Promise<{ readonly title: string; readonly running: boolean; readonly woken?: boolean; readonly note?: string }> {
    const from = await this.thread(input.threadId)
    const text = input.text.trim()
    if (text === '' || text.length > THREAD_LIMITS.peerChars) throw new NexgentError('tool/invalid-input', `"text" must be 1 to ${THREAD_LIMITS.peerChars} characters`)
    const others = (await this.list({ coordinatorSessionId: from.coordinatorSessionId })).filter(thread => thread.threadId !== from.threadId)
    const wanted = input.to.trim()
    const to = others.find(thread => thread.threadId === wanted) ?? others.find(thread => titleKey(thread.title) === titleKey(wanted))
    if (to === undefined) throw new NexgentError('tool/invalid-input', `no other thread "${wanted}"${others.length === 0 ? '' : ` (threads: ${others.map(thread => `"${thread.title}"`).join(', ')})`}`)
    if (to.status === 'stopped' || to.status === 'failed') throw new NexgentError('tool/denied', `"${to.title}" has ${to.status}: tell the coordinator instead (ask_coordinator)`)
    const coordinatorSessionId = from.coordinatorSessionId
    const entry = await this.append(coordinatorSessionId, entries => {
      // Within the current task: the same text once, and at most maxPeerMessages to one thread.
      const sent = currentTaskEntries(entries).filter(item => item.kind === 'message' && item.from === from.threadId && item.to === to.threadId)
      if (sent.some(item => item.text === text)) throw new NexgentError('tool/denied', `you already sent "${to.title}" this message`, { details: { collab: 'limit' } })
      if (sent.length >= THREAD_LIMITS.maxPeerMessages) throw new NexgentError('tool/denied', `you sent "${to.title}" ${sent.length} messages in this task (at most ${THREAD_LIMITS.maxPeerMessages}): post a note to the log, or ask the coordinator`, { details: { collab: 'limit' } })
      // A message passed on too far stops: a reply to a reply goes through the coordinator.
      const hops = hopsOf(entries, input.re)
      if (hops > THREAD_LIMITS.maxHops) throw new NexgentError('tool/denied', `this would be the ${hops}th message passed on (at most ${THREAD_LIMITS.maxHops}): ask the coordinator (ask_coordinator) instead of going on`, { details: { collab: 'hops' } })
      return { from: from.threadId, fromTitle: from.title, kind: 'message', text, to: to.threadId, toTitle: to.title, hops, ...(input.re === undefined ? {} : { re: input.re }) }
    })
    // `wake: named`: a message to an idle thread starts its next turn (a few times per task).
    const records = await this.rt.records(coordinatorSessionId).catch(() => [] as readonly SessionRecord[])
    const collaboration = taskCollaboration(records) ?? DEFAULT_COLLABORATION
    let woken = false
    let note: string | undefined
    if (collaboration.wake === 'named' && (to.status === 'done' || to.status === 'waiting')) {
      const used = (await this.taskCounters(coordinatorSessionId, taskKeyOf(records))).named
      if (used >= THREAD_LIMITS.maxWakes) {
        note = `"${to.title}" is idle and this task already woke idle threads ${used} times (at most ${THREAD_LIMITS.maxWakes}): the message waits for its next turn; ask the coordinator (ask_coordinator) if it must be read now`
      } else {
        await this.bump(coordinatorSessionId, 'named')
        const index = (await this.rt.threadIds(coordinatorSessionId)).indexOf(to.threadId) + 1
        await this.enqueue(coordinatorSessionId, {
          threadId: to.threadId,
          title: to.title,
          name: threadRunName(to.title, index),
          text: `Thread "${from.title}" left you a message (collaboration log #${entry.seq}); it reaches you with this turn. Answer or act on it, and report as usual.`,
          source: 'thread',
          turn: lastTurn(records),
        })
        woken = true
      }
    }
    return { title: to.title, running: this.isRunning(to.threadId), ...(woken ? { woken: true as const } : {}), ...(note === undefined ? {} : { note }) }
  }

  async ask(input: { readonly threadId: string; readonly text: string }): Promise<void> {
    const from = await this.thread(input.threadId)
    const text = input.text.trim()
    if (text === '' || text.length > THREAD_LIMITS.peerChars) throw new NexgentError('tool/invalid-input', `"text" must be 1 to ${THREAD_LIMITS.peerChars} characters`)
    // The allowance is per thread and turn (a thread the user started counts too).
    const turn = lastTurn(await this.rt.records(input.threadId))
    const held = this.asked.get(input.threadId)
    const asked = held?.turn === turn ? held.count : 0
    if (asked >= THREAD_LIMITS.maxAsks) throw new NexgentError('tool/denied', `you asked the coordinator ${asked} times in this turn (at most ${THREAD_LIMITS.maxAsks}): put the rest in your report`, { details: { collab: 'limit' } })
    this.asked.set(input.threadId, { turn, count: asked + 1 })
    const entry = await this.append(from.coordinatorSessionId, () => ({ from: from.threadId, fromTitle: from.title, kind: 'ask', text, turn }))
    await this.rt.wake(from.coordinatorSessionId, `Thread "${from.title}" (${from.threadId}) asks you while it keeps working (collaboration log #${entry.seq}): ${text}\nAnswer it with message_thread (it joins the thread's running turn).`)
  }

  /** A file of the project as it is now (merged), at most `max` bytes; the path must stay inside the project, outside `.nexgent/` and `.git/`. */
  private async readProjectFile(path: string, max: number): Promise<{ readonly text: string; readonly size: number }> {
    const clean = path.trim().replace(/\\/g, '/').replace(/^\.\//, '')
    const parts = clean.split('/')
    if (clean === '' || isAbsolute(clean) || /^[a-zA-Z]:/.test(clean) || parts.includes('..')) throw new NexgentError('tool/invalid-input', 'give a path inside the project, relative to its root')
    if (parts.some(part => part === '.nexgent' || part === '.git')) throw new NexgentError('tool/denied', 'the project\'s .nexgent/ and .git/ are not readable here')
    const root = await realpath(this.rt.projectRoot())
    let real: string
    try {
      real = await realpath(resolve(root, clean))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new NexgentError('tool/failed', `the project has no file ${clean}`)
      throw error
    }
    const inside = relative(root, real)
    if (inside === '' || inside.startsWith('..') || isAbsolute(inside)) throw new NexgentError('tool/denied', 'that path leads outside the project')
    if (inside.split(sep).some(part => part === '.nexgent' || part === '.git')) throw new NexgentError('tool/denied', 'the project\'s .nexgent/ and .git/ are not readable here')
    const handle = await open(real, 'r')
    try {
      const info = await handle.stat()
      if (info.isDirectory()) throw new NexgentError('tool/invalid-input', `${clean} is a directory`)
      const buffer = Buffer.alloc(Math.min(info.size, max))
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
      return { text: buffer.subarray(0, bytesRead).toString('utf8'), size: info.size }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EISDIR') throw new NexgentError('tool/invalid-input', `${clean} is a directory`)
      throw error
    } finally {
      await handle.close()
    }
  }

  /** B14: a project file as the project has it now (merged), for a thread whose copy may be older. */
  async readMerged(input: { readonly threadId: string; readonly path: string }): Promise<string> {
    await this.thread(input.threadId)
    const { text, size } = await this.readProjectFile(input.path, READ_MERGED_BYTES)
    return [`${input.path.trim()} as the project has it now (merged); it may be newer than your copy:`, text, ...(size > READ_MERGED_BYTES ? [`[… ${size - READ_MERGED_BYTES} more bytes not shown (the first ${READ_MERGED_BYTES / 1024} KB are above)]`] : [])].join('\n')
  }

  /**
   * What a session gets from its coordinator's log before its next model
   * request ({@link collabDelivery}), and its cursor moves to the log's end.
   * A thread gets what is for it; the coordinator what its threads wrote.
   * Nothing for any other session, or when nothing is new.
   */
  async deliver(input: Pick<RequestContextInput, 'sessionId' | 'compacted'>): Promise<readonly string[] | undefined> {
    const origin = await this.origin(input.sessionId)
    const isCoordinator = origin === undefined && await this.rt.isCoordinator(input.sessionId)
    if (origin === undefined && !isCoordinator) return undefined
    const coordinatorSessionId = origin?.coordinatorSessionId ?? input.sessionId
    const entries = await this.collab.entries(coordinatorSessionId)
    // Delivery starts at the current task at the earliest (what earlier tasks wrote is read_collab's).
    const cursor = Math.max((await this.collab.cursor(coordinatorSessionId, input.sessionId)) ?? 0, taskStartSeq(entries))
    const last = entries.at(-1)?.seq ?? 0
    if (last <= cursor && !input.compacted) return undefined
    const records = await this.rt.records(coordinatorSessionId).catch(() => [] as readonly SessionRecord[])
    const collaboration = { ...(taskCollaboration(records) ?? DEFAULT_COLLABORATION), mode: await this.rt.collaborationMode() }
    const working = new Map<string, boolean>()
    if (input.compacted) {
      for (const id of new Set(entries.map(entry => entry.from))) {
        const status = (await this.info(id).catch(() => undefined))?.status
        working.set(id, status === 'running' || status === 'waiting')
      }
    }
    let reader: CollabReader
    if (origin === undefined) reader = { sessionId: input.sessionId, coordinator: true }
    else {
      const mine = await this.rt.records(input.sessionId).catch(() => [] as readonly SessionRecord[])
      const touched = touchedPaths(mine, lastTurn(mine))
      reader = { sessionId: input.sessionId, ...(origin.owns === undefined ? {} : { owns: origin.owns }), ...(touched.length === 0 ? {} : { touched }) }
      // `handoff: changed` at work: merges delivered that the thread's own paths would not have brought.
      if (collaboration.handoff === 'changed') {
        const myPaths = readerPaths(entries, reader)
        const changed = entries.filter(entry => entry.seq > cursor && entry.kind === 'merged' && entry.from !== input.sessionId && !(collaboration.mode === 'hybrid' && ownsOverlap(entry.paths, myPaths))).length
        if (changed > 0) await this.bump(coordinatorSessionId, 'changed', changed)
      }
    }
    const text = collabDelivery({
      entries,
      reader,
      coordinatorSessionId,
      cursor,
      collaboration,
      compacted: input.compacted,
      working: id => working.get(id) === true,
    })
    if (last > cursor) await this.collab.setCursor(coordinatorSessionId, input.sessionId, last)
    return text === undefined ? undefined : [text]
  }

  /**
   * Threads whose runs merged changes into the project since the user's last
   * message in the coordinator, once no thread run is still going
   * (`undefined` while one is).
   */
  private async mergedThreads(coordinatorSessionId: string): Promise<number | undefined> {
    const records = await this.rt.records(coordinatorSessionId).catch(() => [] as readonly SessionRecord[])
    const starts = records.filter(record => record.type === 'subagent.start' && record.executionForm === 'thread')
    const ends = records.filter(record => record.type === 'subagent.end')
    const ended = (start: SessionRecord) => start.type === 'subagent.start' && ends.some(end => end.type === 'subagent.end' && end.childSessionId === start.childSessionId && end.childTurn === start.childTurn)
    if (!starts.every(ended)) return undefined
    const since = records.findLast(record => record.type === 'user.message' && record.source === 'user')?.seq ?? 0
    const threads = new Set(starts.flatMap(start => (start.type === 'subagent.start' ? [start.childSessionId] : [])))
    const merged = new Set(ends.flatMap(end => (end.type === 'subagent.end' && end.seq > since && threads.has(end.childSessionId) && (end.result.merge?.applied.length ?? 0) > 0 ? [end.childSessionId] : [])))
    return merged.size
  }

  /** Once a coordinator turn's thread runs have all ended, measure the turn with them and hand it to the library. */
  private measure(coordinatorSessionId: string, turn: number): Promise<void> {
    const previous = this.measuring.get(coordinatorSessionId) ?? Promise.resolve()
    const next = previous.then(() => this.measureNow(coordinatorSessionId, turn)).catch(error => this.rt.report(coordinatorSessionId, error))
    this.measuring.set(coordinatorSessionId, next)
    void next.finally(() => {
      if (this.measuring.get(coordinatorSessionId) === next) this.measuring.delete(coordinatorSessionId)
    })
    return next
  }

  /**
   * Measure the task a thread run belongs to, once nothing of it is still
   * going. A task is the coordinator turn the user started and the turns its
   * threads woke the coordinator for after it ({@link taskTurns}): a thread
   * that asked a question and was answered, or was given its next step, is
   * still working on the same task. So the task is measured, judged and
   * reflected on only when every thread run of those turns has ended, no turn
   * waits in the queue, the final whole-project check (when due) has run, and
   * the coordinator is not in one of the turns (it could still start
   * another); until then the library keeps it waiting, which counts neither
   * for nor against.
   */
  private async measureNow(coordinatorSessionId: string, runTurn: number): Promise<void> {
    const memory = this.rt.organizations()
    if (memory?.noteProfile === undefined && this.memory.onTaskFacts === undefined) return
    // Taken before the awaits below: a new message of the user replaces the plan and the counters.
    const planned = this.loadPlan(coordinatorSessionId) !== undefined
    let records = await this.rt.records(coordinatorSessionId)
    let task = taskTurns(records, runTurn)
    if (task === undefined || threadRuns(records, task.turns).length === 0 || openThreadRuns(records, task.turns) > 0) return
    if ((await this.queueOf(coordinatorSessionId)).length > 0) return
    // A turn the coordinator is in may be one the threads woke it for (whose records may not be written yet): wait for it.
    while (this.rt.running(coordinatorSessionId)) {
      await this.rt.turnDone(coordinatorSessionId)
      if (this.rt.closed()) return
      records = await this.rt.records(coordinatorSessionId)
      task = taskTurns(records, runTurn)!
      // A run the coordinator started meanwhile is measured when it ends.
      if (openThreadRuns(records, task.turns) > 0 || (await this.queueOf(coordinatorSessionId)).length > 0) return
    }
    // The final check of the whole project is part of the task: it starts now, and its end measures the task.
    if ((await this.checkDue(coordinatorSessionId)) !== undefined) {
      await this.maybeCheck(coordinatorSessionId, true)
      return
    }
    const turn = task.owner
    const runs = threadRuns(records, task.turns)
    const children = new Map<string, readonly SessionRecord[]>()
    for (const run of runs) {
      if (children.has(run.childSessionId)) continue
      try {
        children.set(run.childSessionId, await this.rt.records(run.childSessionId))
      } catch {
        // measured from the coordinator's records only
      }
    }
    const costOf = (usage: LLMUsage, of: string | undefined) => this.rt.costOf(usage, of)
    // The task's thread runs count as the turn's, whichever of its turns started them.
    const profile = buildOrganizationProfile({ turn, records: records.map(record => ((record.type === 'subagent.start' || record.type === 'subagent.end') && task.turns.has(record.turn) ? { ...record, turn } : record)), children, usd: 0, costOf })
    // The threads' cost: each run's own requests and its members'.
    let addUsd = 0
    // The task completed only when each of its threads' last run did, without a question left open (a thread waiting for an answer).
    const last = new Map<string, (typeof runs)[number]>()
    for (const run of runs) last.set(run.childSessionId, run)
    const lastEnds = [...last.values()].map(run => records.find(record => record.type === 'subagent.end' && record.childSessionId === run.childSessionId && record.childTurn === run.childTurn))
    const completed = [...last.values()].every(run => records.some(record => record.type === 'subagent.end' && record.childSessionId === run.childSessionId
      && record.childTurn === run.childTurn && record.result.status === 'completed' && reportBlocker(record.result.text) === undefined))
    // A last reply without the four report lines says nothing sure about whether the part was finished.
    const unformatted = lastEnds.some(end => {
      if (end?.type !== 'subagent.end') return false
      const report = parseMemberReport(end.result.text)
      return report.done === undefined || report.notDone === undefined || report.checks === undefined || report.blockers === undefined
    })
    for (const run of runs) {
      const child = children.get(run.childSessionId) ?? []
      let usage = ZERO_USAGE
      for (const record of child) {
        if (!('turn' in record) || record.turn !== run.childTurn) continue
        if (record.type === 'assistant.message') usage = addUsage(usage, record.usage)
        if (record.type === 'subagent.end') usage = addUsage(usage, record.result.usage)
      }
      addUsd += costOf(usage, model(child)) ?? 0
    }
    // What the host saw between the threads, what the arrangement's values did, and the user's corrections.
    const log = await this.collab.entries(coordinatorSessionId).catch(() => [] as readonly CollabEntry[])
    const waiting = (id: string) => threadStatusOf(children.get(id) ?? [], false).status === 'waiting'
    const logged = logEvents(log, { coordinatorSessionId, lastTurnWaiting: waiting })
    const counters = { ...(await this.taskCounters(coordinatorSessionId, String(task.owner), false)) }
    const startTs = records.find(record => record.type === 'user.message' && record.turn === task.owner)?.ts ?? ''
    const correctionsBy: Record<string, number> = {}
    for (const item of taskUserWords(records, task.turns)) if (item.mid) correctionsBy.coordinator = (correctionsBy.coordinator ?? 0) + 1
    for (const [id, child] of children) {
      const start = child[0]
      const name = start?.type === 'session.start' && start.thread !== undefined ? start.thread.title : id
      const said = child.filter(record => record.type === 'user.message' && record.source === 'user' && record.ts >= startTs).length
      if (said > 0) correctionsBy[name] = (correctionsBy[name] ?? 0) + said
    }
    const triggers = { sequence: counters.sequence, changed: counters.changed, named: counters.named, separate: counters.separate }
    const done = completed ? (unformatted ? 'unknown' as const : true) : false
    // Project memory: the task's facts (spend and time for the record only).
    await this.noteFacts(coordinatorSessionId, taskFacts({
      coordinatorSessionId,
      owner: turn,
      turns: task.turns,
      records,
      children,
      completed: done,
      checkFailed: counters.checkFailed > 0,
      idle: logged.idle,
      unanswered: logged.unanswered,
      usd: profile.usd + addUsd,
      ms: profile.ms,
      at: records.findLast(record => record.type === 'subagent.end')?.ts ?? new Date().toISOString(),
    }))
    if (memory?.noteProfile === undefined) return
    await memory.noteProfile({
      sessionId: coordinatorSessionId,
      turn,
      profile: {
        ...profile,
        events: { ...(profile.events ?? NO_COLLABORATION_EVENTS), unanswered: logged.unanswered, idle: logged.idle, checkFailed: counters.checkFailed },
        triggers,
        ...(planned ? { planned: true as const } : {}),
        ...(Object.keys(correctionsBy).length === 0 ? {} : { correctionsBy }),
      },
      addUsd,
      completed: done,
    })
  }
}

// ---------------------------------------------------------------------------
// tools
// ---------------------------------------------------------------------------

export const START_THREAD_DESCRIPTION = 'Hand one part of the work to a thread, short or long: a conversation of its own that runs in the background '
  + 'in its own copy of the project (merged back when each of its turns ends). It does its part itself or organizes its own members. '
  + 'A thread that has finished folds away in the user\'s list; the user can open any thread and talk to it. Give it everything it needs in task: its part, the inputs, what to produce and where, '
  + 'and what not to touch. This returns at once; when the thread ends a turn you get a note with its reply. '
  + `At most ${THREAD_LIMITS.maxRunning} threads run at once; give threads that run at the same time different files (name them in owns), and start a part that needs another's result after that thread ends.`

export const MESSAGE_THREAD_DESCRIPTION = 'Tell one of your threads something: a correction, an answer to its question, or its next step. '
  + 'It joins the turn the thread is running, or starts its next turn in the background; you get a note when that turn ends.'

export const READ_THREAD_DESCRIPTION = 'A thread\'s status, its last reply, and the project files its last turn brought in or left in conflict. With steps, also what each step of its last turn did.'

export const STOP_THREAD_DESCRIPTION = 'Stop a thread that went the wrong way or is no longer needed (its running turn ends, or its waiting turn is dropped).'

export const LIST_THREADS_DESCRIPTION = 'Every thread of this conversation with its status (queued, running, waiting for an answer, done, stopped, failed).'

function definition(spec: Step2ToolSpec, description: string): Tool['definition'] {
  return {
    name: spec.name,
    description,
    inputSchema: spec.inputSchema,
    effects: spec.effects,
    approval: spec.approval,
    ...(spec.concurrent === undefined ? {} : { concurrent: spec.concurrent }),
  }
}

const STATUS_TEXT: Readonly<Record<ThreadStatus, string>> = {
  queued: 'queued (waiting for a free slot)',
  running: 'running',
  waiting: 'waiting for an answer',
  done: 'done',
  stopped: 'stopped',
  failed: 'failed',
}

function infoLine(info: ThreadInfo): string {
  return `- ${info.title} (id ${info.threadId}): ${STATUS_TEXT[info.status]}, ${info.turns} turn${info.turns === 1 ? '' : 's'}${info.origin === 'user' ? '; started by the user' : info.origin === 'plan' ? '; one the user named' : ''}${info.isolated === false ? '; no copy of its own: it changes the project directly' : ''}`
    + `${info.owns === undefined ? '' : `; owns ${info.owns.join(', ')}`}${info.needsApproval === true ? '; a tool call in it waits for the user to allow it (the user answers in that thread)' : ''}${info.blocker === undefined ? '' : `; blocker: ${info.blocker}`}`
}

function host(lookup: () => ThreadHost | undefined, context: ToolContext): ThreadHost {
  if (context.member !== undefined) throw new NexgentError('tool/denied', 'members cannot use threads')
  const threads = lookup()
  if (threads === undefined) throw new NexgentError('tool/failed', 'this host runs no threads')
  return threads
}

function text(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw new NexgentError('tool/invalid-input', `"${field}" must be a non-empty string`)
  return value
}

function integer(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) throw new NexgentError('tool/invalid-input', `"${field}" must be a positive integer`)
  return value
}

function pathList(value: unknown, field: string): string[] {
  if (!Array.isArray(value)) throw new NexgentError('tool/invalid-input', `"${field}" must be a list of paths`)
  return value.map(item => text(item, `${field}[]`))
}

/** The thread tools over `ctx.threads`. */
export function threadTools(lookup: () => ThreadHost | undefined): Tool[] {
  const start: Tool = {
    definition: definition(START_THREAD_TOOL, START_THREAD_DESCRIPTION),
    handler: async (raw, context): Promise<ToolOutput> => {
      const args = (raw ?? {}) as Record<string, unknown>
      const materialIds = args.materialIds === undefined ? undefined : (args.materialIds as unknown[]).map(id => text(id, 'materialIds[]'))
      const info = await host(lookup, context).start({
        coordinatorSessionId: context.sessionId,
        turn: context.turn,
        toolCallId: context.callId,
        title: text(args.title, 'title'),
        task: text(args.task, 'task'),
        ...(materialIds === undefined ? {} : { materialIds }),
        ...(args.owns === undefined ? {} : { owns: pathList(args.owns, 'owns') }),
      })
      return {
        content: info.status === 'queued'
          ? `Thread "${info.title}" created (id ${info.threadId}) and queued: it starts as soon as a running thread ends (only so many threads run at once, and with overlap: sequence a thread waits for those whose paths overlap its own). You get a note when its turn ends. Go on with other work or end your turn: do not wait for it.`
          : `Thread "${info.title}" started (id ${info.threadId}). It works in the background; you get a note when its turn ends. Go on with other work or end your turn: do not wait for it.`,
        meta: { threadId: info.threadId },
      }
    },
  }
  const message: Tool = {
    definition: definition(MESSAGE_THREAD_TOOL, MESSAGE_THREAD_DESCRIPTION),
    handler: async (raw, context): Promise<ToolOutput> => {
      const args = (raw ?? {}) as Record<string, unknown>
      const info = await host(lookup, context).message({
        coordinatorSessionId: context.sessionId,
        turn: context.turn,
        toolCallId: context.callId,
        threadId: text(args.thread, 'thread'),
        text: text(args.text, 'text'),
      })
      return {
        content: info.status === 'queued'
          ? `Thread "${info.title}" is queued: its next turn, with what you sent, starts as soon as a slot is free. You get a note when that turn ends.`
          : `Sent to thread "${info.title}"; it is working on it. You get a note when its turn ends.`,
        meta: { threadId: info.threadId },
      }
    },
  }
  const read: Tool = {
    definition: definition(READ_THREAD_TOOL, READ_THREAD_DESCRIPTION),
    handler: async (raw, context): Promise<ToolOutput> => {
      const args = (raw ?? {}) as Record<string, unknown>
      if (args.steps !== undefined && typeof args.steps !== 'boolean') throw new NexgentError('tool/invalid-input', '"steps" must be a boolean')
      const found = host(lookup, context)
      const view = await found.read({ coordinatorSessionId: context.sessionId, threadId: text(args.thread, 'thread'), ...(args.steps === true ? { steps: true } : {}) })
      const lines = [infoLine(view).slice(2)]
      if (view.applied.length > 0) lines.push(`Brought into the project by its last turn: ${view.applied.join(', ')}`)
      for (const conflict of view.conflicts) lines.push(`Conflict: ${conflict.path} kept as the project has it${conflict.copy === undefined ? '' : `; the thread's version is at ${conflict.copy}`}`)
      lines.push('', 'Last reply:', view.reply.trim() === '' ? '(none)' : view.reply)
      if (view.cut !== undefined) lines.push(`[… ${view.cut} more characters cut]`)
      if (view.trajectory !== undefined) lines.push('', 'What its last turn did (latest steps):', ...(view.trajectory.length === 0 ? ['(no tool calls)'] : view.trajectory.map(step => `- ${step}`)))
      // What it wrote to the collaboration log, by entry number.
      const collab = (found as Partial<SdkThreadHost>).collabFor === undefined ? [] : (await (found as SdkThreadHost).collabFor(view.threadId)).filter(entry => entry.from === view.threadId && entry.kind !== 'release').slice(-5)
      if (collab.length > 0) lines.push('', 'Its latest entries in the collaboration log:', ...collab.map(entry => renderCollabEntry(entry, undefined, context.sessionId)))
      return { content: lines.join('\n') }
    },
  }
  const list: Tool = {
    definition: definition(LIST_THREADS_TOOL, LIST_THREADS_DESCRIPTION),
    handler: async (_raw, context): Promise<ToolOutput> => {
      const threads = await host(lookup, context).list({ coordinatorSessionId: context.sessionId })
      return { content: threads.length === 0 ? 'This conversation has no threads.' : threads.map(infoLine).join('\n') }
    },
  }
  const stop: Tool = {
    definition: definition(STOP_THREAD_TOOL, STOP_THREAD_DESCRIPTION),
    handler: async (raw, context): Promise<ToolOutput> => {
      const args = (raw ?? {}) as Record<string, unknown>
      if (args.reason !== undefined && typeof args.reason !== 'string') throw new NexgentError('tool/invalid-input', '"reason" must be a string')
      const info = await host(lookup, context).stop({
        coordinatorSessionId: context.sessionId,
        threadId: text(args.thread, 'thread'),
        ...(args.reason === undefined || args.reason.trim() === '' ? {} : { reason: args.reason }),
      })
      return { content: `Thread "${info.title}" is now ${STATUS_TEXT[info.status]}. A stopped thread does not wake you; message_thread starts it again when you want it to go on.`, meta: { threadId: info.threadId } }
    },
  }
  return [start, message, read, list, stop]
}

export const POST_COLLAB_DESCRIPTION = 'Post to the collaboration log this task\'s threads share: a note the others can build on, a claim on the paths you will change (refused when a working thread has claimed them), '
  + 'a handoff (what you produced and where, for the thread that builds on it), or a blocker. Each thread gets the entries for it or about its paths before its next step; the coordinator and the user see the log. '
  + 'The coordinator posts notes, which reach every thread.'

export const READ_MERGED_DESCRIPTION = 'A project file as the project has it now, after the threads\' merges: your copy may still hold an older version of files other threads changed. Up to 200 KB.'

export const READ_COLLAB_DESCRIPTION = 'The collaboration log of this task (with all, of earlier tasks too): notes, claims, handoffs, blockers, messages, and which files each thread\'s turn merged into the project.'

export const MESSAGE_PEER_DESCRIPTION = 'Leave another thread of this task a short message it needs from you (an interface you agreed, a file you changed that it uses, a question about its part). '
  + 'It reaches that thread before its next step, or when its next turn starts. Post a note instead for anything every thread should know.'

export const ASK_COORDINATOR_DESCRIPTION = 'Ask the coordinator something now, without ending your turn (a decision outside your part, a conflict with another thread). It answers with a message that joins your turn; keep working meanwhile.'

/** Organization redo: the collaboration tools (which a session sees is decided when it opens: `PEER_TOOL_NAMES`). */
export function peerTools(lookup: () => SdkThreadHost | undefined): Tool[] {
  const peers = (context: ToolContext): SdkThreadHost => {
    if (context.member !== undefined) throw new NexgentError('tool/denied', 'members do not use the collaboration log; report to the thread that started you')
    const found = lookup()
    if (found === undefined) throw new NexgentError('tool/failed', 'this host runs no threads')
    return found
  }
  const post: Tool = {
    definition: definition(POST_COLLAB_TOOL, POST_COLLAB_DESCRIPTION),
    handler: async (raw, context): Promise<ToolOutput> => {
      const args = (raw ?? {}) as Record<string, unknown>
      const entry = await peers(context).post({
        sessionId: context.sessionId,
        kind: text(args.kind, 'kind') as CollabPostKind,
        text: text(args.text, 'text'),
        ...(args.paths === undefined ? {} : { paths: pathList(args.paths, 'paths') }),
        ...(args.waitsFor === undefined ? {} : { waitsFor: text(args.waitsFor, 'waitsFor') }),
        ...(args.re === undefined ? {} : { re: integer(args.re, 're') }),
      })
      return { content: `Posted to the collaboration log (#${entry.seq}, ${entry.kind}).`, meta: { seq: entry.seq } }
    },
  }
  const read: Tool = {
    definition: definition(READ_COLLAB_TOOL, READ_COLLAB_DESCRIPTION),
    handler: async (raw, context): Promise<ToolOutput> => {
      const args = (raw ?? {}) as Record<string, unknown>
      if (args.all !== undefined && typeof args.all !== 'boolean') throw new NexgentError('tool/invalid-input', '"all" must be a boolean')
      const found = peers(context)
      const entries = await found.log({ sessionId: context.sessionId, ...(args.all === true ? { all: true } : {}) })
      if (entries.length === 0) return { content: 'The collaboration log of this task is empty.' }
      const coordinator = (await found.coordinatorOf(context.sessionId)) ?? context.sessionId
      return { content: entries.map(entry => renderCollabEntry(entry, context.sessionId, coordinator)).join('\n') }
    },
  }
  const message: Tool = {
    definition: definition(MESSAGE_PEER_TOOL, MESSAGE_PEER_DESCRIPTION),
    handler: async (raw, context): Promise<ToolOutput> => {
      const args = (raw ?? {}) as Record<string, unknown>
      const sent = await peers(context).messagePeer({ threadId: context.sessionId, to: text(args.to, 'to'), text: text(args.text, 'text'), ...(args.re === undefined ? {} : { re: integer(args.re, 're') }) })
      const content = sent.woken === true
        ? `Left for "${sent.title}", which was idle: its next turn started and it reads the message first.`
        : sent.running ? `Left for "${sent.title}"; it reads it before its next step.` : `Left for "${sent.title}", which is not running; it reads it when its next turn starts.`
      return { content: sent.note === undefined ? content : `${content} ${sent.note}.` }
    },
  }
  const ask: Tool = {
    definition: definition(ASK_COORDINATOR_TOOL, ASK_COORDINATOR_DESCRIPTION),
    handler: async (raw, context): Promise<ToolOutput> => {
      const args = (raw ?? {}) as Record<string, unknown>
      await peers(context).ask({ threadId: context.sessionId, text: text(args.text, 'text') })
      return { content: 'The coordinator has your question; its answer joins your turn. Keep working meanwhile.' }
    },
  }
  const readMerged: Tool = {
    definition: definition(READ_MERGED_TOOL, READ_MERGED_DESCRIPTION),
    handler: async (raw, context): Promise<ToolOutput> => {
      const args = (raw ?? {}) as Record<string, unknown>
      return { content: await peers(context).readMerged({ threadId: context.sessionId, path: text(args.path, 'path') }) }
    },
  }
  return [post, read, message, ask, readMerged]
}

/** Organization redo: before each model request of a thread, what its coordinator's collaboration log has for it. */
export function collabProvider(host: SdkThreadHost): ContextProvider {
  return {
    id: 'collab',
    async beginTurn() {
      return {}
    },
    beforeRequest: async input => {
      const delivered = await host.deliver(input)
      const loop = await host.loopCheck(input).catch(() => undefined)
      return loop === undefined ? delivered : [...(delivered ?? []), ...loop]
    },
  }
}

/**
 * Coordinator step three: what the coordinator conversation is told at the
 * start of every turn. General: how to keep the notes, brief a thread and
 * take its note; nothing about any task.
 */
export const COORDINATOR_PROMPT = [
  'You are this project\'s coordinator conversation: the user\'s standing entry to the project. You do not do the work yourself and start no members; threads do all of it, and each thread organizes its own members. '
    + 'Your job: split the task into parts, hand each part to a thread (start_thread), follow their progress, pass the user\'s corrections on at once (message_thread), '
    + 'check their results, sum them up for the user, and reflect on how the task was split. Answer simple questions directly.',
  '',
  'Project notes: keep them with update_project_notes. They hold what stays true across tasks: the project\'s long-term goals, the user\'s standing rules, decisions made and why, and pitfalls found. Write one short line per fact with its reason, under the headings Goals, Rules, Decisions and Pitfalls. No progress reports, no one-off requests, nothing a file in the project already says. Update them when you learn something of that kind; replace a line that turned out wrong rather than adding a second one.',
  '',
  'Briefing a thread (start_thread, message_thread): state the goal, the inputs (files, materials, what is already known), what done looks like, and what it must not do or touch. Pass on the rules from the notes that apply to its part.',
  '',
  'When a thread\'s note arrives: when the note says its reply was cut, read the whole reply with read_thread first (yourself, without asking the user). Then sum up for the user in a few lines what the thread did and what it left open, decide the next step (answer its question, give it or another thread the next part, check its work, or finish) and do it.',
].join('\n')

/** Project memory: the opening line of the coordinator's observations. */
export const OBSERVATIONS_LEAD = 'Counted by the host from this project\'s earlier tasks (facts, not instructions); take them into account when you split work:'

/** Pure: the coordinator's system sections for a turn (`observations`: {@link observationLines}). */
export function coordinatorSections(notes: string, observations: readonly string[] = []): SystemPromptSection[] {
  return [
    { id: 'coordinator', title: 'Coordinating this project', body: COORDINATOR_PROMPT },
    { id: 'coordinator-notes', title: 'Project notes', body: notes.trim() === '' ? '(none yet)' : notes.trim() },
    ...(observations.length === 0 ? [] : [{ id: 'coordinator-observations', title: 'Project observations', body: [OBSERVATIONS_LEAD, ...observations].join('\n') }]),
  ]
}

/** Coordinator step three: the coordinator's prompt and notes, for its turns only. */
export function coordinatorProvider(host: SdkThreadHost): ContextProvider {
  return {
    id: 'coordinator',
    async beginTurn(input) {
      if (!(await host.isCoordinator(input.sessionId))) return {}
      return { systemSections: coordinatorSections(await host.readNotes(), observationLines(await host.observations())) }
    },
  }
}

export const UPDATE_PROJECT_NOTES_DESCRIPTION = 'Replace the project notes with a new full text: the project\'s long-term goals, the user\'s standing rules, decisions and why, and pitfalls. '
  + `They are shown to you at the start of every turn. At most ${THREAD_LIMITS.notesChars} characters.`

/** Coordinator step three: `update_project_notes`. */
export function projectNotesTool(host: SdkThreadHost): Tool {
  return {
    definition: definition(UPDATE_PROJECT_NOTES_TOOL, UPDATE_PROJECT_NOTES_DESCRIPTION),
    handler: async (raw, context): Promise<ToolOutput> => {
      if (context.member !== undefined || !(await host.isCoordinator(context.sessionId))) throw new NexgentError('tool/denied', 'only the coordinator conversation keeps the project notes')
      const notes = (raw ?? {}) as Record<string, unknown>
      if (typeof notes.notes !== 'string') throw new NexgentError('tool/invalid-input', '"notes" must be a string')
      await host.writeNotes(notes.notes)
      return { content: notes.notes.trim() === '' ? 'The project notes are now empty.' : `The project notes are saved (${notes.notes.trim().length} characters).` }
    },
  }
}

/** Name of the profile row. */
export const THREADS_PLUGIN_NAME = '@nexgent/threads'

/** The plugin of one project: provides `ctx.threads`, registers the thread tools and `update_project_notes`, and the coordinator's context. */
export function threadsPlugin(threads: SdkThreadHost) {
  return {
    name: THREADS_PLUGIN_NAME,
    apply(ctx: Context): void {
      ctx.provide('threads', threads)
      ctx.inject(['tools'], scope => {
        for (const tool of [...threadTools(() => threads), ...peerTools(() => threads), projectNotesTool(threads)]) scope.effect(() => scope.tools.register(tool), `tools.register(${tool.definition.name})`)
      })
      ctx.inject(['context'], scope => {
        scope.effect(() => scope.context.register(coordinatorProvider(threads)), 'context.register(coordinator)')
        scope.effect(() => scope.context.register(collabProvider(threads)), 'context.register(collab)')
      })
    },
  }
}
