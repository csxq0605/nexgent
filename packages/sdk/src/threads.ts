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
 *   starts only those, with the user's words for each).
 * - A thread may be given `owns` (the paths its part changes). Its wake
 *   note says which files it brought in outside them, and which files
 *   another thread of the task also brought in.
 * - The task's arrangement (`CollaborationConfig` on the coordinator turn's
 *   decision) is enforced here: `overlap: sequence` refuses a thread whose
 *   `owns` overlaps a running one's; `handoff: changed` delivers every
 *   thread of the task each `merged` entry of the collaboration log.
 * - The coordinator's threads share a collaboration log in the project
 *   (`<root>/.nexgent/collab/<coordinator>.jsonl`, `collab.ts`). The host
 *   writes a `merged` entry whenever a thread's turn brings files into the
 *   project; with collaboration `hybrid` (the project's setting) threads
 *   also post notes, claims, handoffs and blockers and leave each other
 *   messages; the coordinator posts notes. Before each model request of a
 *   thread, the host delivers what it has not seen yet
 *   ({@link SdkThreadHost.deliver}), so a long turn hears it too. A thread
 *   may ask the coordinator mid-turn in either mode.
 */
import {
  addUsage,
  ASK_COORDINATOR_TOOL,
  COLLAB_POST_KINDS,
  DEFAULT_COLLABORATION,
  MAX_PLANNED_THREADS,
  MESSAGE_PEER_TOOL,
  POST_COLLAB_TOOL,
  READ_COLLAB_TOOL,
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
  type SessionRecord,
  type Step2ToolSpec,
  type ThreadCaller,
  type ThreadHost,
  type ThreadInfo,
  type ThreadOrigin,
  type ThreadStartInput,
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
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { CollabLog, collabDelivery, currentTaskEntries, renderCollabEntry, taskStartSeq } from './collab.js'
import { toMemberResult } from '@nexgent/subagent'
import { buildOrganizationProfile, reportBlocker, withinOwns } from '@nexgent/workflow'

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
  /** Start a turn with `source: thread` (`user`: the user's own message); `done` settles after the SDK's bookkeeping. */
  startTurn(sessionId: string, text: string, materialIds?: readonly string[], source?: 'thread' | 'user'): Promise<{ readonly turn: number; readonly done: Promise<TurnResult> }>
  /** Join the session's running turn (`source: thread`); `false` when no turn takes it. */
  steer(sessionId: string, text: string): Promise<boolean>
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
    ...(start.thread.origin === 'user' ? { origin: 'user' as const } : {}),
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

/** The user's plan of a coordinator's current task, and the planned threads started so far. */
interface PlanState {
  readonly plan: ThreadPlan
  readonly started: Set<string>
}

/** The kernel's `ThreadHost` over the SDK's sessions of one project. */
export class SdkThreadHost implements ThreadHost, ThreadPeers {
  /** Per coordinator: measurements run one at a time. */
  private readonly measuring = new Map<string, Promise<void>>()
  /** Per coordinator: the user's plan for the current task. */
  private readonly plans = new Map<string, PlanState>()
  /** Per thread: questions to the coordinator in its current turn. */
  private readonly asked = new Map<string, number>()
  /** Per session: its thread origin (`null`: not a thread); a session's start record never changes. */
  private readonly origins = new Map<string, ThreadOrigin | null>()
  /** The project's collaboration logs. */
  readonly collab: CollabLog

  constructor(private readonly rt: ThreadRuntime) {
    this.collab = new CollabLog(() => rt.collabDir())
  }

  /**
   * Organization redo: the user sent the coordinator a new message: a new
   * task starts. `plan`: the threads the user named for it (replaces the
   * previous plan; absent: none). The counters of the previous task end.
   */
  newTask(coordinatorSessionId: string, plan?: ThreadPlan): void {
    void this.collab.markTask(coordinatorSessionId).catch(error => this.rt.report(coordinatorSessionId, error))
    if (plan === undefined) this.plans.delete(coordinatorSessionId)
    else this.plans.set(coordinatorSessionId, { plan: checkPlan(plan), started: new Set() })
  }

  /** The user named (more) threads in the middle of the task: their plan replaces the previous one; the threads started so far stay started. */
  setPlan(coordinatorSessionId: string, plan: ThreadPlan): void {
    const started = this.plans.get(coordinatorSessionId)?.started ?? new Set<string>()
    this.plans.set(coordinatorSessionId, { plan: checkPlan(plan), started })
  }

  /** The user's plan of the coordinator's current task, if any. */
  plan(coordinatorSessionId: string): ThreadPlan | undefined {
    return this.plans.get(coordinatorSessionId)?.plan
  }

  async start(input: ThreadStartInput): Promise<ThreadInfo> {
    const title = cleanTitle(input.title)
    if (input.task.trim() === '') throw new NexgentError('tool/invalid-input', '"task" must not be empty')
    const owns = cleanOwns(input.owns)
    const threads = await this.list({ coordinatorSessionId: input.coordinatorSessionId })
    if (threads.length >= THREAD_LIMITS.maxThreads) {
      throw new NexgentError('tool/denied', `this conversation already has ${threads.length} threads (at most ${THREAD_LIMITS.maxThreads}): give an existing thread the work with message_thread`)
    }
    const running = threads.filter(thread => thread.status === 'running')
    if (running.length >= THREAD_LIMITS.maxRunning) {
      throw new NexgentError('tool/denied', `${running.length} threads are running (at most ${THREAD_LIMITS.maxRunning} at once): wait for one to finish, or give a running one the work with message_thread`)
    }
    // The user's plan: with `exact`, only the threads the user named, each once, with the user's words.
    const planned = this.plans.get(input.coordinatorSessionId)
    const item = planned?.plan.threads.find(thread => titleKey(thread.title) === titleKey(title))
    if (planned?.plan.exact === true) {
      const open = planned.plan.threads.filter(thread => !planned.started.has(titleKey(thread.title))).map(thread => `"${thread.title}"`)
      if (item === undefined || planned.started.has(titleKey(title))) {
        throw new NexgentError('tool/denied', open.length === 0
          ? 'the user asked for exactly the threads already started for this task: give more work to one of them with message_thread, or ask the user'
          : `the user asked for exactly these threads, with these titles: ${open.join(', ')} (not started yet). Start only those; give other work to one of them with message_thread, or ask the user`)
      }
    }
    const records = await this.rt.records(input.coordinatorSessionId).catch(() => [] as readonly SessionRecord[])
    const collaboration = taskCollaboration(records) ?? DEFAULT_COLLABORATION
    if (collaboration.overlap === 'sequence' && running.length > 0) {
      if (owns === undefined) throw new NexgentError('tool/denied', `threads are running (${running.map(thread => `"${thread.title}"`).join(', ')}): give this thread \`owns\` (the paths its part changes), or start it after they end`)
      const blocking = running.filter(thread => ownsOverlap(thread.owns, owns))
      if (blocking.length > 0) {
        throw new NexgentError('tool/denied', `its paths overlap those of running threads (${blocking.map(thread => `"${thread.title}"${thread.owns === undefined ? ' (no owns)' : `: ${thread.owns.join(', ')}`}`).join('; ')}): start it after they end, or give it paths they do not change`)
      }
    }
    const lines = [input.task.trim()]
    if (item?.task !== undefined && item.task.trim() !== '') lines.push('', `The user's own words for this part: ${item.task.trim()}`)
    if (owns !== undefined) lines.push('', `Your part changes only these paths: ${owns.join(', ')}. Change nothing else; when another file must change, say so in your report.`)
    if (collaboration.mode === 'hybrid') {
      const others = running.map(thread => `"${thread.title}"${thread.owns === undefined ? '' : ` (${thread.owns.join(', ')})`}`)
      lines.push('', `You work beside the other threads of this task${others.length === 0 ? '' : ` (running now: ${others.join(', ')})`}. What they write to the collaboration log for you or about your paths reaches you on its own before each step. `
        + 'Claim the paths you will change (post_collab kind claim), post what others can build on (note, handoff) or what blocks you, message a thread directly when only it needs to know, and ask the coordinator when a decision is outside your part.')
    }
    const threadId = await this.rt.create({ title, thread: { coordinatorSessionId: input.coordinatorSessionId, title, ...(owns === undefined ? {} : { owns }) } })
    planned?.started.add(titleKey(title))
    await this.runFor(input, threadId, threadRunName(title, threads.length + 1), title, lines.join('\n'), input.materialIds)
    return this.info(threadId)
  }

  /**
   * Organization redo: the user starts a thread of the coordinator
   * themselves. Its first turn is the user's message (kept word for word),
   * runs in the background, and wakes the coordinator when it ends so the
   * coordinator can follow it up. It is the user's, not part of the
   * coordinator's organization (not recorded there, not measured).
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
    if (threads.length >= THREAD_LIMITS.maxThreads) throw new NexgentError('tool/denied', `this conversation already has ${threads.length} threads (at most ${THREAD_LIMITS.maxThreads})`)
    const threadId = await this.rt.create({ title, thread: { coordinatorSessionId: input.coordinatorSessionId, title, origin: 'user', ...(owns === undefined ? {} : { owns }) } })
    const started = await this.rt.startTurn(threadId, input.task, input.materialIds, 'user')
    void started.done
      .then(() => this.userThreadEnded(input.coordinatorSessionId, threadId, title, started.turn))
      .catch(error => this.rt.report(input.coordinatorSessionId, error))
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
    await this.noteMerged(coordinatorSessionId, threadId, title, merge)
    const events = await this.runEvents(coordinatorSessionId, threadId, merge)
    const note = threadWakeNote({ title, threadId, status, reply: replyOf(records, turn), ...(merge === undefined ? {} : { merge }), ...(events === undefined ? {} : { events }) })
    await this.rt.wake(coordinatorSessionId, `The user started thread "${title}" themselves; follow it up like your own threads (do not redo its work).\n${note}`)
  }

  async message(input: ThreadCaller & { readonly threadId: string; readonly text: string }): Promise<ThreadInfo> {
    if (input.text.trim() === '') throw new NexgentError('tool/invalid-input', '"text" must not be empty')
    const info = await this.own(input.coordinatorSessionId, input.threadId)
    if (!(await this.rt.steer(input.threadId, input.text))) {
      // Starting the thread's next turn counts against the threads running at once, like starting a new thread.
      const running = (await this.list({ coordinatorSessionId: input.coordinatorSessionId })).filter(thread => thread.status === 'running' && thread.threadId !== input.threadId).length
      if (running >= THREAD_LIMITS.maxRunning) {
        throw new NexgentError('tool/denied', `${running} threads are running (at most ${THREAD_LIMITS.maxRunning} at once): wait for one to finish before giving this thread its next step`)
      }
      const index = (await this.rt.threadIds(input.coordinatorSessionId)).indexOf(input.threadId) + 1
      await this.runFor(input, input.threadId, threadRunName(info.title, index), info.title, input.text)
    }
    return this.info(input.threadId)
  }

  async read(input: { readonly coordinatorSessionId: string; readonly threadId: string }): Promise<ThreadView> {
    await this.own(input.coordinatorSessionId, input.threadId)
    const records = await this.rt.records(input.threadId)
    const info = threadInfoOf(input.threadId, records, this.rt.running(input.threadId), this.rt.needsApproval(input.threadId))
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
    return threadInfoOf(threadId, await this.rt.records(threadId), this.rt.running(threadId), this.rt.needsApproval(threadId))
  }

  // -------------------------------------------------------------------------
  // coordinator step three: the coordinator's notes and prompt
  // -------------------------------------------------------------------------

  isCoordinator(sessionId: string): Promise<boolean> {
    return this.rt.isCoordinator(sessionId)
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

  /** Start a thread turn for the coordinator and record it there; returns once the run is recorded. */
  private async runFor(caller: ThreadCaller, threadId: string, name: string, title: string, text: string, materialIds?: readonly string[]): Promise<void> {
    this.asked.delete(threadId)
    const started = await this.rt.startTurn(threadId, text, materialIds)
    const recorded = await this.rt.append(caller.coordinatorSessionId, {
      type: 'subagent.start',
      turn: caller.turn,
      ...(caller.toolCallId === undefined ? {} : { toolCallId: caller.toolCallId }),
      childSessionId: threadId,
      childTurn: started.turn,
      name,
      executionForm: 'thread',
      task: text.slice(0, 500),
      ...(materialIds === undefined || materialIds.length === 0 ? {} : { materialIds: [...materialIds] }),
    }).then(() => true, (error: unknown) => {
      this.rt.report(caller.coordinatorSessionId, error)
      return false
    })
    void started.done
      .then(result => ({ result }), (error: unknown) => ({ error }))
      .then(settled => this.ended(caller, threadId, title, started.turn, settled, recorded))
      .catch(error => this.rt.report(caller.coordinatorSessionId, error))
  }

  private async ended(
    caller: ThreadCaller,
    threadId: string,
    title: string,
    childTurn: number,
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
    await this.noteMerged(caller.coordinatorSessionId, threadId, title, result.merge)
    if (cause === 'shutdown') return
    if (this.rt.closed()) return
    // A thread the user stopped, or one stopped at the cost cap, stays stopped: the coordinator is not woken to pick it up again.
    if (cause !== 'user' && cause !== 'cost-cap') {
      const { status } = threadStatusOf(records, false)
      const mergedThreads = result.merge !== undefined && result.merge.applied.length > 0 ? await this.mergedThreads(caller.coordinatorSessionId) : undefined
      const events = await this.runEvents(caller.coordinatorSessionId, threadId, result.merge)
      await this.rt.wake(caller.coordinatorSessionId, threadWakeNote({
        title,
        threadId,
        status,
        reply: result.text,
        ...(result.merge === undefined ? {} : { merge: result.merge }),
        ...(mergedThreads === undefined ? {} : { mergedThreads }),
        ...(events === undefined ? {} : { events }),
      }))
    }
    if (recorded) await this.measure(caller.coordinatorSessionId, caller.turn)
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
      if (entry.kind !== 'message' || entry.to === undefined || !titles.has(entry.to) || this.rt.running(entry.to)) continue
      const cursor = Math.max((await this.collab.cursor(coordinatorSessionId, entry.to).catch(() => undefined)) ?? 0, taskStartSeq(log))
      const to = titles.get(entry.to)!
      if (entry.seq > cursor && !waiting.some(item => item.from === entry.fromTitle && item.to === to)) waiting.push({ from: entry.fromTitle, to })
    }
    if (outside.length === 0 && overlap.length === 0 && waiting.length === 0) return undefined
    return { ...(outside.length === 0 ? {} : { outside }), ...(overlap.length === 0 ? {} : { overlap }), ...(waiting.length === 0 ? {} : { waiting }) }
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

  /** The host's `merged` entry for a thread turn that brought files into the project (a held merge brought nothing). */
  private async noteMerged(coordinatorSessionId: string, threadId: string, title: string, merge: WorkdirMerge | undefined): Promise<void> {
    if (merge === undefined || merge.held === true) return
    const conflicts = merge.conflicts.map(conflict => conflict.path)
    const applied = merge.applied.filter(path => !conflicts.includes(path))
    if (applied.length === 0 && conflicts.length === 0) return
    const text = conflicts.length === 0 ? '' : `in conflict, kept as the project has it: ${conflicts.join(', ')}`
    await this.append(coordinatorSessionId, () => ({ from: threadId, fromTitle: title, kind: 'merged', text, paths: applied })).catch(error => this.rt.report(coordinatorSessionId, error))
  }

  /** A thread of the project, or `tool/denied`. */
  private async thread(threadId: string): Promise<ThreadInfo> {
    try {
      return await this.info(threadId)
    } catch {
      throw new NexgentError('tool/denied', 'only threads and their coordinator use the collaboration log')
    }
  }

  async post(input: { readonly sessionId: string; readonly kind: CollabPostKind; readonly text: string; readonly paths?: readonly string[] }): Promise<CollabEntry> {
    if (!(COLLAB_POST_KINDS as readonly string[]).includes(input.kind)) throw new NexgentError('tool/invalid-input', `"kind" must be one of ${COLLAB_POST_KINDS.join(', ')}`)
    const text = input.text.trim()
    if (text === '' || text.length > THREAD_LIMITS.peerChars) throw new NexgentError('tool/invalid-input', `"text" must be 1 to ${THREAD_LIMITS.peerChars} characters`)
    const paths = cleanOwns(input.paths)
    if (await this.rt.isCoordinator(input.sessionId)) {
      if (input.kind !== 'note') throw new NexgentError('tool/denied', 'the coordinator posts notes (kind note) for its threads; claims, handoffs and blockers are the threads\'')
      return this.append(input.sessionId, () => ({ from: input.sessionId, fromTitle: 'coordinator', kind: 'note', text, ...(paths === undefined ? {} : { paths }) }))
    }
    const info = await this.thread(input.sessionId)
    if (input.kind === 'claim' && paths === undefined) throw new NexgentError('tool/invalid-input', 'a claim names the paths you will change ("paths")')
    return this.append(info.coordinatorSessionId, async entries => {
      if (input.kind === 'claim') {
        // A claim of the current task stands while its thread works (running, or waiting for an answer).
        for (const entry of currentTaskEntries(entries)) {
          if (entry.kind !== 'claim' || entry.from === input.sessionId) continue
          const other = await this.info(entry.from).catch(() => undefined)
          if (other === undefined || (other.status !== 'running' && other.status !== 'waiting')) continue
          if (ownsOverlap(entry.paths, paths)) {
            throw new NexgentError('tool/denied', `"${entry.fromTitle}" has claimed ${entry.paths?.join(', ') ?? 'these paths'} and is still working on them: take other paths, or message_peer it to agree who changes what`)
          }
        }
      }
      return { from: input.sessionId, fromTitle: info.title, kind: input.kind, text, ...(paths === undefined ? {} : { paths }) }
    })
  }

  async log(input: { readonly sessionId: string; readonly all?: boolean }): Promise<readonly CollabEntry[]> {
    const origin = await this.origin(input.sessionId)
    const entries = await this.collab.entries(origin?.coordinatorSessionId ?? input.sessionId)
    return (input.all === true ? entries : currentTaskEntries(entries)).slice(-THREAD_LIMITS.collabShown)
  }

  async messagePeer(input: { readonly threadId: string; readonly to: string; readonly text: string }): Promise<{ readonly title: string; readonly running: boolean }> {
    const from = await this.thread(input.threadId)
    const text = input.text.trim()
    if (text === '' || text.length > THREAD_LIMITS.peerChars) throw new NexgentError('tool/invalid-input', `"text" must be 1 to ${THREAD_LIMITS.peerChars} characters`)
    const others = (await this.list({ coordinatorSessionId: from.coordinatorSessionId })).filter(thread => thread.threadId !== from.threadId)
    const wanted = input.to.trim()
    const to = others.find(thread => thread.threadId === wanted) ?? others.find(thread => titleKey(thread.title) === titleKey(wanted))
    if (to === undefined) throw new NexgentError('tool/invalid-input', `no other thread "${wanted}"${others.length === 0 ? '' : ` (threads: ${others.map(thread => `"${thread.title}"`).join(', ')})`}`)
    if (to.status === 'stopped' || to.status === 'failed') throw new NexgentError('tool/denied', `"${to.title}" has ${to.status}: tell the coordinator instead (ask_coordinator)`)
    await this.append(from.coordinatorSessionId, entries => {
      // Within the current task: the same text once, and at most maxPeerMessages to one thread.
      const sent = currentTaskEntries(entries).filter(entry => entry.kind === 'message' && entry.from === from.threadId && entry.to === to.threadId)
      if (sent.some(entry => entry.text === text)) throw new NexgentError('tool/denied', `you already sent "${to.title}" this message`)
      if (sent.length >= THREAD_LIMITS.maxPeerMessages) throw new NexgentError('tool/denied', `you sent "${to.title}" ${sent.length} messages in this task (at most ${THREAD_LIMITS.maxPeerMessages}): post a note to the log, or ask the coordinator`)
      return { from: from.threadId, fromTitle: from.title, kind: 'message', text, to: to.threadId, toTitle: to.title }
    })
    return { title: to.title, running: this.rt.running(to.threadId) }
  }

  async ask(input: { readonly threadId: string; readonly text: string }): Promise<void> {
    const from = await this.thread(input.threadId)
    const text = input.text.trim()
    if (text === '' || text.length > THREAD_LIMITS.peerChars) throw new NexgentError('tool/invalid-input', `"text" must be 1 to ${THREAD_LIMITS.peerChars} characters`)
    const asked = this.asked.get(input.threadId) ?? 0
    if (asked >= THREAD_LIMITS.maxAsks) throw new NexgentError('tool/denied', `you asked the coordinator ${asked} times in this turn (at most ${THREAD_LIMITS.maxAsks}): put the rest in your report`)
    this.asked.set(input.threadId, asked + 1)
    await this.append(from.coordinatorSessionId, () => ({ from: from.threadId, fromTitle: from.title, kind: 'ask', text }))
    await this.rt.wake(from.coordinatorSessionId, `Thread "${from.title}" (${from.threadId}) asks you while it keeps working: ${text}\nAnswer it with message_thread (it joins the thread's running turn).`)
  }

  /**
   * What a thread gets from its coordinator's log before its next model
   * request ({@link collabDelivery}), and its cursor moves to the log's end.
   * Nothing for a session that is not a thread, or when nothing is new.
   */
  async deliver(input: Pick<RequestContextInput, 'sessionId' | 'compacted'>): Promise<readonly string[] | undefined> {
    const origin = await this.origin(input.sessionId)
    if (origin === undefined) return undefined
    const coordinatorSessionId = origin.coordinatorSessionId
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
    const text = collabDelivery({
      entries,
      reader: { sessionId: input.sessionId, ...(origin.owns === undefined ? {} : { owns: origin.owns }) },
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
   * reflected on only when every thread run of those turns has ended and the
   * coordinator is not in one of them (it could still start another); until
   * then the library keeps it waiting, which counts neither for nor against.
   */
  private async measureNow(coordinatorSessionId: string, runTurn: number): Promise<void> {
    const memory = this.rt.organizations()
    if (memory?.noteProfile === undefined) return
    let records = await this.rt.records(coordinatorSessionId)
    let task = taskTurns(records, runTurn)
    if (task === undefined || threadRuns(records, task.turns).length === 0 || openThreadRuns(records, task.turns) > 0) return
    // A turn the coordinator is in may be one the threads woke it for (whose records may not be written yet): wait for it.
    while (this.rt.running(coordinatorSessionId)) {
      await this.rt.turnDone(coordinatorSessionId)
      if (this.rt.closed()) return
      records = await this.rt.records(coordinatorSessionId)
      task = taskTurns(records, runTurn)!
      // A run the coordinator started meanwhile is measured when it ends.
      if (openThreadRuns(records, task.turns) > 0) return
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
    const completed = [...last.values()].every(run => records.some(record => record.type === 'subagent.end' && record.childSessionId === run.childSessionId
      && record.childTurn === run.childTurn && record.result.status === 'completed' && reportBlocker(record.result.text) === undefined))
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
    await memory.noteProfile({ sessionId: coordinatorSessionId, turn, profile, addUsd, completed })
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

export const READ_THREAD_DESCRIPTION = 'A thread\'s status, its last reply, and the project files its last turn brought in or left in conflict.'

export const LIST_THREADS_DESCRIPTION = 'Every thread of this conversation with its status (running, waiting for an answer, done, stopped, failed).'

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
  running: 'running',
  waiting: 'waiting for an answer',
  done: 'done',
  stopped: 'stopped',
  failed: 'failed',
}

function infoLine(info: ThreadInfo): string {
  return `- ${info.title} (id ${info.threadId}): ${STATUS_TEXT[info.status]}, ${info.turns} turn${info.turns === 1 ? '' : 's'}${info.origin === 'user' ? '; started by the user' : ''}`
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

function pathList(value: unknown, field: string): string[] {
  if (!Array.isArray(value)) throw new NexgentError('tool/invalid-input', `"${field}" must be a list of paths`)
  return value.map(item => text(item, `${field}[]`))
}

/** The four thread tools over `ctx.threads`. */
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
        content: `Thread "${info.title}" started (id ${info.threadId}). It works in the background; you get a note when its turn ends. Go on with other work or end your turn: do not wait for it.`,
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
      return { content: `Sent to thread "${info.title}"; it is working on it. You get a note when its turn ends.`, meta: { threadId: info.threadId } }
    },
  }
  const read: Tool = {
    definition: definition(READ_THREAD_TOOL, READ_THREAD_DESCRIPTION),
    handler: async (raw, context): Promise<ToolOutput> => {
      const args = (raw ?? {}) as Record<string, unknown>
      const view = await host(lookup, context).read({ coordinatorSessionId: context.sessionId, threadId: text(args.thread, 'thread') })
      const lines = [infoLine(view).slice(2)]
      if (view.applied.length > 0) lines.push(`Brought into the project by its last turn: ${view.applied.join(', ')}`)
      for (const conflict of view.conflicts) lines.push(`Conflict: ${conflict.path} kept as the project has it${conflict.copy === undefined ? '' : `; the thread's version is at ${conflict.copy}`}`)
      lines.push('', 'Last reply:', view.reply.trim() === '' ? '(none)' : view.reply)
      if (view.cut !== undefined) lines.push(`[… ${view.cut} more characters cut]`)
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
  return [start, message, read, list]
}

export const POST_COLLAB_DESCRIPTION = 'Post to the collaboration log this task\'s threads share: a note the others can build on, a claim on the paths you will change (refused when a working thread has claimed them), '
  + 'a handoff (what you produced and where, for the thread that builds on it), or a blocker. Each thread gets the entries for it or about its paths before its next step; the coordinator and the user see the log. '
  + 'The coordinator posts notes, which reach every thread.'

export const READ_COLLAB_DESCRIPTION = 'The collaboration log of this task (with all, of earlier tasks too): notes, claims, handoffs, blockers, messages, and which files each thread\'s turn merged into the project.'

export const MESSAGE_PEER_DESCRIPTION = 'Leave another thread of this task a short message it needs from you (an interface you agreed, a file you changed that it uses, a question about its part). '
  + 'It reaches that thread before its next step, or when its next turn starts. Post a note instead for anything every thread should know.'

export const ASK_COORDINATOR_DESCRIPTION = 'Ask the coordinator something now, without ending your turn (a decision outside your part, a conflict with another thread). It answers with a message that joins your turn; keep working meanwhile.'

/** Organization redo: the collaboration tools (which a session sees is decided when it opens: `PEER_TOOL_NAMES`). */
export function peerTools(lookup: () => (ThreadPeers & ThreadHost) | undefined): Tool[] {
  const peers = (context: ToolContext): ThreadPeers => {
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
      })
      return { content: `Posted to the collaboration log (#${entry.seq}, ${entry.kind}).`, meta: { seq: entry.seq } }
    },
  }
  const read: Tool = {
    definition: definition(READ_COLLAB_TOOL, READ_COLLAB_DESCRIPTION),
    handler: async (raw, context): Promise<ToolOutput> => {
      const args = (raw ?? {}) as Record<string, unknown>
      if (args.all !== undefined && typeof args.all !== 'boolean') throw new NexgentError('tool/invalid-input', '"all" must be a boolean')
      const entries = await peers(context).log({ sessionId: context.sessionId, ...(args.all === true ? { all: true } : {}) })
      if (entries.length === 0) return { content: 'The collaboration log of this task is empty.' }
      return { content: entries.map(entry => renderCollabEntry(entry, context.sessionId)).join('\n') }
    },
  }
  const message: Tool = {
    definition: definition(MESSAGE_PEER_TOOL, MESSAGE_PEER_DESCRIPTION),
    handler: async (raw, context): Promise<ToolOutput> => {
      const args = (raw ?? {}) as Record<string, unknown>
      const sent = await peers(context).messagePeer({ threadId: context.sessionId, to: text(args.to, 'to'), text: text(args.text, 'text') })
      return { content: sent.running ? `Left for "${sent.title}"; it reads it before its next step.` : `Left for "${sent.title}", which is not running; it reads it when its next turn starts.` }
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
  return [post, read, message, ask]
}

/** Organization redo: before each model request of a thread, what its coordinator's collaboration log has for it. */
export function collabProvider(host: SdkThreadHost): ContextProvider {
  return {
    id: 'collab',
    async beginTurn() {
      return {}
    },
    beforeRequest: input => host.deliver(input),
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

/** Pure: the coordinator's system sections for a turn. */
export function coordinatorSections(notes: string): SystemPromptSection[] {
  return [
    { id: 'coordinator', title: 'Coordinating this project', body: COORDINATOR_PROMPT },
    { id: 'coordinator-notes', title: 'Project notes', body: notes.trim() === '' ? '(none yet)' : notes.trim() },
  ]
}

/** Coordinator step three: the coordinator's prompt and notes, for its turns only. */
export function coordinatorProvider(host: SdkThreadHost): ContextProvider {
  return {
    id: 'coordinator',
    async beginTurn(input) {
      if (!(await host.isCoordinator(input.sessionId))) return {}
      return { systemSections: coordinatorSections(await host.readNotes()) }
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
