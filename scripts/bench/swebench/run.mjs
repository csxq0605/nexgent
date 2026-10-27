#!/usr/bin/env node
/**
 * Run Nexgent on SWE-bench instances and write a predictions file for the
 * official harness (`python -m swebench.harness.run_evaluation`).
 *
 * For each instance:
 * 1. start the instance's evaluation image (`swebench/sweb.eval.x86_64.*`),
 *    which holds the repository at its base commit in `/testbed` with its
 *    test environment;
 * 2. mount this repository read-only at `/opt/nexgent` and the running Node
 *    at `/opt/node`, write `/testbed/.nexgent/config.json` (sandbox
 *    `full-access`: the container is the sandbox; optional per-task cost
 *    cap) and run `nexgent run --project /testbed --task <issue> --json`;
 * 3. take the diff of `/testbed` against its starting commit (without
 *    `.nexgent/`) as the model patch, and copy the session records, ledger
 *    and token totals out for analysis.
 *
 * Modes:
 * - `scripted-gold` (default, no key, no cost): a local scripted model
 *   server answers every request; its one tool call applies the instance's
 *   gold patch with `git apply`. Proves the whole path: task text in, the
 *   real CLI and tools in the container, the patch out, the harness grading
 *   it. Every instance should come out resolved.
 * - `scripted-empty` (no key, no cost): the scripted model only answers;
 *   every instance should come out unresolved with an empty patch.
 * - `real`: the configured model through the Claude API. Needs
 *   `NEXGENT_API_KEY` (or `ANTHROPIC_API_KEY`) and `--allow-spend`; set
 *   `--cost-cap` per task.
 *
 * Usage:
 *   node scripts/bench/swebench/run.mjs --instances <jsonl> --out <dir>
 *     [--mode scripted-gold|scripted-empty|real] [--label <name>]
 *     [--cost-cap <usd>] [--timeout-min 60] [--model <id>] [--allow-spend]
 *     [--budget <usd> --price in,out,cacheRead,cacheWrite]
 *     [--network isolated|host] [--organization solo|team]
 *
 * `--network isolated` (the default in mode real): the task container joins
 * an internal Docker network with no route out; its only peer is a proxy
 * container (`api-proxy.mjs`) that forwards the model API and holds the key,
 * so the agent cannot fetch upstream fixes and never sees the key. `host`
 * shares the host's network (the scripted modes need it for their local
 * model server).
 *
 * `--organization` sets `NEXGENT_FORCE_ORGANIZATION` in the CLI: every root
 * turn alone (`solo`) or with members (`team`).
 *
 * `--budget` stops before the next instance once the summed cost of the
 * instances run so far (their token totals at `--price`, USD per million
 * tokens) plus one `--cost-cap` would pass it.
 *
 * Needs `pnpm build` (the CLI and test-support run from `dist/`) and a
 * running Docker. Images are pulled as named in the instance; set
 * `--mirror mirror.gcr.io` to pull through a mirror and tag them locally.
 * Output: `<out>/predictions.jsonl` and `<out>/<instance_id>/` (cli.jsonl,
 * stderr.txt, patch.diff, usage.json, nexgent/ records).
 */
import { spawn, spawnSync } from 'node:child_process'
import { mkdir, readFile, writeFile, appendFile, rm } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const { values: args } = parseArgs({
  options: {
    instances: { type: 'string' },
    out: { type: 'string' },
    mode: { type: 'string', default: 'scripted-gold' },
    label: { type: 'string' },
    'cost-cap': { type: 'string' },
    'timeout-min': { type: 'string', default: '60' },
    model: { type: 'string' },
    mirror: { type: 'string' },
    network: { type: 'string' },
    organization: { type: 'string' },
    'proxy-image': { type: 'string', default: 'node:22-slim' },
    budget: { type: 'string' },
    price: { type: 'string', default: '2,10,0.2,2.5' },
    'allow-spend': { type: 'boolean', default: false },
  },
})

const MODES = ['scripted-gold', 'scripted-empty', 'real']
if (args.instances === undefined || args.out === undefined || !MODES.includes(args.mode)) {
  console.error(`usage: run.mjs --instances <jsonl> --out <dir> [--mode ${MODES.join('|')}]`)
  process.exit(2)
}
const real = args.mode === 'real'
if (real && !args['allow-spend']) {
  console.error('mode real calls the paid API: pass --allow-spend to confirm')
  process.exit(2)
}
const apiKey = process.env.NEXGENT_API_KEY ?? process.env.ANTHROPIC_API_KEY
if (real && (apiKey === undefined || apiKey === '')) {
  console.error('mode real needs NEXGENT_API_KEY or ANTHROPIC_API_KEY in the environment')
  process.exit(2)
}

const NETWORK = args.network ?? (real ? 'isolated' : 'host')
if (!['isolated', 'host'].includes(NETWORK) || (NETWORK === 'isolated' && !real)) {
  console.error('--network is isolated (real mode only, the default there) or host')
  process.exit(2)
}
if (args.organization !== undefined && !['solo', 'team'].includes(args.organization)) {
  console.error('--organization is solo or team')
  process.exit(2)
}

const NODE_DIR = dirname(dirname(process.execPath))
const OUT = resolve(args.out)
const LABEL = args.label ?? `nexgent-${args.mode}`
const TIMEOUT_MS = Number(args['timeout-min']) * 60_000
const HOME_IN_CONTAINER = '/root/.nexgent-bench'
/** Fixed test key for the scripted modes; the scripted server never checks it. */
const SCRIPTED_KEY = 'nexgent-bench-scripted-key'
const EXTRA_CA = process.env.NODE_EXTRA_CA_CERTS || undefined
const CA_IN_CONTAINER = '/opt/nexgent-extra-ca.crt'
/** Isolated runs: the internal network the task containers join, and the proxy that is their only way out. */
const BENCH_NET = 'nexgent-bench-net'
const PROXY_NAME = `nexgent-bench-api-${process.pid}`
const PROXY_PORT = 8080
/** What the task container gets as a key in isolated runs: the proxy sets the real one. */
const PROXIED_KEY = 'nexgent-bench-proxied'

function docker(argv, options = {}) {
  const result = spawnSync('docker', argv, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, ...options })
  if (result.status !== 0 && options.check !== false) throw new Error(`docker ${argv.slice(0, 2).join(' ')} failed: ${result.stderr.trim().slice(0, 500)}`)
  return result
}

function ensureImage(image) {
  if (docker(['image', 'inspect', image], { check: false }).status === 0) return
  if (args.mirror === undefined) {
    docker(['pull', '-q', image])
    return
  }
  const mirrored = `${args.mirror}/${image}`
  docker(['pull', '-q', mirrored])
  docker(['tag', mirrored, image])
}

/** The task Nexgent gets: the issue text and where the code is. The gold patch and the tests are never shown. */
function taskText(instance) {
  return [
    `The repository in this project (${instance.repo}) has the issue below. Change the code so that the issue is resolved.`,
    'Do not change or delete existing tests. You may run the existing tests or add new ones.',
    '',
    '<issue>',
    instance.problem_statement.trim(),
    '</issue>',
  ].join('\n')
}

/** Scripted model replies: apply the gold patch, then answer (scripted-gold); or only answer (scripted-empty). */
function scriptFor(instance) {
  const usage = { inputTokens: 1000, outputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0 }
  if (args.mode === 'scripted-empty') return [{ content: ['I could not find a fix.'], usage }]
  const command = `git apply --whitespace=nowarn <<'NEXGENT_BENCH_PATCH'\n${instance.patch}\nNEXGENT_BENCH_PATCH`
  return [
    { toolCalls: [{ name: 'bash', arguments: { command } }], usage },
    { content: ['Applied the fix.'], usage },
  ]
}

function run(command, argv, { input, timeoutMs, env }) {
  return new Promise(resolvePromise => {
    const child = spawn(command, argv, { stdio: ['pipe', 'pipe', 'pipe'], env })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', chunk => { stdout += chunk })
    child.stderr.on('data', chunk => { stderr += chunk })
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs)
    child.on('close', code => {
      clearTimeout(timer)
      resolvePromise({ code, stdout, stderr })
    })
    child.stdin.end(input ?? '')
  })
}

/** Token totals of the ledger lines (`llm.request.end`) under a directory copied out of the container. */
async function tokenTotals(dir) {
  const find = spawnSync('find', [dir, '-name', 'requests.jsonl'], { encoding: 'utf8' })
  const totals = { requests: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, unknownUsage: 0 }
  for (const file of find.stdout.split('\n').filter(Boolean)) {
    for (const line of (await readFile(file, 'utf8')).split('\n')) {
      if (line.trim() === '') continue
      let record
      try { record = JSON.parse(line) } catch { continue }
      if (record.type !== 'llm.request.end') continue
      totals.requests += 1
      const usage = record.usage ?? {}
      if (typeof usage.inputTokens !== 'number') { totals.unknownUsage += 1; continue }
      for (const key of ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens']) if (typeof usage[key] === 'number') totals[key] += usage[key]
    }
  }
  return totals
}

async function runInstance(instance, server) {
  const dir = join(OUT, instance.instance_id)
  await rm(dir, { recursive: true, force: true })
  await mkdir(dir, { recursive: true })
  ensureImage(instance.image)
  const name = `nexgent-bench-${instance.instance_id.replace(/[^a-zA-Z0-9_.-]/g, '-')}-${process.pid}`
  // Behind a TLS-inspecting proxy the host trusts an extra CA through NODE_EXTRA_CA_CERTS; the CLI in the container needs it too.
  const caMount = EXTRA_CA === undefined ? [] : ['-v', `${EXTRA_CA}:${CA_IN_CONTAINER}:ro`]
  docker(['run', '-d', '--name', name, '--network', NETWORK === 'isolated' ? BENCH_NET : 'host', '-v', `${REPO}:/opt/nexgent:ro`, '-v', `${NODE_DIR}:/opt/node:ro`, ...caMount, instance.image, 'tail', '-f', '/dev/null'])
  try {
    const config = {
      version: 1,
      sandboxMode: 'full-access',
      // Background learning makes model calls of its own after the task; a benchmark run measures the task alone.
      learning: { enabled: false },
      ...(args.model === undefined ? {} : { model: args.model }),
      ...(args['cost-cap'] === undefined ? {} : { costCaps: { perTask: { maxUsd: Number(args['cost-cap']) } } }),
    }
    docker(['exec', '-i', name, 'bash', '-c', 'mkdir -p /testbed/.nexgent && cat > /testbed/.nexgent/config.json'], { input: JSON.stringify(config, null, 2) })
    // The key goes in through the environment of `docker exec` (`-e NAME` without a value), never on its command line.
    const env = ['-e', `NEXGENT_HOME=${HOME_IN_CONTAINER}`, '-e', 'NEXGENT_API_KEY']
    if (EXTRA_CA !== undefined) env.push('-e', `NODE_EXTRA_CA_CERTS=${CA_IN_CONTAINER}`)
    if (NETWORK === 'isolated') env.push('-e', `NEXGENT_API_BASE_URL=http://${PROXY_NAME}:${PROXY_PORT}`)
    if (args.organization !== undefined) env.push('-e', `NEXGENT_FORCE_ORGANIZATION=${args.organization}`)
    // The images install the repository into the conda env `testbed`, which only an interactive shell activates
    // (~/.bashrc). Put it first on PATH so `python` and `pytest` in the agent's commands are the ones the tests use.
    const testbedPath = docker(['exec', name, 'bash', '-c', 'test -d /opt/miniconda3/envs/testbed/bin && echo "/opt/miniconda3/envs/testbed/bin:$PATH"'], { check: false }).stdout.trim()
    if (testbedPath !== '') env.push('-e', `PATH=${testbedPath}`, '-e', 'CONDA_DEFAULT_ENV=testbed', '-e', 'CONDA_PREFIX=/opt/miniconda3/envs/testbed')
    if (server !== undefined) env.push('-e', `NEXGENT_API_BASE_URL=${server.baseUrl}`)
    const started = Date.now()
    const cli = await run('docker', ['exec', '-i', ...env, '-w', '/testbed', name, '/opt/node/bin/node', '/opt/nexgent/apps/cli/bin/nexgent.mjs', 'run', '--project', '/testbed', '--task', taskText(instance), '--sandbox', 'full-access', '--json'], { timeoutMs: TIMEOUT_MS, env: { ...process.env, NEXGENT_API_KEY: !real ? SCRIPTED_KEY : NETWORK === 'isolated' ? PROXIED_KEY : apiKey } })
    const ms = Date.now() - started
    await writeFile(join(dir, 'cli.jsonl'), cli.stdout)
    await writeFile(join(dir, 'stderr.txt'), cli.stderr)
    // Everything the run changed, new files included, without Nexgent's own records. Against HEAD, not the base
    // commit: the evaluation images add a commit of their own on top of it (file modes only).
    const diff = docker(['exec', name, 'bash', '-c', `cd /testbed && git add -A -- . ':(exclude).nexgent' && git diff --cached --binary HEAD`])
    const patch = diff.stdout
    await writeFile(join(dir, 'patch.diff'), patch)
    docker(['cp', `${name}:/testbed/.nexgent`, join(dir, 'nexgent-project')], { check: false })
    docker(['cp', `${name}:${HOME_IN_CONTAINER}`, join(dir, 'nexgent-home')], { check: false })
    const usage = { ...(await tokenTotals(dir)), ms, exitCode: cli.code, patchBytes: Buffer.byteLength(patch) }
    await writeFile(join(dir, 'usage.json'), JSON.stringify(usage, null, 2))
    return { patch, usage }
  } finally {
    docker(['rm', '-f', name], { check: false })
  }
}

/**
 * Isolated runs: an internal Docker network (no route out) and a proxy container on it and on the default
 * bridge that forwards only the model API and holds the key (`api-proxy.mjs`). The key reaches the proxy
 * through the environment of `docker exec`, so it is in no container's configuration.
 */
async function startProxy() {
  if (docker(['network', 'inspect', BENCH_NET], { check: false }).status !== 0) docker(['network', 'create', '--internal', BENCH_NET])
  const caMount = EXTRA_CA === undefined ? [] : ['-v', `${EXTRA_CA}:${CA_IN_CONTAINER}:ro`]
  ensureImage(args['proxy-image'])
  docker(['run', '-d', '--name', PROXY_NAME, '-v', `${REPO}:/opt/nexgent:ro`, ...caMount, args['proxy-image'], 'sleep', 'infinity'])
  docker(['network', 'connect', BENCH_NET, PROXY_NAME])
  const env = ['-e', 'NEXGENT_API_KEY', '-e', `NEXGENT_BENCH_PROXY_PORT=${PROXY_PORT}`]
  if (EXTRA_CA !== undefined) env.push('-e', `NODE_EXTRA_CA_CERTS=${CA_IN_CONTAINER}`)
  spawnSync('docker', ['exec', '-d', ...env, PROXY_NAME, 'sh', '-c', 'node /opt/nexgent/scripts/bench/swebench/api-proxy.mjs > /tmp/api-proxy.log 2>&1'], { env: { ...process.env, NEXGENT_API_KEY: apiKey } })
  for (let i = 0; i < 50; i++) {
    const health = docker(['exec', PROXY_NAME, 'node', '-e', `fetch('http://127.0.0.1:${PROXY_PORT}/health').then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))`], { check: false })
    if (health.status === 0) return
    await new Promise(r => setTimeout(r, 200))
  }
  throw new Error('api proxy did not start')
}

async function main() {
  const instances = (await readFile(resolve(args.instances), 'utf8')).split('\n').filter(line => line.trim() !== '').map(line => JSON.parse(line))
  await mkdir(OUT, { recursive: true })
  const predictions = join(OUT, 'predictions.jsonl')
  await writeFile(predictions, '')
  let harness
  const [pIn, pOut, pRead, pWrite] = args.price.split(',').map(Number)
  const budget = args.budget === undefined ? Infinity : Number(args.budget)
  const reserve = args['cost-cap'] === undefined ? 0 : Number(args['cost-cap'])
  let spent = 0
  if (NETWORK === 'isolated') await startProxy()
  try {
    for (const instance of instances) {
      if (spent + reserve > budget) {
        console.log(`budget: stopping before ${instance.instance_id}, spent $${spent.toFixed(2)} of $${budget}`)
        break
      }
      let server
      if (!real) {
        harness ??= await import(join(REPO, 'packages/test-support/dist/index.js'))
        server = await harness.scriptedModelServer({ script: scriptFor(instance) })
      }
      try {
        const { patch, usage } = await runInstance(instance, server)
        spent += (usage.inputTokens * pIn + usage.outputTokens * pOut + usage.cacheReadTokens * pRead + usage.cacheWriteTokens * pWrite) / 1e6
        await appendFile(predictions, `${JSON.stringify({ instance_id: instance.instance_id, model_name_or_path: LABEL, model_patch: patch })}\n`)
        console.log(`${instance.instance_id}: exit ${usage.exitCode}, ${usage.patchBytes} patch bytes, ${usage.requests} requests, ${Math.round(usage.ms / 1000)} s, total $${spent.toFixed(2)}`)
      } catch (error) {
        console.error(`${instance.instance_id}: ${error.message}`)
        await appendFile(predictions, `${JSON.stringify({ instance_id: instance.instance_id, model_name_or_path: LABEL, model_patch: '' })}\n`)
      } finally {
        await server?.close()
      }
    }
  } finally {
    if (NETWORK === 'isolated') {
      docker(['cp', `${PROXY_NAME}:/tmp/api-proxy.log`, join(OUT, 'api-proxy.log')], { check: false })
      docker(['rm', '-f', PROXY_NAME], { check: false })
    }
  }
  console.log(`predictions: ${predictions}`)
  console.log(`grade: python -m swebench.harness.run_evaluation -d SWE-bench/SWE-bench_Verified -p ${predictions} -id ${LABEL} --max_workers 1`)
}

await main()
