/**
 * Coordinator: the organization profile of a turn, from records alone —
 * shares of the cost, the coordinator's wait for members, a member's wait
 * for a free slot, failures, and work rewritten later in the task.
 */
import type { SessionRecord } from '@nexgent/kernel'
import { describe, expect, it } from 'vitest'
import { buildOrganizationProfile, collaborationEvents, collaborationLines, renderEventCounts, unionMs } from '../src/index.js'

const T0 = Date.parse('2026-10-20T10:00:00.000Z')
let seq = 0
const rec = (ms: number, body: Record<string, unknown>): SessionRecord => ({ seq: ++seq, ts: new Date(T0 + ms).toISOString(), sessionId: 'root', ...body }) as unknown as SessionRecord
const usage = (input: number, output: number) => ({ inputTokens: input, outputTokens: output, totalTokens: 'unknown', cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 'unknown' })
const result = (status: string, input: number, output: number, applied: string[] = [], conflicts: string[] = []) => ({
  status, text: '', deliverables: [], usage: usage(input, output), requestCount: 1,
  merge: { applied, merged: [], conflicts: conflicts.map(path => ({ path, kind: 'both-changed' })) },
})

describe('organization profile', () => {
  it('splits the cost by share and measures waits, failures and wasted work', () => {
    const records = [
      rec(0, { type: 'session.start', version: 1, projectRoot: '/p', model: 'm', sandboxMode: 'workspace-write' }),
      rec(0, { type: 'turn.start', turn: 1 }),
      rec(1_000, { type: 'assistant.message', turn: 1, step: 1, requestId: 'q1', content: '', usage: usage(1000, 100), finishReason: 'tool_calls' }),
      rec(1_000, { type: 'organization', turn: 1, toolCallId: 'o1', organizationId: 'org', name: 'plan-build-review', roles: [{ name: 'planner', kind: 'plan', after: [] }, { name: 'builder', kind: 'implement', after: ['planner'] }], workflowId: 'w1' }),
      rec(1_000, { type: 'subagent.start', turn: 1, childSessionId: 'c-plan', childTurn: 1, name: 'planner', executionForm: 'workflow', task: 'plan', queuedMs: 0 }),
      rec(5_000, { type: 'subagent.end', turn: 1, childSessionId: 'c-plan', childTurn: 1, result: result('completed', 8000, 400) }),
      rec(8_000, { type: 'subagent.start', turn: 1, childSessionId: 'c-build', childTurn: 1, name: 'builder', executionForm: 'workflow', task: 'build', queuedMs: 3_000 }),
      rec(12_000, { type: 'subagent.end', turn: 1, childSessionId: 'c-build', childTurn: 1, result: result('completed', 1000, 100, ['src/a.ts', 'src/b.ts'], ['src/c.ts']) }),
      rec(12_000, { type: 'tool.result', turn: 1, step: 1, toolCallId: 'o1', name: 'organize', content: '', isError: false, durationMs: 11_000 }),
      rec(13_000, { type: 'assistant.message', turn: 1, step: 2, requestId: 'q2', content: '', usage: usage(1000, 100), finishReason: 'tool_calls', toolCalls: [{ id: 'w', name: 'write_file', arguments: JSON.stringify({ path: 'src/a.ts', content: 'x' }) }, { id: 'r', name: 'read_file', arguments: '{}' }] }),
      rec(13_500, { type: 'tool.result', turn: 1, step: 2, toolCallId: 'r', name: 'read_file', content: '', isError: true, durationMs: 1 }),
      rec(20_000, { type: 'turn.end', turn: 1, reason: { kind: 'completed' } }),
    ]
    const profile = buildOrganizationProfile({ turn: 1, records, usd: 2, checkRetries: 1, deleted: ['src/b.ts'], costOf: (u) => (u.inputTokens as number) / 1000 + (u.outputTokens as number) / 100 })
    expect(profile.ms).toBe(20_000)
    const [coordinator, planner, builder] = profile.parts
    expect(coordinator).toMatchObject({ name: 'coordinator', kind: 'coordinator', idleMs: 11_000, ms: 9_000, failures: 1, retries: 1, wasted: false })
    // planner 8 + 4 = 12 of 4 + 12 + 2 = 18 units.
    expect(planner).toMatchObject({ name: 'planner', kind: 'plan', ms: 4_000, failures: 0, idleMs: 0 })
    expect(planner!.share).toBeCloseTo(12 / 18, 3)
    expect(planner!.usd).toBeCloseTo(2 * 12 / 18, 4)
    // builder: one conflict; a.ts rewritten whole by the coordinator, b.ts deleted: wasted.
    expect(builder).toMatchObject({ name: 'builder', kind: 'implement', idleMs: 3_000, failures: 1, wasted: true, redoneBy: 'coordinator' })
  })

  it('counts a member that ran twice as one part with a retry, and work kept as not wasted', () => {
    const records = [
      rec(0, { type: 'turn.start', turn: 2 }),
      rec(0, { type: 'subagent.start', turn: 2, childSessionId: 'c', childTurn: 1, name: 'm', executionForm: 'delegate', task: 't' }),
      rec(1_000, { type: 'subagent.end', turn: 2, childSessionId: 'c', childTurn: 1, result: result('failed', 10, 1, ['x.ts']) }),
      rec(2_000, { type: 'subagent.start', turn: 2, childSessionId: 'c', childTurn: 2, name: 'm', executionForm: 'delegate', task: 't' }),
      rec(3_000, { type: 'subagent.end', turn: 2, childSessionId: 'c', childTurn: 2, result: result('completed', 10, 1, ['x.ts']) }),
      rec(4_000, { type: 'turn.end', turn: 2, reason: { kind: 'completed' } }),
    ]
    const [, member] = buildOrganizationProfile({ turn: 2, records, usd: 0 }).parts
    expect(member).toMatchObject({ name: 'm', kind: 'member', retries: 1, failures: 1, ms: 2_000, wasted: false })
  })

  it('counts overlapping waits once', () => {
    expect(unionMs([[0, 10], [5, 15], [20, 25]])).toBe(20)
  })
})

describe('collaboration events', () => {
  const call = (id: string, name: string, args: Record<string, unknown>) => ({ id, name, arguments: JSON.stringify(args) })
  const msg = (turn: number, calls: ReturnType<typeof call>[]) => rec(1, { type: 'assistant.message', turn, toolCalls: calls })
  const fail = (turn: number, name: string, collab: string) => rec(2, { type: 'tool.result', turn, toolCallId: 'x', name, isError: true, content: 'no', error: { name: 'NexgentError', code: 'tool/denied', message: 'no', details: { collab } } })
  const run = (name: string, start: number, end: number, files: string[]) => ({ name, childSessionId: name, childTurn: 1, files, conflicts: 0, start, end })

  it('counts a shared file as overlap only when the parts ran at the same time', () => {
    expect(collaborationEvents([run('a', 0, 10, ['x.ts']), run('b', 5, 20, ['x.ts'])], undefined).overlap).toBe(1)
    expect(collaborationEvents([run('a', 0, 10, ['x.ts']), run('b', 10, 20, ['x.ts'])], undefined).overlap).toBe(0)
  })

  it('counts rereads, regroups, capped, cycles and refused by details.collab', () => {
    const children = new Map<string, SessionRecord[]>([['a', [
      msg(1, [call('1', 'read_file', { path: 'a.ts' })]),
      msg(1, [call('2', 'read_file', { path: 'a.ts' }), call('3', 'read_file', { path: 'b.ts' }), call('4', 'write_file', { path: 'b.ts' }), call('5', 'read_file', { path: 'b.ts' })]),
      rec(3, { type: 'organization', turn: 1 }), rec(4, { type: 'organization', turn: 1 }),
      fail(1, 'post_collab', 'claim'), fail(1, 'message_peer', 'sequence'), fail(1, 'message_peer', 'hops'), fail(1, 'ask_coordinator', 'limit'), fail(1, 'message_peer', 'wakes'), fail(1, 'post_collab', 'cycle'),
    ]]])
    expect(collaborationEvents([run('a', 0, 10, [])], children)).toMatchObject({ reread: 1, regroups: 1, refused: 2, capped: 3, cycles: 1 })
  })

  it('renders the non-zero events and the host-enforced lines', () => {
    expect(renderEventCounts({ overlap: 1, conflicts: 0, missing: 0, outside: 0, messages: 2, refused: 0 })).toBe('events: overlap 1, messages 2')
    expect(renderEventCounts(undefined)).toBe('')
    const base = { mode: 'central', handoff: 'brief', overlap: 'parallel' } as const
    expect(collaborationLines({ ...base, wake: 'named', check: 'separate' }).join(' ')).toMatch(/wakes it.*did none of the work/)
    expect(collaborationLines({ ...base, check: 'merged' }).join(' ')).toMatch(/merged last/)
  })
})
