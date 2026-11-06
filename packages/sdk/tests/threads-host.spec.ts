/**
 * The thread host's behavior over an in-memory runtime: the user's plan kept
 * in the project, the user's words passed on, the queue, stopping, the final
 * whole-project check, the log's reach (coordinator, `collabFor`, `read_merged`),
 * the limits of messages between threads, and the profile handed to the
 * organization library.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import * as nodePath from 'node:path'
import { ZERO_USAGE, type OrganizationProfile, type SessionRecord } from '@nexgent/kernel'
import { describe, expect, it } from 'vitest'
import { SdkThreadHost } from '../src/index.js'
import { threadTrajectory } from '../src/threads.js'
import { at, host } from './threads-fake.js'

const caller = { coordinatorSessionId: 'c', turn: 1 }
const central = { mode: 'central', handoff: 'brief', overlap: 'parallel' }
const hybrid = { ...central, mode: 'hybrid' }

type Fake = Awaited<ReturnType<typeof host>>

/** The user says something to the coordinator in the middle of its turn. */
function userSays(t: Fake, content: string): void {
  const list = t.sessions.get('c')!
  list.push({ ts: at, seq: list.length + 1, type: 'user.message', turn: 1, source: 'user', content } as unknown as SessionRecord)
}

describe('the user\'s plan and words', () => {
  it('keeps the plan in the project: it binds a host started later, and its started threads stay started', async () => {
    const t = await host()
    t.host.newTask('c', { threads: [{ title: 'API' }, { title: 'UI' }], exact: true })
    await t.host.start({ ...caller, title: 'api', task: 'Build the API.' })
    expect(JSON.parse(await readFile(nodePath.join(t.dir, 'c.plan.json'), 'utf8'))).toMatchObject({ started: ['api'] })
    const again = new SdkThreadHost(t.rt)
    expect(again.plan('c')).toEqual({ threads: [{ title: 'API' }, { title: 'UI' }], exact: true })
    await expect(again.start({ ...caller, title: 'API', task: 'Again.' })).rejects.toThrow(/"UI"/)
    again.newTask('c')
    expect(again.plan('c')).toBeUndefined()
  })

  it('passes the user\'s words on word for word: to a new thread, with a message, and mid-turn to running threads, once each', async () => {
    const t = await host()
    userSays(t, 'use tabs, not spaces')
    await t.host.start({ ...caller, title: 'Format', task: 'Format the code.' })
    expect(t.started.at(-1)).toMatchObject({ text: 'Format the code.', relay: ['the task', 'use tabs, not spaces'] })
    userSays(t, 'and keep lines short')
    await t.host.coordinatorTurnEnded('c', 1)
    expect(t.steered.at(-1)).toMatchObject({ sessionId: 't1', relay: ['and keep lines short'] })
    // Nothing is sent twice.
    await t.host.message({ ...caller, threadId: 't1', text: 'Go on.' })
    expect(t.steered.at(-1)!.relay).toBeUndefined()
    await t.host.coordinatorTurnEnded('c', 1)
    expect(t.steered).toHaveLength(2)
  })
})

describe('the queue and stopping', () => {
  it('queues what exceeds the threads allowed at once, starts it when one ends, and stops a running or a waiting thread', async () => {
    const t = await host()
    t.setSlots(1)
    await t.host.start({ ...caller, title: 'A', task: 'Part A.' })
    expect(await t.host.start({ ...caller, title: 'B', task: 'Part B.' })).toMatchObject({ status: 'queued' })
    expect(await t.host.startByUser({ coordinatorSessionId: 'c', title: 'Mine', task: 'My part.' })).toMatchObject({ status: 'queued', origin: 'user' })
    await t.host.stop({ coordinatorSessionId: 'c', threadId: 't2', reason: 'not needed' })
    expect(JSON.parse(await readFile(nodePath.join(t.dir, 'c.queue.json'), 'utf8')).map((item: { title: string }) => item.title)).toEqual(['Mine'])
    // Stopping the running thread starts the next waiting one, and does not wake the coordinator.
    const wakes = t.wakes.length
    await t.host.stop({ coordinatorSessionId: 'c', threadId: 't1' })
    expect(t.cancelled).toEqual(['t1'])
    expect(t.started.at(-1)).toMatchObject({ sessionId: 't3', source: 'user' })
    expect(t.wakes).toHaveLength(wakes)
    expect((await t.host.log({ sessionId: 'c' })).filter(entry => entry.kind === 'stopped').map(entry => entry.fromTitle)).toEqual(['B', 'A'])
  })

  it('starts the next turn of a thread messaged just as its turn ends, without waiting on itself', async () => {
    const t = await host()
    await t.host.start({ ...caller, title: 'A', task: 'Part A.' })
    const ended = t.endTurn('t1', { kind: 'completed' })
    const messaged = t.host.message({ ...caller, threadId: 't1', text: 'One more thing.' })
    await Promise.race([Promise.all([ended, messaged]), new Promise((_, reject) => setTimeout(() => reject(new Error('deadlock')), 3000))])
    for (let i = 0; i < 100 && t.started.length < 2; i += 1) await new Promise(resolve => setTimeout(resolve, 10))
    expect(t.started.at(-1)).toMatchObject({ sessionId: 't1', text: 'One more thing.' })
  })

  it('runs a thread whose next turn overlaps nothing under overlap: sequence only when the running ones end, and counts it as a trigger', async () => {
    const t = await host({ ...central, overlap: 'sequence' })
    await t.host.start({ ...caller, title: 'A', task: 'Part A.', owns: ['src/a'] })
    await t.finish('t1')
    await t.host.start({ ...caller, title: 'B', task: 'Part B.', owns: ['src/b'] })
    // An idle thread's next turn goes through the same rule.
    await t.host.start({ ...caller, title: 'C', task: 'Part C.', owns: ['src/c'] })
    expect(await t.host.message({ ...caller, threadId: 't1', text: 'More.' })).toMatchObject({ status: 'running' })
    await t.finish('t1')
    await t.host.start({ ...caller, title: 'D', task: 'No paths.' })
    expect((await t.host.list({ coordinatorSessionId: 'c' })).find(thread => thread.title === 'D')?.status).toBe('queued')
    expect(JSON.parse(await readFile(nodePath.join(t.dir, 'c.triggers.json'), 'utf8'))).toMatchObject({ sequence: 1 })
  })
})

describe('a project opened again', () => {
  it('starts what waited in the queue and the coordinator\'s threads whose turn the last process cut short', async () => {
    const t = await host()
    t.setSlots(1)
    await t.host.start({ ...caller, title: 'A', task: 'Part A.' })
    await t.host.start({ ...caller, title: 'B', task: 'Part B.' })
    await t.endTurn('t1', { kind: 'cancelled', cause: 'shutdown' })
    await t.host.startByUser({ coordinatorSessionId: 'c', title: 'Mine', task: 'My part.' })
    t.setSlots(3)
    const started = t.started.length
    const again = new SdkThreadHost(t.rt)
    await again.resume('c')
    // What waited in the queue starts; A's cut-short turn restarts with its task.
    expect(t.started.slice(started).map(item => item.sessionId).sort()).toEqual(['t1', 't3'])
    const restart = t.started.find((item, index) => index >= started && item.sessionId === 't1')!
    expect(restart.text).toContain('interrupted')
    expect(restart.text).toContain('Part A.')
    await again.resume('c')
    expect(t.started.slice(started)).toHaveLength(2)
  })
})

describe('the final check of the whole project', () => {
  it('starts, once, in the thread that merged last when every thread has ended', async () => {
    const t = await host()
    await t.host.start({ ...caller, title: 'Schema', task: 'Write the schema.' })
    await t.host.start({ ...caller, title: 'Queries', task: 'Write the queries.' })
    await t.finish('t1', ['db/schema.sql'])
    await t.finish('t2', ['db/queries.sql'])
    expect(t.wakes.at(-1)!.text).toContain('The host starts one final check of the whole project as soon as you end your turn (by "Queries"')
    // The coordinator's turn is over: the host starts the check.
    await t.host.coordinatorTurnEnded('c', 1)
    expect(t.started.at(-1)).toMatchObject({ sessionId: 't2' })
    expect(t.started.at(-1)!.text).toContain('Check the whole project')
    expect(t.sessions.get('c')!.filter(record => record.type === 'subagent.start').map(record => (record as unknown as { name: string }).name).at(-1)).toMatch(/^check-/)
    await t.host.coordinatorTurnEnded('c', 1)
    expect(t.started.filter(item => item.text.includes('Check the whole project'))).toHaveLength(1)
    // Its report wakes the coordinator, and no further check follows.
    await t.finish('t2')
    expect(t.wakes.at(-1)!.text).toContain('final whole-project check the host ran')
    await t.host.coordinatorTurnEnded('c', 1)
    expect(t.started.filter(item => item.text.includes('Check the whole project'))).toHaveLength(1)
  })

  it('starts a separate thread for it under check: separate, and counts a failed report', async () => {
    const t = await host({ ...central, check: 'separate' })
    await t.host.start({ ...caller, title: 'A', task: 'Part A.' })
    await t.host.start({ ...caller, title: 'B', task: 'Part B.' })
    await t.finish('t1', ['a.ts'])
    await t.finish('t2', ['b.ts'])
    await t.host.coordinatorTurnEnded('c', 1)
    expect(t.started.at(-1)!.sessionId).toBe('t3')
    expect((await t.host.list({ coordinatorSessionId: 'c' })).at(-1)).toMatchObject({ title: 'Check the whole project' })
    const wakes = t.wakes.length
    await t.endTurn('t3', { kind: 'completed' }, [], 'Done: ran the tests\nNot done: the build fails\nChecks: tests pass\nBlockers: none')
    for (let i = 0; i < 400 && t.wakes.length === wakes; i += 1) await new Promise(resolve => setTimeout(resolve, 5))
    expect(JSON.parse(await readFile(nodePath.join(t.dir, 'c.triggers.json'), 'utf8'))).toMatchObject({ separate: 1, checkFailed: 1 })
  })
})

describe('the log\'s reach', () => {
  it('shows threads\' words to the coordinator, collects what concerns each conversation, and reads the merged project', async () => {
    const t = await host(hybrid)
    await t.host.start({ ...caller, title: 'API', task: 'Build the API.', owns: ['src/api'] })
    await t.host.start({ ...caller, title: 'UI', task: 'Build the UI.', owns: ['src/ui'] })
    await t.host.messagePeer({ threadId: 't1', to: 'UI', text: 'The list is paged.' })
    await t.host.post({ sessionId: 't1', kind: 'note', text: 'Paging uses ?page=n.' })
    const heard = (await t.host.deliver({ sessionId: 'c', compacted: false }))![0]!
    expect(heard).toContain('"API" to "UI": The list is paged.')
    expect(heard).toContain('"API" notes: Paging uses ?page=n.')
    await expect(t.host.deliver({ sessionId: 'c', compacted: false })).resolves.toBeUndefined()
    expect((await t.host.collabFor('t2')).map(entry => entry.kind)).toEqual(['message', 'note'])
    expect((await t.host.collabFor('t1')).map(entry => entry.kind)).toEqual(['message', 'note'])
    expect((await t.host.collabFor('c')).map(entry => entry.fromTitle)).toEqual(['API', 'API'])
    // read_merged: the project's current file, inside the project only.
    await mkdir(nodePath.join(t.project, 'src'), { recursive: true })
    await writeFile(nodePath.join(t.project, 'src', 'a.ts'), 'export const a = 1\n')
    await expect(t.host.readMerged({ threadId: 't2', path: 'src/a.ts' })).resolves.toContain('export const a = 1')
    await expect(t.host.readMerged({ threadId: 't2', path: '../outside' })).rejects.toThrow(/inside the project/)
    await expect(t.host.readMerged({ threadId: 't2', path: '.git/config' })).rejects.toThrow(/not readable/)
    await expect(t.host.readMerged({ threadId: 't2', path: 'nope.ts' })).rejects.toThrow(/no file/)
  })

  it('refuses what is passed on too far or would close a circle of waiting, wakes an idle thread under wake: named a few times, and resets a thread\'s questions each turn', async () => {
    const t = await host({ ...hybrid, wake: 'named' })
    await t.host.start({ ...caller, title: 'A', task: 'Part A.' })
    await t.host.start({ ...caller, title: 'B', task: 'Part B.' })
    // Hops: a reply to a reply goes through the coordinator.
    await t.host.messagePeer({ threadId: 't1', to: 'B', text: 'Q1' })
    await t.host.messagePeer({ threadId: 't2', to: 'A', text: 'A1', re: 1 })
    await expect(t.host.messagePeer({ threadId: 't1', to: 'B', text: 'Q2', re: 2 })).rejects.toMatchObject({ details: { collab: 'hops' } })
    // Waiting for each other.
    await t.host.post({ sessionId: 't1', kind: 'blocker', text: 'Need the schema.', waitsFor: 'B' })
    await expect(t.host.post({ sessionId: 't2', kind: 'blocker', text: 'Need the API.', waitsFor: 'A' })).rejects.toMatchObject({ details: { collab: 'cycle' } })
    // Questions: a few per turn.
    for (const text of ['one', 'two', 'three']) await t.host.ask({ threadId: 't2', text })
    await expect(t.host.ask({ threadId: 't2', text: 'four' })).rejects.toMatchObject({ details: { collab: 'limit' } })
    // An idle thread a message names starts its next turn, a few times per task.
    await t.finish('t2')
    const woken = await t.host.messagePeer({ threadId: 't1', to: 'B', text: 'Please look at X.' })
    expect(woken).toMatchObject({ woken: true, running: true })
    expect(t.started.at(-1)).toMatchObject({ sessionId: 't2' })
    await t.host.ask({ threadId: 't2', text: 'a new turn, a new allowance' })
    for (const text of ['Y', 'Z', 'W']) {
      await t.finish('t2')
      await t.host.messagePeer({ threadId: 't1', to: 'B', text })
    }
    await t.finish('t2')
    // Past the allowance the message is only left, not refused, and says so.
    await expect(t.host.messagePeer({ threadId: 't1', to: 'B', text: 'One more.' })).resolves.toMatchObject({ running: false, note: expect.stringContaining('at most 4') })
    expect(JSON.parse(await readFile(nodePath.join(t.dir, 'c.triggers.json'), 'utf8'))).toMatchObject({ named: 4 })
  })
})

describe('what the host reports', () => {
  it('shows the steps of a thread\'s last turn, one line per tool call', () => {
    const call = (id: string, name: string, args: Record<string, unknown>) => ({ id, name, arguments: JSON.stringify(args) })
    const records = [
      { type: 'assistant.message', turn: 1, step: 1, content: '', usage: ZERO_USAGE, toolCalls: [call('1', 'read_file', { path: 'src/a.ts' }), call('2', 'bash', { command: `npm test ${'x'.repeat(200)}` })] },
      { type: 'tool.result', turn: 1, step: 1, toolCallId: '1', name: 'read_file', content: 'ok', isError: false },
      { type: 'tool.result', turn: 1, step: 1, toolCallId: '2', name: 'bash', content: 'boom', isError: true, error: { code: 'tool/failed', message: 'boom' } },
    ] as unknown as SessionRecord[]
    const lines = threadTrajectory(records, 1)
    expect(lines[0]).toBe('read_file src/a.ts: ok')
    expect(lines[1]).toMatch(/^bash npm test x+: failed \(tool\/failed\)$/)
    expect(lines[1]!.length).toBeLessThan(120)
  })

  it('marks a thread without a copy of its own', async () => {
    const t = await host()
    t.unisolated.add('t1')
    const info = await t.host.start({ ...caller, title: 'A', task: 'Part A.' })
    expect(info).toMatchObject({ isolated: false })
  })

  it('hands the library what it measured: log events, triggers, the plan, the user\'s corrections, and a report it could not read', async () => {
    const t = await host({ ...central, handoff: 'changed' })
    const noted: { profile: OrganizationProfile; completed?: boolean | 'unknown' }[] = []
    t.setOrganizations({ noteProfile: async (input: { profile: OrganizationProfile; completed?: boolean | 'unknown' }) => { noted.push({ profile: input.profile, ...(input.completed === undefined ? {} : { completed: input.completed }) }) } } as never)
    t.host.newTask('c', { threads: [{ title: 'A' }, { title: 'B' }], exact: true })
    userSays(t, 'prefer small steps')
    await t.host.start({ ...caller, title: 'A', task: 'Part A.' })
    await t.host.start({ ...caller, title: 'B', task: 'Part B.' })
    await t.finish('t1', ['a.ts'])
    expect((await t.host.deliver({ sessionId: 't2', compacted: false }))?.[0]).toContain('a.ts')
    await t.endTurn('t2', { kind: 'completed' }, [], 'all done, nothing else to say')
    for (let i = 0; i < 400 && noted.length === 0; i += 1) await new Promise(resolve => setTimeout(resolve, 5))
    expect(noted).toHaveLength(1)
    expect(noted[0]!.completed).toBe('unknown')
    expect(noted[0]!.profile).toMatchObject({ planned: true, triggers: { changed: 1, sequence: 0 }, correctionsBy: { coordinator: 1 } })
    expect(noted[0]!.profile.events).toMatchObject({ unanswered: 0, idle: 0, checkFailed: 0 })
  })
})

