#!/usr/bin/env node
/**
 * How often the keep-or-revert rule of organization reflection decides
 * wrongly, by simulation. No model is called: the script builds synthetic
 * team runs and judges them with the product's own functions
 * (`newChange`, `judgeChange` from `@nexgent/capabilities`), so the numbers
 * follow the rule as it is in the code (KEEP_AFTER, IMPROVE_BY,
 * WHOLE_TOLERANCE).
 *
 * Setting (one cell of the table per noise level, history size and true
 * effect):
 * - A team run has three parts, a coordinator, an `implement` member and a
 *   `test` member. Each part's cost is lognormal with medians 0.2, 0.5 and
 *   0.3 (USD) and the same log-sd `sigma` (run-to-run noise).
 * - The class has `history` earlier team runs; the last one is the source
 *   run, drawn until `implement` is a cost hotspot there (share at least
 *   HOTSPOT_SHARE and above the median of earlier implement costs), as
 *   reflection would require.
 * - The change targets that hotspot (`cost` of `implement`; the action is
 *   `narrow-reading`, which every run follows, so no trial is dropped as
 *   unfollowed). Under the change the implement cost is multiplied by
 *   `1 - effect`; the other parts are unchanged.
 * - Each trial run goes well with probability `pGood`, independently of the
 *   change.
 *
 * A wrong keep is a change with effect <= 0 that is kept; a wrong revert
 * is a change with effect >= 0.3 that is reverted.
 *
 * Usage: node scripts/organization-rule-sim.mjs [--trials 20000] [--seed 1] [--p-good 1] [--json]
 * Needs `pnpm build` first (it imports the built package).
 */
import { parseArgs } from 'node:util'
import { HOTSPOT_SHARE, IMPROVE_BY, KEEP_AFTER, WHOLE_TOLERANCE, judgeChange, median, newChange } from '../packages/capabilities/dist/index.js'

const { values: args } = parseArgs({
  options: {
    trials: { type: 'string', default: '20000' },
    seed: { type: 'string', default: '1' },
    'p-good': { type: 'string', default: '1' },
    json: { type: 'boolean', default: false },
  },
})
const TRIALS = Number(args.trials)
const P_GOOD = Number(args['p-good'])

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

/** One simulated change: its verdict. */
function simulate(sigma, history, effect) {
  const earlier = Array.from({ length: history - 1 }, () => run(drawUsds(sigma)))
  const earlierImpl = earlier.map(item => item.profile.parts[1].usd)
  let source
  for (;;) {
    source = run(drawUsds(sigma))
    const impl = source.profile.parts[1]
    if (impl.share >= HOTSPOT_SHARE && (earlierImpl.length === 0 || impl.usd > median(earlierImpl))) break
  }
  const team = [...earlier, source]
  const hotspot = { part: 'impl', kind: 'implement', cause: 'cost', value: source.profile.parts[1].share }
  const change = newChange({ classId: 'sim', run: source, hotspot, action: 'narrow-reading', history: team, id: `c${seq}` })
  const runs = [...team]
  for (let i = 0; i < KEEP_AFTER; i += 1) {
    runs.push(run(drawUsds(sigma, effect), { change: change.id, good: random() < P_GOOD }))
    const verdict = judgeChange(change, runs)
    if (verdict !== undefined) return verdict
  }
  return judgeChange(change, runs)
}

const SIGMAS = [0.3, 0.5, 0.8]
const HISTORIES = [2, 4, 8]
const EFFECTS = [-0.2, 0, 0.2, 0.3, 0.5]

const rows = []
for (const sigma of SIGMAS) {
  for (const history of HISTORIES) {
    const keptByEffect = {}
    for (const effect of EFFECTS) {
      let kept = 0
      for (let i = 0; i < TRIALS; i += 1) if (simulate(sigma, history, effect) === 'kept') kept += 1
      keptByEffect[effect] = kept / TRIALS
    }
    rows.push({ sigma, history, kept: keptByEffect })
  }
}

if (args.json) {
  console.log(JSON.stringify({ trials: TRIALS, seed: Number(args.seed), pGood: P_GOOD, rule: { KEEP_AFTER, IMPROVE_BY, WHOLE_TOLERANCE, HOTSPOT_SHARE }, rows }, null, 2))
} else {
  const pct = value => `${(value * 100).toFixed(1)}%`
  console.log(`Kept share by true effect on the implement cost (${TRIALS} changes per cell, seed ${args.seed}, pGood ${P_GOOD}; rule: ${KEEP_AFTER} trials, each ${IMPROVE_BY * 100}% under the old median, whole cost within +${WHOLE_TOLERANCE * 100}%)`)
  console.log('')
  console.log(`| sigma | history | ${EFFECTS.map(effect => `effect ${effect}`).join(' | ')} |`)
  console.log(`| --- | --- | ${EFFECTS.map(() => '---').join(' | ')} |`)
  for (const row of rows) console.log(`| ${row.sigma} | ${row.history} | ${EFFECTS.map(effect => pct(row.kept[effect])).join(' | ')} |`)
}
