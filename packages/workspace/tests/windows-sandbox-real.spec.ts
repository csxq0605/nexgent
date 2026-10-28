/**
 * The Windows sandbox for real (`srt-win`): installs it when needed (one
 * administrator prompt; none on a CI runner, which runs elevated), then
 * runs PowerShell commands as the sandbox account. Runs only on Windows
 * with NEXGENT_WINDOWS_SANDBOX_TEST=1 (windows-accept.yml).
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import * as nodePath from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { getWindowsSandboxUserStatusAsync, grantWindowsAcl, resolveSrtWin, VENDORED_SRT_WIN_EXE } from '@anthropic-ai/sandbox-runtime'
import { buildRestrictLauncher, createWindowsSandbox, defaultWriteDenies, labelFolder, LabelRecord, type OsSandbox, type OsSandboxPolicy } from '../src/index.js'

/**
 * Runs a command line as a standard user would (the runner is an elevated administrator): this
 * process's token through SAFER's Normal User level (Administrators deny-only, no privileges) at
 * Medium integrity. Returns its exit code and output.
 */
const STANDARD_USER = `
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class StandardUser {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] struct StartupInfo {
    public int cb; public string reserved; public string desktop; public string title;
    public int x; public int y; public int xSize; public int ySize; public int xChars; public int yChars; public int fill;
    public int flags; public short showWindow; public short reserved2; public IntPtr reserved3;
    public IntPtr stdInput; public IntPtr stdOutput; public IntPtr stdError;
  }
  [StructLayout(LayoutKind.Sequential)] struct ProcessInformation { public IntPtr process; public IntPtr thread; public int processId; public int threadId; }
  [StructLayout(LayoutKind.Sequential)] struct MandatoryLabel { public IntPtr Sid; public uint Attributes; }
  [DllImport("advapi32.dll", SetLastError = true)] static extern bool SaferCreateLevel(uint scope, uint level, uint flags, out IntPtr handle, IntPtr reserved);
  [DllImport("advapi32.dll", SetLastError = true)] static extern bool SaferComputeTokenFromLevel(IntPtr level, IntPtr inToken, out IntPtr outToken, uint flags, IntPtr reserved);
  [DllImport("advapi32.dll", SetLastError = true)] static extern bool SetTokenInformation(IntPtr token, int infoClass, ref MandatoryLabel info, uint length);
  [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)] static extern bool ConvertStringSidToSidW(string sid, out IntPtr result);
  [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)] static extern bool CreateProcessAsUserW(IntPtr token, string application, StringBuilder commandLine, IntPtr processAttributes, IntPtr threadAttributes, bool inheritHandles, uint flags, IntPtr environment, string directory, ref StartupInfo startup, out ProcessInformation info);
  [DllImport("kernel32.dll")] static extern IntPtr GetStdHandle(int which);
  [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
  [DllImport("kernel32.dll")] static extern bool GetExitCodeProcess(IntPtr process, out uint code);
  static int Fail(string step) { Console.Error.WriteLine(step + " failed: " + Marshal.GetLastWin32Error()); return 9100; }
  public static int Run(string commandLine) {
    IntPtr level, token;
    if (!SaferCreateLevel(2, 0x20000, 1, out level, IntPtr.Zero)) return Fail("SaferCreateLevel");
    if (!SaferComputeTokenFromLevel(level, IntPtr.Zero, out token, 0, IntPtr.Zero)) return Fail("SaferComputeTokenFromLevel");
    MandatoryLabel label = new MandatoryLabel();
    if (!ConvertStringSidToSidW("S-1-16-8192", out label.Sid)) return Fail("ConvertStringSidToSid");
    label.Attributes = 0x20;
    if (!SetTokenInformation(token, 25, ref label, (uint)Marshal.SizeOf(typeof(MandatoryLabel)))) return Fail("SetTokenInformation");
    StartupInfo startup = new StartupInfo();
    startup.cb = Marshal.SizeOf(typeof(StartupInfo));
    startup.flags = 0x100;
    startup.stdInput = GetStdHandle(-10);
    startup.stdOutput = GetStdHandle(-11);
    startup.stdError = GetStdHandle(-12);
    ProcessInformation info;
    if (!CreateProcessAsUserW(token, null, new StringBuilder(commandLine), IntPtr.Zero, IntPtr.Zero, true, 0, IntPtr.Zero, null, ref startup, out info)) return Fail("CreateProcessAsUser");
    WaitForSingleObject(info.process, 0xFFFFFFFF);
    uint code;
    GetExitCodeProcess(info.process, out code);
    return (int)code;
  }
}
'@
exit [StandardUser]::Run($env:NX_STANDARD_USER_COMMAND)
`

function asStandardUser(commandLine: string): { code: number | null; output: string } {
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', STANDARD_USER], {
    encoding: 'utf8', env: { ...process.env, NX_STANDARD_USER_COMMAND: commandLine }, windowsHide: true, timeout: 120_000,
  })
  return { code: result.status, output: `${result.stdout}${result.stderr}` }
}

const enabled = process.platform === 'win32' && process.env.NEXGENT_WINDOWS_SANDBOX_TEST === '1'

describe.runIf(enabled)('Windows sandbox (real)', () => {
  let sandbox: OsSandbox
  let root: string
  let project: string
  let temp: string
  let outside: string
  let secret: string
  let wide: string
  let leftover: string
  let eproj: string
  let base: Omit<OsSandboxPolicy, 'commandId'>

  beforeAll(async () => {
    sandbox = createWindowsSandbox()
    const first = await sandbox.probe()
    if (first.kind === 'none') {
      expect(first.installable, first.reason).toBe(true)
      const installed = await sandbox.install!()
      expect(installed, JSON.stringify(installed)).toMatchObject({ kind: 'installed', status: { kind: 'active' } })
    }
    root = await realpath(await mkdtemp(nodePath.join(tmpdir(), 'nxwin-')))
    // Private like a profile folder: only this user, SYSTEM and Administrators (a runner's temp drive lets Users read).
    const acl = spawnSync('icacls', [root, '/inheritance:r', '/grant:r', `${process.env.USERNAME}:(OI)(CI)F`, '*S-1-5-18:(OI)(CI)F', '*S-1-5-32-544:(OI)(CI)F'], { encoding: 'utf8' })
    expect(acl.status, acl.stdout + acl.stderr).toBe(0)
    project = nodePath.join(root, 'proj')
    temp = nodePath.join(root, 'tmp')
    outside = nodePath.join(root, 'outside')
    secret = nodePath.join(project, 'secret')
    wide = nodePath.join(root, 'wide')
    leftover = nodePath.join(root, 'leftover')
    eproj = nodePath.join(root, 'eproj')
    await Promise.all([
      mkdir(nodePath.join(project, '.git', 'hooks'), { recursive: true }),
      mkdir(nodePath.join(project, '.nexgent'), { recursive: true }),
      mkdir(secret, { recursive: true }),
      mkdir(temp, { recursive: true }),
      mkdir(outside, { recursive: true }),
      mkdir(wide, { recursive: true }),
      mkdir(leftover, { recursive: true }),
      mkdir(nodePath.join(eproj, 'src'), { recursive: true }),
    ])
    // Like a new data drive (E:\\): Authenticated Users and Users may modify; the sandbox account is in both groups.
    const open = spawnSync('icacls', [wide, '/grant', '*S-1-5-11:(OI)(CI)M', '*S-1-5-32-545:(OI)(CI)M'], { encoding: 'utf8' })
    expect(open.status, open.stdout + open.stderr).toBe(0)
    // A project made on a new data drive (E:\\): it inherits the drive's default ACL, so its owner may only
    // modify it through Authenticated Users (no Full Control, no WRITE_OWNER to change its label).
    await writeFile(nodePath.join(eproj, 'src', 'existing.txt'), 'OLD')
    const drive = spawnSync('icacls', [eproj, '/inheritance:r', '/grant:r', '*S-1-5-11:(OI)(CI)M', '*S-1-5-18:(OI)(CI)F'], { encoding: 'utf8' })
    expect(drive.status, drive.stdout + drive.stderr).toBe(0)
    await writeFile(nodePath.join(project, 'readme.txt'), 'PROJECT-TEXT')
    await mkdir(nodePath.join(project, 'src'))
    await writeFile(nodePath.join(project, 'src', 'existing.txt'), 'OLD')
    await writeFile(nodePath.join(project, '.nexgent', 'config.json'), '{}')
    await writeFile(nodePath.join(secret, 'key.txt'), 'SECRET-IN-PROJECT')
    await writeFile(nodePath.join(outside, 'private.txt'), 'OUTSIDE-TEXT')
    base = {
      writeRoots: [project, temp],
      denyWrite: defaultWriteDenies(project),
      denyRead: [secret],
      network: true,
      readRoots: [project],
      cwd: project,
      env: { TEMP: temp, TMP: temp },
      shell: 'pwsh',
    }
  }, 300_000)

  afterAll(async () => {
    await sandbox?.dispose()
    if (root !== undefined) await rm(root, { recursive: true, force: true })
  })

  async function go(script: string, extra: Partial<OsSandboxPolicy> = {}, using: OsSandbox = sandbox): Promise<{ code: number | null; stdout: string; stderr: string }> {
    const commandId = randomBytes(16).toString('base64url')
    const wrapped = await using.wrap(script, { ...base, ...extra, commandId })
    if (wrapped.kind !== 'wrapped') throw new Error(`not wrapped: ${wrapped.reason}`)
    try {
      return await new Promise(resolve => {
        const child = spawn(wrapped.program, wrapped.args, { cwd: project, env: { ...process.env, ...wrapped.env }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
        let stdout = ''
        let stderr = ''
        child.stdout.on('data', (c: Buffer) => { stdout += c.toString() })
        child.stderr.on('data', (c: Buffer) => { stderr += c.toString() })
        const timer = setTimeout(() => child.kill(), 60_000)
        child.on('exit', code => { clearTimeout(timer); resolve({ code, stdout, stderr }) })
      })
    } finally {
      using.release(commandId)
    }
  }

  it('is active', async () => {
    expect(await sandbox.probe()).toEqual({ kind: 'active', platform: 'windows' })
  })

  it('reads and writes the project and the temp directory', async () => {
    const result = await go(`Get-Content readme.txt; Set-Content made.txt hello; Get-Content made.txt; Set-Content src\\existing.txt NEW; Set-Content (Join-Path $env:TEMP 't.txt') t; Get-Content (Join-Path $env:TEMP 't.txt')`)
    expect(result.stdout, result.stderr).toContain('PROJECT-TEXT')
    expect(result.stdout).toContain('hello')
    expect(result.stdout).toMatch(/^t\r?$/m)
    expect(await readFile(nodePath.join(project, 'made.txt'), 'utf8')).toContain('hello')
    // A file that was there before the project was opened for writes.
    expect(await readFile(nodePath.join(project, 'src', 'existing.txt'), 'utf8'), result.stderr).toContain('NEW')
  }, 120_000)

  it('cannot read or write outside, nor read a protected path inside the project', async () => {
    const result = await go(`Get-Content '${nodePath.join(outside, 'private.txt')}'; Get-Content '${nodePath.join(secret, 'key.txt')}'; Set-Content '${nodePath.join(outside, 'new.txt')}' x; "done"`)
    expect(result.stdout, result.stderr).toContain('done')
    expect(result.stdout).not.toContain('OUTSIDE-TEXT')
    expect(result.stdout).not.toContain('SECRET-IN-PROJECT')
    expect(existsSync(nodePath.join(outside, 'new.txt'))).toBe(false)
  }, 120_000)

  it('cannot write a folder outside whose ACL lets Authenticated Users and Users modify it', async () => {
    const result = await go(`Set-Content '${nodePath.join(wide, 'w.txt')}' pwned; New-Item -ItemType Directory '${nodePath.join(wide, 'sub')}' | Out-Null; "done"`)
    expect(result.stdout, result.stderr).toContain('done')
    expect(existsSync(nodePath.join(wide, 'w.txt'))).toBe(false)
    expect(existsSync(nodePath.join(wide, 'sub'))).toBe(false)
  }, 120_000)

  it('writes a project the user may only modify (a new data drive\'s default ACL), and still not outside it', async () => {
    const policy = { writeRoots: [eproj, temp], denyWrite: defaultWriteDenies(eproj), denyRead: [], readRoots: [eproj], cwd: eproj }
    const result = await go(`Set-Content '${nodePath.join(eproj, 'made.txt')}' inside; Set-Content '${nodePath.join(eproj, 'src', 'existing.txt')}' NEW; Set-Content '${nodePath.join(wide, 'e.txt')}' pwned; "done"`, policy)
    expect(result.stdout, result.stderr).toContain('done')
    expect(await readFile(nodePath.join(eproj, 'made.txt'), 'utf8'), result.stderr).toContain('inside')
    expect(await readFile(nodePath.join(eproj, 'src', 'existing.txt'), 'utf8'), result.stderr).toContain('NEW')
    expect(existsSync(nodePath.join(wide, 'e.txt'))).toBe(false)
    expect(spawnSync('icacls', [eproj], { encoding: 'utf8' }).stdout).toMatch(/Mandatory Label\\Low/i)
    // The next command finds the folder ready.
    const again = await go(`Set-Content '${nodePath.join(eproj, 'again.txt')}' again; "done"`, policy)
    expect(await readFile(nodePath.join(eproj, 'again.txt'), 'utf8'), again.stderr).toContain('again')
  }, 120_000)

  it('as a standard user who owns a folder but may only modify it, labels it by allowing themselves WRITE_OWNER, and takes both back', async () => {
    const own = nodePath.join(root, 'eown')
    const foreign = nodePath.join(root, 'eforeign')
    for (const dir of [own, foreign]) {
      await mkdir(nodePath.join(dir, 'src'), { recursive: true })
      await writeFile(nodePath.join(dir, 'src', 'existing.txt'), 'OLD')
    }
    // Owned by this user, as a folder they made on E:\\ would be; the other one by Administrators.
    for (const [dir, owner] of [[own, process.env.USERNAME!], [foreign, '*S-1-5-32-544']] as const) {
      const set = spawnSync('icacls', [dir, '/setowner', owner, '/T', '/C'], { encoding: 'utf8' })
      expect(set.status, set.stdout + set.stderr).toBe(0)
      const drive = spawnSync('icacls', [dir, '/inheritance:r', '/grant:r', '*S-1-5-11:(OI)(CI)M', '*S-1-5-18:(OI)(CI)F', '/T', '/C'], { encoding: 'utf8' })
      expect(drive.status, drive.stdout + drive.stderr).toBe(0)
    }
    // The case this fixes: Modify alone does not let a standard user change the label.
    const plain = asStandardUser(`icacls "${own}" /setintegritylevel (OI)(CI)L`)
    expect(plain.code, plain.output).not.toBe(0)
    const { launcher } = await buildRestrictLauncher()
    const label = asStandardUser(`"${launcher}" --label low "${own}"`)
    expect(label.code, label.output).toBe(0)
    const held = spawnSync('icacls', [own], { encoding: 'utf8' }).stdout
    expect(held).toMatch(/[(,]WO[,)]/)
    expect(held).toMatch(/Mandatory Label\\Low/i)
    expect(spawnSync('icacls', [nodePath.join(own, 'src', 'existing.txt')], { encoding: 'utf8' }).stdout).toMatch(/Mandatory Label\\Low/i)
    const unlabel = asStandardUser(`"${launcher}" --label none "${own}"`)
    expect(unlabel.code, unlabel.output).toBe(0)
    const after = spawnSync('icacls', [own], { encoding: 'utf8' }).stdout
    expect(after).not.toMatch(/[(,]WO[,)]/)
    expect(after).not.toMatch(/Mandatory Label\\Low/i)
    // A folder someone else owns: the reason is clear.
    const refused = asStandardUser(`"${launcher}" --label low "${foreign}"`)
    expect(refused.code).toBe(9011)
    expect(refused.output).toContain("only the folder's owner or an administrator can")
    expect(spawnSync('icacls', [foreign], { encoding: 'utf8' }).stdout).not.toMatch(/[(,]WO[,)]|Mandatory Label\\Low/i)
  }, 180_000)

  it('keeps .nexgent and .git/hooks read-only', async () => {
    await go(`Set-Content '.nexgent\\config.json' changed; Set-Content '.git\\hooks\\pre-commit' x; "done"`)
    expect(await readFile(nodePath.join(project, '.nexgent', 'config.json'), 'utf8')).toBe('{}')
    expect(existsSync(nodePath.join(project, '.git', 'hooks', 'pre-commit'))).toBe(false)
  }, 120_000)

  it('read-only: the project is readable but not writable, the temp directory is', async () => {
    const result = await go(`Get-Content readme.txt; Set-Content ro.txt x; Set-Content (Join-Path $env:TEMP 'ok.txt') ok; "done"`, { writeRoots: [temp], denyWrite: [], readOnly: true })
    expect(result.stdout, result.stderr).toContain('PROJECT-TEXT')
    expect(existsSync(nodePath.join(project, 'ro.txt'))).toBe(false)
    const acl = spawnSync('icacls', [temp], { encoding: 'utf8' }).stdout
    expect(existsSync(nodePath.join(temp, 'ok.txt')), `${result.stdout}\n${result.stderr}\n${acl}`).toBe(true)
  }, 120_000)

  it('runs the Node on PATH', async () => {
    const result = await go(`node -e "console.log('node ' + process.version)"`)
    expect(result.stdout, result.stderr).toContain(`node ${process.version}`)
  }, 120_000)

  it('keeps stderr free of progress records, in PowerShell 7 and Windows PowerShell 5.1', async () => {
    for (const shell of ['pwsh', 'powershell']) {
      const result = await go(`Get-ChildItem | Out-Null; Import-Module Microsoft.PowerShell.Archive -ErrorAction SilentlyContinue; & node -e "console.log('node ok')"; 'ok'`, { shell })
      expect(result.stdout, `${shell}: ${result.stderr}`).toContain('node ok')
      expect(result.stderr, shell).not.toContain('CLIXML')
    }
  }, 120_000)

  describe('a grant another process holds', () => {
    let holder: ChildProcess

    beforeAll(async () => {
      // Another Nexgent (or one that crashed) granted the sandbox account modify on a folder.
      holder = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 600000)'], { stdio: 'ignore' })
      const srtWin = resolveSrtWin({ path: VENDORED_SRT_WIN_EXE })
      const user = await getWindowsSandboxUserStatusAsync({ srtWin })
      grantWindowsAcl({ sandboxUserSid: user.sid!, write: [leftover], read: [], holderPid: holder.pid!, srtWin })
    }, 120_000)

    afterAll(() => { holder.kill() })

    it('does not let a read-only command write there', async () => {
      const result = await go(`Set-Content '${nodePath.join(leftover, 'ro.txt')}' x; "done"`, { writeRoots: [temp], denyWrite: [], readOnly: true })
      expect(result.stdout, result.stderr).toContain('done')
      expect(existsSync(nodePath.join(leftover, 'ro.txt'))).toBe(false)
    }, 120_000)
  })

  it('lets Windows PowerShell 5.1 reach a listed host through the proxy', async () => {
    const result = await go(`(Invoke-WebRequest -UseBasicParsing -Uri https://registry.npmjs.org/ -TimeoutSec 30).StatusCode`, {
      shell: 'powershell',
      network: { mode: 'allowlist', allowedDomains: ['registry.npmjs.org'], owner: 's', ask: async () => false },
    })
    // curl.exe and PowerShell 7 use Schannel too.
    const others = await go(`curl.exe -sS -o NUL -w "curl %{http_code}" https://registry.npmjs.org/; ''; 'pwsh ' + (Invoke-WebRequest -UseBasicParsing -Uri https://registry.npmjs.org/ -TimeoutSec 30).StatusCode`, {
      network: { mode: 'allowlist', allowedDomains: ['registry.npmjs.org'], owner: 's', ask: async () => false },
    })
    expect(others.stdout, others.stderr).toContain('curl 200')
    expect(others.stdout, others.stderr).toContain('pwsh 200')
    if (!result.stdout.includes('200')) {
      const network = { mode: 'allowlist' as const, allowedDomains: ['registry.npmjs.org'], owner: 's', ask: async () => false }
      const curl = await go(`curl.exe -sS -o NUL -w "%{http_code}" https://registry.npmjs.org/; " rc=$LASTEXITCODE"`, { network })
      const seven = await go(`(Invoke-WebRequest -UseBasicParsing -Uri https://registry.npmjs.org/ -TimeoutSec 30).StatusCode`, { network })
      const inner = await go(`try { (New-Object Net.WebClient).DownloadString('https://registry.npmjs.org/').Length } catch { $e = $_.Exception; while ($e) { $e.GetType().FullName + ': ' + $e.Message; $e = $e.InnerException } }; [Net.ServicePointManager]::SecurityProtocol; [System.Net.WebRequest]::DefaultWebProxy.Address`, { shell: 'powershell', network })
      expect.fail(`5.1: ${result.stderr}\ncurl: ${curl.stdout} ${curl.stderr}\npwsh: ${seven.stdout} ${seven.stderr}\n5.1 detail: ${inner.stdout} ${inner.stderr}`)
    }
  }, 120_000)

  describe('network', () => {
    let server: Server
    let port = 0
    beforeAll(async () => {
      server = createServer((_req, res) => res.end('reached'))
      await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
      port = (server.address() as AddressInfo).port
    })
    afterAll(() => new Promise<void>(resolve => server.close(() => resolve())))
    const fetchIt = () => `curl.exe -s --max-time 10 http://127.0.0.1:${port}/; " rc=$LASTEXITCODE"`

    it('reaches a host on the allow list through the proxy, and asks about others once', async () => {
      const listed = await go(fetchIt(), { network: { mode: 'allowlist', allowedDomains: [`127.0.0.1:${port}`], owner: 's', ask: async () => false } })
      expect(listed.stdout, listed.stderr).toContain('reached')
      const asked: string[] = []
      const yes = await go(`${fetchIt()}; ${fetchIt()}`, { network: { mode: 'allowlist', allowedDomains: [], owner: 's', ask: async host => { asked.push(host); return true } } })
      expect(yes.stdout.match(/reached/g)).toHaveLength(2)
      expect(asked).toEqual(['127.0.0.1'])
      const no = await go(fetchIt(), { network: { mode: 'allowlist', allowedDomains: [], owner: 's', ask: async () => false } })
      expect(no.stdout).not.toContain('reached')
    }, 120_000)

    it('blocks a connection that skips the proxy, and every host when the network is off', async () => {
      const direct = await go(`curl.exe -s --max-time 10 --noproxy '*' http://127.0.0.1:${port}/; " rc=$LASTEXITCODE"`, { network: true })
      expect(direct.stdout).not.toContain('reached')
      const off = await go(fetchIt(), { network: { mode: 'off', ask: async () => true } })
      expect(off.stdout).not.toContain('reached')
    }, 120_000)
  })

  describe('when the sandbox is closed', () => {
    const sandboxSid = async () => (await getWindowsSandboxUserStatusAsync({ srtWin: resolveSrtWin({ path: VENDORED_SRT_WIN_EXE }) })).sid!
    const aclMentions = (path: string, sid: string) => {
      const out = spawnSync('icacls', [path], { encoding: 'utf8' }).stdout
      return out.includes('srt-sandbox') || out.includes(sid) || /Mandatory Label\\Low/i.test(out)
    }

    it('takes back every grant it made', async () => {
      const sid = await sandboxSid()
      expect(aclMentions(project, sid)).toBe(true)
      await sandbox.dispose()
      expect(aclMentions(project, sid)).toBe(false)
      expect(aclMentions(temp, sid)).toBe(false)
      expect(aclMentions(eproj, sid)).toBe(false)
    }, 120_000)

    it('clears grants a process that has ended left behind, on the next start', async () => {
      const sid = await sandboxSid()
      const holder = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 600000)'], { stdio: 'ignore' })
      grantWindowsAcl({ sandboxUserSid: sid, write: [outside], read: [], holderPid: holder.pid!, srtWin: resolveSrtWin({ path: VENDORED_SRT_WIN_EXE }) })
      // ...and labelled the folder Low, as the sandbox does.
      const tools = await buildRestrictLauncher()
      labelFolder(tools.launcher, outside, true)
      new LabelRecord(nodePath.join(tmpdir(), 'nexgent-sandbox-tools', 'labels'), holder.pid!).save([outside])
      expect(aclMentions(outside, sid)).toBe(true)
      holder.kill()
      await new Promise(resolve => holder.once('exit', resolve))
      const next = createWindowsSandbox()
      try {
        expect(await next.probe()).toEqual({ kind: 'active', platform: 'windows' })
        expect(aclMentions(outside, sid)).toBe(false)
      } finally {
        await next.dispose()
      }
    }, 180_000)
  })
})
