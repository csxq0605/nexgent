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
  isWindowsPowerShell,
  planWindowsAccess,
  PROGRESS_OFF,
  stripProgressRecords,
  LabelRecord,
  launcherArgument,
  RESTRICT_SOURCE,
  sandboxScript,
  setWindowsSandboxLibrary,
  toolReadDirs,
  UNCONFINED_COMMAND_DESCRIPTION,
  unconfinedHits,
  windowsKey,
  WINDOWS_NOT_INSTALLED,
  WINDOWS_POWERSHELL_PROXY,
  withEnvironment,
  type WindowsLibrary,
} from '../src/index.js'

const dirs: string[] = []
afterEach(async () => {
  setWindowsSandboxLibrary(undefined)
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

describe('Windows access plan', () => {
  it('grants new roots once and denies existing protected paths below them', () => {
    const exists = (path: string) => !path.endsWith('missing')
    const first = planWindowsAccess(
      { writeRoots: ['C:\\Work\\App'], readRoots: ['C:\\Users\\me\\nvm'], denyWrite: ['C:\\Work\\App\\.git\\hooks', 'C:\\Work\\App\\missing', 'D:\\Else'], denyRead: ['C:\\Users\\me\\.ssh'] },
      new Map(), new Set(), exists,
    )
    expect(first).toEqual({ grantWrite: ['C:\\Work\\App'], grantRead: ['C:\\Users\\me\\nvm'], denyRead: [], denyWrite: ['C:\\Work\\App\\.git\\hooks'] })
    const held = new Map([[windowsKey('C:\\Work\\App'), 'C:\\Work\\App'], [windowsKey('C:\\Temp\\s1'), 'C:\\Temp\\s1']])
    const again = planWindowsAccess(
      { writeRoots: ['c:\\temp\\S1\\'], readRoots: ['C:\\Work\\App'], denyWrite: [], denyRead: [] },
      held, new Set([windowsKey('C:\\Users\\me\\nvm')]), exists,
    )
    expect(again).toEqual({ grantWrite: [], grantRead: [], denyRead: [], denyWrite: [] })
    // A read-only command: every write root held before is denied, never one at or above its own.
    const readOnly = planWindowsAccess(
      { writeRoots: ['c:\\temp\\S1\\'], readRoots: ['C:\\Work\\App'], denyWrite: [], denyRead: [], readOnly: true },
      held, new Set(), exists,
    )
    expect(readOnly).toEqual({ grantWrite: [], grantRead: [], denyRead: [], denyWrite: ['C:\\Work\\App'] })
  })

  it('starts the shell at Low integrity without privileges or restricting SIDs, from the command\'s temp directory', () => {
    expect(RESTRICT_SOURCE).toContain('"S-1-16-4096"')
    expect(RESTRICT_SOURCE).toContain('CreateRestrictedToken(token, 0x1, 0, IntPtr.Zero, 0, IntPtr.Zero, 0, IntPtr.Zero')
    expect(RESTRICT_SOURCE).toContain('S:(ML;OICI;NW;;;LW)')
    // A folder the user owns but may only modify: they allow themselves WRITE_OWNER while it is labelled.
    expect(RESTRICT_SOURCE).toContain('FileSystemRights.TakeOwnership')
    expect(RESTRICT_SOURCE).toContain('if (toLow && error == 5)')
    expect(launcherArgument('C:\\T')).toBe('low|C:\\T')
    expect(launcherArgument(undefined)).toBe('low')
  })

  it('records labelled folders per process and hands back only those of ended processes nobody else holds', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'nexgent-labels-'))
    dirs.push(dir)
    const alive = (pid: number) => pid !== 2
    new LabelRecord(dir, 2, alive).save(['C:\\Gone', 'C:\\Shared'])
    new LabelRecord(dir, 3, alive).save(['c:\\shared'])
    const me = new LabelRecord(dir, 1, alive)
    expect(me.heldElsewhere('C:\\SHARED')).toBe(true)
    expect(me.orphaned()).toEqual(['C:\\Gone'])
    expect(me.orphaned()).toEqual([])
  })

  it('reads tool folders under the profile, never the profile itself or a protected path', () => {
    const real = (path: string) => (path.includes('link') ? 'C:\\Users\\me\\AppData\\Roaming\\nvm\\v22' : path)
    expect(toolReadDirs(
      ['C:\\Windows\\System32', 'C:\\Users\\me', 'C:\\Users\\me\\nodejs-link', 'C:\\Users\\me\\.ssh\\bin', 'C:\\Users\\me\\scoop\\shims', ''],
      'C:\\Users\\me', ['C:\\Users\\me\\scoop\\shims\\'], ['C:\\Users\\me\\.ssh'], real,
    )).toEqual(['C:\\Users\\me\\AppData\\Roaming\\nvm\\v22', 'C:\\Users\\me\\scoop\\shims\\'])
  })

  it('turns progress off, routes Windows PowerShell through the proxy, then sets the variables', () => {
    expect(isWindowsPowerShell('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe')).toBe(true)
    expect(isWindowsPowerShell('C:\\Program Files\\PowerShell\\7\\pwsh.exe')).toBe(false)
    expect(sandboxScript('npm test', { A: '1' }, false)).toBe(`${PROGRESS_OFF}\n[Environment]::SetEnvironmentVariable('A', '1')\nnpm test`)
    expect(sandboxScript('npm test', undefined, true)).toBe(`${PROGRESS_OFF}\n${WINDOWS_POWERSHELL_PROXY}\nnpm test`)
    expect(WINDOWS_POWERSHELL_PROXY).toContain('[System.Net.WebRequest]::DefaultWebProxy')
    expect(WINDOWS_POWERSHELL_PROXY).toContain('NetworkCredential')
  })

  it('drops PowerShell progress records from stderr and keeps everything else', () => {
    const progress = '<Obj S="progress" RefId="0"><TN RefId="0"><T>System.Management.Automation.PSCustomObject</T></TN><MS><I64 N="SourceId">1</I64><PR N="Record"><AV>Preparing modules for first use.</AV><AI>0</AI><Nil /><PI>-1</PI><PC>-1</PC><T>Completed</T><SR>-1</SR><SD> </SD></PR></MS></Obj>'
    const error = '<S S="Error">boom_x000D__x000A_</S>'
    const open = '<Objs Version="1.1.0.1" xmlns="http://schemas.microsoft.com/powershell/2004/04">'
    expect(stripProgressRecords(`#< CLIXML\r\n${open}${progress}${progress}</Objs>\r\n`)).toBe('')
    expect(stripProgressRecords(`warning\n#< CLIXML\n${open}${progress}</Objs>`)).toBe('warning\n')
    // Error strings become text; Windows PowerShell writes one block per record after a single header.
    expect(stripProgressRecords(`#< CLIXML\r\n${open}${progress}${error}</Objs>`)).toBe('boom\r\n')
    expect(stripProgressRecords(`#< CLIXML\r\n${open}${progress}</Objs>\r\n${open}${progress}</Objs>\r\n${open}${error}</Objs>\r\n`)).toBe('boom\r\n')
    expect(stripProgressRecords(`#< CLIXML\r\n${open}<S S="Error">a &lt; b_x005F_c</S></Objs>`)).toBe('a < b_c')
    // Something else serialized stays as it was.
    expect(stripProgressRecords(`#< CLIXML\n${open}<Obj S="other"></Obj></Objs>`)).toBe(`${open}<Obj S="other"></Obj></Objs>`)
    expect(stripProgressRecords('plain error\n')).toBe('plain error\n')
  })

  it('sets the environment inside the script', () => {
    expect(withEnvironment('npm test', undefined)).toBe('npm test')
    expect(withEnvironment('npm test', { TEMP: "C:\\T'1" })).toBe("[Environment]::SetEnvironmentVariable('TEMP', 'C:\\T''1')\nnpm test")
  })
})

describe('createWindowsSandbox', () => {
  interface Fake { provisioned: boolean; initError?: { code: string; message: string }; grantError?: string; cancel?: boolean; labelFailures?: number }

  async function setup(fake: Fake) {
    const home = await mkdtemp(join(tmpdir(), 'nexgent-winsb-'))
    dirs.push(home)
    const project = join(home, 'project')
    await mkdir(join(project, '.git', 'hooks'), { recursive: true })
    const temp = join(home, 'temp')
    await mkdir(temp)
    const grants: Array<{ sid: string; write: readonly string[]; read: readonly string[] }> = []
    const revoked: string[] = []
    const recovered: string[] = []
    const wraps: Array<{ command: string; shell: unknown; config: unknown; cwd?: string }> = []
    const registered: string[] = []
    const labels: Array<[string, boolean]> = []
    const recordDir = await mkdtemp(join(tmpdir(), 'nexgent-labels-'))
    dirs.push(recordDir)
    // A process that has ended left a label behind.
    new LabelRecord(recordDir, 999_999_999, () => false).save(['C:\\Crashed'])
    let installs = 0
    let resets = 0
    const library: WindowsLibrary = {
      manager: {
        async initialize() {
          if (!fake.provisioned) throw Object.assign(new Error('not provisioned'), { code: 'not_provisioned' })
          if (fake.initError !== undefined) throw Object.assign(new Error(fake.initError.message), { code: fake.initError.code })
        },
        async wrapWithSandboxArgv(command, shell, config, _signal, cwd) {
          wraps.push({ command, shell, config, ...(cwd === undefined ? {} : { cwd }) })
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
        grant: (sid, write, read) => {
          if (fake.grantError !== undefined && write.length > 0) throw new Error(fake.grantError)
          grants.push({ sid, write: [...write], read: [...read] })
        },
        revoke: sid => { revoked.push(sid) },
        recover: sid => { recovered.push(sid) },
        install: async () => {
          installs += 1
          if (fake.cancel === true) return { cancelled: true }
          fake.provisioned = true
          return {}
        },
      },
      tools: async () => ({ launcher: 'C:\\T\\nexgent-restrict.exe', dir: 'C:\\T' }),
      label: (_launcher, path, low) => {
        labels.push([path, low])
        if (low && (fake.labelFailures ?? 0) > 0) {
          fake.labelFailures! -= 1
          throw new Error(`cannot open ${path} for sandboxed writes: nexgent-sandbox: Windows does not let this account mark ${path} writable for the sandbox`)
        }
      },
      labelRecordDir: recordDir,
    }
    setWindowsSandboxLibrary(async () => library)
    const sandbox = createWindowsSandbox({ platform: 'win32', skipTrial: true, home })
    const policy = (id: string, extra: object = {}) => ({
      writeRoots: [project], denyWrite: [join(project, '.nexgent'), join(project, '.git', 'hooks')], denyRead: [],
      network: true, commandId: `${id}-0123456789abcdefghijklmnopqrstuvwxyz`, shell: 'pwsh', readRoots: [project], cwd: project, ...extra,
    })
    return { project, temp, sandbox, policy, grants, revoked, recovered, wraps, registered, labels, recordDir, counts: () => ({ installs, resets }) }
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
    const { sandbox } = await setup({ provisioned: true, initError: { code: '', message: 'Sandbox dependencies not available: WFP filter missing' } })
    expect(await sandbox.probe()).toMatchObject({ kind: 'none', installable: true, reason: expect.stringContaining('WFP') })
  })

  it('grants and labels the roots once, runs the shell through the low-integrity launcher, passes the denies and the environment, and binds the network list', async () => {
    const { project, sandbox, policy, grants, recovered, wraps, registered, labels } = await setup({ provisioned: true })
    const wrapped = await sandbox.wrap('npm test', policy('c1', { env: { TEMP: 'T' } }))
    expect(wrapped).toMatchObject({ kind: 'wrapped', program: 'srt-win.exe' })
    // Leftovers of a crashed process are cleared, the launcher's folder is readable, then the project is granted.
    expect(recovered).toEqual(['S-1-5-21-1-2-3-1001'])
    expect(grants.map(grant => [grant.sid, grant.write, grant.read])).toEqual([['S-1-5-21-1-2-3-1001', [], ['C:\\T']], ['S-1-5-21-1-2-3-1001', [project], expect.any(Array)]])
    // The crashed process's label comes off, then the project is labelled Low.
    expect(labels).toEqual([['C:\\Crashed', false], [project, true]])
    expect(wraps[0]!.shell).toMatchObject({ exe: 'C:\\T\\nexgent-restrict.exe', args: ['low|T', expect.stringMatching(/pwsh|powershell/i), '-NoProfile', '-NonInteractive', '-Command'] })
    expect(wraps[0]!.command).toContain(PROGRESS_OFF)
    expect(wraps[0]!.command).toContain("[Environment]::SetEnvironmentVariable('CURL_HOME', 'C:\\T')")
    expect(wraps[0]!.command.endsWith("[Environment]::SetEnvironmentVariable('TEMP', 'T')\nnpm test")).toBe(true)
    expect(wraps[0]!.cwd).toBe(project)
    // .nexgent does not exist: nothing to deny there yet.
    expect(wraps[0]!.config).toEqual({ filesystem: { denyRead: [], denyWrite: [join(project, '.git', 'hooks')] } })
    expect(registered).toEqual([policy('c1').commandId])
    await sandbox.wrap('npm test', policy('c2'))
    expect(grants).toHaveLength(2)
    expect(labels).toHaveLength(2)
    expect(sandbox.annotate(policy('c1').commandId, 'Access to the path is denied.', 1)).toContain('<sandbox_violations>')
    expect(sandbox.annotate(policy('c1').commandId, 'Access to the path is denied.', 0)).toBe('Access to the path is denied.')
    await sandbox.dispose()
  })

  it('keeps a read-only command out of the write roots held before, and takes every grant and label back on dispose', async () => {
    const { project, temp, sandbox, policy, revoked, wraps, labels } = await setup({ provisioned: true })
    await sandbox.wrap('npm test', policy('c1'))
    await sandbox.wrap('node x.mjs', policy('c2', { writeRoots: [temp], denyWrite: [], readOnly: true, env: { TEMP: temp } }))
    // The shell starts with TEMP set to its temp directory (PowerShell needs a writable TEMP to keep its full language).
    expect((wraps[1]!.shell as { args: string[] }).args[0]).toBe(`low|${temp}`)
    expect((wraps[1]!.config as { filesystem: { denyWrite: string[] } }).filesystem.denyWrite).toEqual([project])
    expect(labels.slice(1)).toEqual([[project, true], [temp, true]])
    await sandbox.dispose()
    expect(revoked).toEqual(['S-1-5-21-1-2-3-1001'])
    expect(labels.slice(3)).toEqual([[project, false], [temp, false]])
  })

  it('does not run a command on a folder it could not label, keeps no record of it, and tries again with the same reason next time', async () => {
    const fake: Fake = { provisioned: true, labelFailures: 2 }
    const { project, sandbox, policy, labels, recordDir } = await setup(fake)
    const reason = expect.stringContaining(`does not let this account mark ${project} writable`)
    expect(await sandbox.wrap('npm test', policy('c1'))).toMatchObject({ kind: 'unavailable', fatal: true, reason })
    expect(new LabelRecord(recordDir, 1, () => true).heldElsewhere(project)).toBe(false)
    expect(await sandbox.wrap('npm test', policy('c2'))).toMatchObject({ kind: 'unavailable', fatal: true, reason })
    expect(await sandbox.wrap('npm test', policy('c3'))).toMatchObject({ kind: 'wrapped' })
    expect(labels.filter(([path]) => path === project)).toEqual([[project, true], [project, true], [project, true]])
    await sandbox.dispose()
    expect(labels.at(-1)).toEqual([project, false])
  })

  it('switches Windows PowerShell 5.1 to the proxy', async () => {
    const { sandbox, policy, wraps } = await setup({ provisioned: true })
    await sandbox.wrap('Invoke-WebRequest https://registry.npmjs.org/', policy('c1', { shell: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe' }))
    expect(wraps[0]!.command).toContain(WINDOWS_POWERSHELL_PROXY)
    await sandbox.wrap('Invoke-WebRequest https://registry.npmjs.org/', policy('c2', { shell: 'C:\\Program Files\\PowerShell\\7\\pwsh.exe' }))
    expect(wraps[1]!.command).not.toContain(WINDOWS_POWERSHELL_PROXY)
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
