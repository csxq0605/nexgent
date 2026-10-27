/**
 * The Windows sandbox as far as it runs off Windows: capability SIDs, the
 * ACL plan, the launcher spec, the asks for commands without isolation.
 * The restricted launch itself (C# in the job launcher) runs only on
 * Windows.
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  assignCapabilities,
  createWindowsSandbox,
  denyArgs,
  grantArgs,
  isCapabilitySid,
  JOB_LAUNCHER,
  JOB_SANDBOX_FAILED_MARKER,
  JOB_SOURCE,
  jobLaunchSpec,
  planDenies,
  randomCapabilitySid,
  rootKey,
  UNCONFINED_COMMAND_DESCRIPTION,
  unconfinedHits,
  WINDOWS_CAPABILITIES_FILE,
  type IcaclsRunner,
} from '../src/index.js'

const dirs: string[] = []
afterEach(async () => {
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

describe('capability SIDs', () => {
  it('are random S-1-5-21 SIDs, one per directory, kept across calls', () => {
    const sid = randomCapabilitySid()
    expect(isCapabilitySid(sid)).toBe(true)
    expect(randomCapabilitySid()).not.toBe(sid)
    let n = 0
    const make = () => `S-1-5-21-1-2-3-${++n}`
    const first = assignCapabilities({ version: 1, roots: {} }, ['C:\\Work\\App', 'C:\\Temp\\nexgent-s1'], make)
    expect(first.sids).toEqual(['S-1-5-21-1-2-3-1', 'S-1-5-21-1-2-3-2'])
    // Same directory, other spelling: same SID.
    const again = assignCapabilities(first.record, ['c:\\work\\app\\'], make)
    expect(again.sids).toEqual(['S-1-5-21-1-2-3-1'])
    expect(rootKey('C:\\Work\\App\\')).toBe('c:\\work\\app')
  })

  it('plan a grant on each directory and a deny on the protected paths inside it', () => {
    expect(grantArgs('C:\\Work\\App', 'S-1-5-21-1-2-3-4')).toEqual(['C:\\Work\\App', '/grant', '*S-1-5-21-1-2-3-4:(OI)(CI)M', '/Q'])
    expect(denyArgs('C:\\Work\\App\\.git\\hooks', 'S-1-5-21-1-2-3-4', true)[2]).toBe('*S-1-5-21-1-2-3-4:(OI)(CI)(WD,AD,WEA,WA,DE,DC,WDAC,WO)')
    expect(denyArgs('C:\\Work\\App\\.git\\config', 'S-1-5-21-1-2-3-4', false)[2]).toBe('*S-1-5-21-1-2-3-4:(WD,AD,WEA,WA,DE,DC,WDAC,WO)')
    expect(planDenies(['C:\\Work\\App', 'C:\\Temp\\s'], ['A', 'B'], ['C:\\Work\\App\\.nexgent', 'C:\\Users\\me\\.ssh'])).toEqual([{ path: 'C:\\Work\\App\\.nexgent', sids: ['A'] }])
  })
})

describe('job launcher with a restricted token', () => {
  it('carries the capabilities in the spec and never starts the command without them', () => {
    const spec = jobLaunchSpec('pwsh', ['-Command', 'x'], {}, ['S-1-5-21-1-2-3-4'])
    expect(spec.capabilities).toEqual(['S-1-5-21-1-2-3-4'])
    expect(jobLaunchSpec('pwsh', [], {}).capabilities).toBeUndefined()
    expect(JOB_SOURCE).toContain('CreateRestrictedToken(token, 0x1 | 0x4 | 0x8')
    expect(JOB_SOURCE).toContain('CreateProcessAsUserW')
    // The restricted branch exits after the restricted start; the plain start follows it.
    const restricted = JOB_LAUNCHER.indexOf('if ($null -ne $spec.capabilities)')
    expect(restricted).toBeGreaterThan(0)
    expect(JOB_LAUNCHER.indexOf(JOB_SANDBOX_FAILED_MARKER)).toBeGreaterThan(restricted)
    expect(JOB_LAUNCHER.indexOf('[Diagnostics.Process]::Start')).toBeGreaterThan(JOB_LAUNCHER.indexOf('exit $code'))
  })
})

describe('createWindowsSandbox', () => {
  async function setup(options: { trial?: string; failGrant?: boolean } = {}) {
    const home = await mkdtemp(join(tmpdir(), 'nexgent-winsb-'))
    dirs.push(home)
    const project = join(home, 'project')
    await mkdir(join(project, '.git', 'hooks'), { recursive: true })
    await writeFile(join(project, '.git', 'config'), '')
    const calls: string[][] = []
    const acl = new Map<string, string>()
    const icacls: IcaclsRunner = async args => {
      calls.push([...args])
      if (args.length === 1) return { code: 0, output: acl.get(args[0]!) ?? '' }
      if (options.failGrant === true) return { code: 5, output: 'Access is denied.' }
      if (args[1] === '/grant') acl.set(args[0]!, args[2]!)
      return { code: 0, output: '' }
    }
    const sandbox = createWindowsSandbox({ home, icacls, platform: 'win32', trial: async () => options.trial })
    const policy = (id: string) => ({
      writeRoots: [project], denyWrite: [join(project, '.nexgent'), join(project, '.git', 'hooks'), join(project, '.git', 'config')],
      denyRead: [], network: true, commandId: id, shell: 'pwsh',
    })
    return { home, project, sandbox, calls, policy }
  }

  it('wraps pwsh with the directory capability, grants it once and protects existing paths', async () => {
    const { home, project, sandbox, calls, policy } = await setup()
    expect(await sandbox.probe()).toEqual({ kind: 'active', platform: 'windows' })
    const wrapped = await sandbox.wrap('npm test', policy('c1'))
    expect(wrapped).toMatchObject({ kind: 'wrapped', program: 'pwsh', args: ['-NoProfile', '-NonInteractive', '-Command', 'npm test'] })
    const sid = (wrapped as { capabilities?: readonly string[] }).capabilities![0]!
    expect(isCapabilitySid(sid)).toBe(true)
    expect(calls.filter(call => call[1] === '/grant')).toEqual([grantArgs(project, sid)])
    // .nexgent does not exist: nothing to deny yet.
    expect(calls.filter(call => call[1] === '/deny').map(call => call[0]).sort()).toEqual([join(project, '.git', 'config'), join(project, '.git', 'hooks')])
    const saved = JSON.parse(await readFile(join(home, WINDOWS_CAPABILITIES_FILE), 'utf8'))
    expect(Object.values(saved.roots)).toEqual([{ sid }])
    // A second command and a second instance reuse the SID; the ACE is already there.
    calls.length = 0
    await sandbox.wrap('npm test', policy('c2'))
    expect(calls).toEqual([])
    const other = createWindowsSandbox({ home, platform: 'win32', trial: async () => undefined, icacls: async args => { calls.push([...args]); return { code: 0, output: args.length === 1 ? `x *${sid}:(OI)(CI)(M)` : '' } } })
    expect(await other.wrap('x', policy('c3'))).toMatchObject({ capabilities: [sid] })
    expect(calls.filter(call => call[1] === '/grant')).toEqual([])
    expect(sandbox.annotate('c1', 'Access to the path is denied.', 1)).toContain('<sandbox_violations>')
    expect(sandbox.annotate('c1', 'Access to the path is denied.', 0)).toBe('Access to the path is denied.')
  })

  it('does not run a command whose ACLs it cannot set, and reports no sandbox when the trial fails', async () => {
    const failing = await setup({ failGrant: true })
    expect(await failing.sandbox.wrap('x', failing.policy('c1'))).toMatchObject({ kind: 'unavailable', fatal: true })
    const broken = await setup({ trial: 'CreateRestrictedToken failed (error 5)' })
    expect(await broken.sandbox.probe()).toMatchObject({ kind: 'none', reason: expect.stringContaining('CreateRestrictedToken') })
    expect(await broken.sandbox.wrap('x', broken.policy('c1'))).toMatchObject({ kind: 'unavailable' })
    expect(await broken.sandbox.wrap('x', broken.policy('c1'))).not.toHaveProperty('fatal')
    const elsewhere = createWindowsSandbox({ platform: 'linux' })
    expect(await elsewhere.probe()).toMatchObject({ kind: 'none' })
  })
})

describe('commands without isolation on Windows', () => {
  it('asks for every command that is not read-only, once each, and leaves read-only ones', () => {
    const hits = unconfinedHits('Get-ChildItem; npm install; Remove-Item build -Recurse', [])
    expect(hits.map(hit => hit.segment)).toEqual(['npm install', 'Remove-Item build -Recurse'])
    expect(hits[0]).toMatchObject({ kind: 'unconfined', risk: 'medium', allowedScopes: ['once', 'session', 'project'], description: UNCONFINED_COMMAND_DESCRIPTION })
    expect(unconfinedHits('npm install', hits)).toEqual([])
    expect(unconfinedHits('Get-Content a.txt', [])).toEqual([])
  })
})
