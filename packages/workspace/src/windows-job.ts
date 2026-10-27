/**
 * Windows process-tree containment with a Job Object (`permissions.md`
 * §已知边界, step-2 work partition W7). Node cannot create a Job Object
 * without a native addon, so the runner starts a small `pwsh` launcher that
 * puts itself into a new job with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` and
 * then starts the real command, which inherits the job and the launcher's
 * standard handles. The job handle is held only by the launcher, so when the
 * launcher exits or is killed every process still in the job (descendants
 * whose parent already exited included) is terminated by the system.
 *
 * The P/Invoke source is written once to the temp directory
 * (`nexgent-job-<hash>.cs`), compiled by the first launcher into
 * `nexgent-job-<hash>.dll` and loaded from there afterwards; the spec passed
 * through the environment stays small. The launcher runs under PowerShell 7
 * and under Windows PowerShell 5.1 (ADR 0022 decision 7). When the job
 * cannot be created the launcher still runs the command, and the runner's
 * `taskkill /T` fallback applies.
 *
 * With a capability list in the spec the launcher starts the command with a
 * restricted token instead (`windows-sandbox.ts`, after Codex
 * `windows-sandbox-rs/src/token.rs`): `CreateRestrictedToken` with
 * `DISABLE_MAX_PRIVILEGE | LUA_TOKEN | WRITE_RESTRICTED` and the restricting
 * SIDs capabilities, logon SID, Everyone; a default DACL that grants those
 * SIDs the objects the command creates; `SeChangeNotifyPrivilege` enabled;
 * `CreateProcessAsUserW` with the launcher's standard handles. A write then
 * succeeds only where the file's ACL also allows one of the restricting
 * SIDs, that is in the directories granted to the capabilities. When any
 * step fails the command is not run at all: the launcher exits with
 * {@link JOB_SANDBOX_FAILED_EXIT}.
 */
import { createHash } from 'node:crypto'
import { existsSync, renameSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** Exit code the launcher uses when the command itself could not be started. */
export const JOB_START_FAILED_EXIT = 9009
/** Prefix of the launcher's stderr line for a command that could not be started. */
export const JOB_START_FAILED_MARKER = 'nexgent-job: start-failed: '
/** Exit code the launcher uses when the restricted token or process could not be made (the command did not run). */
export const JOB_SANDBOX_FAILED_EXIT = 9010
/** Prefix of the launcher's stderr line for {@link JOB_SANDBOX_FAILED_EXIT}. */
export const JOB_SANDBOX_FAILED_MARKER = 'nexgent-job: sandbox-failed: '
/** Environment variable carrying the launch spec to the launcher; removed before the command starts. */
export const JOB_SPEC_ENV = 'NEXGENT_JOB_SPEC'

/** C# for `NexgentJob.Enter()`: create a kill-on-close job and assign the current process to it. */
export const JOB_SOURCE = `using System;
using System.Runtime.InteropServices;
public static class NexgentJob {
  [StructLayout(LayoutKind.Sequential)] struct Basic { public long PerProcessUserTimeLimit; public long PerJobUserTimeLimit; public uint LimitFlags; public UIntPtr MinimumWorkingSetSize; public UIntPtr MaximumWorkingSetSize; public uint ActiveProcessLimit; public UIntPtr Affinity; public uint PriorityClass; public uint SchedulingClass; }
  [StructLayout(LayoutKind.Sequential)] struct Io { public ulong ReadOperationCount; public ulong WriteOperationCount; public ulong OtherOperationCount; public ulong ReadTransferCount; public ulong WriteTransferCount; public ulong OtherTransferCount; }
  [StructLayout(LayoutKind.Sequential)] struct Extended { public Basic BasicLimitInformation; public Io IoInfo; public UIntPtr ProcessMemoryLimit; public UIntPtr JobMemoryLimit; public UIntPtr PeakProcessMemoryUsed; public UIntPtr PeakJobMemoryUsed; }
  [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)] static extern IntPtr CreateJobObjectW(IntPtr attributes, string name);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetInformationJobObject(IntPtr job, int infoClass, ref Extended info, uint length);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
  [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
  public static bool Enter() {
    IntPtr job = CreateJobObjectW(IntPtr.Zero, null);
    if (job == IntPtr.Zero) return false;
    Extended info = new Extended();
    info.BasicLimitInformation.LimitFlags = 0x2000;
    if (!SetInformationJobObject(job, 9, ref info, (uint)Marshal.SizeOf(typeof(Extended)))) return false;
    return AssignProcessToJobObject(job, GetCurrentProcess());
  }

  [StructLayout(LayoutKind.Sequential)] struct SidAndAttributes { public IntPtr Sid; public uint Attributes; }
  [StructLayout(LayoutKind.Sequential)] struct Luid { public uint LowPart; public int HighPart; }
  [StructLayout(LayoutKind.Sequential)] struct TokenPrivileges { public uint PrivilegeCount; public Luid Luid; public uint Attributes; }
  [StructLayout(LayoutKind.Sequential)] struct TokenDefaultDacl { public IntPtr DefaultDacl; }
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] struct StartupInfo {
    public int cb; public string lpReserved; public string lpDesktop; public string lpTitle;
    public int dwX; public int dwY; public int dwXSize; public int dwYSize; public int dwXCountChars; public int dwYCountChars;
    public int dwFillAttribute; public int dwFlags; public short wShowWindow; public short cbReserved2; public IntPtr lpReserved2;
    public IntPtr hStdInput; public IntPtr hStdOutput; public IntPtr hStdError;
  }
  [StructLayout(LayoutKind.Sequential)] struct ProcessInformation { public IntPtr hProcess; public IntPtr hThread; public int dwProcessId; public int dwThreadId; }
  [DllImport("advapi32.dll", SetLastError = true)] static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);
  [DllImport("advapi32.dll", SetLastError = true)] static extern bool GetTokenInformation(IntPtr token, int infoClass, IntPtr info, uint length, out uint returned);
  [DllImport("advapi32.dll", SetLastError = true)] static extern bool CreateRestrictedToken(IntPtr existing, uint flags, uint disableCount, IntPtr disable, uint deleteCount, IntPtr delete, uint restrictCount, SidAndAttributes[] restrict, out IntPtr created);
  [DllImport("advapi32.dll", SetLastError = true)] static extern bool SetTokenInformation(IntPtr token, int infoClass, ref TokenDefaultDacl info, uint length);
  [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)] static extern bool ConvertStringSidToSidW(string sid, out IntPtr result);
  [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)] static extern bool ConvertSidToStringSidW(IntPtr sid, out IntPtr result);
  [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)] static extern bool ConvertStringSecurityDescriptorToSecurityDescriptorW(string sddl, uint revision, out IntPtr descriptor, IntPtr size);
  [DllImport("advapi32.dll", SetLastError = true)] static extern bool GetSecurityDescriptorDacl(IntPtr descriptor, out bool present, out IntPtr dacl, out bool defaulted);
  [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)] static extern bool LookupPrivilegeValueW(string system, string name, out Luid luid);
  [DllImport("advapi32.dll", SetLastError = true)] static extern bool AdjustTokenPrivileges(IntPtr token, bool disableAll, ref TokenPrivileges state, uint length, IntPtr previous, IntPtr returned);
  [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)] static extern bool CreateProcessAsUserW(IntPtr token, string application, System.Text.StringBuilder commandLine, IntPtr processAttributes, IntPtr threadAttributes, bool inheritHandles, uint flags, IntPtr environment, string directory, ref StartupInfo startup, out ProcessInformation info);
  [DllImport("kernel32.dll")] static extern IntPtr GetStdHandle(int which);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetHandleInformation(IntPtr handle, uint mask, uint flags);
  [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
  [DllImport("kernel32.dll")] static extern bool GetExitCodeProcess(IntPtr process, out uint code);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr memory);

  static Exception Fail(string step) { return new Exception(step + " failed (error " + Marshal.GetLastWin32Error() + ")"); }

  static IntPtr Sid(string text) {
    IntPtr sid;
    if (!ConvertStringSidToSidW(text, out sid)) throw Fail("ConvertStringSidToSid " + text);
    return sid;
  }

  // The logon SID of the current token (the group with SE_GROUP_LOGON_ID), as text.
  static string LogonSid(IntPtr token) {
    uint length;
    GetTokenInformation(token, 2, IntPtr.Zero, 0, out length);
    IntPtr groups = Marshal.AllocHGlobal((int)length);
    try {
      if (!GetTokenInformation(token, 2, groups, length, out length)) throw Fail("GetTokenInformation");
      int count = Marshal.ReadInt32(groups);
      int size = Marshal.SizeOf(typeof(SidAndAttributes));
      IntPtr first = new IntPtr(groups.ToInt64() + IntPtr.Size);
      for (int i = 0; i < count; i++) {
        SidAndAttributes entry = (SidAndAttributes)Marshal.PtrToStructure(new IntPtr(first.ToInt64() + i * size), typeof(SidAndAttributes));
        if ((entry.Attributes & 0xC0000000) == 0xC0000000) {
          IntPtr text;
          if (!ConvertSidToStringSidW(entry.Sid, out text)) throw Fail("ConvertSidToStringSid");
          string result = Marshal.PtrToStringUni(text);
          LocalFree(text);
          return result;
        }
      }
    } finally { Marshal.FreeHGlobal(groups); }
    throw new Exception("the current token has no logon SID");
  }

  // Start commandLine with a write-restricted token whose restricting SIDs are capabilities + logon SID + Everyone; return its exit code.
  public static int RunRestricted(string commandLine, string directory, string[] capabilities) {
    IntPtr token;
    if (!OpenProcessToken(GetCurrentProcess(), 0x1AB, out token)) throw Fail("OpenProcessToken");
    string logon = LogonSid(token);
    string[] restricting = new string[capabilities.Length + 2];
    capabilities.CopyTo(restricting, 0);
    restricting[capabilities.Length] = logon;
    restricting[capabilities.Length + 1] = "S-1-1-0";
    SidAndAttributes[] sids = new SidAndAttributes[restricting.Length];
    for (int i = 0; i < restricting.Length; i++) { sids[i].Sid = Sid(restricting[i]); sids[i].Attributes = 0; }
    IntPtr restricted;
    if (!CreateRestrictedToken(token, 0x1 | 0x4 | 0x8, 0, IntPtr.Zero, 0, IntPtr.Zero, (uint)sids.Length, sids, out restricted)) throw Fail("CreateRestrictedToken");
    CloseHandle(token);
    // Objects the command creates (pipes, files without inherited ACLs) stay usable under the write restriction.
    System.Text.StringBuilder sddl = new System.Text.StringBuilder("D:");
    foreach (string sid in restricting) sddl.Append("(A;;GA;;;").Append(sid).Append(")");
    sddl.Append("(A;;RC;;;OW)");
    IntPtr descriptor;
    if (!ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl.ToString(), 1, out descriptor, IntPtr.Zero)) throw Fail("ConvertStringSecurityDescriptor");
    bool present, defaulted;
    TokenDefaultDacl dacl = new TokenDefaultDacl();
    if (!GetSecurityDescriptorDacl(descriptor, out present, out dacl.DefaultDacl, out defaulted)) throw Fail("GetSecurityDescriptorDacl");
    if (!SetTokenInformation(restricted, 6, ref dacl, (uint)IntPtr.Size)) throw Fail("SetTokenInformation(TokenDefaultDacl)");
    TokenPrivileges change = new TokenPrivileges();
    if (LookupPrivilegeValueW(null, "SeChangeNotifyPrivilege", out change.Luid)) {
      change.PrivilegeCount = 1;
      change.Attributes = 0x2;
      AdjustTokenPrivileges(restricted, false, ref change, (uint)Marshal.SizeOf(typeof(TokenPrivileges)), IntPtr.Zero, IntPtr.Zero);
    }
    StartupInfo startup = new StartupInfo();
    startup.cb = Marshal.SizeOf(typeof(StartupInfo));
    startup.dwFlags = 0x100;
    startup.hStdInput = GetStdHandle(-10);
    startup.hStdOutput = GetStdHandle(-11);
    startup.hStdError = GetStdHandle(-12);
    foreach (IntPtr handle in new IntPtr[] { startup.hStdInput, startup.hStdOutput, startup.hStdError }) {
      if (handle != IntPtr.Zero && handle != new IntPtr(-1)) SetHandleInformation(handle, 1, 1);
    }
    ProcessInformation info;
    if (!CreateProcessAsUserW(restricted, null, new System.Text.StringBuilder(commandLine), IntPtr.Zero, IntPtr.Zero, true, 0x400, IntPtr.Zero, directory, ref startup, out info)) throw Fail("CreateProcessAsUser");
    CloseHandle(info.hThread);
    WaitForSingleObject(info.hProcess, 0xFFFFFFFF);
    uint code;
    GetExitCodeProcess(info.hProcess, out code);
    CloseHandle(info.hProcess);
    CloseHandle(restricted);
    LocalFree(descriptor);
    return (int)code;
  }
}
`

/** The compiled helper's path: temp dir + a hash of {@link JOB_SOURCE}; the source sits next to it as `.cs`. */
export function jobAssemblyPath(): string {
  const hash = createHash('sha256').update(JOB_SOURCE).digest('hex').slice(0, 16)
  return join(tmpdir(), `nexgent-job-${hash}.dll`)
}

let sourceReady = false

/** Write {@link JOB_SOURCE} next to the assembly path once (atomic rename; concurrent writers agree). Never throws. */
export function ensureJobSource(dll: string = jobAssemblyPath()): void {
  if (sourceReady) return
  const source = dll.replace(/\.dll$/, '.cs')
  try {
    if (!existsSync(dll) && !existsSync(source)) {
      const temp = `${source}.${process.pid}.tmp`
      writeFileSync(temp, JOB_SOURCE)
      renameSync(temp, source)
    }
    sourceReady = true
  } catch {
    // The launcher then fails to compile, runs the command without a job, and taskkill /T remains.
  }
}

/** What the launcher reads from {@link JOB_SPEC_ENV}. */
export interface JobLaunchSpec {
  readonly command: string
  readonly args: readonly string[]
  /** Compiled helper; its source is the same path with `.cs`. */
  readonly dll: string
  /** `PSModulePath` as the runner computed it, restored for the command (`null` = unset). */
  readonly psModulePath: string | null
  /** Capability SIDs: start the command with a restricted token that may write only where they are granted (`windows-sandbox.ts`). */
  readonly capabilities?: readonly string[]
}

/**
 * The launcher script. It never writes to stdout; it exits with the
 * command's exit code, or {@link JOB_START_FAILED_EXIT} after a
 * {@link JOB_START_FAILED_MARKER} line on stderr when the command could not
 * be started.
 */
export const JOB_LAUNCHER = `$ErrorActionPreference = 'Stop'
$spec = [Environment]::GetEnvironmentVariable('${JOB_SPEC_ENV}') | ConvertFrom-Json
[Environment]::SetEnvironmentVariable('${JOB_SPEC_ENV}', $null)
try {
  if (-not ('NexgentJob' -as [type])) {
    if (-not (Test-Path -LiteralPath $spec.dll)) {
      $tmp = [IO.Path]::Combine([IO.Path]::GetDirectoryName($spec.dll), [IO.Path]::GetFileNameWithoutExtension($spec.dll) + '-' + $PID + '.dll')
      Add-Type -Path ([IO.Path]::ChangeExtension($spec.dll, '.cs')) -OutputAssembly $tmp
      try { Move-Item -LiteralPath $tmp -Destination $spec.dll -ErrorAction Stop } catch { Remove-Item -LiteralPath $tmp -ErrorAction SilentlyContinue }
    }
    Add-Type -Path $spec.dll
  }
  $null = [NexgentJob]::Enter()
} catch {
}
# CommandLineToArgvW quoting, for Windows PowerShell 5.1 (no ArgumentList) and the restricted start.
function Join-CommandLine([string[]]$words) {
  $quoted = foreach ($word in $words) {
    $text = [string]$word
    if ($text.Length -gt 0 -and $text -notmatch '[\\s"]') { $text; continue }
    $sb = New-Object Text.StringBuilder
    [void]$sb.Append('"')
    $slashes = 0
    foreach ($ch in $text.ToCharArray()) {
      if ([string]$ch -ceq '\\') { $slashes++ }
      elseif ([string]$ch -ceq '"') { [void]$sb.Append('\\' * ($slashes * 2 + 1)); [void]$sb.Append('"'); $slashes = 0 }
      else { if ($slashes -gt 0) { [void]$sb.Append('\\' * $slashes) }; [void]$sb.Append($ch); $slashes = 0 }
    }
    if ($slashes -gt 0) { [void]$sb.Append('\\' * ($slashes * 2)) }
    [void]$sb.Append('"')
    $sb.ToString()
  }
  $quoted -join ' '
}
if ($null -ne $spec.capabilities) {
  # Never started without the restriction: any failure here ends the launcher.
  [Environment]::SetEnvironmentVariable('PSModulePath', $spec.psModulePath)
  try {
    $line = Join-CommandLine (@([string]$spec.command) + @($spec.args))
    $code = [NexgentJob]::RunRestricted($line, [Environment]::CurrentDirectory, [string[]]@($spec.capabilities))
  } catch {
    [Console]::Error.WriteLine('${JOB_SANDBOX_FAILED_MARKER}' + $_.Exception.Message)
    exit ${JOB_SANDBOX_FAILED_EXIT}
  }
  exit $code
}
$psi = New-Object Diagnostics.ProcessStartInfo -ArgumentList ([string]$spec.command)
if ($PSVersionTable.PSVersion.Major -ge 6) {
  foreach ($arg in @($spec.args)) { $psi.ArgumentList.Add([string]$arg) }
} else {
  $psi.Arguments = Join-CommandLine @($spec.args)
}
$psi.UseShellExecute = $false
$psi.WorkingDirectory = [Environment]::CurrentDirectory
if ($PSVersionTable.PSVersion.Major -ge 6) {
  if ($null -eq $spec.psModulePath) { $null = $psi.Environment.Remove('PSModulePath') } else { $psi.Environment['PSModulePath'] = [string]$spec.psModulePath }
} else {
  if ($null -eq $spec.psModulePath) { $psi.EnvironmentVariables.Remove('PSModulePath') } else { $psi.EnvironmentVariables['PSModulePath'] = [string]$spec.psModulePath }
}
try {
  $child = [Diagnostics.Process]::Start($psi)
} catch {
  [Console]::Error.WriteLine('${JOB_START_FAILED_MARKER}' + $_.Exception.InnerException.Message)
  exit ${JOB_START_FAILED_EXIT}
}
$child.WaitForExit()
exit $child.ExitCode
`

/** `pwsh` arguments that run {@link JOB_LAUNCHER}. */
export function jobLauncherArgs(): string[] {
  return ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(JOB_LAUNCHER, 'utf16le').toString('base64')]
}

/** The launch spec for one command. */
export function jobLaunchSpec(command: string, args: readonly string[], env: Readonly<Record<string, string>>, capabilities?: readonly string[]): JobLaunchSpec {
  const key = Object.keys(env).find(name => name.toLowerCase() === 'psmodulepath')
  const dll = jobAssemblyPath()
  ensureJobSource(dll)
  return { command, args: [...args], dll, psModulePath: key === undefined ? null : env[key]!, ...(capabilities === undefined ? {} : { capabilities: [...capabilities] }) }
}
