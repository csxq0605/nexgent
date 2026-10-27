/**
 * The Windows sandbox as far as it runs off Windows: the access plan, the
 * environment prefix, the tool folders, and the backend against a fake
 * `srt-win` library (status, grants, denies, install). The sandbox itself
 * runs only on Windows (windows-accept.yml).
 */
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  createWindowsSandbox,
  planWindowsAccess,
  setWindowsSandboxLibrary,
  toolReadDirs,
  UNCONFINED_COMMAND_DESCRIPTION,
  unconfinedHits,
  windowsKey,
  WINDOWS_NOT_INSTALLED,
  withEnvironment,
  type WindowsLibrary,
} from '../src/index.js'

const dirs: string[] = []
afterEach(async () => {
  setWindowsSandboxLibrary(undefined)
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

describe('Windows access plan', () => {
  it('grants new roots once, denies existing protected paths below them, and in read-only mode every other write root', () => {
    const exists = (path: string) => !path.endsWith('missing')
    const first = planWindowsAccess(
      { writeRoots: ['C:\\Work\\App'], readRoots: ['C:\\Users\\me\\nvm'], denyWrite: ['C:\\Work\\App\\.git\\hooks', 'C:\\Work\\App\\missing', 'D:\\Else'], denyRead: ['C:\\Users\\me\\.ssh'], readOnly: false },
      new Map(), new Set(), exists,
    )
    expect(first).toEqual({ grantWrite: ['C:\\Work\\App'], grantRead: ['C:\\Users\\me\\nvm'], denyRead: [], denyWrite: ['C:\\Work\\App\\.git\\hooks'] })
    const held = new Map([[windowsKey('C:\\Work\\App'), 'C:\\Work\\App'], [windowsKey('C:\\Temp\\s1'), 'C:\\Temp\\s1']])
    const readOnly = planWindowsAccess(
      { writeRoots: ['c:\\temp\\S1\\'], readRoots: ['C:\\Work\\App'], denyWrite: [], denyRead: [], readOnly: true },
      held, new Set([windowsKey('C:\\Users\\me\\nvm')]), exists,
    )
    expect(readOnly).toEqual({ grantWrite: [], grantRead: [], denyRead: [], denyWrite: ['C:\\Work\\App'] })
  })

  it('reads tool folders under the profile, never the profile itself or a protected path', () => {
    const real = (path: string) => (path.includes('link') ? 'C:\\Users\\me\\AppData\\Roaming\\nvm\\v22' : path)
    expect(toolReadDirs(
      ['C:\\Windows\\System32', 'C:\\Users\\me', 'C:\\Users\\me\\nodejs-link', 'C:\\Users\\me\\.ssh\\bin', 'C:\\Users\\me\\scoop\\shims', ''],
      'C:\\Users\\me', ['C:\\Users\\me\\scoop\\shims\\'], ['C:\\Users\\me\\.ssh'], real,
    )).toEqual(['C:\\Users\\me\\AppData\\Roaming\\nvm\\v22', 'C:\\Users\\me\\scoop\\shims\\'])
  })

  it('sets the environment inside the script', () => {
    expect(withEnvironment('npm test', undefined)).toBe('npm test')
    expect(withEnvironment('npm test', { TEMP: "C:\\T'1" })).toBe("[Environment]::SetEnvironmentVariable('TEMP', 'C:\\T''1')\nnpm test")
  })
})

describe('createWindowsSandbox', () => {
  interface Fake { provisioned: boolean; initError?: { code: string; message: string }; grantError?: string; cancel?: boolean }

  async function setup(fake: Fake) {
    const home = await mkdtemp(join(tmpdir(), 'nexgent-winsb-'))
    dirs.push(home)
    const project = join(home, 'project')
    await mkdir(join(project, '.git', 'hooks'), { recursive: true })
    const temp = join(home, 'temp')
    await mkdir(temp)
    const grants: Array<{ write: readonly string[]; read: readonly string[] }> = []
    const wraps: Array<{ command: string; config: unknown; cwd?: string }> = []
    const registered: string[] = []
    let installs = 0
    let resets = 0
    const library: WindowsLibrary = {
      manager: {
        async initialize() {
          if (!fake.provisioned) throw Object.assign(new Error('not provisioned'), { code: 'not_provisioned' })
          if (fake.initError !== undefined) throw Object.assign(new Error(fake.initError.message), { code: fake.initError.code })
        },
        async wrapWithSandboxArgv(command, _shell, config, _signal, cwd) {
          wraps.push({ command, config, ...(cwd === undefined ? {} : { cwd }) })
          return { argv: ['srt-win.exe', 'exec', '--', command], env: {} }
        },
        registerCommandNetworkLists: id => { registered.push(id) },
        unregisterCommandNetworkLists: () => undefined,
        cleanupAfterCommand: () => undefined,
        reset: async () => { resets += 1 },
      },
      srt: {
        exe: 'srt-win.exe',
        userStatus: async () => ({ provisioned: fake.provisioned, credPresent: fake.provisioned, ...(fake.provisioned ? { sid: 'S-1-5-21-1-2-3-1001' } : {}) }),
        grant: (_sid, write, read) => {
          if (fake.grantError !== undefined) throw new Error(fake.grantError)
          grants.push({ write: [...write], read: [...read] })
        },
        install: async () => {
          installs += 1
          if (fake.cancel === true) return { cancelled: true }
          fake.provisioned = true
          return {}
        },
      },
    }
    setWindowsSandboxLibrary(async () => library)
    const sandbox = createWindowsSandbox({ platform: 'win32', skipTrial: true, home })
    const policy = (id: string, extra: object = {}) => ({
      writeRoots: [project], denyWrite: [join(project, '.nexgent'), join(project, '.git', 'hooks')], denyRead: [],
      network: true, commandId: `${id}-0123456789abcdefghijklmnopqrstuvwxyz`, shell: 'pwsh', readRoots: [project], cwd: project, ...extra,
    })
    return { project, temp, sandbox, policy, grants, wraps, registered, counts: () => ({ installs, resets }) }
  }

  it('reports not installed as installable, installs behind one prompt and is active after', async () => {
    const fake: Fake = { provisioned: false, cancel: true }
    const { sandbox, counts } = await setup(fake)
    expect(await sandbox.probe()).toEqual({ kind: 'none', reason: WINDOWS_NOT_INSTALLED, installable: true })
    expect(await sandbox.wrap('x', { writeRoots: [], denyWrite: [], denyRead: [], network: true, commandId: 'c'.repeat(20) })).toMatchObject({ kind: 'unavailable' })
    expect(await sandbox.install!()).toEqual({ kind: 'cancelled' })
    expect(await sandbox.probe()).toMatchObject({ kind: 'none', installable: true })
    fake.cancel = false
    expect(await sandbox.install!()).toEqual({ kind: 'installed', status: { kind: 'active', platform: 'windows' } })
    expect(await sandbox.probe()).toEqual({ kind: 'active', platform: 'windows' })
    expect(counts().installs).toBe(2)
    await sandbox.dispose()
    expect(counts().resets).toBeGreaterThan(0)
  })

  it('offers a reinstall when the network filter is missing', async () => {
    const { sandbox } = await setup({ provisioned: true, initError: { code: 'wfp_filter_missing', message: 'WFP filter missing' } })
    expect(await sandbox.probe()).toMatchObject({ kind: 'none', installable: true, reason: expect.stringContaining('WFP') })
  })

  it('grants the roots once, passes the denies and the environment, and binds the network list', async () => {
    const { project, sandbox, policy, grants, wraps, registered } = await setup({ provisioned: true })
    const wrapped = await sandbox.wrap('npm test', policy('c1', { env: { TEMP: 'T' } }))
    expect(wrapped).toMatchObject({ kind: 'wrapped', program: 'srt-win.exe' })
    expect(grants).toHaveLength(1)
    expect(grants[0]!.write).toEqual([project])
    expect(wraps[0]!.command).toBe("[Environment]::SetEnvironmentVariable('TEMP', 'T')\nnpm test")
    expect(wraps[0]!.cwd).toBe(project)
    // .nexgent does not exist: nothing to deny there yet.
    expect(wraps[0]!.config).toEqual({ filesystem: { denyRead: [], denyWrite: [join(project, '.git', 'hooks')] } })
    expect(registered).toEqual([policy('c1').commandId])
    await sandbox.wrap('npm test', policy('c2'))
    expect(grants).toHaveLength(1)
    expect(sandbox.annotate(policy('c1').commandId, 'Access to the path is denied.', 1)).toContain('<sandbox_violations>')
    expect(sandbox.annotate(policy('c1').commandId, 'Access to the path is denied.', 0)).toBe('Access to the path is denied.')
    await sandbox.dispose()
  })

  it('keeps a read-only command out of the write roots granted before', async () => {
    const { project, temp, sandbox, policy, wraps } = await setup({ provisioned: true })
    await sandbox.wrap('npm test', policy('c1'))
    await sandbox.wrap('node x.mjs', policy('c2', { writeRoots: [temp], denyWrite: [], readOnly: true }))
    expect((wraps[1]!.config as { filesystem: { denyWrite: string[] } }).filesystem.denyWrite).toEqual([project])
    await sandbox.dispose()
  })

  it('does not run a command whose grants fail', async () => {
    const { sandbox, policy } = await setup({ provisioned: true, grantError: 'srt-win grant failed' })
    expect(await sandbox.wrap('x', policy('c1'))).toMatchObject({ kind: 'unavailable', fatal: true, reason: expect.stringContaining('grant failed') })
    await sandbox.dispose()
  })

  it('reports no sandbox elsewhere', async () => {
    expect(await createWindowsSandbox({ platform: 'linux' }).probe()).toMatchObject({ kind: 'none' })
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
