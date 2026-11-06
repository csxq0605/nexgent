/**
 * Organization redo: the user names the threads of a task (an exact plan is
 * a hard limit), starts a thread themselves, gives threads paths (`owns`),
 * and the host enforces the collaboration variables (`overlap: sequence`,
 * `handoff: changed`); threads share a collaboration log in the project,
 * delivered before each model request (in a hybrid project they also post
 * to it and message each other), and ask the coordinator mid-turn.
 */
import { readFile } from 'node:fs/promises'
import * as nodePath from 'node:path'
import { COLLAB_DELIVERY_LEAD, type CollabEntry, type Context, type LLMRequest } from '@nexgent/kernel'
import { llmSessionText, scriptedProvider, type ScriptedProvider, type ScriptEntry } from '@nexgent/test-support'
import { describe, expect, it } from 'vitest'
import { SdkThreadHost, checkPlan, collabDelivery, ownsOverlap, taskCollaboration } from '../src/index.js'
import { testSdk, waitForEvent, type TestSdk } from './helpers.js'
import { at, host, report } from './threads-fake.js'

const caller = { coordinatorSessionId: 'c', turn: 1 }
const central = { mode: 'central', handoff: 'brief', overlap: 'parallel' }

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
    const api = await t.host.start({ ...caller, title: 'api', task: 'Build the API.' })
    // The user's words go along word for word (relay), not inside the coordinator's brief; the thread carries the user's own title.
    expect(api).toMatchObject({ title: 'API', origin: 'plan' })
    expect(t.started.at(-1)!.text).toBe('Build the API.')
    expect(t.started.at(-1)!.relay).toEqual(['add the /users endpoint', 'the task'])
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
    // A thread without paths, or with paths a running thread's overlap, waits in the queue (and is persisted there).
    await expect(t.host.start({ ...caller, title: 'Docs', task: 'Write docs.' })).resolves.toMatchObject({ status: 'queued' })
    await expect(t.host.start({ ...caller, title: 'Lexer', task: 'Change the lexer.', owns: ['src/parser/lexer.ts'] })).resolves.toMatchObject({ status: 'queued' })
    await expect(t.host.start({ ...caller, title: 'Assets', task: 'Add assets.', owns: ['assets'] })).resolves.toMatchObject({ owns: ['assets'], status: 'running' })
    expect(t.started.at(-1)!.text).toContain('Your part changes only these paths: assets.')
    expect(JSON.parse(await readFile(nodePath.join(t.dir, 'c.queue.json'), 'utf8')).map((item: { title: string }) => item.title)).toEqual(['Docs', 'Lexer'])
    // Once the parser thread has ended, the lexer may start; the docs thread (no paths) waits for every running thread.
    await t.finish('t1', ['src/parser/index.ts'])
    expect((await t.host.list({ coordinatorSessionId: 'c' })).map(thread => `${thread.title}:${thread.status}`)).toEqual(['Parser:done', 'Docs:queued', 'Lexer:running', 'Assets:running'])
    await t.finish('t4')
    await t.finish('t3')
    expect((await t.host.list({ coordinatorSessionId: 'c' })).find(thread => thread.title === 'Docs')?.status).toBe('running')
    // The queue started each turn with its run recorded in the coordinator.
    expect(t.sessions.get('c')!.filter(record => record.type === 'subagent.start').map(record => (record as unknown as { name: string }).name)).toEqual(['parser', 'assets', 'lexer', 'docs'])
  })

  it('lets overlapping threads run together by default, and tells the coordinator which files both changed', async () => {
    const t = await host(central)
    await t.host.start({ ...caller, title: 'A', task: 'Part A.' })
    await t.host.start({ ...caller, title: 'B', task: 'Part B.' })
    await t.finish('t1', ['src/shared.ts'])
    await t.finish('t2', ['src/shared.ts', 'src/b.ts'])
    expect(t.wakes.at(-1)!.text).toContain('src/shared.ts (also "A")')
  })

  it('tells every thread of the task which files the others brought in under handoff: changed', async () => {
    const t = await host({ ...central, handoff: 'changed' })
    await t.host.start({ ...caller, title: 'Schema', task: 'Write the schema.' })
    await t.host.start({ ...caller, title: 'Queries', task: 'Write the queries.' })
    await t.finish('t1', ['db/schema.sql'])
    // The running thread hears it before its next step, once.
    const delivered = await t.host.deliver({ sessionId: 't2', compacted: false })
    expect(delivered?.[0]).toContain(`${COLLAB_DELIVERY_LEAD}:`)
    expect(delivered?.[0]).toContain('"Schema"\'s turn merged into the project [db/schema.sql]')
    await expect(t.host.deliver({ sessionId: 't2', compacted: false })).resolves.toBeUndefined()
    // A thread started later hears it with its first step too.
    await t.host.start({ ...caller, title: 'Docs', task: 'Write docs.' })
    expect((await t.host.deliver({ sessionId: 't3', compacted: false }))?.[0]).toContain('db/schema.sql')
  })

  it('keeps the merges from a central thread under handoff: brief, and keeps what each thread saw across restarts', async () => {
    const t = await host(central)
    await t.host.start({ ...caller, title: 'Schema', task: 'Write the schema.' })
    await t.host.start({ ...caller, title: 'Queries', task: 'Write the queries.' })
    await t.finish('t1', ['db/schema.sql'])
    await expect(t.host.deliver({ sessionId: 't2', compacted: false })).resolves.toBeUndefined()
    // The coordinator's notes reach every thread, in either mode.
    await t.host.post({ sessionId: 'c', kind: 'note', text: 'The user wants SQLite.' })
    expect((await t.host.deliver({ sessionId: 't2', compacted: false }))?.[0]).toContain('the coordinator notes: The user wants SQLite.')
    const again = new SdkThreadHost(t.rt)
    await expect(again.deliver({ sessionId: 't2', compacted: false })).resolves.toBeUndefined()
    // The log is in the project and never tracked.
    expect(await readFile(nodePath.join(t.dir, '.gitignore'), 'utf8')).toContain('*')
    expect((await readFile(nodePath.join(t.dir, 'c.jsonl'), 'utf8')).trim().split('\n').map(line => (JSON.parse(line) as CollabEntry).kind)).toEqual(['merged', 'note'])
  })
})

describe('threads that work together (hybrid)', () => {
  const hybrid = { ...central, mode: 'hybrid' }

  it('tells a thread about the log, and refuses a claim on paths a working thread has claimed', async () => {
    const t = await host(hybrid)
    await t.host.start({ ...caller, title: 'API', task: 'Build the API.' })
    await t.host.start({ ...caller, title: 'Client', task: 'Build the client.' })
    expect(t.started.at(-1)!.text).toMatch(/running now: "API"/)
    expect(t.started.at(-1)!.text).toContain('reaches you on its own before each step')
    await t.host.post({ sessionId: 't1', kind: 'claim', text: 'I change the routes.', paths: ['src/routes'] })
    await expect(t.host.post({ sessionId: 't2', kind: 'claim', text: 'Me too.', paths: ['src/routes/users.ts'] })).rejects.toThrow(/"API" has claimed src\/routes/)
    await t.host.post({ sessionId: 't2', kind: 'note', text: 'The client uses fetch.' })
    await expect(t.host.post({ sessionId: 't2', kind: 'claim', text: 'No paths.' })).rejects.toThrow(/names the paths/)
    await expect(t.host.post({ sessionId: 'c', kind: 'claim', text: 'Mine.', paths: ['x'] })).rejects.toThrow(/posts notes/)
    await expect(t.host.post({ sessionId: 'nobody', kind: 'note', text: 'x' })).rejects.toThrow(/only threads/)
    // Once the API thread has ended, its claim no longer stands.
    await t.finish('t1')
    await expect(t.host.post({ sessionId: 't2', kind: 'claim', text: 'Now me.', paths: ['src/routes/users.ts'] })).resolves.toMatchObject({ seq: 4 })
    // The coordinator reads the same log.
    expect((await t.host.log({ sessionId: 'c' })).map(entry => `${entry.fromTitle}:${entry.kind}`)).toEqual(['API:claim', 'Client:note', 'API:release', 'Client:claim'])
  })

  it('delivers a message between threads before the next step or with the next turn, once, and wakes the coordinator for a question', async () => {
    const t = await host(hybrid)
    await t.host.start({ ...caller, title: 'API', task: 'Build the API.' })
    await t.host.start({ ...caller, title: 'Client', task: 'Build the client.' })
    await expect(t.host.messagePeer({ threadId: 't1', to: 'client', text: 'GET /users returns a list.' })).resolves.toEqual({ title: 'Client', running: true })
    expect((await t.host.deliver({ sessionId: 't2', compacted: false }))?.[0]).toContain('#1 "API" to you: GET /users returns a list.')
    // Not a steer: nothing joins the turn as the coordinator's.
    expect(t.steered).toEqual([])
    await expect(t.host.messagePeer({ threadId: 't1', to: 'Client', text: 'GET /users returns a list.' })).rejects.toThrow(/already sent/)
    await expect(t.host.messagePeer({ threadId: 't1', to: 'Nobody', text: 'Hi.' })).rejects.toThrow(/no other thread "Nobody"/)
    // A thread not running reads the message when its next turn starts; its coordinator is told one waits.
    await t.finish('t2')
    await expect(t.host.messagePeer({ threadId: 't1', to: 'Client', text: 'Also GET /users/:id.' })).resolves.toMatchObject({ running: false })
    await t.finish('t1')
    expect(t.wakes.at(-1)!.text).toContain('Thread "API" left a message for "Client"')
    await t.host.message({ ...caller, threadId: 't2', text: 'Add the user page.' })
    expect(t.started.at(-1)!.text).toBe('Add the user page.')
    expect((await t.host.deliver({ sessionId: 't2', compacted: false }))?.[0]).toContain('"API" to you: Also GET /users/:id.')
    // A question to the coordinator is logged and wakes it; a thread asks only a few times a turn.
    await t.host.ask({ threadId: 't2', text: 'Paginate the list?' })
    expect(t.wakes.at(-1)).toMatchObject({ sessionId: 'c' })
    expect(t.wakes.at(-1)!.text).toMatch(/Thread "Client" \(t2\) asks you while it keeps working \(collaboration log #\d+\): Paginate the list\?/)
    expect((await t.host.log({ sessionId: 't2' })).at(-1)).toMatchObject({ kind: 'ask', text: 'Paginate the list?' })
  })

  it('delivers in full what concerns a thread\'s paths and counts the rest; after a compaction, re-sends what still holds', async () => {
    const t = await host(hybrid)
    await t.host.start({ ...caller, title: 'API', task: 'Build the API.', owns: ['src/api'] })
    await t.host.start({ ...caller, title: 'UI', task: 'Build the UI.', owns: ['src/ui'] })
    await t.host.start({ ...caller, title: 'Docs', task: 'Write the docs.', owns: ['docs'] })
    await t.host.post({ sessionId: 't1', kind: 'claim', text: 'Routes.', paths: ['src/api/routes'] })
    await t.host.post({ sessionId: 't3', kind: 'handoff', text: 'Usage page done.', paths: ['src/ui/help.md'] })
    const ui = (await t.host.deliver({ sessionId: 't2', compacted: false }))![0]!
    expect(ui).toContain('"Docs" hands off [src/ui/help.md]: Usage page done.')
    expect(ui).not.toContain('Routes.')
    expect(ui).toContain('1 other new entry is not about your paths')
    await expect(t.host.deliver({ sessionId: 't2', compacted: false })).resolves.toBeUndefined()
    const after = (await t.host.deliver({ sessionId: 't2', compacted: true }))![0]!
    expect(after).toContain('Still in force from earlier in this task')
    expect(after).toContain('Usage page done.')
  })

  it('marks a new task in the log at once: earlier claims and message limits no longer count', async () => {
    const t = await host(hybrid)
    await t.host.start({ ...caller, title: 'API', task: 'Build the API.' })
    await t.host.start({ ...caller, title: 'Client', task: 'Build the client.' })
    await t.host.post({ sessionId: 't1', kind: 'claim', text: 'Routes.', paths: ['src/routes'] })
    await t.host.messagePeer({ threadId: 't1', to: 'Client', text: 'Same text.' })
    t.host.newTask('c')
    await expect(t.host.post({ sessionId: 't2', kind: 'claim', text: 'Mine now.', paths: ['src/routes'] })).resolves.toMatchObject({ kind: 'claim' })
    await expect(t.host.messagePeer({ threadId: 't1', to: 'Client', text: 'Same text.' })).resolves.toMatchObject({ title: 'Client' })
    expect((await t.host.log({ sessionId: 'c', all: true })).map(entry => entry.kind)).toEqual(['claim', 'message', 'task', 'claim', 'message'])
  })

  it('a new task starts the log afresh for the threads', () => {
    const entries: CollabEntry[] = [
      { seq: 1, at, from: 't1', fromTitle: 'A', kind: 'note', text: 'old' },
      { seq: 2, at, from: 'c', fromTitle: 'coordinator', kind: 'task', text: '' },
      { seq: 3, at, from: 't1', fromTitle: 'A', kind: 'note', text: 'new' },
    ]
    const text = collabDelivery({ entries, reader: { sessionId: 't2' }, coordinatorSessionId: 'c', cursor: 2, collaboration: { mode: 'hybrid', handoff: 'brief' }, compacted: true, working: () => true })
    expect(text).toContain('"A" notes: new')
    expect(text).not.toContain('old')
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
  it('sends the user\'s threads with the message, and gives the collaboration tools to threads only in a hybrid project', async () => {
    const t = await threadSdk([
      { toolCalls: [{ name: 'start_thread', arguments: { title: 'Notes', task: 'Write out/notes.md.' } }] },
      { content: 'Started.' },
      { content: 'Done.' },
    ], {
      Notes: [
        { toolCalls: [{ name: 'read_collab', arguments: {} }] },
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
    expect(tools(undefined)).toEqual(expect.arrayContaining(['post_collab', 'read_collab']))
    expect(tools(undefined)).not.toContain('message_peer')
    expect(tools(undefined)).not.toContain('ask_coordinator')
    expect(tools('Notes')).toEqual(expect.arrayContaining(['post_collab', 'read_collab', 'message_peer', 'ask_coordinator']))
    await expect(t.sdk.call('threads.collab', { projectId: project.projectId, sessionId: coordinator.sessionId })).resolves.toEqual([])
  })

  it('keeps post_collab away from threads of a central project but gives them reading and asking, and lets the user start a thread', async () => {
    const t = await threadSdk([{ content: 'Followed up.' }], { Mine: [{ content: report('fixed it') }] })
    const project = await t.sdk.call('projects.open', { root: nodePath.join(t.base, 'p'), create: true })
    const coordinator = await t.sdk.call('sessions.coordinator', { projectId: project.projectId })
    const info = await t.sdk.call('threads.start', { projectId: project.projectId, sessionId: coordinator.sessionId, title: 'Mine', task: 'Fix it.' })
    expect(info).toMatchObject({ title: 'Mine', origin: 'user' })
    await waitForEvent(t, event => event.sessionId === coordinator.sessionId && event.type === 'turn.end' && event.turn === 1)
    expect(messageText(t.llm().calls.find(call => call.route === undefined)!.request)).toContain('The user started thread "Mine" themselves')
    const tools = t.llm().calls.find(call => call.route === 'Mine')!.request.tools?.map(tool => tool.name) ?? []
    expect(tools).not.toContain('post_collab')
    expect(tools).toContain('read_collab')
    expect(tools).toContain('read_merged')
    expect(tools).toContain('ask_coordinator')
  })
})
