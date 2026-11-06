/**
 * New direction step 3: the organization library classes similar tasks,
 * compares teams with working alone by deterministic signals only, keeps
 * 1 in 5 (then 1 in 10) turns for comparison, and suggests the organization
 * that went well with its roles.
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { OrganizationRun, TurnOrganizationEnd } from '@nexgent/kernel'
import { asksRedo, defaultOrganizer } from '@nexgent/workflow'
import { describe, expect, it } from 'vitest'
import {
  classVerdict,
  foldOrganizationLog,
  OrganizationLibrary,
  ORGANIZATION_CONCLUDED_CONTROL_RATE,
  ORGANIZATION_CONTROL_RATE,
  pickOrganization,
  suggestOrganization,
  summarizeOrganizations,
  type FoldedRun,
  wentWell,
  collaborationFor,
  counted,
  judgeTrial,
  keptCollaboration,
  MAX_TRIAL_RUNS,
  needFor,
  newTrial,
  trialNote,
  type TrialRun,
  type TrialState,
} from '../src/index.js'
import { NO_COLLABORATION_EVENTS, type CollaborationEvents, type OrganizationProfile } from '@nexgent/kernel'

const KEY = ['export', 'csv', 'report', 'endpoint']
let n = 0
function run(over: Partial<FoldedRun> = {}): FoldedRun {
  n += 1
  return {
    id: `r${n}`, at: '2026-10-19T00:00:00.000Z', classId: 'c1', key: KEY, sessionId: `s${n}`, turn: 1, decision: 'team', control: false,
    reorganizations: 0, corrections: 0, completed: true, usd: 1, reworked: false, ...over,
  }
}
const planBuild = { name: 'plan-build-review' as const, roles: [{ name: 'planner', kind: 'plan' as const, after: [] }, { name: 'builder', kind: 'implement' as const, after: ['planner'] }] }
const sequence = (...values: number[]) => () => values.shift() ?? 0.5

describe('organization library', () => {
  it('puts similar tasks in one class and marks a session reworked by later feedback', () => {
    const runs = foldOrganizationLog([
      { type: 'run', ...run({ sessionId: 'a' }) },
      { type: 'run', ...run({ sessionId: 'b' }) },
      { type: 'rework', sessionId: 'a', at: '2026-10-19T00:00:01.000Z' },
    ])
    expect(runs.map(r => r.reworked)).toEqual([true, false])
    expect(suggestOrganization(['export', 'csv', 'report', 'button'], runs, () => 0.9).classId).toBe('c1')
    expect(suggestOrganization(['typo', 'readme', 'title'], runs, () => 0.9).classId).not.toBe('c1')
  })

  it('does not count a run still waiting for its threads, or one whose thread run failed, as gone well', async () => {
    const at = '2026-10-19T00:00:01.000Z'
    const runs = foldOrganizationLog([
      { type: 'run', ...run({ sessionId: 'waiting', waiting: true }) },
      { type: 'run', ...run({ sessionId: 'failed', waiting: true }) },
      { type: 'run', ...run({ sessionId: 'done', waiting: true }) },
      { type: 'profile', sessionId: 'failed', turn: 1, profile: profile(0.5), completed: false, at },
      { type: 'profile', sessionId: 'done', turn: 1, profile: profile(0.5), at },
    ])
    expect(runs.map(r => [r.sessionId, wentWell(r)])).toEqual([['waiting', false], ['failed', false], ['done', true]])
    const dir = await mkdtemp(join(tmpdir(), 'org-threads-'))
    try {
      const library = new OrganizationLibrary(dir)
      const { id: _id, at: _at, reworked: _reworked, ...recorded } = run({ sessionId: 's-threads', waiting: true })
      await library.record(recorded)
      await library.noteProfile({ sessionId: 's-threads', turn: 1, profile: profile(0.5), completed: false })
      const [stored] = await library.runs()
      expect(stored).toMatchObject({ completed: false })
      expect(wentWell(stored!)).toBe(false)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('takes an external review of a run with no other signal: a low score means it did not go well', async () => {
    const runs = foldOrganizationLog([
      { type: 'run', ...run({ sessionId: 'a', turn: 1 }) },
      { type: 'run', ...run({ sessionId: 'b', turn: 1 }) },
      { type: 'review', sessionId: 'a', turn: 1, score: 0.4, at: '2026-10-19T00:00:01.000Z' },
      { type: 'review', sessionId: 'b', turn: 1, score: 0.9, at: '2026-10-19T00:00:01.000Z' },
    ])
    expect(runs.map(r => [r.review, wentWell(r)])).toEqual([[0.4, false], [0.9, true]])
    const dir = await mkdtemp(join(tmpdir(), 'org-review-'))
    try {
      const library = new OrganizationLibrary(dir)
      const { id: _id, at: _at, reworked: _reworked, ...recorded } = run({ sessionId: 's-review', turn: 2 })
      await library.record(recorded)
      await library.noteReview({ sessionId: 's-review', turn: 1, score: 0.1 })
      await library.noteReview({ sessionId: 's-review', turn: 2, score: 0.2 })
      expect((await library.lines()).filter(line => line.type === 'review')).toHaveLength(1)
      expect((await library.runs())[0]).toMatchObject({ review: 0.2 })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('compares teams with working alone and lowers the comparison share once there is a verdict', () => {
    const comparing = [run({ decision: 'solo' }), run()]
    expect(classVerdict(comparing)).toBe('comparing')
    // Just under the comparison share: this turn is done alone.
    expect(suggestOrganization(KEY, comparing, sequence(ORGANIZATION_CONTROL_RATE - 0.01))).toMatchObject({ decision: 'solo', control: true, runs: 2 })
    const decided = [
      ...Array.from({ length: 5 }, (_, i) => run({ decision: 'solo', corrections: i === 0 ? 0 : 1 })),
      ...Array.from({ length: 5 }, () => run({ organization: planBuild })),
    ]
    expect(classVerdict(decided)).toBe('team-better')
    expect(suggestOrganization(KEY, decided, sequence(ORGANIZATION_CONTROL_RATE - 0.01))).toMatchObject({ decision: 'team', control: false })
    expect(suggestOrganization(KEY, decided, sequence(ORGANIZATION_CONCLUDED_CONTROL_RATE - 0.01))).toMatchObject({ decision: 'solo', control: true })
    const reversed = decided.map(r => ({ ...r, decision: r.decision === 'solo' ? 'team' as const : 'solo' as const }))
    expect(classVerdict(reversed)).toBe('solo-better')
    expect(suggestOrganization(KEY, reversed, sequence(0.5))).toMatchObject({ decision: 'solo', control: false })
    expect(summarizeOrganizations(decided)[0]).toMatchObject({ verdict: 'team-better', soloRuns: 5, teamRuns: 5, organization: 'plan-build-review', soloGood: 0.2, teamGood: 1, costChange: 0 })
  })

  it('leaves runs still waiting for their threads out of the comparison until they settle', () => {
    const solo = Array.from({ length: 5 }, () => run({ decision: 'solo' }))
    const pending = Array.from({ length: 5 }, () => run({ organization: planBuild, waiting: true }))
    expect(classVerdict([...solo, ...pending])).toBe('comparing')
    expect(summarizeOrganizations([...solo, ...pending])[0]).toMatchObject({ verdict: 'comparing', soloRuns: 5, teamRuns: 0 })
    // The same team runs once settled count as they went.
    expect(classVerdict([...solo, ...pending.map(({ waiting: _waiting, ...r }) => ({ ...r, completed: false }))])).toBe('solo-better')
  })

  it('suggests the organization that went well with its roles, and weighs cost', () => {
    const failedCustom = run({ organization: { name: 'custom', roles: [{ name: 'x', kind: 'implement', after: [] }] }, checks: { passed: 0, total: 1 } })
    const good = run({ organization: planBuild })
    // Same sampled rates (a constant draw): the cheaper organization wins; a custom one never went well, so it is not a candidate.
    const cheap = pickOrganization([failedCustom, good, run({ organization: { name: 'lead-checker', roles: [] }, usd: 5 })], () => 0.5)
    expect(cheap).toEqual({ name: 'plan-build-review', roles: planBuild.roles })
    const changed = run({ organization: { name: 'custom', roles: [{ name: 'setup', kind: 'implement', after: [] }, { name: 'tester', kind: 'test', after: ['setup'] }] }, reorganizations: 1 })
    expect(pickOrganization([changed], sequence(0.1, 0.1, 0.1, 0.9, 0.9))).toEqual({ name: 'custom', roles: changed.organization!.roles })
  })

  it('learns from the turns the organizer decided, end to end', async () => {
    const library = new OrganizationLibrary(join(await mkdtemp(join(tmpdir(), 'nexgent-orgs-')), 'organizations'))
    const organizer = defaultOrganizer({ memory: () => library, random: () => 0.99 })
    const text = 'Add a CSV export to the reports page.\nIt needs a server endpoint, a download button and tests for both.'
    const decide = (sessionId: string, source: 'user' | 'feedback' = 'user', rating?: number) =>
      organizer.decide({ sessionId, turn: 1, text, source, materialIds: [], ...(rating === undefined ? {} : { rating }) })
    const end = (sessionId: string, over: Partial<TurnOrganizationEnd> = {}) => organizer.noteTurnEnd!({
      sessionId, turn: 1, reason: { kind: 'completed' }, use: { decision: 'team', chosenBy: 'default', name: 'plan-build-review', roles: 2, reorganizations: 0, corrections: 0 },
      organization: planBuild, checks: [{ name: 'test-command', passed: true }], usd: 0.4, projectRoot: '/nowhere', tools: [], changes: [], presented: [], ...over,
    })
    expect((await decide('s1'))!.decision).toEqual({ decision: 'team', chosenBy: 'default', suggested: expect.any(String) })
    await end('s1')
    const second = await decide('s2')
    expect(second!.decision.chosenBy).toBe('memory')
    await end('s2', { use: { decision: 'team', chosenBy: 'memory', reorganizations: 0, corrections: 1 } })
    // Feedback asking for changes reworks the session's turn; a feedback turn is not recorded itself.
    await decide('s1', 'feedback', 2)
    await decide('s2', 'feedback', 5)
    const runs = await library.runs()
    expect(runs.map(r => [r.sessionId, r.reworked, r.corrections, r.checks, r.usd])).toEqual([['s1', true, 0, { passed: 1, total: 1 }, 0.4], ['s2', false, 1, { passed: 1, total: 1 }, 0.4]])
    expect(new Set(runs.map(r => r.classId)).size).toBe(1)
    expect(await library.summary()).toMatchObject([{ verdict: 'comparing', teamRuns: 2, soloRuns: 0, teamGood: 0 }])
  })

  it('classes tasks worded differently by what they did, and counts redo messages and deleted results as rework', async () => {
    const base = await mkdtemp(join(tmpdir(), 'nexgent-orgs-'))
    const project = join(base, 'project')
    await mkdir(project)
    await writeFile(join(project, 'report.csv'), 'a,b\n')
    const library = new OrganizationLibrary(join(base, 'organizations'))
    const organizer = defaultOrganizer({ memory: () => library, random: () => 0.99 })
    const did = {
      projectRoot: project,
      tools: ['organize', 'read_file', 'run_command', 'write_file'],
      changes: [{ path: 'src/export.ts', change: 'added' as const }, { path: 'tests/export.test.ts', change: 'modified' as const }],
      checks: [{ name: 'test-command', passed: true }],
    }
    const turn = async (sessionId: string, turnNo: number, text: string, over: Partial<TurnOrganizationEnd> = {}) => {
      await organizer.decide({ sessionId, turn: turnNo, text, source: 'user', materialIds: [] })
      await organizer.noteTurnEnd!({
        sessionId, turn: turnNo, reason: { kind: 'completed' }, use: { decision: 'team', chosenBy: 'default', reorganizations: 0, corrections: 0 }, usd: 0.3, presented: [], ...did, ...over,
      })
    }
    await turn('s1', 1, 'Add a CSV export to the reports page.\nIt needs a server endpoint and tests.', { presented: ['report.csv'] })
    await turn('s2', 1, '订单列表要能下载成表格文件。\n后端加接口，前端加按钮，并补上测试。')
    let runs = await library.runs()
    expect(runs.map(r => r.traits)).toEqual([['check:test-command', 'ext:ts', 'tool:read_file', 'tool:run_command', 'tool:write_file'], expect.any(Array)])
    expect(runs[1]!.classId).toBe(runs[0]!.classId)
    expect(runs[0]!.outputs).toEqual(['report.csv'])
    // A later task worded like the second one now finds the shared class by its words.
    expect((await library.suggest({ text: '客户列表要能下载成表格文件。\n后端加接口，前端加按钮。', random: () => 0.99 })).classId).toBe(runs[0]!.classId)
    // A follow-up saying the result is wrong reworks that session's turn; a new task mentioning such a word later does not.
    await organizer.decide({ sessionId: 's2', turn: 2, text: '不对，改回去，按钮放在表格上面。', source: 'user', materialIds: [] })
    await organizer.decide({ sessionId: 's1', turn: 2, text: 'Add paging to the list.\nUndo is not needed.', source: 'user', materialIds: [] })
    // The user deleted the first task's result outside Nexgent: rework too, noticed at the next recorded turn.
    await rm(join(project, 'report.csv'))
    await turn('s3', 1, 'Add a PDF export to the invoices page.\nIt needs an endpoint and tests.')
    runs = await library.runs()
    expect(runs.map(r => [r.sessionId, r.reworked])).toEqual([['s1', true], ['s2', true], ['s3', false]])
  })

  it('recognizes a redo message only in its opening sentence', () => {
    expect(asksRedo('不对，改回去')).toBe(true)
    expect(asksRedo('This is wrong. Use semicolons.')).toBe(true)
    expect(asksRedo('Please redo the chart with weekly totals')).toBe(true)
    expect(asksRedo('Add an undo button to the editor')).toBe(false)
    expect(asksRedo('给编辑器加一个按钮。不对的输入要提示。')).toBe(false)
    expect(asksRedo('加一个撤销按钮')).toBe(false)
    expect(asksRedo('嗯，撤销刚才的改动')).toBe(true)
    expect(asksRedo('导出的文件不是我要的格式')).toBe(true)
  })
})

function profile(builderShare: number, over: { failures?: number; usd?: number; ms?: number } = {}): OrganizationProfile {
  const usd = over.usd ?? 1
  const ms = over.ms ?? 10_000
  const part = (name: string, kind: 'coordinator' | 'implement', share: number, failures = 0) => ({ name, kind, tokens: Math.round(share * 1000), share, usd: share * usd, ms: share * ms, failures, retries: 0, idleMs: 0, wasted: false })
  return { usd, ms, tokens: 1000, parts: [part('coordinator', 'coordinator', 1 - builderShare), part('builder', 'implement', builderShare, over.failures)] }
}
describe('collaboration trials', () => {
  const events = (over: Partial<CollaborationEvents> = {}): CollaborationEvents => ({ ...NO_COLLABORATION_EVENTS, ...over })
  let seq = 0
  const trun = (over: Partial<TrialRun> = {}): TrialRun => {
    seq += 1
    return { id: `t${seq}`, seq, level: 'coordinator', parts: 2, events: events(), sound: true, usd: 1, ...over }
  }

  it('counts only settled coordinator runs split among at least two threads', () => {
    expect(counted(trun())).toBe(true)
    expect(counted(trun({ parts: 1 }))).toBe(false)
    const { level: _level, ...member } = trun()
    expect(counted(member)).toBe(false)
    expect(counted(trun({ waiting: true }))).toBe(false)
  })

  it('needs as many clean runs as chance alone would rarely give, and none for rare events', () => {
    expect(needFor(1)).toBe(2)
    expect(needFor(0.8)).toBe(2)
    expect(needFor(0.5)).toBe(4)
    expect(needFor(0.2)).toBeUndefined()
    expect(needFor(0)).toBeUndefined()
  })

  it('starts a trial on events that keep happening, and none on a rare one', () => {
    const often = [trun({ events: events({ conflicts: 1 }) }), trun({ events: events({ overlap: 2 }) }), trun(), trun({ events: events({ conflicts: 1 }) })]
    const trial = newTrial(often, [], undefined, 'trial-1')
    expect(trial).toMatchObject({ id: 'trial-1', variable: 'overlap', value: 'sequence', target: ['overlap', 'conflicts'], baseline: { runs: 4, hits: 3 }, need: 2, runId: often.at(-1)!.id })
    // One conflict in five runs is too rare to tell from luck with few runs.
    const rare = [trun(), trun(), trun(), trun(), trun({ events: events({ conflicts: 1 }) })]
    expect(newTrial(rare, [])).toBeUndefined()
    // Too few runs, or a clean latest run, start nothing.
    expect(newTrial([trun({ events: events({ missing: 1 }) }), trun({ events: events({ missing: 1 }) })], [])).toBeUndefined()
    expect(newTrial([...often, trun()], [])).toBeUndefined()
  })

  it('keeps a trial after enough clean runs that applied it, and reverts it at once when the events come back or the result is worse', () => {
    const trial = newTrial([trun({ events: events({ missing: 1 }) }), trun({ events: events({ missing: 1 }) }), trun({ events: events({ missing: 1 }) })], [], undefined, 'h')!
    expect(trial).toMatchObject({ variable: 'handoff', value: 'manifest', need: 2 })
    const under = (over: Partial<TrialRun> = {}) => trun({ trial: 'h', collaboration: { mode: 'central', handoff: 'manifest', overlap: 'parallel' }, ...over })
    expect(judgeTrial(trial, [under()])).toBeUndefined()
    expect(judgeTrial(trial, [under(), under()])).toBe('kept')
    expect(judgeTrial(trial, [under(), under({ events: events({ missing: 1 }) })])).toBe('reverted')
    expect(judgeTrial(trial, [under({ sound: false })])).toBe('reverted')
    expect(judgeTrial(trial, [under({ usd: 1.6 })])).toBe('reverted')
    // A run that did not apply it (a single thread) is no trial; enough of them end it without a verdict.
    const idle = Array.from({ length: MAX_TRIAL_RUNS }, () => under({ parts: 1 }))
    expect(judgeTrial(trial, idle.slice(0, 2))).toBeUndefined()
    expect(judgeTrial(trial, idle)).toBe('inconclusive')
  })

  it('gives a kept value as the default and the trial going on on top of it', () => {
    const overlap = { id: 'o', shape: 'coordinator', variable: 'overlap' as const, value: 'sequence', target: ['overlap' as const], baseline: { runs: 3, hits: 3 }, need: 2, baselineUsd: 1, runId: 'x' }
    const handoff = { ...overlap, id: 'h', variable: 'handoff' as const, value: 'manifest', target: ['missing' as const] }
    const states: TrialState[] = [{ trial: overlap, seq: 1, verdict: { verdict: 'kept', seq: 5 } }, { trial: handoff, seq: 6 }]
    expect(keptCollaboration(states, 'hybrid')).toEqual({ mode: 'hybrid', handoff: 'summary', overlap: 'sequence' })
    expect(collaborationFor(states)).toMatchObject({ collaboration: { mode: 'central', handoff: 'manifest', overlap: 'sequence' }, trial: { id: 'h' } })
    expect(trialNote(states, [])).toEqual({ status: 'kept', variable: 'overlap', value: 'sequence' })
    expect(trialNote(states, [trun({ seq: 7 })])).toEqual({ status: 'trying', variable: 'handoff', value: 'manifest' })
    const done: TrialState[] = [{ trial: handoff, seq: 6, verdict: { verdict: 'reverted', seq: 9 } }]
    expect(trialNote(done, [trun({ seq: 8 })])).toEqual({ status: 'reverted', variable: 'handoff', value: 'manifest' })
    expect(trialNote(done, [trun({ seq: 10 })])).toBeUndefined()
    // A reverted variable cools down before it is tried again.
    const hit = Array.from({ length: 4 }, (_, index) => trun({ seq: 10 + index, events: events({ missing: 1 }) }))
    expect(newTrial(hit, done)).toBeUndefined()
  })

  it('starts, applies and judges a trial through the library and the organizer, end to end', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'nexgent-collab-'))
    try {
      const library = new OrganizationLibrary(dir)
      const TASK = 'Add the export endpoint to the report service.\nWrite its tests and update the README.'
      const organizer = defaultOrganizer({ memory: () => library, random: () => 0.9 })
      const thread = (name: string) => ({ name, kind: 'thread' as const, tokens: 1, share: 0.5, usd: 0.5, ms: 1, failures: 0, retries: 0, idleMs: 0, wasted: false })
      const profile = (conflicts: number): OrganizationProfile => ({ usd: 1, ms: 10, tokens: 3, parts: [{ ...thread('coordinator'), kind: 'coordinator' }, thread('a'), thread('b')], events: events({ conflicts }) })
      // Three coordinator runs split among two threads, each with a conflict, start a trial.
      for (let turn = 1; turn <= 3; turn += 1) {
        await library.record({ classId: 'c', key: ['report'], sessionId: 'coord', turn, level: 'coordinator', decision: 'team', control: false, reorganizations: 0, corrections: 0, completed: true, usd: 1, waiting: true, collaboration: { mode: 'central', handoff: 'summary', overlap: 'parallel' } })
        await library.noteProfile({ sessionId: 'coord', turn, profile: profile(1) })
      }
      const [trial] = await library.trials()
      expect(trial?.trial).toMatchObject({ variable: 'overlap', value: 'sequence', need: 2 })
      const next = await organizer.decide({ sessionId: 'coord', turn: 4, text: TASK, source: 'user', materialIds: [], coordinator: true, collaboration: 'central' })
      expect(next?.decision).toMatchObject({ decision: 'team', collaboration: { overlap: 'sequence', handoff: 'summary', mode: 'central' }, trial: { status: 'trying', variable: 'overlap' } })
      expect(next?.section.body).toContain('owns')
      for (let turn = 4; turn <= 5; turn += 1) {
        await library.record({ classId: 'c', key: ['report'], sessionId: 'coord', turn, level: 'coordinator', decision: 'team', control: false, reorganizations: 0, corrections: 0, completed: true, usd: 1, waiting: true, collaboration: { mode: 'central', handoff: 'summary', overlap: 'sequence' }, trial: trial!.trial.id })
        await library.noteProfile({ sessionId: 'coord', turn, profile: profile(0) })
      }
      expect((await library.trials())[0]?.verdict?.verdict).toBe('kept')
      const after = await library.suggest({ text: TASK, level: 'coordinator', random: () => 0.9 })
      expect(after).toMatchObject({ collaboration: { overlap: 'sequence' }, trialNote: { status: 'kept', variable: 'overlap' } })
      expect(after.trial).toBeUndefined()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

export type { OrganizationRun }
