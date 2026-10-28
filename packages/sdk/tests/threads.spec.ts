/**
 * Coordinator step two through the SDK: a conversation hands work to a
 * thread (`start_thread`); the thread runs in the background in its own copy
 * of the project, its turn is recorded in the conversation as a member run
 * (`executionForm: thread`), its files are merged back, and its end wakes
 * the conversation (`user.message.source: thread`). A thread that asks a
 * question waits; `message_thread` answers it. Once a turn's threads have
 * all ended, the organization library gets the turn's full profile.
 */
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import * as nodePath from 'node:path'
import { resolveUserDataLayout, type Context, type LLMRequest, type SessionRecord } from '@nexgent/kernel'
import { llmSessionText, scriptedProvider, type ScriptedProvider, type ScriptEntry } from '@nexgent/test-support'
import { describe, expect, it } from 'vitest'
import { COORDINATOR_NOTES_FILE, SdkThreadHost, threadRunName, threadStatusOf, type SdkEvent, type ThreadRuntime } from '../src/index.js'
import { testSdk, waitForEvent, type TestSdk } from './helpers.js'

const THREAD_LINE = /You are a thread of this project's coordinator conversation, working on "([^"]+)"/

/** An SDK whose scripted model answers threads from `threads[title]` and everything else from `main`. */
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

const report = (done: string, blockers = 'none') => `Done: ${done}\nNot done: none\nChecks: none\nBlockers: ${blockers}`

async function recordsOf(t: TestSdk, projectId: string, sessionId: string): Promise<readonly SessionRecord[]> {
  const view = await t.sdk.call('sessions.view', { projectId, sessionId })
  expect(view.summary.sessionId).toBe(sessionId)
  return (await (t.sdk as unknown as { projects: Map<string, { app: { ctx: { session: { readAll(id: string): Promise<{ records: SessionRecord[] }> } } } }> }).projects.get(projectId)!.app.ctx.session.readAll(sessionId)).records
}

const turnEnd = (sessionId: string, turn: number) => (event: SdkEvent) => event.sessionId === sessionId && event.type === 'turn.end' && event.turn === turn

describe('threads through the SDK', () => {
  it('runs a thread in the background, merges its files, records it as a run and wakes the conversation', async () => {
    const t = await threadSdk([
      { toolCalls: [{ name: 'start_thread', arguments: { title: 'Summary', task: 'Write out/a.md with the summary.' } }] },
      { content: 'A thread is writing the summary.' },
      // Woken by the thread.
      { content: 'The summary is in out/a.md.' },
    ], {
      Summary: [
        { toolCalls: [{ name: 'write_file', arguments: { path: 'out/a.md', content: 'summary' } }], chunkDelayMs: 150 },
        { content: report('wrote out/a.md') },
      ],
    })
    const project = await t.sdk.call('projects.open', { root: nodePath.join(t.base, 'p'), create: true })
    const coordinator = await t.sdk.call('sessions.coordinator', { projectId: project.projectId })
    const started = await t.sdk.startTurn({ projectId: project.projectId, sessionId: coordinator.sessionId, text: 'Summarize the project.\nPut the summary in out/a.md and keep the rest of the project as it is.' })
    expect((await started.done).reason).toEqual({ kind: 'completed' })
    await waitForEvent(t, turnEnd(coordinator.sessionId, 2))

    const threadStart = (t.events.find(event => event.type === 'member.start' && event.sessionId === coordinator.sessionId) as Extract<SdkEvent, { type: 'member.start' }>).run
    expect(threadStart).toMatchObject({ executionForm: 'thread', name: 'summary', childTurn: 1 })
    const threadId = threadStart.childSessionId

    // The thread's copy was merged into the project.
    expect(await readFile(nodePath.join(project.root, 'out/a.md'), 'utf8')).toBe('summary')

    // The conversation: the run, then the wake note as turn 2.
    const records = await recordsOf(t, project.projectId, coordinator.sessionId)
    const end = records.find(record => record.type === 'subagent.end')
    expect(end).toMatchObject({ turn: 1, childSessionId: threadId, childTurn: 1, result: { status: 'completed', merge: { applied: ['out/a.md'] } } })
    const wake = records.find(record => record.type === 'user.message' && record.source === 'thread')
    expect(wake).toMatchObject({ turn: 2 })
    expect((wake as Extract<SessionRecord, { type: 'user.message' }>).content).toContain('Thread "Summary"')
    expect(t.events.some(event => event.type === 'thread.message' && event.sessionId === coordinator.sessionId && event.turn === 2)).toBe(true)

    // The thread is a conversation of its own, under the coordinator, without the thread tools.
    const threadRecords = await recordsOf(t, project.projectId, threadId)
    expect(threadRecords[0]).toMatchObject({ type: 'session.start', thread: { coordinatorSessionId: coordinator.sessionId, title: 'Summary' } })
    expect(threadRecords.find(record => record.type === 'user.message' && record.source !== 'inject')).toMatchObject({ source: 'thread', content: 'Write out/a.md with the summary.' })
    const list = await t.sdk.call('sessions.list', { projectId: project.projectId })
    expect(list.find(summary => summary.sessionId === threadId)).toMatchObject({ thread: { title: 'Summary' } })
    expect(await t.sdk.call('threads.list', { projectId: project.projectId, sessionId: coordinator.sessionId })).toEqual([
      expect.objectContaining({ threadId, title: 'Summary', status: 'done', turns: 1 }),
    ])

    // The organization library measured turn 1 again with the thread in it.
    const log = nodePath.join(resolveUserDataLayout(t.home).organizations, 'runs.jsonl')
    await expect.poll(async () => existsSync(log) && (await readFile(log, 'utf8')).includes('"type":"profile"'), { timeout: 3_000 }).toBe(true)
    const lines = (await readFile(log, 'utf8')).trim().split('\n').map(line => JSON.parse(line) as { type: string; sessionId?: string; level?: string; waiting?: boolean; profile?: { parts: { kind: string }[] } })
    // Two layers: the coordinator's turn is a coordinator-level run (its split into threads); a thread's own turn, when recorded, is a members'-level run.
    const runs = lines.filter(line => line.type === 'run')
    expect(runs.find(line => line.sessionId === coordinator.sessionId)).toMatchObject({ level: 'coordinator', waiting: true })
    expect(runs.filter(line => line.level === 'coordinator').map(line => line.sessionId)).toEqual([coordinator.sessionId])
    expect(lines.find(line => line.type === 'profile')!.profile!.parts.map(part => part.kind)).toEqual(['coordinator', 'thread'])
  })

  it('hides the thread tools in threads, keeps a thread with a question waiting, and message_thread answers it', async () => {
    let threadId = ''
    const t = await threadSdk([
      { toolCalls: [{ name: 'start_thread', arguments: { title: 'Report', task: 'Write the report.' } }] },
      { content: 'Started.' },
      // Woken with the question: answer it.
      () => ({ toolCalls: [{ name: 'message_thread', arguments: { thread: threadId, text: 'Use 2025.' } }] }),
      { content: 'Answered.' },
      // Woken again: done.
      { content: 'The report is done.' },
    ], {
      Report: [
        { content: report('nothing yet', 'which year should the report cover?'), chunkDelayMs: 150 },
        { content: report('wrote the 2025 report') },
      ],
    })
    const project = await t.sdk.call('projects.open', { root: nodePath.join(t.base, 'p'), create: true })
    const coordinator = await t.sdk.call('sessions.coordinator', { projectId: project.projectId })
    const firstRun = waitForEvent(t, event => event.type === 'member.start' && event.sessionId === coordinator.sessionId)
    await t.sdk.startTurn({ projectId: project.projectId, sessionId: coordinator.sessionId, text: 'Write the report' })
    threadId = ((await firstRun) as Extract<SdkEvent, { type: 'member.start' }>).run.childSessionId
    await waitForEvent(t, turnEnd(coordinator.sessionId, 3))

    const records = await recordsOf(t, project.projectId, coordinator.sessionId)
    const notes = records.filter(record => record.type === 'user.message' && record.source === 'thread').map(record => (record as Extract<SessionRecord, { type: 'user.message' }>).content)
    expect(notes[0]).toContain('stopped with a question or blocker')
    expect(notes[1]).toContain('finished its turn')
    expect(records.filter(record => record.type === 'subagent.start').map(record => [record.turn, (record as Extract<SessionRecord, { type: 'subagent.start' }>).childTurn])).toEqual([[1, 1], [2, 2]])
    expect(await t.sdk.call('threads.list', { projectId: project.projectId, sessionId: coordinator.sessionId })).toEqual([expect.objectContaining({ threadId, status: 'done', turns: 2 })])

    // Tools: the conversation has the thread tools, the thread does not.
    // The command tool is `bash`, or `pwsh` on Windows.
    const shell = process.platform === 'win32' ? 'pwsh' : 'bash'
    const tools = (route: string | undefined) => t.llm().calls.find(call => call.route === route)!.request.tools?.map(tool => tool.name) ?? []
    expect(tools(undefined)).toEqual(expect.arrayContaining(['start_thread', 'message_thread', 'read_thread', 'list_threads']))
    expect(tools('Report')).not.toContain('start_thread')
    expect(tools('Report')).not.toContain('list_threads')
    expect(tools('Report')).not.toContain('update_project_notes')
    // The coordinator only assigns: no tool that writes or runs commands; its thread keeps them.
    expect(tools(undefined)).not.toEqual(expect.arrayContaining(['write_file']))
    expect(tools(undefined).filter(name => ['write_file', 'str_replace', 'bash', 'pwsh', 'run_code'].includes(name))).toEqual([])
    // Two layers: the coordinator starts no members; a thread organizes its own.
    expect(tools(undefined)).toEqual(expect.arrayContaining(['read_file']))
    expect(tools(undefined).filter(name => ['organize', 'delegate', 'workflow'].includes(name))).toEqual([])
    expect(tools('Report')).toEqual(expect.arrayContaining(['write_file', shell, 'organize']))
  })

  it('gives only the coordinator its prompt, its notes and update_project_notes', async () => {
    const notes = '## Rules\n- Keep the public API unchanged (the user said so for every task).'
    const t = await threadSdk([
      { toolCalls: [{ name: 'update_project_notes', arguments: { notes } }] },
      { content: 'Noted.' },
      { content: 'Second turn.' },
      // An ordinary conversation.
      { content: 'Hello.' },
    ], {})
    const project = await t.sdk.call('projects.open', { root: nodePath.join(t.base, 'p'), create: true })
    const coordinator = await t.sdk.call('sessions.coordinator', { projectId: project.projectId })
    expect((await (await t.sdk.startTurn({ projectId: project.projectId, sessionId: coordinator.sessionId, text: 'Remember the rule.' })).done).reason).toEqual({ kind: 'completed' })
    expect((await (await t.sdk.startTurn({ projectId: project.projectId, sessionId: coordinator.sessionId, text: 'Next.' })).done).reason).toEqual({ kind: 'completed' })
    const other = await t.sdk.call('sessions.create', { projectId: project.projectId })
    expect((await (await t.sdk.startTurn({ projectId: project.projectId, sessionId: other.sessionId, text: 'Hi.' })).done).reason).toEqual({ kind: 'completed' })

    const calls = t.llm().calls
    const system = (index: number) => JSON.stringify(calls[index]!.request.messages.filter(message => message.role === 'system'))
    const tools = (index: number) => calls[index]!.request.tools?.map(tool => tool.name) ?? []
    expect(system(0)).toContain('Coordinating this project')
    expect(system(0)).toContain('(none yet)')
    expect(tools(0)).toContain('update_project_notes')
    // The notes are kept in the project's data directory and shown from the next turn on.
    const dataDir = (t.sdk as unknown as { projects: Map<string, { app: { ctx: { workspace: { layout: { dataDir: string } } } } }> }).projects.get(project.projectId)!.app.ctx.workspace.layout.dataDir
    expect(await readFile(nodePath.join(dataDir, COORDINATOR_NOTES_FILE), 'utf8')).toBe(`${notes}\n`)
    expect(system(2)).toContain('Keep the public API unchanged')
    // An ordinary conversation has neither.
    expect(system(3)).not.toContain('Coordinating this project')
    expect(tools(3)).not.toContain('update_project_notes')
    expect(tools(3)).toContain('start_thread')
    expect(tools(3)).toContain('write_file')
    expect(system(0)).toContain('do none of the work yourself')
    expect(system(3)).not.toContain('do none of the work yourself')
  })

  it('does not wake the conversation for a thread the user stopped', async () => {
    const t = await threadSdk([
      { toolCalls: [{ name: 'start_thread', arguments: { title: 'Long', task: 'Write out/b.md.' } }] },
      { content: 'A thread is on it.' },
      { content: 'should not be asked' },
    ], {
      Long: [{ toolCalls: [{ name: 'write_file', arguments: { path: 'out/b.md', content: 'b' } }], chunkDelayMs: 2_000 }, { content: report('wrote out/b.md') }],
    })
    const project = await t.sdk.call('projects.open', { root: nodePath.join(t.base, 'p'), create: true })
    const coordinator = await t.sdk.call('sessions.coordinator', { projectId: project.projectId })
    const started = await t.sdk.startTurn({ projectId: project.projectId, sessionId: coordinator.sessionId, text: 'Write the long part.' })
    await started.done
    const threadId = (t.events.find(event => event.type === 'member.start' && event.sessionId === coordinator.sessionId) as Extract<SdkEvent, { type: 'member.start' }>).run.childSessionId
    await t.sdk.call('turns.cancel', { projectId: project.projectId, sessionId: threadId })
    await waitForEvent(t, turnEnd(threadId, 1))
    // A wake would start turn 2 right after the thread's end.
    await new Promise(resolve => setTimeout(resolve, 500))
    expect(t.events.some(event => event.type === 'turn.start' && event.sessionId === coordinator.sessionId && event.turn === 2)).toBe(false)
    expect(await t.sdk.call('threads.list', { projectId: project.projectId, sessionId: coordinator.sessionId })).toEqual([expect.objectContaining({ threadId, status: 'stopped' })])
  })

  it('shows that a thread waits for the user to allow a tool call until it is answered there', async () => {
    const t = await threadSdk([
      { toolCalls: [{ name: 'start_thread', arguments: { title: 'Config', task: 'Write .env with A=1.' } }] },
      { content: 'Started.' },
      { content: 'The thread wrote .env.' },
    ], {
      Config: [
        { toolCalls: [{ name: 'write_file', arguments: { path: '.env', content: 'A=1\n' } }] },
        { content: report('wrote .env') },
      ],
    })
    const project = await t.sdk.call('projects.open', { root: nodePath.join(t.base, 'p'), create: true })
    const coordinator = await t.sdk.call('sessions.coordinator', { projectId: project.projectId })
    await t.sdk.startTurn({ projectId: project.projectId, sessionId: coordinator.sessionId, text: 'Set up the config' })
    const ask = (await waitForEvent(t, event => event.type === 'approval.request')) as Extract<SdkEvent, { type: 'approval.request' }>
    const threadId = ask.sessionId
    expect(await t.sdk.call('threads.list', { projectId: project.projectId, sessionId: coordinator.sessionId })).toEqual([expect.objectContaining({ threadId, status: 'running', needsApproval: true })])
    expect(await t.sdk.call('approvals.respond', { projectId: project.projectId, sessionId: threadId, decision: { id: ask.request.id, decision: 'allow', scope: 'once' } })).toBe(true)
    await waitForEvent(t, turnEnd(coordinator.sessionId, 2))
    const [thread] = await t.sdk.call('threads.list', { projectId: project.projectId, sessionId: coordinator.sessionId })
    expect(thread).toMatchObject({ threadId, status: 'done' })
    expect(thread!.needsApproval).toBeUndefined()
    expect(await readFile(nodePath.join(project.root, '.env'), 'utf8')).toBe('A=1\n')
  })

  it('names runs and reads a thread status from its records', () => {
    expect(threadRunName('Release notes', 1)).toBe('release-notes')
    expect(threadRunName('发布说明', 2)).toBe('thread-2')
    const at = '2026-10-20T00:00:00.000Z'
    const base = [
      { type: 'session.start', ts: at, seq: 1, thread: { coordinatorSessionId: 'c', title: 'x' } },
      { type: 'turn.start', ts: at, seq: 2, turn: 1 },
    ] as unknown as SessionRecord[]
    const reply = (content: string) => ({ type: 'assistant.message', ts: at, seq: 3, turn: 1, step: 1, content, usage: {} }) as unknown as SessionRecord
    const ended = (kind: string) => ({ type: 'turn.end', ts: at, seq: 4, turn: 1, reason: { kind } }) as unknown as SessionRecord
    expect(threadStatusOf(base, true)).toEqual({ status: 'running' })
    expect(threadStatusOf([...base, reply(report('x')), ended('completed')], false)).toEqual({ status: 'done' })
    expect(threadStatusOf([...base, reply(report('x', 'which file?')), ended('completed')], false)).toEqual({ status: 'waiting', blocker: 'which file?' })
    expect(threadStatusOf([...base, ended('cancelled')], false)).toEqual({ status: 'stopped' })
    expect(threadStatusOf([...base, ended('error')], false)).toEqual({ status: 'failed' })
  })
})

describe('threads under the coordinator\'s limits', () => {
  it('gives a thread plan mode while the coordinator is in plan mode, and releases it with the coordinator\'s approval', async () => {
    const t = await threadSdk([
      { toolCalls: [{ name: 'start_thread', arguments: { title: 'Worker', task: 'Write result.txt.' } }] },
      { content: 'Assigned.' },
      { content: 'Noted.' },
    ], {
      Worker: [
        { toolCalls: [{ name: 'write_file', arguments: { path: 'result.txt', content: 'changed' } }] },
        { content: report('tried to write result.txt') },
      ],
    })
    const project = await t.sdk.call('projects.open', { root: nodePath.join(t.base, 'p'), create: true })
    const coordinator = await t.sdk.call('sessions.coordinator', { projectId: project.projectId })
    await t.sdk.call('sessions.setMode', { projectId: project.projectId, sessionId: coordinator.sessionId, plan: true })
    const started = await t.sdk.startTurn({ projectId: project.projectId, sessionId: coordinator.sessionId, text: 'Plan the change; wait for my approval before editing.' })
    await started.done
    await waitForEvent(t, turnEnd(coordinator.sessionId, 2))
    const threadId = (t.events.find(event => event.type === 'member.start' && event.sessionId === coordinator.sessionId) as Extract<SdkEvent, { type: 'member.start' }>).run.childSessionId
    expect(existsSync(nodePath.join(project.root, 'result.txt'))).toBe(false)
    const threadRecords = await recordsOf(t, project.projectId, threadId)
    expect(threadRecords.find(record => record.type === 'session.mode')).toMatchObject({ plan: true, reason: 'coordinator' })
    expect(threadRecords.find(record => record.type === 'tool.result' && record.name === 'write_file')).toMatchObject({ isError: true, error: { code: 'sandbox/denied' } })
    // The user approves the coordinator's plan: its threads leave plan mode with it, without an approval of their own.
    await t.sdk.call('sessions.setMode', { projectId: project.projectId, sessionId: coordinator.sessionId, plan: false })
    await expect.poll(async () => (await recordsOf(t, project.projectId, threadId)).findLast(record => record.type === 'session.mode'), { timeout: 3_000 })
      .toMatchObject({ plan: false, reason: 'plan-approved' })
  })

  it('keeps plan mode the user turned on for a thread when the coordinator gives it work or leaves its own plan mode', async () => {
    let threadId = ''
    const t = await threadSdk([
      { toolCalls: [{ name: 'start_thread', arguments: { title: 'Worker', task: 'Look at the project.' } }] },
      { content: 'Assigned.' },
      { content: 'Noted.' },
      () => ({ toolCalls: [{ name: 'message_thread', arguments: { thread: threadId, text: 'Write result.txt now.' } }] }),
      { content: 'Asked.' },
      { content: 'Noted.' },
    ], {
      Worker: [
        { content: report('looked') },
        { toolCalls: [{ name: 'write_file', arguments: { path: 'result.txt', content: 'changed' } }] },
        { content: report('tried to write result.txt') },
      ],
    })
    const project = await t.sdk.call('projects.open', { root: nodePath.join(t.base, 'p'), create: true })
    const coordinator = await t.sdk.call('sessions.coordinator', { projectId: project.projectId })
    const firstRun = waitForEvent(t, event => event.type === 'member.start' && event.sessionId === coordinator.sessionId)
    await t.sdk.startTurn({ projectId: project.projectId, sessionId: coordinator.sessionId, text: 'Look around' })
    threadId = ((await firstRun) as Extract<SdkEvent, { type: 'member.start' }>).run.childSessionId
    await waitForEvent(t, turnEnd(coordinator.sessionId, 2))
    // The user puts the thread itself in plan mode; the coordinator going in and out of plan mode does not end it.
    await t.sdk.call('sessions.setMode', { projectId: project.projectId, sessionId: threadId, plan: true })
    await t.sdk.call('sessions.setMode', { projectId: project.projectId, sessionId: coordinator.sessionId, plan: true })
    await t.sdk.call('sessions.setMode', { projectId: project.projectId, sessionId: coordinator.sessionId, plan: false })
    await t.sdk.startTurn({ projectId: project.projectId, sessionId: coordinator.sessionId, text: 'Have it write the result' })
    await waitForEvent(t, turnEnd(coordinator.sessionId, 4))
    expect(existsSync(nodePath.join(project.root, 'result.txt'))).toBe(false)
    const threadRecords = await recordsOf(t, project.projectId, threadId)
    expect(threadRecords.filter(record => record.type === 'session.mode').map(record => [record.plan, record.reason])).toEqual([[true, 'host']])
    expect(threadRecords.find(record => record.type === 'tool.result' && record.name === 'write_file')).toMatchObject({ isError: true, error: { code: 'sandbox/denied' } })
  })

  it('does not start an idle thread\'s next turn through message_thread while the most threads are running', async () => {
    const ids = ['t1', 't2', 't3', 't4']
    const running = new Set(ids.slice(0, 3))
    const records = (id: string): SessionRecord[] => [
      { type: 'session.start', seq: 1, ts: '2026-10-26T00:00:00.000Z', sessionId: id, version: 1, projectRoot: '/p', model: 'm', sandboxMode: 'workspace-write', thread: { coordinatorSessionId: 'c', title: id } },
      { type: 'turn.start', seq: 2, ts: '2026-10-26T00:00:00.000Z', sessionId: id, turn: 1 },
      { type: 'turn.end', seq: 3, ts: '2026-10-26T00:00:00.000Z', sessionId: id, turn: 1, reason: { kind: 'completed' } },
    ] as SessionRecord[]
    let started = 0
    const host = new SdkThreadHost({
      threadIds: async () => ids,
      records: async (id: string) => records(id),
      running: (id: string) => running.has(id),
      needsApproval: () => false,
      steer: async () => false,
      startTurn: async (id: string) => {
        started += 1
        running.add(id)
        return { turn: 2, done: new Promise(() => undefined) }
      },
      append: async () => undefined,
      report: () => undefined,
    } as unknown as ThreadRuntime)
    await expect(host.message({ coordinatorSessionId: 'c', turn: 1, threadId: 't4', text: 'Continue the work.' })).rejects.toMatchObject({ code: 'tool/denied' })
    expect(started).toBe(0)
    // Once a thread ends, the idle one gets its next turn.
    running.delete('t3')
    await host.message({ coordinatorSessionId: 'c', turn: 1, threadId: 't4', text: 'Continue the work.' })
    expect(started).toBe(1)
  })
})

describe('a thread works, is checked and is measured in its own copy of the project', () => {
  it('checks the files a thread presented where it wrote them: no "missing" retry before its copy is merged', async () => {
    const t = await threadSdk([
      { toolCalls: [{ name: 'start_thread', arguments: { title: 'Data', task: 'Write out/data.json and present it.' } }] },
      { content: 'A thread is writing the data.' },
      { content: 'The data is in out/data.json.' },
    ], {
      Data: [
        { toolCalls: [{ name: 'write_file', arguments: { path: 'out/data.json', content: '{"rows": 3}\n' } }] },
        { toolCalls: [{ name: 'present', arguments: { paths: ['out/data.json'], summary: 'The data as JSON.' } }] },
        { content: report('wrote and presented out/data.json') },
      ],
    })
    const project = await t.sdk.call('projects.open', { root: nodePath.join(t.base, 'p'), create: true })
    const coordinator = await t.sdk.call('sessions.coordinator', { projectId: project.projectId })
    const firstRun = waitForEvent(t, event => event.type === 'member.start' && event.sessionId === coordinator.sessionId)
    await t.sdk.startTurn({ projectId: project.projectId, sessionId: coordinator.sessionId, text: 'Write out/data.json with the row count and present it.' })
    const threadId = ((await firstRun) as Extract<SdkEvent, { type: 'member.start' }>).run.childSessionId
    await waitForEvent(t, turnEnd(coordinator.sessionId, 2))

    // The thread was not sent back to fix a file it had presented: three requests, no check note.
    expect(t.llm().calls.filter(call => call.route === 'Data')).toHaveLength(3)
    const records = await recordsOf(t, project.projectId, threadId)
    expect(records.filter(record => record.type === 'user.message' && record.source === 'inject' && /missing/.test(record.content))).toEqual([])
    expect(await readFile(nodePath.join(project.root, 'out/data.json'), 'utf8')).toBe('{"rows": 3}\n')
  })

  it('lets a thread write its own copy with write_spreadsheet and run_code without asking, like a conversation', async () => {
    const t = await threadSdk([
      { toolCalls: [{ name: 'start_thread', arguments: { title: 'Sheet', task: 'Write out/plan.xlsx and out/sum.txt.' } }] },
      { content: 'A thread is writing the files.' },
      { content: 'The files are in out/.' },
    ], {
      Sheet: [
        { toolCalls: [{ name: 'load_skill', arguments: { name: 'spreadsheets' } }] },
        { toolCalls: [{ name: 'write_spreadsheet', arguments: { path: 'out/plan.xlsx', sheets: [{ name: 'Plan', rows: [['item', 'qty'], ['a', 2]] }] } }] },
        { toolCalls: [{ name: 'run_code', arguments: { code: 'await writeFile("out/sum.txt", String(1 + 2)); return "ok"' } }] },
        { content: report('wrote out/plan.xlsx and out/sum.txt') },
      ],
    })
    const project = await t.sdk.call('projects.open', { root: nodePath.join(t.base, 'p'), create: true })
    const asks: string[] = []
    t.sdk.subscribe(event => {
      if (event.type !== 'approval.request') return
      asks.push(`${event.request.tool}: ${event.request.summary}`)
      void t.sdk.call('approvals.respond', { projectId: project.projectId, sessionId: event.sessionId, decision: { id: event.request.id, decision: 'deny', scope: 'once' } })
    })
    const coordinator = await t.sdk.call('sessions.coordinator', { projectId: project.projectId })
    await t.sdk.startTurn({ projectId: project.projectId, sessionId: coordinator.sessionId, text: 'Write the plan workbook out/plan.xlsx and the sum in out/sum.txt.' })
    await waitForEvent(t, turnEnd(coordinator.sessionId, 2))

    expect(asks).toEqual([])
    expect(existsSync(nodePath.join(project.root, 'out/plan.xlsx'))).toBe(true)
    expect(await readFile(nodePath.join(project.root, 'out/sum.txt'), 'utf8')).toBe('3')
  })

  it('keeps a task unsettled in the organization library while a thread still works on it after a question was answered', async () => {
    let threadId = ''
    const t = await threadSdk([
      { toolCalls: [{ name: 'start_thread', arguments: { title: 'Report', task: 'Write the report.' } }] },
      { content: 'Started.' },
      // Woken with the question: answer it; the thread works on.
      () => ({ toolCalls: [{ name: 'message_thread', arguments: { thread: threadId, text: 'Use 2025.' } }] }),
      { content: 'Answered.' },
      // Woken again: done.
      { content: 'The report is done.' },
    ], {
      Report: [
        { content: report('nothing yet', 'which year should the report cover?') },
        // The answered run takes a while.
        { content: ['Done: wrote the 2025 report\n', 'Not done: none\n', 'Checks: none\n', 'Blockers: none'], chunkDelayMs: 500 },
      ],
    })
    const project = await t.sdk.call('projects.open', { root: nodePath.join(t.base, 'p'), create: true })
    const coordinator = await t.sdk.call('sessions.coordinator', { projectId: project.projectId })
    const firstRun = waitForEvent(t, event => event.type === 'member.start' && event.sessionId === coordinator.sessionId)
    await t.sdk.startTurn({ projectId: project.projectId, sessionId: coordinator.sessionId, text: 'Write the yearly report of the project.\nPut it in report.md and keep the rest of the project as it is.' })
    threadId = ((await firstRun) as Extract<SdkEvent, { type: 'member.start' }>).run.childSessionId
    // The coordinator answered (turn 2) and the thread is on its second run.
    await waitForEvent(t, turnEnd(coordinator.sessionId, 2))
    await expect.poll(async () => (await t.sdk.call('threads.list', { projectId: project.projectId, sessionId: coordinator.sessionId }))[0]?.status).toBe('running')

    const log = nodePath.join(resolveUserDataLayout(t.home).organizations, 'runs.jsonl')
    const lines = async () => (await readFile(log, 'utf8')).trim().split('\n').map(line => JSON.parse(line) as { type: string; completed?: boolean; waiting?: boolean })
    // Still working: the task's run waits, with no outcome, no profile and no change derived from it.
    await new Promise(resolve => setTimeout(resolve, 300))
    expect((await lines()).map(line => line.type)).toEqual(['run'])
    expect((await lines())[0]).toMatchObject({ waiting: true })

    await waitForEvent(t, turnEnd(coordinator.sessionId, 3))
    await expect.poll(async () => (await lines()).some(line => line.type === 'profile'), { timeout: 3_000 }).toBe(true)
    // Settled once the thread finished: the answered question is not a failure.
    expect((await lines()).find(line => line.type === 'profile')).not.toHaveProperty('completed')
  })
})
