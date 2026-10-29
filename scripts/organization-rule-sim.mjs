#!/usr/bin/env node
/**
 * How often the keep-or-revert rule of organization reflection decides
 * wrongly, by simulation, next to a few alternative rules. No model is
 * called: the script builds synthetic team runs and judges them.
 *
 * Rules compared (`--rules`, comma separated; default all):
 * - `current`: the product's own `newChange` and `judgeChange` from
 *   `@nexgent/capabilities` (KEEP_AFTER trials, each IMPROVE_BY under the
 *   old median of the part's share, whole cost within WHOLE_TOLERANCE).
 * - `usd`: the same two-trial rule, but on the part's cost in USD instead
 *   of its share of the task's cost.
 * - `usd-clean`: `usd`, with the baseline taken from the runs before the
 *   source run (the source run was picked for being hot, so it pulls the
 *   median up).
 * - `sequential`: on log cost of the part against the earlier runs, after
 *   each trial from the MIN_TRIALS-th on: keep when the mean log ratio is
 *   clearly below 0 (one-sided z at Z_KEEP, the noise estimated from the
 *   earlier runs pooled with a prior); revert when it is at or above 0,
 *   or at once when the bottom line fails; otherwise try again, at most
 *   MAX_TRIALS times, then revert. This is the "keep trying while undecided" idea of archive and
 *   tree search methods, in its simplest statistical form.
 *
 * Setting (one cell per noise level, history size and true effect):
 * - A team run has three parts, a coordinator, an `implement` member and a
 *   `test` member. Each part's cost is lognormal with medians 0.2, 0.5 and
 *   0.3 (USD) and the same log-sd `sigma` (run-to-run noise).
 * - The class has `history` team runs; the last one is the source run,
 *   drawn until `implement` is a cost hotspot there (share at least
 *   HOTSPOT_SHARE and above the median of earlier implement costs), as
 *   reflection requires.
 * - The change targets that hotspot (`cost` of `implement`; the action is
 *   `narrow-reading`, which every run follows, so no trial is dropped as
 *   unfollowed). Under the change the implement cost is multiplied by
 *   `1 - effect`; the other parts are unchanged.
 * - Each trial run goes well with probability `pGood`, independently of the
 *   change.
 *
 * Reported per rule and cell: the share of changes kept, and the mean
 * number of trial runs used.
 *
 * Usage: node scripts/organization-rule-sim.mjs [--trials 20000] [--seed 1] [--p-good 1] [--rules current,usd] [--json]
 * Needs `pnpm build` first (it imports the built package).
 */
import { parseArgs } from 'node:util'
import { HOTSPOT_SHARE, IMPROVE_BY, KEEP_AFTER, WHOLE_TOLERANCE, judgeChange, keptBottomLine, median, newChange } from '../packages/capabilities/dist/index.js'

const { values: args } = parseArgs({
  options: {
    trials: { type: 'string', default: '20000' },
    seed: { type: 'string', default: '1' },
    'p-good': { type: 'string', default: '1' },
    rules: { type: 'string', default: 'current,usd,usd-clean,sequential' },
    'seq-min': { type: 'string', default: '3' },
    'seq-max': { type: 'string', default: '8' },
    'seq-z': { type: 'string', default: '2' },
    json: { type: 'boolean', default: false },
  },
})
const TRIALS = Number(args.trials)
const P_GOOD = Number(args['p-good'])
const RULES = args.rules.split(',').map(rule => rule.trim()).filter(rule => rule !== '')
/** `sequential`: fewest trials before a verdict, most trials, and the one-sided z a keep needs. */
const MIN_TRIALS = Number(args['seq-min'])
const MAX_TRIALS = Number(args['seq-max'])
const Z_KEEP = Number(args['seq-z'])
/** Prior log-sd of a part's cost, pooled with the earlier runs' own estimate (weight PRIOR_WEIGHT runs). */
const PRIOR_SIGMA = 0.5
const PRIOR_WEIGHT = 2

/** Small seeded generator (mulberry32), so a run of the script is reproducible. */
function rng(seed) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
const random = rng(Number(args.seed))
function normal() {
  const u = 1 - random()
  const v = random()
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v)
}
const lognormal = (med, sigma) => med * Math.exp(sigma * normal())

const MEDIANS = { coordinator: 0.2, implement: 0.5, test: 0.3 }

function profileOf(usds) {
  const total = usds.coordinator + usds.implement + usds.test
  const part = (name, kind) => ({ name, kind, tokens: 0, share: usds[kind] / total, usd: usds[kind], ms: 1000, failures: 0, retries: 0, idleMs: 0, wasted: false })
  return { usd: total, ms: 3000, tokens: 0, parts: [part('coordinator', 'coordinator'), part('impl', 'implement'), part('qa', 'test')] }
}

function drawUsds(sigma, effect = 0) {
  return {
    coordinator: lognormal(MEDIANS.coordinator, sigma),
    implement: lognormal(MEDIANS.implement, sigma) * (1 - effect),
    test: lognormal(MEDIANS.test, sigma),
  }
}

let seq = 0
function run(usds, extra = {}) {
  const profile = profileOf(usds)
  seq += 1
  return { id: `r${seq}`, seq, decision: 'team', usd: profile.usd, profile, good: true, organization: { roles: [] }, ...extra }
}

const implUsd = item => item.profile.parts[1].usd

/** The class history ending in a source run where `implement` is a cost hotspot, and the change found on it. */
function setup(sigma, history) {
  const earlier = Array.from({ length: history - 1 }, () => run(drawUsds(sigma)))
  const earlierImpl = earlier.map(implUsd)
  let source
  for (;;) {
    source = run(drawUsds(sigma))
    const impl = source.profile.parts[1]
    if (impl.share >= HOTSPOT_SHARE && (earlierImpl.length === 0 || impl.usd > median(earlierImpl))) break
  }
  const team = [...earlier, source]
  const hotspot = { part: 'impl', kind: 'implement', cause: 'cost', value: source.profile.parts[1].share }
  const change = newChange({ classId: 'sim', run: source, hotspot, action: 'narrow-reading', history: team, id: `c${seq}` })
  return { earlier, team, change }
}

function trial(sigma, effect, change) {
  return run(drawUsds(sigma, effect), { change: change.id, good: random() < P_GOOD })
}

/** Each rule: a verdict ('kept' | 'reverted') and the trial runs it used. */
const JUDGES = {
  current(sigma, effect, { team, change }) {
    const runs = [...team]
    for (let i = 1; ; i += 1) {
      runs.push(trial(sigma, effect, change))
      const verdict = judgeChange(change, runs)
      if (verdict !== undefined) return { verdict, used: i }
    }
  },
  usd(sigma, effect, ctx) {
    return twoTrialsOnUsd(sigma, effect, ctx, ctx.team)
  },
  'usd-clean'(sigma, effect, ctx) {
    return twoTrialsOnUsd(sigma, effect, ctx, ctx.earlier.length > 0 ? ctx.earlier : ctx.team)
  },
  sequential(sigma, effect, { earlier, team, change }) {
    const base = (earlier.length > 0 ? earlier : team).map(item => Math.log(implUsd(item)))
    const mean = base.reduce((sum, value) => sum + value, 0) / base.length
    const squares = base.reduce((sum, value) => sum + (value - mean) ** 2, 0)
    const sd = Math.sqrt((squares + PRIOR_WEIGHT * PRIOR_SIGMA ** 2) / (base.length - 1 + PRIOR_WEIGHT))
    const ratios = []
    for (let i = 1; i <= MAX_TRIALS; i += 1) {
      const item = trial(sigma, effect, change)
      if (!keptBottomLine(change, item)) return { verdict: 'reverted', used: i }
      ratios.push(Math.log(implUsd(item)) - mean)
      if (i < MIN_TRIALS) continue
      const m = ratios.reduce((sum, value) => sum + value, 0) / ratios.length
      const z = m / (sd * Math.sqrt(1 / ratios.length + 1 / base.length))
      if (z <= -Z_KEEP) return { verdict: 'kept', used: i }
      if (m >= 0) return { verdict: 'reverted', used: i }
    }
    return { verdict: 'reverted', used: MAX_TRIALS }
  },
}

function twoTrialsOnUsd(sigma, effect, { change }, baselineRuns) {
  const baseline = median(baselineRuns.map(implUsd))
  for (let i = 1; i <= KEEP_AFTER; i += 1) {
    const item = trial(sigma, effect, change)
    if (!keptBottomLine(change, item)) return { verdict: 'reverted', used: i }
    if (implUsd(item) > baseline * (1 - IMPROVE_BY)) return { verdict: 'reverted', used: i }
  }
  return { verdict: 'kept', used: KEEP_AFTER }
}

const SIGMAS = [0.3, 0.5, 0.8]
const HISTORIES = [2, 4, 8]
const EFFECTS = [-0.2, 0, 0.2, 0.3, 0.5]

const results = []
for (const rule of RULES) {
  const judge = JUDGES[rule]
  if (judge === undefined) throw new Error(`unknown rule ${rule}`)
  for (const sigma of SIGMAS) {
    for (const history of HISTORIES) {
      const kept = {}
      const used = {}
      for (const effect of EFFECTS) {
        let keptCount = 0
        let usedSum = 0
        for (let i = 0; i < TRIALS; i += 1) {
          const outcome = judge(sigma, effect, setup(sigma, history))
          if (outcome.verdict === 'kept') keptCount += 1
          usedSum += outcome.used
        }
        kept[effect] = keptCount / TRIALS
        used[effect] = usedSum / TRIALS
      }
      results.push({ rule, sigma, history, kept, used })
    }
  }
}

if (args.json) {
  console.log(JSON.stringify({ trials: TRIALS, seed: Number(args.seed), pGood: P_GOOD, rule: { KEEP_AFTER, IMPROVE_BY, WHOLE_TOLERANCE, HOTSPOT_SHARE, MAX_TRIALS, Z_KEEP }, results }, null, 2))
} else {
  const pct = value => `${(value * 100).toFixed(1)}%`
  console.log(`Kept share by true effect on the implement cost, and mean trial runs used (${TRIALS} changes per cell, seed ${args.seed}, pGood ${P_GOOD})`)
  for (const rule of RULES) {
    console.log('')
    console.log(`rule: ${rule}`)
    console.log('')
    console.log(`| sigma | history | ${EFFECTS.map(effect => `effect ${effect}`).join(' | ')} | trials (effect 0) |`)
    console.log(`| --- | --- | ${EFFECTS.map(() => '---').join(' | ')} | --- |`)
    for (const row of results.filter(item => item.rule === rule)) console.log(`| ${row.sigma} | ${row.history} | ${EFFECTS.map(effect => pct(row.kept[effect])).join(' | ')} | ${row.used[0].toFixed(2)} |`)
  }
}
