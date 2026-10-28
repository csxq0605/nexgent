/**
 * The low-integrity launcher for the Windows sandbox. `srt-win` runs a
 * command as the sandbox account, but that account is a member of
 * Authenticated Users and Users, so any folder whose ACL lets those groups
 * write (the default on a new data drive such as `E:\`) would be writable
 * from the sandbox. This launcher runs inside `srt-win` and starts the shell
 * at Low integrity, without privileges: Windows lets a Low process write
 * only objects labelled Low (every unlabelled file counts as Medium), so
 * group grants no longer open anything for writing. The sandbox labels
 * the command's write directories Low while it holds them (`--label`), and
 * the launcher labels the sandbox account's own profile Low once. Reads are
 * unchanged. (A write-restricted token would do the same for files, but
 * Schannel refuses restricted tokens: no HTTPS for curl, PowerShell or .NET.)
 *
 * Built once per machine with Windows PowerShell's `Add-Type`
 * (.NET Framework, present on every Windows) into the user's temp folder,
 * next to a `_curlrc` for curl inside the sandbox.
 */
import { spawn, spawnSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * C# 5 (what Windows PowerShell's `Add-Type` compiles). Usage:
 * `nexgent-restrict.exe low[|<temp dir>] <command line>` runs the command at Low integrity;
 * `nexgent-restrict.exe --label low|none <path>` labels a folder (and what it holds) Low, or removes the label.
 */
export const RESTRICT_SOURCE = `using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text;

public static class NexgentRestrict {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] struct StartupInfo {
    public int cb; public string reserved; public string desktop; public string title;
    public int x; public int y; public int xSize; public int ySize; public int xChars; public int yChars; public int fill;
    public int flags; public short showWindow; public short reserved2; public IntPtr reserved3;
    public IntPtr stdInput; public IntPtr stdOutput; public IntPtr stdError;
  }
  [StructLayout(LayoutKind.Sequential)] struct ProcessInformation { public IntPtr process; public IntPtr thread; public int processId; public int threadId; }
  [StructLayout(LayoutKind.Sequential)] struct MandatoryLabel { public IntPtr Sid; public uint Attributes; }
  [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
  [DllImport("advapi32.dll", SetLastError = true)] static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);
  [DllImport("advapi32.dll", SetLastError = true)] static extern bool CreateRestrictedToken(IntPtr existing, uint flags, uint disableCount, IntPtr disable, uint deleteCount, IntPtr delete, uint restrictCount, IntPtr restrict, out IntPtr created);
  [DllImport("advapi32.dll", SetLastError = true)] static extern bool SetTokenInformation(IntPtr token, int infoClass, ref MandatoryLabel info, uint length);
  [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)] static extern bool ConvertStringSidToSidW(string sid, out IntPtr result);
  [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)] static extern bool ConvertStringSecurityDescriptorToSecurityDescriptorW(string sddl, uint revision, out IntPtr descriptor, IntPtr size);
  [DllImport("advapi32.dll", SetLastError = true)] static extern bool GetSecurityDescriptorSacl(IntPtr descriptor, out bool present, out IntPtr sacl, out bool defaulted);
  [DllImport("advapi32.dll", CharSet = CharSet.Unicode)] static extern uint SetNamedSecurityInfoW(string name, int objectType, uint info, IntPtr owner, IntPtr group, IntPtr dacl, IntPtr sacl);
  [DllImport("advapi32.dll")] static extern uint SetSecurityInfo(IntPtr handle, int objectType, uint info, IntPtr owner, IntPtr group, IntPtr dacl, IntPtr sacl);
  [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)] static extern bool CreateProcessAsUserW(IntPtr token, string application, StringBuilder commandLine, IntPtr processAttributes, IntPtr threadAttributes, bool inheritHandles, uint flags, IntPtr environment, string directory, ref StartupInfo startup, out ProcessInformation info);
  [DllImport("kernel32.dll")] static extern IntPtr GetStdHandle(int which);
  [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
  [DllImport("kernel32.dll")] static extern bool GetExitCodeProcess(IntPtr process, out uint code);
  [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] static extern IntPtr GetProcessWindowStation();
  [DllImport("user32.dll")] static extern IntPtr GetThreadDesktop(uint threadId);

  static int Fail(string what) {
    int error = Marshal.GetLastWin32Error();
    Console.Error.WriteLine("nexgent-sandbox: " + what + " failed (error " + error + ")");
    return 9010;
  }

  // The SACL with a Low no-write-up label inherited by everything below, or none at all.
  static IntPtr LabelSacl(bool low) {
    IntPtr descriptor; IntPtr sacl; bool present; bool defaulted;
    if (!ConvertStringSecurityDescriptorToSecurityDescriptorW(low ? "S:(ML;OICI;NW;;;LW)" : "S:", 1, out descriptor, IntPtr.Zero)) return IntPtr.Zero;
    if (!GetSecurityDescriptorSacl(descriptor, out present, out sacl, out defaulted)) return IntPtr.Zero;
    return sacl;
  }

  // SE_FILE_OBJECT, LABEL_SECURITY_INFORMATION; Windows passes an inheritable label on to what the folder holds.
  static uint Label(string path, bool low) {
    IntPtr sacl = LabelSacl(low);
    if (sacl == IntPtr.Zero) return (uint)Marshal.GetLastWin32Error();
    return SetNamedSecurityInfoW(path, 1, 0x10, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, sacl);
  }

  // Changing a label needs WRITE_OWNER. On a new data drive a user's own folder often grants them only Modify
  // (through Authenticated Users), but as its owner they may always change its DACL: allow themselves
  // WRITE_OWNER there (inherited by what it holds) for as long as the label stays, then take it back.
  static FileSystemAccessRule OwnerChangeRule() {
    return new FileSystemAccessRule(WindowsIdentity.GetCurrent().User, FileSystemRights.TakeOwnership,
      InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit, PropagationFlags.None, AccessControlType.Allow);
  }

  static bool AllowOwnerChange(string path, bool allow) {
    try {
      DirectorySecurity security = Directory.GetAccessControl(path, AccessControlSections.Access);
      if (allow) security.AddAccessRule(OwnerChangeRule()); else security.RemoveAccessRuleSpecific(OwnerChangeRule());
      Directory.SetAccessControl(path, security);
      return true;
    } catch (Exception) {
      return false;
    }
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

  // One argument as written: quotes taken off, and a trailing backslash that quoting doubled undone.
  static string Unquote(string token) {
    if (token.Length < 2 || token[0] != '"') return token;
    string inner = token.Substring(1, token.Length - 2);
    return inner.EndsWith("\\\\\\\\") ? inner.Substring(0, inner.Length - 1) : inner;
  }

  public static int Main() {
    string line = Environment.CommandLine;
    int i = SkipSpaces(line, TokenEnd(line, SkipSpaces(line, 0)));
    int end = TokenEnd(line, i);
    string first = Unquote(line.Substring(i, end - i));
    string rest = line.Substring(SkipSpaces(line, end));

    if (first == "--label") {
      int levelEnd = TokenEnd(rest, 0);
      string level = rest.Substring(0, levelEnd);
      string path = Unquote(rest.Substring(SkipSpaces(rest, levelEnd)).TrimEnd());
      bool low = level == "low";
      uint error = Label(path, low);
      if (low && error == 5) {
        if (!AllowOwnerChange(path, true)) {
          Console.Error.WriteLine("nexgent-sandbox: Windows does not let this account mark " + path + " writable for the sandbox: only the folder's owner or an administrator can (error 5)");
          return 9011;
        }
        error = Label(path, true);
        if (error != 0) AllowOwnerChange(path, false);
      }
      if (!low) AllowOwnerChange(path, false);
      if (error != 0) { Console.Error.WriteLine("nexgent-sandbox: cannot label " + path + " (error " + error + ")"); return 9011; }
      return 0;
    }

    // "low|<temp dir>": the shell's TEMP and TMP from its first moment (PowerShell checks its language mode by
    // writing a file to TEMP, and the account's own temp folder may not be labelled yet).
    int bar = first.IndexOf('|');
    string mode = bar < 0 ? first : first.Substring(0, bar);
    if (bar >= 0 && bar + 1 < first.Length) {
      string temp = first.Substring(bar + 1);
      Environment.SetEnvironmentVariable("TEMP", temp);
      Environment.SetEnvironmentVariable("TMP", temp);
    }
    if (mode != "low" || rest.Length == 0) { Console.Error.WriteLine("nexgent-sandbox: usage: low[|<temp>] <command line>"); return 9010; }

    // The sandbox account's own profile (caches, tool settings) stays writable: label it Low, once.
    string profile = Environment.GetEnvironmentVariable("USERPROFILE");
    if (!string.IsNullOrEmpty(profile)) {
      string marker = Path.Combine(profile, "AppData", "Local", "nexgent-sandbox-low");
      if (!File.Exists(marker) && Label(profile, true) == 0) { try { File.WriteAllText(marker, ""); } catch (Exception) { } }
    }
    // The window station and desktop srt-win made for this run: Low as well. Best effort.
    IntPtr windowLabel = LabelSacl(true);
    if (windowLabel != IntPtr.Zero) {
      SetSecurityInfo(GetProcessWindowStation(), 7, 0x10, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, windowLabel);
      SetSecurityInfo(GetThreadDesktop(GetCurrentThreadId()), 7, 0x10, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, windowLabel);
    }

    IntPtr token;
    // TOKEN_ASSIGN_PRIMARY | TOKEN_DUPLICATE | TOKEN_QUERY | TOKEN_ADJUST_DEFAULT
    if (!OpenProcessToken(GetCurrentProcess(), 0x0001 | 0x0002 | 0x0008 | 0x0080, out token)) return Fail("OpenProcessToken");
    IntPtr low;
    // DISABLE_MAX_PRIVILEGE, no restricting SIDs (Schannel refuses restricted tokens)
    if (!CreateRestrictedToken(token, 0x1, 0, IntPtr.Zero, 0, IntPtr.Zero, 0, IntPtr.Zero, out low)) return Fail("CreateRestrictedToken");
    MandatoryLabel label = new MandatoryLabel();
    if (!ConvertStringSidToSidW("S-1-16-4096", out label.Sid)) return Fail("ConvertStringSidToSid");
    label.Attributes = 0x20; // SE_GROUP_INTEGRITY
    // TokenIntegrityLevel
    if (!SetTokenInformation(low, 25, ref label, (uint)Marshal.SizeOf(typeof(MandatoryLabel)))) return Fail("SetTokenInformation(TokenIntegrityLevel)");

    StartupInfo startup = new StartupInfo();
    startup.cb = Marshal.SizeOf(typeof(StartupInfo));
    startup.flags = 0x100;
    startup.stdInput = GetStdHandle(-10);
    startup.stdOutput = GetStdHandle(-11);
    startup.stdError = GetStdHandle(-12);
    ProcessInformation info;
    if (!CreateProcessAsUserW(low, null, new StringBuilder(rest), IntPtr.Zero, IntPtr.Zero, true, 0, IntPtr.Zero, null, ref startup, out info)) return Fail("CreateProcessAsUser");
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

/** Pure: the launcher's first argument: Low integrity, and the temp directory the shell starts with. */
export function launcherArgument(temp: string | undefined): string {
  return temp === undefined || temp === '' ? 'low' : `low|${temp}`
}

/** Label `path` (and what it holds) Low, so a sandboxed command may write there, or take the label off. Throws when it fails. */
export function labelFolder(launcher: string, path: string, low: boolean): void {
  const result = spawnSync(launcher, ['--label', low ? 'low' : 'none', path], { windowsHide: true, timeout: 600_000, encoding: 'utf8' })
  if (result.status !== 0) throw new Error(`cannot ${low ? 'open' : 'close'} ${path} for sandboxed writes: ${(result.stderr || result.error?.message || `exit ${String(result.status)}`).trim()}`)
}

/**
 * Which folders each Nexgent process labelled, one file per process id in
 * `dir`, so that the labels a crashed process left behind come off on the
 * next start, and a folder another running process still uses keeps its label.
 */
export class LabelRecord {
  constructor(private readonly dir: string, private readonly pid: number = process.pid, private readonly alive: (pid: number) => boolean = isAlive) {}

  /** Write this process's labelled folders. */
  save(paths: readonly string[]): void {
    try {
      mkdirSync(this.dir, { recursive: true })
      const file = join(this.dir, `${this.pid}.json`)
      if (paths.length === 0) rmSync(file, { force: true })
      else writeFileSync(file, JSON.stringify(paths))
    } catch {
      // the labels still come off on dispose
    }
  }

  /** Folders labelled by processes that have ended, minus those a running process still holds; their records are dropped. */
  orphaned(): string[] {
    const dead: string[] = []
    const held = new Set<string>()
    let names: string[] = []
    try {
      names = readdirSync(this.dir).filter(name => /^\d+\.json$/.test(name))
    } catch {
      return []
    }
    for (const name of names) {
      const pid = Number(name.slice(0, -5))
      let paths: string[] = []
      try {
        const parsed: unknown = JSON.parse(readFileSync(join(this.dir, name), 'utf8'))
        if (Array.isArray(parsed)) paths = parsed.filter((path): path is string => typeof path === 'string')
      } catch {
        // unreadable: nothing to take back
      }
      if (pid !== this.pid && !this.alive(pid)) {
        dead.push(...paths)
        try {
          rmSync(join(this.dir, name), { force: true })
        } catch {
          // tried again next start
        }
      } else {
        for (const path of paths) held.add(path.toLowerCase())
      }
    }
    return [...new Set(dead)].filter(path => !held.has(path.toLowerCase()))
  }

  /** Whether another running process holds `path`. */
  heldElsewhere(path: string): boolean {
    try {
      for (const name of readdirSync(this.dir)) {
        const pid = Number(name.slice(0, -5))
        if (!/^\d+\.json$/.test(name) || pid === this.pid || !this.alive(pid)) continue
        const parsed: unknown = JSON.parse(readFileSync(join(this.dir, name), 'utf8'))
        if (Array.isArray(parsed) && parsed.some(other => typeof other === 'string' && other.toLowerCase() === path.toLowerCase())) return true
      }
    } catch {
      // nothing readable: nobody else
    }
    return false
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

const building = new Map<string, Promise<RestrictTools>>()

/** Compile the launcher once (per source version) into the temp folder. Rejects when it cannot be built. */
export function buildRestrictLauncher(base: string = tmpdir(), source: string = RESTRICT_SOURCE): Promise<RestrictTools> {
  const key = `${base}\u0000${source}`
  let pending = building.get(key)
  if (pending === undefined) {
    pending = build(base, source).catch((error: unknown) => {
      building.delete(key)
      throw error
    })
    building.set(key, pending)
  }
  return pending
}

async function build(base: string, source: string): Promise<RestrictTools> {
  const hash = createHash('sha256').update(source).update(SANDBOX_CURLRC).digest('hex').slice(0, 16)
  const dir = join(base, 'nexgent-sandbox-tools', hash)
  const launcher = join(dir, 'nexgent-restrict.exe')
  if (existsSync(launcher) && existsSync(join(dir, '_curlrc'))) return { launcher, dir }
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, '_curlrc'), SANDBOX_CURLRC)
  const file = join(dir, 'nexgent-restrict.cs')
  await writeFile(file, source)
  const partial = join(dir, `nexgent-restrict-${randomBytes(4).toString('hex')}.exe`)
  const quote = (text: string) => `'${text.replaceAll("'", "''")}'`
  const script = `$ErrorActionPreference='Stop'; Add-Type -TypeDefinition ([IO.File]::ReadAllText(${quote(file)})) -OutputAssembly ${quote(partial)} -OutputType ConsoleApplication`
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
