/**
 * TEMPORARY diagnostics on a Windows runner: can a shell at Low (or Untrusted)
 * integrity open HTTPS through Schannel, start PowerShell, and write only to
 * folders labelled for it? Runs as the runner's own user, outside srt-win.
 * Prints, asserts nothing.
 */
import { spawn, spawnSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import * as nodePath from 'node:path'
import { describe, it } from 'vitest'
import { buildRestrictLauncher } from '../src/index.js'

const enabled = process.platform === 'win32' && process.env.NEXGENT_WINDOWS_SANDBOX_TEST === '1'

const LOW_SOURCE = `using System;
using System.Runtime.InteropServices;
using System.Text;

public static class NexgentLow {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] struct StartupInfo {
    public int cb; public string reserved; public string desktop; public string title;
    public int x; public int y; public int xSize; public int ySize; public int xChars; public int yChars; public int fill;
    public int flags; public short showWindow; public short reserved2; public IntPtr reserved3;
    public IntPtr stdInput; public IntPtr stdOutput; public IntPtr stdError;
  }
  [StructLayout(LayoutKind.Sequential)] struct ProcessInformation { public IntPtr process; public IntPtr thread; public int processId; public int threadId; }
  [StructLayout(LayoutKind.Sequential)] struct Label { public IntPtr Sid; public uint Attributes; }
  [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
  [DllImport("advapi32.dll", SetLastError = true)] static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);
  [DllImport("advapi32.dll", SetLastError = true)] static extern bool DuplicateTokenEx(IntPtr existing, uint access, IntPtr attributes, int level, int type, out IntPtr created);
  [DllImport("advapi32.dll", SetLastError = true)] static extern bool SetTokenInformation(IntPtr token, int infoClass, ref Label info, uint length);
  [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)] static extern bool ConvertStringSidToSidW(string sid, out IntPtr result);
  [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)] static extern bool CreateProcessAsUserW(IntPtr token, string application, StringBuilder commandLine, IntPtr processAttributes, IntPtr threadAttributes, bool inheritHandles, uint flags, IntPtr environment, string directory, ref StartupInfo startup, out ProcessInformation info);
  [DllImport("kernel32.dll")] static extern IntPtr GetStdHandle(int which);
  [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
  [DllImport("kernel32.dll")] static extern bool GetExitCodeProcess(IntPtr process, out uint code);

  static int Fail(string what) { Console.Error.WriteLine("low: " + what + " failed (error " + Marshal.GetLastWin32Error() + ")"); return 9010; }

  public static int Main() {
    string line = Environment.CommandLine;
    int i = line.StartsWith("\\"") ? line.IndexOf('"', 1) + 1 : line.IndexOf(' ');
    while (line[i] == ' ') i++;
    int end = line.IndexOf(' ', i);
    string level = line.Substring(i, end - i);
    string rest = line.Substring(end + 1).TrimStart();
    IntPtr token;
    if (!OpenProcessToken(GetCurrentProcess(), 0x0001 | 0x0002 | 0x0008 | 0x0080, out token)) return Fail("OpenProcessToken");
    IntPtr low;
    if (!DuplicateTokenEx(token, 0x02000000, IntPtr.Zero, 2, 1, out low)) return Fail("DuplicateTokenEx");
    Label label = new Label();
    if (!ConvertStringSidToSidW(level, out label.Sid)) return Fail("ConvertStringSidToSid");
    label.Attributes = 0x20;
    if (!SetTokenInformation(low, 25, ref label, (uint)Marshal.SizeOf(typeof(Label)))) return Fail("SetTokenInformation");
    StartupInfo startup = new StartupInfo();
    startup.cb = Marshal.SizeOf(typeof(StartupInfo));
    startup.flags = 0x100;
    startup.stdInput = GetStdHandle(-10); startup.stdOutput = GetStdHandle(-11); startup.stdError = GetStdHandle(-12);
    ProcessInformation info;
    if (!CreateProcessAsUserW(low, null, new StringBuilder(rest), IntPtr.Zero, IntPtr.Zero, true, 0, IntPtr.Zero, null, ref startup, out info)) return Fail("CreateProcessAsUser");
    WaitForSingleObject(info.process, 0xFFFFFFFF);
    uint code; GetExitCodeProcess(info.process, out code);
    return (int)code;
  }
}
`

function run(exe: string, args: string[], env: NodeJS.ProcessEnv = process.env): Promise<string> {
  return new Promise(resolve => {
    const child = spawn(exe, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, env })
    let out = ''
    child.stdout.on('data', (c: Buffer) => { out += c.toString() })
    child.stderr.on('data', (c: Buffer) => { out += `[err]${c.toString()}` })
    const timer = setTimeout(() => { child.kill(); resolve(`TIMEOUT ${out}`) }, 60_000)
    child.on('exit', code => { clearTimeout(timer); resolve(`exit ${String(code)} ${out}`) })
    child.on('error', error => { clearTimeout(timer); resolve(`spawn error ${error.message}`) })
  })
}

describe.runIf(enabled)('low integrity diagnostics', () => {
  it('prints what works at Low and Untrusted integrity', async () => {
    const base = nodePath.join(tmpdir(), 'nxlow')
    const medium = nodePath.join(base, 'medium')
    const lowDir = nodePath.join(base, 'low')
    mkdirSync(medium, { recursive: true })
    mkdirSync(lowDir, { recursive: true })
    console.log('DIAG label', JSON.stringify(spawnSync('icacls', [lowDir, '/setintegritylevel', '(OI)(CI)L'], { encoding: 'utf8' }).stdout))
    const tools = await buildRestrictLauncher(nodePath.join(tmpdir(), 'nxdiag'), LOW_SOURCE)
    const sys = process.env.SystemRoot ?? 'C:\\Windows'
    const ps51 = nodePath.join(sys, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    const script = [
      "$ProgressPreference='SilentlyContinue'",
      '$ExecutionContext.SessionState.LanguageMode',
      `curl.exe -sS -o NUL -w "curl %{http_code}" https://registry.npmjs.org/; ''`,
      "try { 'iwr ' + (Invoke-WebRequest -UseBasicParsing -Uri https://registry.npmjs.org/ -TimeoutSec 30).StatusCode } catch { 'iwr ERR ' + $_.Exception.Message }",
      `try { Set-Content '${medium}\\m.txt' x -ErrorAction Stop; 'medium WROTE' } catch { 'medium DENIED' }`,
      `try { Set-Content '${lowDir}\\l.txt' x -ErrorAction Stop; 'low WROTE' } catch { 'low DENIED ' + $_.Exception.Message }`,
      `& node -e "require('fs').writeFileSync(process.argv[1], 'x'); console.log('node low WROTE')" '${lowDir}\\n.txt'`,
      `& git --version`,
    ].join('\n')
    const env = { ...process.env, TEMP: lowDir, TMP: lowDir }
    for (const [level, sid] of [['low', 'S-1-16-4096'], ['untrusted', 'S-1-16-0']] as const) {
      for (const shell of ['pwsh', ps51]) {
        console.log('DIAG', level, shell, JSON.stringify(await run(tools.launcher, [sid, shell, '-NoProfile', '-NonInteractive', '-Command', script], env)))
      }
    }
  }, 600_000)
})
