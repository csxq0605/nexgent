/**
 * Organization redo: the user names the threads of a task (an exact plan is
 * a hard limit), starts a thread themselves, gives threads paths (`owns`),
 * and the host enforces the collaboration variables (`overlap: sequence`,
 * `handoff: manifest`) and, in a hybrid project, lets threads work together
 * (board, messages between threads, questions to the coordinator).
 */
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import * as nodePath from 'node:path'
import { ZERO_USAGE, type Context, type LLMRequest, type SessionRecord, type ThreadOrigin, type TurnResult, type WorkdirMerge } from '@nexgent/kernel'
import { llmSessionText, scriptedProvider, type ScriptedProvider, type ScriptEntry } from '@nexgent/test-support'
import { describe, expect, it } from 'vitest'
import { SdkThreadHost, checkPlan, manifestLines, ownsOverlap, taskCollaboration, type ThreadRuntime } from '../src/index.js'
import { testSdk, waitForEvent, type TestSdk } from './helpers.js'

const at = '2026-11-06T00:00:00.000Z'
const report = (done: string, blockers = 'none') => `Done: ${done}\nNot done: none\nChecks: none\nBlockers: ${blockers}`

/** An in-memory runtime: sessions are record lists; turns end when the test says so. */
function fakeRuntime(boards: string) {
  const sessions = new Map<string, SessionRecord[]>()
  const running = new Set<string>()
  const finishers = new Map<string, (result: TurnResult) => void>()
  const merges = new Map<string, WorkdirMerge>()
  const started: { sessionId: string; text: string; source: string }[] = []
  const steered: { sessionId: string; text: string }[] = []
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
    async startTurn(sessionId, text, _materialIds, source = 'thread') {
      started.push({ sessionId, text, source })
      const turn = sessions.get(sessionId)!.filter(record => record.type === 'turn.start').length + 1
      push(sessionId, { type: 'turn.start', turn })
      push(sessionId, { type: 'user.message', turn, source, content: text })
      running.add(sessionId)
      const done = new Promise<TurnResult>(resolve => finishers.set(sessionId, resolve))
      return { turn, done }
    },
    async steer(sessionId, text) {
      if (!running.has(sessionId)) return false
      steered.push({ sessionId, text })
      return true
    },
    running: sessionId => running.has(sessionId),
    async turnDone() {},
    async wake(sessionId, text) {
      wakes.push({ sessionId, text })
    },
    async threadIds(coordinatorSessionId) {
      return [...sessions].filter(([, list]) => list[0]?.type === 'session.start' && list[0].thread?.coordinatorSessionId === coordinatorSessionId).map(([id]) => id)
    },
    lastMerge: sessionId => merges.get(sessionId),
    costOf: () => undefined,
    organizations: () => undefined,
    closed: () => false,
    report(_sessionId, error) {
      throw error
    },
    needsApproval: () => false,
    isCoordinator: async sessionId => sessionId === 'c',
    notesFile: () => nodePath.join(boards, 'notes.md'),
    boardsDir: () => boards,
  }
  /** End a thread's running turn with a report (and what its merge brought in). */
  async function finish(sessionId: string, applied: readonly string[] = []): Promise<void> {
    const turn = sessions.get(sessionId)!.filter(record => record.type === 'turn.start').length
    const text = report('its part')
    push(sessionId, { type: 'assistant.message', turn, step: 1, content: text, usage: ZERO_USAGE })
    push(sessionId, { type: 'turn.end', turn, reason: { kind: 'completed' } })
    running.delete(sessionId)
    const merge: WorkdirMerge = { applied: [...applied], merged: [], conflicts: [] }
    if (applied.length > 0) merges.set(sessionId, merge)
    finishers.get(sessionId)!({ sessionId, turn, reason: { kind: 'completed' }, text, usage: ZERO_USAGE, ...(applied.length > 0 ? { merge } : {}) })
    // Let the host record the run's end and wake the coordinator.
    const woken = wakes.length
    for (let i = 0; i < 500 && wakes.length === woken; i += 1) await new Promise(resolve => setImmediate(resolve))
  }
  /** The coordinator's current task runs with this arrangement (its user turn's decision). */
  function userTurn(collaboration?: Record<string, unknown>): void {
    const turn = sessions.get('c')!.filter(record => record.type === 'turn.start').length + 1
    push('c', { type: 'turn.start', turn, ...(collaboration === undefined ? {} : { organization: { collaboration } }) })
    push('c', { type: 'user.message', turn, source: 'user', content: 'the task' })
  }
  return { rt, started, steered, wakes, finish, userTurn, sessions }
}

async function host(collaboration?: Record<string, unknown>) {
  const fake = fakeRuntime(await mkdtemp(nodePath.join(tmpdir(), 'nexgent-boards-')))
  fake.userTurn(collaboration)
  return { ...fake, host: new SdkThreadHost(fake.rt) }
}

const caller = { coordinatorSessionId: 'c', turn: 1 }
const central = { mode: 'central', handoff: 'summary', overlap: 'parallel' }

describe('the user\'s threads', () => {
  it('checks a plan: titles, at most a few threads, no title twice', () => {
    expect(checkPlan({ threads: [{ title: '  API  ', task: ' the endpoints ' }, { title: 'UI' }], exact: true })).toEqual({ threads: [{ title: 'API', task: 'the endpoints' }, { title: 'UI' }], exact: true })
    expect(() => checkPlan({ threads: [], exact: true })).toThrow(/1 to/)
    expect(() => checkPlan({ threads: [{ title: 'API' }, { title: 'api' }], exact: true })).toThrow(/twice|two threads/)
  })

  it('starts exactly the threads of an exact plan, each once, with the user\'s words', async () => {
    const t = await host()
    t.host.newTask('c', { threads: [{ title: 'API', task: 'add the /users endpoint' }, { title: 'UI' }], exact: true })
    await expect(t.host.start({ ...caller, title: 'Docs', task: 'Write the docs.' })).rejects.toThrow(/exactly these threads.*"API", "UI"/)
    await t.host.start({ ...caller, title: 'api', task: 'Build the API.' })
    expect(t.started.at(-1)!.text).toContain('The user\'s own words for this part: add the /users endpoint')
    await expect(t.host.start({ ...caller, title: 'API', task: 'Again.' })).rejects.toThrow(/"UI"/)
    await t.host.start({ ...caller, title: 'UI', task: 'Build the UI.' })
    await expect(t.host.start({ ...caller, title: 'Tests', task: 'Test it.' })).rejects.toThrow(/already started/)
    // A suggestion (not exact) limits nothing; a new task without a plan neither.
    t.host.newTask('c', { threads: [{ title: 'API' }], exact: false })
    await t.finish('t1')
    await expect(t.host.start({ ...caller, title: 'Docs', task: 'Write the docs.' })).resolves.toMatchObject({ title: 'Docs' })
  })

  it('starts a thread the user asked for, marked as theirs, and wakes the coordinator when it ends', async () => {
    const t = await host()
    const info = await t.host.startByUser({ coordinatorSessionId: 'c', title: 'Fix the login', task: 'The login page loops; fix it.', owns: ['src/login'] })
    expect(info).toMatchObject({ title: 'Fix the login', origin: 'user', owns: ['src/login'], status: 'running' })
    expect(t.started.at(-1)).toMatchObject({ sessionId: info.threadId, text: 'The login page loops; fix it.', source: 'user' })
    // Not one of the coordinator's runs.
    expect(t.sessions.get('c')!.some(record => record.type === 'subagent.start')).toBe(false)
    await t.finish(info.threadId, ['src/login/page.ts', 'README.md'])
    expect(t.wakes.at(-1)!.text).toMatch(/The user started thread "Fix the login" themselves/)
    expect(t.wakes.at(-1)!.text).toContain('outside the paths its part was given: README.md')
  })
})

describe('collaboration the host enforces', () => {
  it('reads the task\'s arrangement from the coordinator\'s user turn', async () => {
    const t = await host({ ...central, overlap: 'sequence' })
    expect(taskCollaboration(await t.rt.records('c'))).toMatchObject({ overlap: 'sequence' })
    expect(ownsOverlap(['src/a'], ['src/a/x.ts'])).toBe(true)
    expect(ownsOverlap(['src/a'], ['src/b'])).toBe(false)
    expect(ownsOverlap(undefined, ['src/b'])).toBe(true)
  })

  it('runs threads whose paths overlap one after another under overlap: sequence', async () => {
    const t = await host({ ...central, overlap: 'sequence' })
    await t.host.start({ ...caller, title: 'Parser', task: 'Change the parser.', owns: ['src/parser'] })
    await expect(t.host.start({ ...caller, title: 'Docs', task: 'Write docs.' })).rejects.toThrow(/give this thread `owns`/)
    await expect(t.host.start({ ...caller, title: 'Lexer', task: 'Change the lexer.', owns: ['src/parser/lexer.ts'] })).rejects.toThrow(/overlap.*"Parser": src\/parser/)
    await expect(t.host.start({ ...caller, title: 'Docs', task: 'Write docs.', owns: ['docs'] })).resolves.toMatchObject({ owns: ['docs'] })
    expect(t.started.at(-1)!.text).toContain('Your part changes only these paths: docs.')
    // Once the parser thread has ended, the lexer may start.
    await t.finish('t1', ['src/parser/index.ts'])
    await expect(t.host.start({ ...caller, title: 'Lexer', task: 'Change the lexer.', owns: ['src/parser/lexer.ts'] })).resolves.toMatchObject({ title: 'Lexer' })
  })

  it('lets overlapping threads run together by default, and tells the coordinator which files both changed', async () => {
    const t = await host(central)
    await t.host.start({ ...caller, title: 'A', task: 'Part A.' })
    await t.host.start({ ...caller, title: 'B', task: 'Part B.' })
    await t.finish('t1', ['src/shared.ts'])
    await t.finish('t2', ['src/shared.ts', 'src/b.ts'])
    expect(t.wakes.at(-1)!.text).toContain('src/shared.ts (also "A")')
  })

  it('hands a new thread the files the earlier threads brought in under handoff: manifest', async () => {
    const t = await host({ ...central, handoff: 'manifest' })
    await t.host.start({ ...caller, title: 'Schema', task: 'Write the schema.' })
    await t.finish('t1', ['db/schema.sql'])
    await t.host.start({ ...caller, title: 'Queries', task: 'Write the queries.' })
    expect(t.started.at(-1)!.text).toContain('- Schema: db/schema.sql')
    expect(manifestLines([{ threadId: 'x', childTurn: 1, name: 'x', ended: false, applied: ['a'] }])).toEqual([])
  })
})

describe('threads that work together (hybrid)', () => {
  const hybrid = { ...central, mode: 'hybrid' }

  it('tells a thread about the board, and refuses a claim on paths a working thread has claimed', async () => {
    const t = await host(hybrid)
    await t.host.start({ ...caller, title: 'API', task: 'Build the API.' })
    await t.host.start({ ...caller, title: 'Client', task: 'Build the client.' })
    expect(t.started.at(-1)!.text).toMatch(/running now: "API"/)
    await t.host.post({ threadId: 't1', kind: 'claim', text: 'I change the routes.', paths: ['src/routes'] })
    await expect(t.host.post({ threadId: 't2', kind: 'claim', text: 'Me too.', paths: ['src/routes/users.ts'] })).rejects.toThrow(/"API" has claimed src\/routes/)
    await t.host.post({ threadId: 't2', kind: 'fact', text: 'The client uses fetch.' })
    await expect(t.host.post({ threadId: 't2', kind: 'claim', text: 'No paths.' })).rejects.toThrow(/names the paths/)
    // Once the API thread has ended, its claim no longer stands.
    await t.finish('t1')
    await expect(t.host.post({ threadId: 't2', kind: 'claim', text: 'Now me.', paths: ['src/routes/users.ts'] })).resolves.toMatchObject({ seq: 3 })
    // The coordinator reads the same board.
    expect((await t.host.board({ sessionId: 'c' })).map(entry => `${entry.thread}:${entry.kind}`)).toEqual(['API:claim', 'Client:fact', 'Client:claim'])
  })

  it('delivers a message between threads now or with the next turn, once, and wakes the coordinator for a question', async () => {
    const t = await host(hybrid)
    await t.host.start({ ...caller, title: 'API', task: 'Build the API.' })
    await t.host.start({ ...caller, title: 'Client', task: 'Build the client.' })
    await expect(t.host.messagePeer({ threadId: 't1', to: 'client', text: 'GET /users returns a list.' })).resolves.toEqual({ delivered: 'now', title: 'Client' })
    expect(t.steered.at(-1)).toMatchObject({ sessionId: 't2' })
    expect(t.steered.at(-1)!.text).toMatch(/from thread "API" \(another agent, not the user/)
    await expect(t.host.messagePeer({ threadId: 't1', to: 'Client', text: 'GET /users returns a list.' })).rejects.toThrow(/already sent/)
    await expect(t.host.messagePeer({ threadId: 't1', to: 'Nobody', text: 'Hi.' })).rejects.toThrow(/no other thread "Nobody"/)
    // A thread not running gets the message when its next turn starts.
    await t.finish('t2')
    await expect(t.host.messagePeer({ threadId: 't1', to: 'Client', text: 'Also GET /users/:id.' })).resolves.toMatchObject({ delivered: 'next-turn' })
    await t.host.message({ ...caller, threadId: 't2', text: 'Add the user page.' })
    expect(t.started.at(-1)!.text).toMatch(/from thread "API".*Also GET \/users\/:id\.\n\nAdd the user page\./s)
    // A question to the coordinator wakes it; a thread asks only a few times a turn.
    await t.host.ask({ threadId: 't1', text: 'Paginate the list?' })
    expect(t.wakes.at(-1)).toMatchObject({ sessionId: 'c' })
    expect(t.wakes.at(-1)!.text).toMatch(/Thread "API" \(t1\) asks you while it keeps working: Paginate the list\?/)
    // Only threads use the board and the messages.
    await expect(t.host.post({ threadId: 'c', kind: 'fact', text: 'x' })).rejects.toThrow(/only threads/)
  })
})

// ---------------------------------------------------------------------------
// through the SDK
// ---------------------------------------------------------------------------

const THREAD_LINE = /You are a thread of this project's coordinator conversation, working on "([^"]+)"/

async function threadSdk(main: ScriptEntry<LLMRequest>[], threads: Record<string, ScriptEntry<LLMRequest>[]>): Promise<TestSdk & { readonly llm: () => ScriptedProvider }> {
  let provider: ScriptedProvider | undefined
  const t = await testSdk([], {
    registry: {
      '@nexgent/llm': {
        name: 'scripted-llm',
        apply(ctx: Context) {
          provider = scriptedProvider(main, { routeKey: request => THREAD_LINE.exec(llmSessionText(request))?.[1], routes: threads })
          ctx.provide('llm', provider)
        },
      },
    },
  })
  return { ...t, llm: () => provider! }
}

/** The text of a request's messages. */
const messageText = (request: LLMRequest) => request.messages.map(message => (typeof message.content === 'string' ? message.content : JSON.stringify(message.content))).join('\n')

describe('collaboration through the SDK', () => {
  it('sends the user\'s threads with the message, and gives the board tools to threads only in a hybrid project', async () => {
    const t = await threadSdk([
      { toolCalls: [{ name: 'start_thread', arguments: { title: 'Notes', task: 'Write out/notes.md.' } }] },
      { content: 'Started.' },
      { content: 'Done.' },
    ], {
      Notes: [
        { toolCalls: [{ name: 'read_board', arguments: {} }] },
        { content: report('nothing to do') },
      ],
    })
    const project = await t.sdk.call('projects.open', { root: nodePath.join(t.base, 'p'), create: true })
    // The coordinator is open before the switch: it reopens with the new mode.
    const coordinator = await t.sdk.call('sessions.coordinator', { projectId: project.projectId })
    await t.sdk.call('settings.update', { projectId: project.projectId, patch: { collaboration: 'hybrid' } })
    expect(await t.sdk.call('settings.get', { projectId: project.projectId })).toMatchObject({ collaboration: 'hybrid' })
    await t.sdk.call('turns.send', { projectId: project.projectId, sessionId: coordinator.sessionId, text: 'Write the notes.', threads: [{ title: 'Notes', task: 'only the notes' }] })
    await waitForEvent(t, event => event.sessionId === coordinator.sessionId && event.type === 'turn.end' && event.turn === 2)

    const first = t.llm().calls.find(call => call.route === undefined)!
    expect(messageText(first.request)).toContain('Threads I want for this task (start exactly these, with these titles, and no others):\n1. Notes: only the notes')
    const tools = (route: string | undefined) => t.llm().calls.find(call => call.route === route)!.request.tools?.map(tool => tool.name) ?? []
    expect(tools(undefined)).toContain('read_board')
    expect(tools(undefined)).not.toContain('post_board')
    expect(tools('Notes')).toEqual(expect.arrayContaining(['post_board', 'read_board', 'message_peer', 'ask_coordinator']))
    await expect(t.sdk.call('threads.board', { projectId: project.projectId, sessionId: coordinator.sessionId })).resolves.toEqual([])
  })

  it('keeps the board tools away from a central project, and lets the user start a thread', async () => {
    const t = await threadSdk([{ content: 'Followed up.' }], { Mine: [{ content: report('fixed it') }] })
    const project = await t.sdk.call('projects.open', { root: nodePath.join(t.base, 'p'), create: true })
    const coordinator = await t.sdk.call('sessions.coordinator', { projectId: project.projectId })
    const info = await t.sdk.call('threads.start', { projectId: project.projectId, sessionId: coordinator.sessionId, title: 'Mine', task: 'Fix it.' })
    expect(info).toMatchObject({ title: 'Mine', origin: 'user' })
    await waitForEvent(t, event => event.sessionId === coordinator.sessionId && event.type === 'turn.end' && event.turn === 1)
    expect(messageText(t.llm().calls.find(call => call.route === undefined)!.request)).toContain('The user started thread "Mine" themselves')
    const tools = t.llm().calls.find(call => call.route === 'Mine')!.request.tools?.map(tool => tool.name) ?? []
    expect(tools).not.toContain('post_board')
    expect(tools).not.toContain('read_board')
  })
})
