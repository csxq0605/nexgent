#!/usr/bin/env node
/**
 * Summarize one run.mjs output directory, optionally with the harness report.
 *
 * Per instance: resolved (from the report), tokens and cost (from usage.json,
 * priced with --price "in,out,cacheRead,cacheWrite" in USD per million tokens),
 * wall time, and whether the patch touches test files (a sign the run edited
 * tests instead of the code; the harness resets those files before grading, so
 * such edits never count toward resolving, but they are worth counting).
 *
 * Usage:
 *   node scripts/bench/swebench/summarize.mjs --out <run dir> [--report <harness report json>]
 *     [--price 3,15,0.3,3.75] [--json]
 */
import { readFile, readdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'

const { values: args } = parseArgs({
  options: {
    out: { type: 'string' },
    report: { type: 'string' },
    price: { type: 'string', default: '3,15,0.3,3.75' },
    json: { type: 'boolean', default: false },
  },
})
if (args.out === undefined) {
  console.error('usage: summarize.mjs --out <run dir> [--report <json>] [--price in,out,cacheRead,cacheWrite]')
  process.exit(2)
}
const [pIn, pOut, pRead, pWrite] = args.price.split(',').map(Number)
const TEST_PATH = /(^|\/)(tests?|testing)(\/|$)|(^|\/)test_[^/]*\.py$|_tests?\.py$|(^|\/)conftest\.py$/

function touchedFiles(patch) {
  const files = new Set()
  for (const match of patch.matchAll(/^diff --git a\/(\S+) b\/(\S+)$/gm)) files.add(match[2])
  return [...files]
}

const OUT = resolve(args.out)
const report = args.report === undefined ? undefined : JSON.parse(await readFile(resolve(args.report), 'utf8'))
const resolvedIds = new Set(report?.resolved_ids ?? [])
const rows = []
for (const entry of await readdir(OUT, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue
  const dir = join(OUT, entry.name)
  let usage
  try { usage = JSON.parse(await readFile(join(dir, 'usage.json'), 'utf8')) } catch { continue }
  const patch = await readFile(join(dir, 'patch.diff'), 'utf8').catch(() => '')
  const files = touchedFiles(patch)
  const cost = (usage.inputTokens * pIn + usage.outputTokens * pOut + usage.cacheReadTokens * pRead + usage.cacheWriteTokens * pWrite) / 1e6
  rows.push({
    id: entry.name,
    resolved: report === undefined ? null : resolvedIds.has(entry.name),
    emptyPatch: patch.trim() === '',
    touchesTests: files.some(file => TEST_PATH.test(file)),
    files: files.length,
    requests: usage.requests,
    unknownUsage: usage.unknownUsage,
    costUsd: Number(cost.toFixed(4)),
    seconds: Math.round(usage.ms / 1000),
    exitCode: usage.exitCode,
  })
}
rows.sort((a, b) => a.id.localeCompare(b.id))
const n = rows.length
const sum = key => rows.reduce((total, row) => total + (row[key] === true ? 1 : typeof row[key] === 'number' ? row[key] : 0), 0)
const totals = {
  instances: n,
  resolved: report === undefined ? null : sum('resolved'),
  emptyPatch: sum('emptyPatch'),
  touchesTests: sum('touchesTests'),
  costUsd: Number(sum('costUsd').toFixed(4)),
  meanCostUsd: n === 0 ? 0 : Number((sum('costUsd') / n).toFixed(4)),
  meanSeconds: n === 0 ? 0 : Math.round(sum('seconds') / n),
  unknownUsage: sum('unknownUsage'),
}
if (args.json) {
  console.log(JSON.stringify({ totals, rows }, null, 2))
} else {
  for (const row of rows) console.log(`${row.id}\tresolved=${row.resolved}\ttests=${row.touchesTests}\tfiles=${row.files}\t$${row.costUsd}\t${row.seconds}s`)
  console.log(JSON.stringify(totals))
}
