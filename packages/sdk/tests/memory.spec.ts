import { readFile } from 'node:fs/promises'
import * as nodePath from 'node:path'
import { describe, expect, it } from 'vitest'
import { resolveProjectLayout, type LLMRequest, type ProjectObservation, type SessionRecord, type TaskFacts } from '@nexgent/kernel'
import { findPatterns, loopNote, mergeObservations, observationLines, parseSuggestions } from '../src/index.js'
import { systemOf, testSdk, waitForEvent, type TestSdk } from './helpers.js'

function facts(key: string, over: Partial<TaskFacts> = {}): TaskFacts {
  return { formatVersion: 1, key, coordinatorSessionId: 'c', turn: 1, at: `2026-11-0${key}T00:00:00.000Z`, task: `task ${key}`, threads: 0, completed: true, checkFailed: false, idle: 0, unanswered: 0, corrections: [], files: [], loops: [], ...over }
}

const file = (path: string, over: Partial<TaskFacts['files'][number]> = {}) => ({ path, threads: ['A'], conflicts: 0, outside: false, reread: false, ...over })

describe('project memory patterns (pure)', () => {
  it('finds the same correction coming back in two tasks, and not a one-off', () => {
    const found = findPatterns([
      facts('1', { corrections: [{ text: '不要改公共接口，保持 parse 的签名', to: 'coordinator', kind: 'mid', at: 'x' }] }),
      facts('2', { corrections: [{ text: '把日志级别调低一点', to: 'A', kind: 'mid', at: 'x' }] }),
      facts('3', { corrections: [{ text: '还是不要改公共接口，parse 签名别动', to: 'coordinator', kind: 'redo', at: 'x' }] }),
    ])
    expect(found.map(pattern => pattern.kind)).toEqual(['drift'])
    expect(found[0]!.evidence.tasks.map(task => task.key)).toEqual(['3', '1'])
    expect(found[0]!.evidence.quotes?.[0]).toContain('parse 签名别动')
  })

  it('finds a file with trouble in three tasks, groups a directory, and judges a split by its problems', () => {
    const trouble = (key: string) => facts(key, { threads: 2, checkFailed: key !== '3', files: [file('src/a.ts', { conflicts: 1 }), file('src/b.ts', { threads: ['A', 'B'] }), file('README.md', { reread: true })] })
    const found = findPatterns([trouble('1'), trouble('2'), trouble('3'), facts('4', { threads: 2 })])
    const hotspot = found.filter(pattern => pattern.kind === 'hotspot')
    expect(hotspot.map(pattern => pattern.key).sort()).toEqual(['README.md', 'src/'])
    expect(hotspot.find(pattern => pattern.key === 'src/')!.evidence).toMatchObject({ files: ['src/a.ts', 'src/b.ts'], trouble: { conflicts: 3, threads: 3 } })
    const split = found.find(pattern => pattern.kind === 'split')!
    expect(split.evidence).toMatchObject({ of: 4, problems: { checkFailed: 2, conflicts: 3 } })
  })

  it('keeps an observation found again under its id and decision, and never brings back a dismissed one', () => {
    const first = mergeObservations([], findPatterns([facts('1', { loops: [{ who: 'A', tool: 'bash', code: 'tool/failed', count: 3 }] }), facts('2', { loops: [{ who: 'B', tool: 'bash', count: 4 }] })]), '2', 'now', () => 'id-1')
    expect(first.fresh).toEqual(['id-1'])
    const dismissed: ProjectObservation[] = first.observations.map(item => ({ ...item, status: 'dismissed' }))
    const again = mergeObservations(dismissed, findPatterns([facts('1', { loops: [{ who: 'A', tool: 'bash', count: 3 }] }), facts('2', { loops: [{ who: 'B', tool: 'bash', count: 4 }] }), facts('3', { loops: [{ who: 'A', tool: 'bash', count: 3 }] })]), '3', 'later', () => 'id-2')
    expect(again.fresh).toEqual([])
    expect(again.observations).toHaveLength(1)
    expect(again.observations[0]).toMatchObject({ id: 'id-1', status: 'dismissed', taskKey: '3' })
    expect(again.observations[0]!.evidence.tasks).toHaveLength(3)
  })

  it('tells the coordinator about hotspots and splits only', () => {
    const base = { status: 'open' as const, taskKey: '1', createdAt: 'x', updatedAt: 'x' }
    const lines = observationLines([
      { ...base, id: '1', kind: 'hotspot', key: 'src/a.ts', evidence: { tasks: [{ key: '1', at: 'x', task: 't' }], trouble: { conflicts: 2, threads: 0, outside: 0, reread: 0 } } },
      { ...base, id: '2', kind: 'drift', key: 'k', evidence: { tasks: [], quotes: ['q'] } },
      { ...base, id: '3', kind: 'hotspot', key: 'gone.ts', status: 'dismissed', evidence: { tasks: [] } },
    ])
    expect(lines).toEqual(['- src/a.ts: trouble in 1 of the latest tasks (2 merge conflicts). Give it to one thread at a time.'])
  })

  it('notes a call failing the same way three times in a row, and parses suggestions', () => {
    const call = (seq: number, id: string): SessionRecord[] => [
      { type: 'assistant.message', seq, ts: 'x', turn: 1, step: seq, content: '', toolCalls: [{ id, name: 'bash', arguments: '{"command":"npm test"}' }], finishReason: 'tool_use', usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 } } as unknown as SessionRecord,
      { type: 'tool.result', seq: seq + 1, ts: 'x', turn: 1, step: seq, toolCallId: id, name: 'bash', content: 'no', isError: true, error: { code: 'tool/failed', message: 'no' }, durationMs: 1 } as unknown as SessionRecord,
    ]
    const start = { type: 'turn.start', seq: 0, ts: 'x', turn: 1 } as unknown as SessionRecord
    expect(loopNote([start, ...call(1, 'a'), ...call(3, 'b')])).toBeUndefined()
    expect(loopNote([start, ...call(1, 'a'), ...call(3, 'b'), ...call(5, 'c')])?.note).toContain('The last 3 calls of bash had the same input and failed the same way (tool/failed)')
    expect(parseSuggestions('Sure: {"items":[{"id":"a","suggestion":"Keep it.","rule":"Do X"},{"nope":1}]}')).toEqual(new Map([['a', { suggestion: 'Keep it.', rule: 'Do X' }]]))
  })
})

async function coordinator(t: TestSdk) {
  const project = await t.sdk.call('projects.open', { root: nodePath.join(t.base, 'p'), create: true })
  const session = await t.sdk.call('sessions.coordinator', { projectId: project.projectId })
  const dataDir = resolveProjectLayout(project.root, { home: t.home }).dataDir
  const send = async (text: string, turn: number) => {
    await t.sdk.call('turns.send', { projectId: project.projectId, sessionId: session.sessionId, text })
    await waitForEvent(t, event => event.sessionId === session.sessionId && event.type === 'turn.end' && event.turn === turn)
  }
  return { projectId: project.projectId, sessionId: session.sessionId, dataDir, send }
}

async function until<T>(read: () => Promise<T | undefined>, timeoutMs = 10_000): Promise<T> {
  const end = Date.now() + timeoutMs
  for (;;) {
    const value = await read().catch(() => undefined)
    if (value !== undefined) return value
    if (Date.now() > end) throw new Error('timed out')
    await new Promise(resolve => setTimeout(resolve, 25))
  }
}

describe('project memory in the SDK', () => {
  it('lets the conversation propose a rule only in the user\'s own words, kept pending until the user confirms', async () => {
    const t = await testSdk([
      { toolCalls: [{ name: 'propose_memory', arguments: { text: '公共接口一律不改', quote: '以后都不要改公共接口', files: ['src/api.ts'] } }] },
      { toolCalls: [{ name: 'propose_memory', arguments: { text: 'Use tabs', quote: 'always use tabs' } }] },
      { content: 'ok' },
    ])
    const c = await coordinator(t)
    await c.send('先修 bug。以后都不要改公共接口。', 1)
    const results = t.eventsOf(c.sessionId).flatMap(event => (event.type === 'tool.result' ? [event] : []))
    expect(results[0]).toMatchObject({ name: 'propose_memory', isError: false })
    expect(results[1]).toMatchObject({ name: 'propose_memory', isError: true })
    expect(results[1]!.content).toContain('the user\'s own words')
    const { entries } = await t.sdk.call('handbook.list', { projectId: c.projectId, includeRetired: true })
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({ kind: 'rule', pending: true, status: 'trial', text: '公共接口一律不改', quote: '以后都不要改公共接口', files: ['src/api.ts'], missing: ['src/api.ts'] })
    const confirmed = await t.sdk.call('handbook.setStatus', { projectId: c.projectId, entryId: entries[0]!.id, status: 'active' })
    expect(confirmed.entry.pending).toBeUndefined()
  })

  it('adds, edits and deletes entries and keeps the notes from the memory page', async () => {
    const t = await testSdk([])
    const c = await coordinator(t)
    const rule = await t.sdk.call('handbook.add', { projectId: c.projectId, text: '日期一律用 UTC', appliesTo: 'api/' })
    expect(rule.entry).toMatchObject({ kind: 'rule', status: 'active', appliesTo: 'api/' })
    expect(rule.ops[0]).toMatchObject({ op: 'add', actor: 'user' })
    const edited = await t.sdk.call('handbook.edit', { projectId: c.projectId, entryId: rule.entry.id, text: '日期一律用 UTC 存储', appliesTo: 'server/' })
    expect(edited.entry).toMatchObject({ text: '日期一律用 UTC 存储', appliesTo: 'server/' })
    const practice = await t.sdk.call('handbook.add', { projectId: c.projectId, kind: 'practice', text: 'Run the migration check before the build' })
    expect(practice.entry).toMatchObject({ status: 'active', scope: 'project' })
    expect(practice.entry.kind).toBeUndefined()
    await expect(t.sdk.call('handbook.add', { projectId: c.projectId, kind: 'practice', text: 'Run the migration check before the build' })).rejects.toMatchObject({ code: 'tool/invalid-input' })
    await expect(t.sdk.call('handbook.edit', { projectId: c.projectId, entryId: practice.entry.id, appliesTo: 'x' })).rejects.toMatchObject({ code: 'tool/invalid-input' })
    expect(await t.sdk.call('memory.notes', { projectId: c.projectId })).toEqual({ text: '' })
    const notes = await t.sdk.call('memory.saveNotes', { projectId: c.projectId, text: '## Goals\n- ship it\n' })
    expect(notes.text).toBe('## Goals\n- ship it')
    expect(notes.updatedAt).toEqual(expect.any(String))
    expect(await readFile(nodePath.join(c.dataDir, 'coordinator-notes.md'), 'utf8')).toBe('## Goals\n- ship it\n')
  })

  it('counts a correction coming back across tasks and lets the user keep it as a rule', async () => {
    const suggestion = (request: LLMRequest) => {
      const body = JSON.parse(String(request.messages[1]!.content)) as { patterns: { id: string }[] }
      return { content: JSON.stringify({ items: [{ id: body.patterns[0]!.id, suggestion: '你多次要求不改公共接口。', rule: '不要改公共接口，保持 parse 的签名' }] }) }
    }
    const t = await testSdk([
      { content: 'ok' },
      { content: 'ok' },
      { content: 'ok' },
      request => (systemOf(request).includes('problems that keep coming back') ? suggestion(request) : { content: 'ok' }),
    ], { observationSuggestions: true })
    const c = await coordinator(t)
    await c.send('Write the parser module.', 1)
    await c.send('不对，不要改公共接口，保持 parse 函数的签名不变', 2)
    await c.send('错了，还是不要改公共接口，parse 函数签名要保持', 3)
    const facts = await until(async () => {
      const lines = (await readFile(nodePath.join(c.dataDir, 'memory', 'facts.jsonl'), 'utf8')).trim().split('\n')
      return lines.length === 3 ? lines.map(line => JSON.parse(line) as TaskFacts) : undefined
    })
    expect(facts.map(item => item.corrections.map(correction => correction.kind))).toEqual([[], ['redo'], ['redo']])
    const listed = await until(async () => {
      const list = await t.sdk.call('memory.observations', { projectId: c.projectId })
      return list.observations[0]?.suggestion === undefined ? undefined : list
    })
    const drift = listed.observations[0]!
    expect(drift).toMatchObject({ kind: 'drift', status: 'open', rule: '不要改公共接口，保持 parse 的签名', suggestion: '你多次要求不改公共接口。' })
    expect(drift.evidence.tasks).toHaveLength(2)
    expect(t.events.some(event => event.type === 'memory.observations')).toBe(true)
    const kept = await t.sdk.call('memory.resolve', { projectId: c.projectId, observationId: drift.id, status: 'adopted', text: drift.rule! })
    expect(kept).toMatchObject({ status: 'adopted', entryId: expect.any(String) })
    const { entries } = await t.sdk.call('handbook.list', { projectId: c.projectId })
    expect(entries.find(entry => entry.id === kept.entryId)).toMatchObject({ kind: 'rule', status: 'active', quote: '错了，还是不要改公共接口，parse 函数签名要保持' })
  })
})
