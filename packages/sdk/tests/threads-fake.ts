/** An in-memory thread runtime for the thread host's tests: sessions are record lists; turns end when the test says so. */
import { ZERO_USAGE, type OrganizationMemory, type SessionRecord, type ThreadOrigin, type TurnResult, type WorkdirMerge } from '@nexgent/kernel'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import * as nodePath from 'node:path'
import { SdkThreadHost, type ThreadRuntime } from '../src/index.js'

export const at = '2026-11-06T00:00:00.000Z'
export const report = (done: string, blockers = 'none') => `Done: ${done}\nNot done: none\nChecks: none\nBlockers: ${blockers}`

/** An in-memory runtime: sessions are record lists; turns end when the test says so. */
export function fakeRuntime(boards: string, project = boards) {
  let mode: 'central' | 'hybrid' = 'central'
  const sessions = new Map<string, SessionRecord[]>()
  const running = new Set<string>()
  const finishers = new Map<string, (result: TurnResult) => void>()
  const dones = new Map<string, Promise<TurnResult>>()
  const merges = new Map<string, WorkdirMerge>()
  const started: { sessionId: string; text: string; source: string; relay?: readonly string[] }[] = []
  const cancelled: string[] = []
  let attached: SdkThreadHost | undefined
  let slots = 3
  const unisolated = new Set<string>()
  let memory: OrganizationMemory | undefined
  const steered: { sessionId: string; text: string; relay?: readonly string[] }[] = []
  const wakes: { sessionId: string; text: string }[] = []
  let next = 0
  const push = (sessionId: string, record: Record<string, unknown>) => {
    const list = sessions.get(sessionId)!
    list.push({ ts: at, seq: list.length + 1, ...record } as unknown as SessionRecord)
  }
  sessions.set('c', [])
  push('c', { type: 'session.start' })
  const rt: ThreadRuntime = {
    async create(input: { readonly title: string; readonly thread: ThreadOrigin }) {
      next += 1
      const id = `t${next}`
      sessions.set(id, [])
      push(id, { type: 'session.start', thread: input.thread })
      return id
    },
    async ensureOpen() {},
    async records(sessionId) {
      const list = sessions.get(sessionId)
      if (list === undefined) throw new Error(`no session ${sessionId}`)
      return [...list]
    },
    async append(sessionId, record) {
      push(sessionId, record as unknown as Record<string, unknown>)
    },
    async startTurn(sessionId, text, _materialIds, source = 'thread', relay) {
      // Like the SDK: a turn that has ended but is not settled yet is waited for.
      while (dones.has(sessionId) && !running.has(sessionId)) await dones.get(sessionId)!.catch(() => undefined)
      started.push({ sessionId, text, source, ...(relay === undefined ? {} : { relay }) })
      const turn = sessions.get(sessionId)!.filter(record => record.type === 'turn.start').length + 1
      push(sessionId, { type: 'turn.start', turn })
      push(sessionId, { type: 'user.message', turn, source, content: text })
      for (const words of relay ?? []) push(sessionId, { type: 'user.message', turn, source: 'relay', content: words })
      running.add(sessionId)
      const done = new Promise<TurnResult>(resolve => finishers.set(sessionId, resolve)).finally(() => {
        if (dones.get(sessionId) === done) dones.delete(sessionId)
      })
      dones.set(sessionId, done)
      return { turn, done }
    },
    async steer(sessionId, text, relay) {
      if (!running.has(sessionId)) return false
      steered.push({ sessionId, text, ...(relay === undefined ? {} : { relay }) })
      for (const words of relay ?? []) push(sessionId, { type: 'user.message', turn: 1, source: 'relay', content: words })
      return true
    },
    async cancel(sessionId) {
      cancelled.push(sessionId)
      await end(sessionId, { kind: 'cancelled', cause: 'user' })
    },
    maxRunning: async () => slots,
    projectRoot: () => project,
    isolated: sessionId => (unisolated.has(sessionId) ? false : undefined),
    running: sessionId => running.has(sessionId),
    async turnDone(sessionId) {
      await dones.get(sessionId)?.catch(() => undefined)
    },
    async wake(sessionId, text) {
      wakes.push({ sessionId, text })
    },
    async threadIds(coordinatorSessionId) {
      return [...sessions].filter(([, list]) => list[0]?.type === 'session.start' && list[0].thread?.coordinatorSessionId === coordinatorSessionId).map(([id]) => id)
    },
    lastMerge: sessionId => merges.get(sessionId),
    costOf: () => undefined,
    organizations: () => memory,
    closed: () => false,
    report(_sessionId, error) {
      throw error
    },
    needsApproval: () => false,
    isCoordinator: async sessionId => sessionId === 'c',
    notesFile: () => nodePath.join(boards, 'notes.md'),
    collabDir: () => boards,
    collaborationMode: async () => mode,
  }
  /** End a thread's running turn (the SDK tells the host, then the turn's promise settles). */
  async function end(sessionId: string, reason: TurnResult['reason'], applied: readonly string[] = [], text = report('its part')): Promise<void> {
    const turn = sessions.get(sessionId)!.filter(record => record.type === 'turn.start').length
    push(sessionId, { type: 'assistant.message', turn, step: 1, content: text, usage: ZERO_USAGE })
    push(sessionId, { type: 'turn.end', turn, reason })
    running.delete(sessionId)
    const merge: WorkdirMerge = { applied: [...applied], merged: [], conflicts: [] }
    if (applied.length > 0) merges.set(sessionId, merge)
    const result: TurnResult = { sessionId, turn, reason, text, usage: ZERO_USAGE, ...(applied.length > 0 ? { merge } : {}) }
    await attached?.turnEnded(sessionId, result)
    finishers.get(sessionId)!(result)
    // The host's follow-up of the settled turn (the queue) runs after it.
    await new Promise(resolve => setImmediate(resolve))
  }
  /** End a thread's running turn with a report (and what its merge brought in), and let the host wake the coordinator. */
  async function finish(sessionId: string, applied: readonly string[] = []): Promise<void> {
    const woken = wakes.length
    await end(sessionId, { kind: 'completed' }, applied)
    for (let i = 0; i < 400 && wakes.length === woken; i += 1) await new Promise(resolve => setTimeout(resolve, 5))
  }
  /** The coordinator's current task runs with this arrangement (its user turn's decision). */
  function userTurn(collaboration?: Record<string, unknown>): void {
    mode = collaboration?.mode === 'hybrid' ? 'hybrid' : 'central'
    const turn = sessions.get('c')!.filter(record => record.type === 'turn.start').length + 1
    push('c', { type: 'turn.start', turn, ...(collaboration === undefined ? {} : { organization: { collaboration } }) })
    push('c', { type: 'user.message', turn, source: 'user', content: 'the task' })
  }
  return { rt, started, steered, wakes, cancelled, finish, userTurn, sessions, dir: boards, project, attach: (threads: SdkThreadHost) => { attached = threads }, setSlots: (n: number) => { slots = n }, endTurn: end, unisolated, setOrganizations: (value: OrganizationMemory) => { memory = value } }
}

export async function host(collaboration?: Record<string, unknown>) {
  const fake = fakeRuntime(await mkdtemp(nodePath.join(tmpdir(), 'nexgent-boards-')), await mkdtemp(nodePath.join(tmpdir(), 'nexgent-project-')))
  fake.userTurn(collaboration)
  const threads = new SdkThreadHost(fake.rt)
  fake.attach(threads)
  return { ...fake, host: threads }
}

