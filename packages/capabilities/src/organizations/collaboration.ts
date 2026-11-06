/**
 * Organization redo (user, 2026-11-06): optimize how the parts of a task
 * work together, not a sentence in a prompt. The library tries one
 * collaboration variable at a time (`COLLABORATION_TRIALS`: run threads
 * whose files overlap one after another; hand each thread the files the
 * earlier threads brought in), which the host then enforces, and judges it
 * by the collaboration events it is meant to remove (`CollaborationEvents`,
 * counted from the run records).
 *
 * - Which runs count: coordinator-level runs whose work went to at least
 *   two threads (with one thread there is nothing between threads), that
 *   ran the host's own split (not one the user named: `planned`) and whose
 *   threads reported in the four-line format (`completed` not `unknown`).
 * - Shapes: runs are grouped by `collaborationShape` (mode, number of
 *   threads, whether their `owns` overlapped). Baselines, trials, verdicts
 *   and cooldowns are kept per shape.
 * - Starting a trial: the latest run had a target event of a variable that
 *   is still at its default, and the variable is not cooling down; with
 *   several such variables, the one whose target events the baseline hit
 *   most often (the trial records the event hit most as `cause`). The
 *   baseline is the last {@link BASELINE_WINDOW} such runs; it needs at
 *   least {@link BASELINE_MIN}. With a share `p0` of them hitting a target,
 *   the trial needs `n` clean runs in a row, the least n ≥ 2 with
 *   (1 − p0)ⁿ ≤ {@link CHANCE}: chance alone would leave that many runs
 *   clean at most 10 % of the time. When n would exceed {@link MAX_NEED},
 *   the events are too rare to judge with few runs and no trial starts.
 * - Judging, on every run under the trial whose value took effect (its
 *   `triggers` entry is above 0; a run where it did not is neither clean
 *   nor failed): a target event again, a run that did not go well (a
 *   correction sent to a thread counts, one sent to the coordinator does
 *   not), a cost above {@link COST_TOLERANCE} times or a wall time above
 *   {@link TIME_TOLERANCE} times the baseline's median reverts it; `n` clean runs keep it (its value becomes
 *   the default); {@link MAX_TRIAL_RUNS} runs under it without a verdict
 *   end it as inconclusive.
 * - A reverted or inconclusive variable is not tried again for the next
 *   {@link COOLDOWN} counted runs.
 *
 * Nothing here depends on the kind of task: the variables and events are
 * the same for every task.
 */
import { randomUUID } from 'node:crypto'
import {
  COLLABORATION_TRIALS,
  DEFAULT_COLLABORATION,
  type CollaborationConfig,
  type CollaborationEvents,
  type CollaborationEventName,
  type CollaborationMode,
  type CollaborationTrial,
  type CollaborationTrialNote,
  type CollaborationTriggers,
  type CollaborationVerdict,
} from '@nexgent/kernel'

/** Counted runs a baseline is taken from (the latest). */
export const BASELINE_WINDOW = 10
/** Counted runs a trial needs before it can start. */
export const BASELINE_MIN = 3
/** The chance a trial's clean runs may have of being luck alone. */
export const CHANCE = 0.1
/** Most clean runs a trial may need (rarer events cannot be judged with few runs). */
export const MAX_NEED = 4
/** Runs under a trial (applied or not) before it ends without a verdict. */
export const MAX_TRIAL_RUNS = 6
/** How much more than the baseline's median a run under a trial may cost. */
export const COST_TOLERANCE = 1.5
/** How much more than the baseline's median wall time a run under a trial may take. */
export const TIME_TOLERANCE = 2
/** Counted runs a reverted or inconclusive variable waits before it is tried again. */
export const COOLDOWN = 10
/** The shape a task is assumed to have before its threads are known (see {@link collaborationShape}). */
export function defaultShape(mode: CollaborationMode): string {
  return `coordinator:${mode}:2:open`
}

/** Pure: the kind of task a run is, `coordinator:<mode>:<2|3+>:<apart|overlap|open>`. */
export function collaborationShape(run: { readonly mode: CollaborationMode; readonly parts: number; readonly owns?: 'apart' | 'overlap' | 'open' }): string {
  return `coordinator:${run.mode}:${run.parts >= 3 ? '3+' : '2'}:${run.owns ?? 'open'}`
}

/** What the trials need of a recorded run. */
export interface TrialRun {
  readonly id: string
  /** Position of the run's line in the library. */
  readonly seq: number
  readonly level?: 'coordinator'
  /** Threads (or members) its work went to. */
  readonly parts: number
  readonly events?: CollaborationEvents
  readonly collaboration?: CollaborationConfig
  readonly trial?: string
  /** It went well apart from the user's mid-task corrections. */
  readonly sound: boolean
  readonly usd: number
  /** Wall time of the task in ms. */
  readonly ms?: number
  /** What the trial's values did in the run. */
  readonly triggers?: CollaborationTriggers
  /** The user named the threads: the run is no trial. */
  readonly planned?: boolean
  /** The threads reported without the four-line format: whether the task completed is unknown. */
  readonly unknown?: boolean
  /** Whether the threads' `owns` kept apart, overlapped, or a thread had none. */
  readonly owns?: 'apart' | 'overlap' | 'open'
  /** Its threads have not all ended yet (no events, no outcome). */
  readonly waiting?: boolean
}

/** A trial with its verdict, as the library's lines give it. */
export interface TrialState {
  readonly trial: CollaborationTrial
  readonly seq: number
  readonly verdict?: { readonly verdict: CollaborationVerdict; readonly seq: number }
}

/** Pure: whether a run counts for collaboration (a settled coordinator run split among at least two threads, with its events). */
export function counted(run: TrialRun): boolean {
  return run.level === 'coordinator' && run.waiting !== true && run.parts >= 2 && run.events !== undefined && run.planned !== true && run.unknown !== true
}

/** Pure: a run's shape. */
export function shapeOf(run: TrialRun): string {
  return collaborationShape({ mode: run.collaboration?.mode ?? 'central', parts: run.parts, ...(run.owns === undefined ? {} : { owns: run.owns }) })
}

/** Pure: the shape a new task of `mode` is assumed to have: that of the latest counted run of the mode, else {@link defaultShape}. */
export function expectedShape(runs: readonly TrialRun[], mode: CollaborationMode): string {
  const latest = runs.filter(run => counted(run) && (run.collaboration?.mode ?? 'central') === mode).at(-1)
  return latest === undefined ? defaultShape(mode) : shapeOf(latest)
}

/** Pure: whether a run had one of the events. */
export function hits(run: Pick<TrialRun, 'events'>, target: readonly CollaborationEventName[]): boolean {
  return target.some(name => (run.events?.[name] ?? 0) > 0)
}

/** Pure: clean runs in a row a trial needs, given the share of baseline runs that hit its target (`undefined`: too rare to judge). */
export function needFor(p0: number): number | undefined {
  if (!(p0 > 0)) return undefined
  for (let n = 2; n <= MAX_NEED; n += 1) if ((1 - p0) ** n <= CHANCE) return n
  return undefined
}

function median(values: readonly number[]): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((l, r) => l - r)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2
}

/** Pure: the shape's arrangement: the defaults with the values of kept trials (a later one wins). */
export function keptCollaboration(states: readonly TrialState[], mode: CollaborationMode = 'central', shape: string = defaultShape(mode)): CollaborationConfig {
  let config: CollaborationConfig = { ...DEFAULT_COLLABORATION, mode }
  for (const state of [...states].filter(item => item.trial.shape === shape).sort((l, r) => (l.verdict?.seq ?? 0) - (r.verdict?.seq ?? 0))) {
    if (state.verdict?.verdict === 'kept') config = { ...config, [state.trial.variable]: state.trial.value }
  }
  return config
}

/** Pure: the arrangement a new task of the shape runs with: the kept one, and the trial's value when one is going. */
export function collaborationFor(states: readonly TrialState[], mode: CollaborationMode = 'central', shape: string = defaultShape(mode)): { readonly collaboration: CollaborationConfig; readonly trial?: CollaborationTrial } {
  const config = keptCollaboration(states, mode, shape)
  const active = states.find(state => state.verdict === undefined && state.trial.shape === shape)?.trial
  return active === undefined ? { collaboration: config } : { collaboration: { ...config, [active.variable]: active.value }, trial: active }
}

/** Pure: whether a run under a trial actually ran with the trial's value. */
function applied(trial: CollaborationTrial, run: TrialRun): boolean {
  return (run.triggers?.[TRIGGER_OF[trial.value] ?? 'sequence'] ?? 0) > 0
}

/** The `triggers` entry that shows a trial value took effect. */
const TRIGGER_OF: Readonly<Record<string, keyof CollaborationTriggers>> = Object.freeze({ sequence: 'sequence', changed: 'changed', named: 'named', separate: 'separate' })

/** Pure: the verdict on a trial from the runs (in order), or `undefined` while it goes on. */
export function judgeTrial(trial: CollaborationTrial, runs: readonly TrialRun[]): CollaborationVerdict | undefined {
  const under = runs.filter(run => run.trial === trial.id && counted(run))
  const tried = under.filter(run => applied(trial, run))
  let clean = 0
  for (const run of tried) {
    if (!run.sound || hits(run, trial.target)) return 'reverted'
    if (trial.baselineUsd > 0 && run.usd > trial.baselineUsd * COST_TOLERANCE) return 'reverted'
    // Running overlapping threads one after another costs wall time by design, so that variable is not judged on time.
    if (trial.variable !== 'overlap' && trial.baselineMs !== undefined && trial.baselineMs > 0 && run.ms !== undefined && run.ms > trial.baselineMs * TIME_TOLERANCE) return 'reverted'
    clean += 1
    if (clean >= trial.need) return 'kept'
  }
  return under.length >= MAX_TRIAL_RUNS ? 'inconclusive' : undefined
}

/**
 * Pure: a new trial after a run (`runId`; default the last one), or
 * `undefined`. `runs`: the library's runs in order; `states`: the trials so far.
 */
export function newTrial(runs: readonly TrialRun[], states: readonly TrialState[], runId?: string, id: string = randomUUID()): CollaborationTrial | undefined {
  const latest = runId === undefined ? runs.at(-1) : runs.find(run => run.id === runId)
  if (latest === undefined || !counted(latest)) return undefined
  const shape = shapeOf(latest)
  if (states.some(state => state.verdict === undefined && state.trial.shape === shape)) return undefined
  const kept = keptCollaboration(states, latest.collaboration?.mode ?? 'central', shape)
  const all = runs.filter(run => counted(run) && shapeOf(run) === shape)
  let best: { readonly option: typeof COLLABORATION_TRIALS[number]; readonly baseline: readonly TrialRun[]; readonly hit: number; readonly need: number } | undefined
  for (const option of COLLABORATION_TRIALS) {
    if (kept[option.variable] === option.value || !hits(latest, option.target)) continue
    // Cooling down: reverted or inconclusive within the last COOLDOWN counted runs of the shape.
    const cooling = states.some(state => state.trial.shape === shape && state.trial.variable === option.variable && state.verdict !== undefined && state.verdict.verdict !== 'kept'
      && all.filter(run => run.seq > state.verdict!.seq).length < COOLDOWN)
    if (cooling) continue
    // The baseline: counted runs of the shape that ran with the variable at its default.
    const baseline = all.filter(run => run.collaboration === undefined || run.collaboration[option.variable] !== option.value).slice(-BASELINE_WINDOW)
    if (baseline.length < BASELINE_MIN) continue
    const hit = baseline.filter(run => hits(run, option.target)).length
    const need = needFor(hit / baseline.length)
    if (need === undefined) continue
    // Several variables can be tried: take the one whose target events the baseline hit most often.
    if (best === undefined || hit / baseline.length > best.hit / best.baseline.length) best = { option, baseline, hit, need }
  }
  if (best === undefined) return undefined
  const { option, baseline, hit, need } = best
  let cause: CollaborationEventName | undefined
  let most = 0
  for (const name of option.target) {
    const n = baseline.filter(run => (run.events?.[name] ?? 0) > 0).length
    if (n > most) { most = n; cause = name }
  }
  const msValues = baseline.map(run => run.ms).filter((ms): ms is number => ms !== undefined && ms > 0)
  return {
    id,
    shape,
    variable: option.variable,
    value: option.value,
    target: [...option.target],
    baseline: { runs: baseline.length, hits: hit },
    need,
    baselineUsd: Math.round(median(baseline.map(run => run.usd)) * 1e6) / 1e6,
    ...(msValues.length === 0 ? {} : { baselineMs: Math.round(median(msValues)) }),
    ...(cause === undefined ? {} : { cause }),
    runId: latest.id,
  }
}

/**
 * Pure: the line for the next coordinator task: a verdict no counted run
 * has followed yet, or the trial going on.
 */
export function trialNote(all: readonly TrialState[], allRuns: readonly TrialRun[], shape?: string): CollaborationTrialNote | undefined {
  const states = shape === undefined ? all : all.filter(state => state.trial.shape === shape)
  const runs = shape === undefined ? allRuns : allRuns.filter(run => shapeOf(run) === shape)
  const judged = states.filter(state => state.verdict !== undefined).sort((l, r) => l.verdict!.seq - r.verdict!.seq).at(-1)
  if (judged !== undefined && !runs.some(run => counted(run) && run.seq > judged.verdict!.seq)) {
    return { status: judged.verdict!.verdict, variable: judged.trial.variable, value: judged.trial.value }
  }
  const active = states.find(state => state.verdict === undefined)
  return active === undefined ? undefined : { status: 'trying', variable: active.trial.variable, value: active.trial.value }
}
