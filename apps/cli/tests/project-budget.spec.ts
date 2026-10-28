/**
 * `costCaps.perProject` across runs on one project at the same time: two
 * `nexgent run`s, each with its own app, the real JSONL ledger on disk and
 * the scripted Claude Messages API server. Nothing is replaced or paused;
 * the runs are started together and repeated, so the check and the count
 * must be one step whatever the interleaving.
 */
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { scriptedModelServer, type ScriptedModelServer } from '@nexgent/test-support'
import { main } from '../src/index.js'
import { testIo } from './helpers.js'

const usage = { inputTokens: 100, outputTokens: 20, totalTokens: 120, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 }
const ROUNDS = 12

let work: string | undefined
let server: ScriptedModelServer | undefined
afterEach(async () => {
  await server?.close()
  server = undefined
  if (work !== undefined) await fs.rm(work, { recursive: true, force: true, maxRetries: 10 })
  work = undefined
})

it('sends at most maxRequests across two runs started together on the same project', async () => {
  const sent: number[] = []
  for (let round = 0; round < ROUNDS; round += 1) {
    work = await fs.mkdtemp(path.join(os.tmpdir(), 'nexgent-cli-budget-'))
    const project = path.join(work, 'project')
    const home = path.join(work, 'home')
    await fs.mkdir(path.join(project, '.nexgent'), { recursive: true })
    await fs.mkdir(home)
    await fs.writeFile(path.join(project, '.nexgent', 'config.json'), `${JSON.stringify({ costCaps: { perProject: { maxRequests: 1 } } })}\n`)
    server = await scriptedModelServer({ script: [{ content: ['one'], usage }, { content: ['two'], usage }] })
    const env = { NEXGENT_API_KEY: 'e2e-test-key', NEXGENT_API_BASE_URL: server.baseUrl, NEXGENT_HOME: home }
    await Promise.all(['first', 'second'].map(task => main(['run', '--project', project, '--task', task], testIo(work!, env).io)))
    sent.push(server.requests.length)
    await server.close()
    server = undefined
    await fs.rm(work, { recursive: true, force: true, maxRetries: 10 })
    work = undefined
  }
  expect(sent).toEqual(Array.from({ length: ROUNDS }, () => 1))
}, 120_000)
