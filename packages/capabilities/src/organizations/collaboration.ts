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
 *   two threads (with one thread there is nothing between threads).
 * - Starting a trial: the latest run had a target event of a variable that
 *   is still at its default, and the variable is not cooling down. The
 *   baseline is the last {@link BASELINE_WINDOW} such runs; it needs at
 *   least {@link BASELINE_MIN}. With a share `p0` of them hitting a target,
 *   the trial needs `n` clean runs in a row, the least n ≥ 2 with
 *   (1 − p0)ⁿ ≤ {@link CHANCE}: chance alone would leave that many runs
 *   clean at most 10 % of the time. When n would exceed {@link MAX_NEED},
 *   the events are too rare to judge with few runs and no trial starts.
 * - Judging, on every run under the trial that applied it: a target event
 *   again, a run that did not go well (apart from the user's mid-task
 *   corrections), or a cost above {@link COST_TOLERANCE} times the
 *   baseline's median reverts it; `n` clean runs keep it (its value becomes
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
/** Counted runs a reverted or inconclusive variable waits before it is tried again. */
export const COOLDOWN = 10
/** The shape every counted coordinator run has (trials apply to any coordinator task split among threads). */
export const COORDINATOR_SHAPE = 'coordinator'

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
  return run.level === 'coordinator' && run.waiting !== true && run.parts >= 2 && run.events !== undefined
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
export function keptCollaboration(states: readonly TrialState[], mode: CollaborationMode = 'central'): CollaborationConfig {
  let config: CollaborationConfig = { ...DEFAULT_COLLABORATION, mode }
  for (const state of [...states].sort((l, r) => (l.verdict?.seq ?? 0) - (r.verdict?.seq ?? 0))) {
    if (state.verdict?.verdict === 'kept') config = { ...config, [state.trial.variable]: state.trial.value }
  }
  return config
}

/** Pure: the arrangement a new task of the shape runs with: the kept one, and the trial's value when one is going. */
export function collaborationFor(states: readonly TrialState[], mode: CollaborationMode = 'central'): { readonly collaboration: CollaborationConfig; readonly trial?: CollaborationTrial } {
  const config = keptCollaboration(states, mode)
  const active = states.find(state => state.verdict === undefined)?.trial
  return active === undefined ? { collaboration: config } : { collaboration: { ...config, [active.variable]: active.value }, trial: active }
}

/** Pure: whether a run under a trial actually ran with the trial's value. */
function applied(trial: CollaborationTrial, run: TrialRun): boolean {
  return run.collaboration?.[trial.variable] === trial.value
}

/** Pure: the verdict on a trial from the runs (in order), or `undefined` while it goes on. */
export function judgeTrial(trial: CollaborationTrial, runs: readonly TrialRun[]): CollaborationVerdict | undefined {
  const under = runs.filter(run => run.trial === trial.id && run.waiting !== true)
  const tried = under.filter(run => counted(run) && applied(trial, run))
  let clean = 0
  for (const run of tried) {
    if (!run.sound || hits(run, trial.target)) return 'reverted'
    if (trial.baselineUsd > 0 && run.usd > trial.baselineUsd * COST_TOLERANCE) return 'reverted'
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
  if (states.some(state => state.verdict === undefined)) return undefined
  const latest = runId === undefined ? runs.at(-1) : runs.find(run => run.id === runId)
  if (latest === undefined || !counted(latest)) return undefined
  const kept = keptCollaboration(states)
  const all = runs.filter(counted)
  for (const option of COLLABORATION_TRIALS) {
    if (kept[option.variable] === option.value || !hits(latest, option.target)) continue
    // Cooling down: reverted or inconclusive within the last COOLDOWN counted runs.
    const cooling = states.some(state => state.trial.variable === option.variable && state.verdict !== undefined && state.verdict.verdict !== 'kept'
      && all.filter(run => run.seq > state.verdict!.seq).length < COOLDOWN)
    if (cooling) continue
    // The baseline: counted runs that ran with the variable at its default.
    const baseline = all.filter(run => run.collaboration === undefined || run.collaboration[option.variable] !== option.value).slice(-BASELINE_WINDOW)
    if (baseline.length < BASELINE_MIN) continue
    const hit = baseline.filter(run => hits(run, option.target)).length
    const need = needFor(hit / baseline.length)
    if (need === undefined) continue
    return {
      id,
      shape: COORDINATOR_SHAPE,
      variable: option.variable,
      value: option.value,
      target: [...option.target],
      baseline: { runs: baseline.length, hits: hit },
      need,
      baselineUsd: Math.round(median(baseline.map(run => run.usd)) * 1e6) / 1e6,
      runId: latest.id,
    }
  }
  return undefined
}

/**
 * Pure: the line for the next coordinator task: a verdict no counted run
 * has followed yet, or the trial going on.
 */
export function trialNote(states: readonly TrialState[], runs: readonly TrialRun[]): CollaborationTrialNote | undefined {
  const judged = states.filter(state => state.verdict !== undefined).sort((l, r) => l.verdict!.seq - r.verdict!.seq).at(-1)
  if (judged !== undefined && !runs.some(run => counted(run) && run.seq > judged.verdict!.seq)) {
    return { status: judged.verdict!.verdict, variable: judged.trial.variable, value: judged.trial.value }
  }
  const active = states.find(state => state.verdict === undefined)
  return active === undefined ? undefined : { status: 'trying', variable: active.trial.variable, value: active.trial.value }
}
