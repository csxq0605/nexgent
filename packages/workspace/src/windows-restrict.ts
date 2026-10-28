/**
 * The write-restricted launcher for the Windows sandbox. `srt-win` runs a
 * command as the sandbox account, but that account is a member of
 * Authenticated Users and Users, so any folder whose ACL lets those groups
 * write (the default on a new data drive such as `E:\`) would be writable
 * from the sandbox. This launcher runs inside `srt-win` and starts the shell
 * with a write-restricted token (`CreateRestrictedToken(WRITE_RESTRICTED)`,
 * as Chromium and Codex do): a write passes only when the ACL also grants it
 * to one of the restricting SIDs, which are the SIDs we name (the sandbox
 * account itself, or a capability SID per write directory) plus the logon
 * SID, Everyone and RESTRICTED. Group grants such as Authenticated Users no
 * longer count for writes; reads are unchanged.
 *
 * Built once per machine with Windows PowerShell's `Add-Type`
 * (.NET Framework, present on every Windows) into the user's temp folder,
 * next to a `_curlrc` for curl inside the sandbox.
 */
import { spawn } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** C# 5 (what Windows PowerShell's `Add-Type` compiles). Usage: `nexgent-restrict.exe <sid>[,<sid>...] <command line>`; `USER` names the caller's own SID. */
export const RESTRICT_SOURCE = `using System;
using System.Runtime.InteropServices;
using System.Text;

public static class NexgentRestrict {
  [StructLayout(LayoutKind.Sequential)] struct SidAndAttributes { public IntPtr Sid; public uint Attributes; }
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] struct StartupInfo {
    public int cb; public string reserved; public string desktop; public string title;
    public int x; public int y; public int xSize; public int ySize; public int xChars; public int yChars; public int fill;
    public int flags; public short showWindow; public short reserved2; public IntPtr reserved3;
    public IntPtr stdInput; public IntPtr stdOutput; public IntPtr stdError;
  }
  [StructLayout(LayoutKind.Sequential)] struct ProcessInformation { public IntPtr process; public IntPtr thread; public int processId; public int threadId; }
  [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
  [DllImport("advapi32.dll", SetLastError = true)] static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);
  [DllImport("advapi32.dll", SetLastError = true)] static extern bool GetTokenInformation(IntPtr token, int infoClass, IntPtr info, uint length, out uint returned);
  [DllImport("advapi32.dll", SetLastError = true)] static extern bool CreateRestrictedToken(IntPtr existing, uint flags, uint disableCount, IntPtr disable, uint deleteCount, IntPtr delete, uint restrictCount, SidAndAttributes[] restrict, out IntPtr created);
  [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)] static extern bool ConvertStringSidToSidW(string sid, out IntPtr result);
  [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)] static extern bool CreateProcessAsUserW(IntPtr token, string application, StringBuilder commandLine, IntPtr processAttributes, IntPtr threadAttributes, bool inheritHandles, uint flags, IntPtr environment, string directory, ref StartupInfo startup, out ProcessInformation info);
  [DllImport("kernel32.dll")] static extern IntPtr GetStdHandle(int which);
  [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
  [DllImport("kernel32.dll")] static extern bool GetExitCodeProcess(IntPtr process, out uint code);

  static int Fail(string what) {
    int error = Marshal.GetLastWin32Error();
    Console.Error.WriteLine("nexgent-sandbox: " + what + " failed (error " + error + ")");
    return 9010;
  }

  static IntPtr TokenInfo(IntPtr token, int infoClass) {
    uint size;
    GetTokenInformation(token, infoClass, IntPtr.Zero, 0, out size);
    IntPtr buffer = Marshal.AllocHGlobal((int)size);
    if (!GetTokenInformation(token, infoClass, buffer, size, out size)) return IntPtr.Zero;
    return buffer;
  }

  static int SkipSpaces(string line, int i) {
    while (i < line.Length && (line[i] == ' ' || line[i] == '\\t')) i++;
    return i;
  }

  static int TokenEnd(string line, int i) {
    if (i < line.Length && line[i] == '"') { int close = line.IndexOf('"', i + 1); return close < 0 ? line.Length : close + 1; }
    while (i < line.Length && line[i] != ' ' && line[i] != '\\t') i++;
    return i;
  }

  public static int Main() {
    string line = Environment.CommandLine;
    int i = SkipSpaces(line, TokenEnd(line, SkipSpaces(line, 0)));
    int end = TokenEnd(line, i);
    string sidList = line.Substring(i, end - i).Trim('"');
    string rest = line.Substring(SkipSpaces(line, end));
    if (sidList.Length == 0 || rest.Length == 0) { Console.Error.WriteLine("nexgent-sandbox: usage: <sids> <command line>"); return 9010; }

    IntPtr token;
    // TOKEN_ASSIGN_PRIMARY | TOKEN_DUPLICATE | TOKEN_QUERY
    if (!OpenProcessToken(GetCurrentProcess(), 0x0001 | 0x0002 | 0x0008, out token)) return Fail("OpenProcessToken");
    IntPtr user = TokenInfo(token, 1);
    if (user == IntPtr.Zero) return Fail("GetTokenInformation(TokenUser)");
    IntPtr groups = TokenInfo(token, 2);
    if (groups == IntPtr.Zero) return Fail("GetTokenInformation(TokenGroups)");

    System.Collections.Generic.List<IntPtr> sids = new System.Collections.Generic.List<IntPtr>();
    foreach (string name in (sidList + ",S-1-1-0,S-1-5-12").Split(',')) {
      if (name.Length == 0) continue;
      if (name == "USER") { sids.Add(Marshal.ReadIntPtr(user)); continue; }
      IntPtr sid;
      if (!ConvertStringSidToSidW(name, out sid)) return Fail("ConvertStringSidToSid(" + name + ")");
      sids.Add(sid);
    }
    // The logon SID: objects of this logon session (window station, desktop, named objects) grant it.
    int count = Marshal.ReadInt32(groups);
    int entry = 2 * IntPtr.Size;
    for (int k = 0; k < count; k++) {
      uint attributes = (uint)Marshal.ReadInt32(groups, IntPtr.Size + k * entry + IntPtr.Size);
      if ((attributes & 0xC0000000) == 0xC0000000) sids.Add(Marshal.ReadIntPtr(groups, IntPtr.Size + k * entry));
    }
    SidAndAttributes[] restrict = new SidAndAttributes[sids.Count];
    for (int k = 0; k < sids.Count; k++) { restrict[k].Sid = sids[k]; restrict[k].Attributes = 0; }

    IntPtr restricted;
    // DISABLE_MAX_PRIVILEGE | WRITE_RESTRICTED
    if (!CreateRestrictedToken(token, 0x1 | 0x8, 0, IntPtr.Zero, 0, IntPtr.Zero, (uint)restrict.Length, restrict, out restricted)) return Fail("CreateRestrictedToken");

    StartupInfo startup = new StartupInfo();
    startup.cb = Marshal.SizeOf(typeof(StartupInfo));
    startup.flags = 0x100;
    startup.stdInput = GetStdHandle(-10);
    startup.stdOutput = GetStdHandle(-11);
    startup.stdError = GetStdHandle(-12);
    ProcessInformation info;
    if (!CreateProcessAsUserW(restricted, null, new StringBuilder(rest), IntPtr.Zero, IntPtr.Zero, true, 0, IntPtr.Zero, null, ref startup, out info)) return Fail("CreateProcessAsUser");
    WaitForSingleObject(info.process, 0xFFFFFFFF);
    uint code;
    if (!GetExitCodeProcess(info.process, out code)) return Fail("GetExitCodeProcess");
    return (int)code;
  }
}
`

/** curl inside the sandbox: certificate revocation lookups go straight to the CA's servers, which the network filter blocks, so a failed lookup is not fatal (git gets the same setting from the sandbox library). */
export const SANDBOX_CURLRC = 'ssl-revoke-best-effort\n'

/** What the sandbox needs from {@link buildRestrictLauncher}. */
export interface RestrictTools {
  /** `nexgent-restrict.exe`. */
  readonly launcher: string
  /** Its folder (granted read to the sandbox account), also `CURL_HOME`. */
  readonly dir: string
}

/** Pure: the restricting SIDs for one command, as the launcher's first argument. */
export function restrictingSids(readOnly: boolean, capabilities: readonly string[]): string {
  return [...(readOnly ? [] : ['USER']), ...capabilities].join(',') || 'S-1-5-12'
}

/** Pure: a random SID for one write directory (a capability: no account has it). */
export function randomCapabilitySid(): string {
  const parts = Array.from({ length: 4 }, () => randomBytes(4).readUInt32LE(0))
  return `S-1-5-21-${parts.join('-')}`
}

let building: Promise<RestrictTools> | undefined

/** Compile the launcher once (per source version) into the temp folder. Rejects when it cannot be built. */
export function buildRestrictLauncher(base: string = tmpdir()): Promise<RestrictTools> {
  building ??= build(base).catch((error: unknown) => {
    building = undefined
    throw error
  })
  return building
}

async function build(base: string): Promise<RestrictTools> {
  const hash = createHash('sha256').update(RESTRICT_SOURCE).update(SANDBOX_CURLRC).digest('hex').slice(0, 16)
  const dir = join(base, 'nexgent-sandbox-tools', hash)
  const launcher = join(dir, 'nexgent-restrict.exe')
  if (existsSync(launcher) && existsSync(join(dir, '_curlrc'))) return { launcher, dir }
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, '_curlrc'), SANDBOX_CURLRC)
  const source = join(dir, 'nexgent-restrict.cs')
  await writeFile(source, RESTRICT_SOURCE)
  const partial = join(dir, `nexgent-restrict-${randomBytes(4).toString('hex')}.exe`)
  const quote = (text: string) => `'${text.replaceAll("'", "''")}'`
  const script = `$ErrorActionPreference='Stop'; Add-Type -TypeDefinition ([IO.File]::ReadAllText(${quote(source)})) -OutputAssembly ${quote(partial)} -OutputType ConsoleApplication`
  const system = process.env.SystemRoot ?? 'C:\\Windows'
  const powershell = join(system, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  await new Promise<void>((resolve, reject) => {
    const child = spawn(existsSync(powershell) ? powershell : 'powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] })
    let stderr = ''
    child.stderr.on('data', (chunk: Buffer) => { if (stderr.length < 4000) stderr += chunk.toString('utf8') })
    const timer = setTimeout(() => child.kill(), 120_000)
    child.once('error', error => { clearTimeout(timer); reject(error) })
    child.once('exit', code => {
      clearTimeout(timer)
      if (code === 0 && existsSync(partial)) resolve()
      else reject(new Error(`cannot build the sandbox launcher (exit ${String(code)}): ${stderr.trim().split('\n')[0] ?? ''}`))
    })
  })
  try {
    await rename(partial, launcher)
  } catch (error) {
    // Another process won the race: use its copy.
    await rm(partial, { force: true })
    if (!existsSync(launcher)) throw error
  }
  return { launcher, dir }
}
