/**
 * The Windows system sandbox (`permissions.md` §系统沙箱, Windows): the
 * Windows backend of `@anthropic-ai/sandbox-runtime` (`srt-win`, the same
 * design as Codex's elevated Windows sandbox). Commands run as the
 * dedicated local account `srt-sandbox`:
 *
 * - **network**: a WFP filter lets that account connect only to the
 *   library's local proxy, so the domain allow list and the questions
 *   about other hosts work as on macOS / Linux (`NetworkGate`), and a
 *   program that ignores the proxy variables is still blocked;
 * - **files**: the account has no rights on the user's files. A command's
 *   write directories get an inheritable modify ACE for it, the
 *   directories it must read (the project in read-only mode, the folders
 *   of tools on `PATH` under the user's profile, the Node that runs
 *   programs) a read ACE; write- and read-protected paths below them get
 *   a deny ACE for that command (`srt-win exec --deny-*`).
 *
 * The account and the WFP filter are made once per machine by
 * {@link installWindowsCommandSandbox} (one administrator prompt). Until
 * then the probe reports `none` with `installable: true`; a command whose
 * sandbox cannot be set up does not run (`fatal`).
 *
 * Grants are held by this process (the library keeps them in a per-user
 * database and removes them at `reset()`, or after a crash on the next
 * start): a directory granted for writing stays writable for later
 * sandboxed commands of this process, except read-only ones.
 */
import { spawn, spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, realpathSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import * as nodePath from 'node:path'
import type { CommandSandboxInstallResult } from '@nexgent/kernel'
import {
  forget,
  GLOBAL_CONFIG,
  MIN_COMMAND_ID_LENGTH,
  NetworkGate,
  reasonFrom,
  registerNetwork,
  VIOLATION_HINT,
  type OsSandbox,
  type OsSandboxInstallResult,
  type OsSandboxStatus,
  type OsSandboxWrap,
  type SandboxManagerLike,
} from './os-sandbox.js'
import { currentPowerShell } from './shell-check.js'
import { buildRestrictLauncher, randomCapabilitySid, restrictingSids, type RestrictTools } from './windows-restrict.js'

/** The slice of the library's `SandboxManager` used on Windows. */
export interface WindowsManagerLike extends Pick<SandboxManagerLike, 'registerCommandNetworkLists' | 'unregisterCommandNetworkLists' | 'cleanupAfterCommand' | 'reset'> {
  initialize(config: unknown, askCallback?: unknown, enableLogMonitor?: boolean): Promise<void>
  wrapWithSandboxArgv(
    command: string,
    binShell?: string | { exe: string; args: readonly string[] },
    customConfig?: unknown,
    abortSignal?: AbortSignal,
    cwd?: string,
    options?: { commandId?: string; commandText?: string },
  ): Promise<{ argv: string[]; env: NodeJS.ProcessEnv }>
}

/** The library's `srt-win` helpers used here (tests inject fakes). */
export interface SrtWinLike {
  /** `srt-win` itself. */
  readonly exe: string
  /** The sandbox account; `sid` once it is provisioned. */
  userStatus(): Promise<{ readonly provisioned: boolean; readonly credPresent: boolean; readonly sid?: string }>
  /** Additive, process-held ACEs for a SID (the account, or a capability SID). Throws when `srt-win` fails. */
  grant(sandboxUserSid: string, write: readonly string[], read: readonly string[]): void
  /** Remove this process's ACEs for a SID. Never throws. */
  revoke(sandboxUserSid: string): void
  /** Remove ACEs that processes which have ended left behind (a crash). Never throws. */
  recover(sandboxUserSid: string): void
  /** The one-time machine install (one administrator prompt). */
  install(): Promise<{ readonly cancelled?: true }>
}

/** The library as this module uses it. */
export interface WindowsLibrary {
  readonly manager: WindowsManagerLike
  readonly srt: SrtWinLike
  /** The write-restricted launcher (`windows-restrict.ts`). */
  tools(): Promise<RestrictTools>
}

async function loadLibrary(): Promise<WindowsLibrary> {
  const lib = await import('@anthropic-ai/sandbox-runtime')
  const exe = lib.VENDORED_SRT_WIN_EXE
  const srtWin = () => lib.resolveSrtWin({ path: exe })
  return {
    manager: lib.SandboxManager as unknown as WindowsManagerLike,
    srt: {
      exe,
      userStatus: () => lib.getWindowsSandboxUserStatusAsync({ srtWin: srtWin() }),
      grant: (sandboxUserSid, write, read) => lib.grantWindowsAcl({ sandboxUserSid, write, read, srtWin: srtWin() }),
      revoke: sandboxUserSid => {
        try {
          lib.revokeWindowsAcl({ sandboxUserSid, srtWin: srtWin() })
        } catch {
          // best effort
        }
      },
      recover: sandboxUserSid => {
        spawnSync(exe, [lib.SRT_WIN_DISPATCH_ARG1, 'acl', 'recover', '--sandbox-user-sid', sandboxUserSid], { windowsHide: true, timeout: 60_000, stdio: 'ignore' })
      },
      install: async () => {
        const result = await lib.installWindowsSandboxAsync({ srtWin: srtWin() })
        return result.cancelled === true ? { cancelled: true } : {}
      },
    },
    tools: () => buildRestrictLauncher(),
  }
}

/** Why there is no Windows sandbox yet, when the account is not provisioned. */
export const WINDOWS_NOT_INSTALLED = 'the Windows sandbox is not installed yet (one administrator prompt sets it up)'

interface WinBackend {
  readonly lib?: WindowsLibrary
  readonly gate: NetworkGate
  readonly failure?: string
  readonly installable?: boolean
  readonly sid?: string
  readonly tools?: RestrictTools
}

// One per process: the library's manager is a singleton. `generation` moves on after an install.
let shared: { readonly generation: number; readonly backend: Promise<WinBackend>; refs: number } | undefined
let generation = 0
let loader: () => Promise<WindowsLibrary> = loadLibrary
// What this process granted the account already, by comparable path.
const grantedWrite = new Map<string, string>()
const grantedRead = new Set<string>()
// The capability SID of each directory a read-only command wrote to, and every SID this process granted to.
const capabilities = new Map<string, string>()
const grantees = new Set<string>()
let exitHook: (() => void) | undefined

function forgetGrants(): void {
  grantedWrite.clear()
  grantedRead.clear()
  capabilities.clear()
  grantees.clear()
}

/** Take back every ACE this process granted (the library's `reset()` only takes back what its own config stamped). */
function revokeAll(lib: WindowsLibrary | undefined): void {
  if (lib !== undefined) for (const sid of grantees) lib.srt.revoke(sid)
  forgetGrants()
}

/** Tests: the library to use instead of `@anthropic-ai/sandbox-runtime`; resets the process state. */
export function setWindowsSandboxLibrary(load: (() => Promise<WindowsLibrary>) | undefined): void {
  loader = load ?? loadLibrary
  shared = undefined
  generation += 1
  forgetGrants()
}

/** Pure: a Windows path for comparing (case and trailing separators ignored). */
export function windowsKey(path: string): string {
  return nodePath.win32.resolve(path).replace(/[\\/]+$/, '').toLowerCase()
}

/** Pure: whether `path` is `root` or below it (Windows comparison). */
export function windowsWithin(root: string, path: string): boolean {
  const a = windowsKey(root)
  const b = windowsKey(path)
  return b === a || b.startsWith(`${a}\\`)
}

/** Pure: PowerShell statements that set `env` in the process before `script` runs. */
export function withEnvironment(script: string, env: Readonly<Record<string, string>> | undefined): string {
  const entries = Object.entries(env ?? {})
  if (entries.length === 0) return script
  const quote = (text: string) => `'${text.replaceAll("'", "''")}'`
  const lines = entries.map(([name, value]) => `[Environment]::SetEnvironmentVariable(${quote(name)}, ${quote(value)})`)
  return `${lines.join('; ')}\n${script}`
}

/**
 * Pure: directories a sandboxed command reads besides its roots: the
 * folders on `PATH` under the user's profile (per-user installs of Node,
 * Python, Scoop, npm globals...; their real location when they are links)
 * and `extra` (the Node that runs programs); none that holds or lies in a
 * read-protected path, never the profile itself.
 */
export function toolReadDirs(pathEntries: readonly string[], home: string, extra: readonly string[], denyRead: readonly string[], real: (path: string) => string | undefined): string[] {
  const out = new Map<string, string>()
  for (const entry of [...pathEntries, ...extra]) {
    if (entry.trim() === '') continue
    const resolved = real(entry)
    if (resolved === undefined || !windowsWithin(home, resolved) || windowsKey(resolved) === windowsKey(home)) continue
    if (denyRead.some(denied => windowsWithin(denied, resolved) || windowsWithin(resolved, denied))) continue
    out.set(windowsKey(resolved), resolved)
  }
  return [...out.values()]
}

/** What one command's grants and denies come to. */
export interface WindowsAccessPlan {
  /** Directories to grant for writing that this process has not granted yet. */
  readonly grantWrite: string[]
  /** Directories to grant for reading that this process has not granted yet. */
  readonly grantRead: string[]
  /** Paths the command may not read (existing, below a granted directory). */
  readonly denyRead: string[]
  /** Paths the command may not write (existing, below a granted directory). */
  readonly denyWrite: string[]
}

/**
 * Pure: the grants and per-command denies for one command, given what the
 * process granted before (`heldWrite` and `heldRead` by {@link windowsKey})
 * and which paths exist. A read-only command needs no denies for the
 * directories granted for writing: its token only writes where its own
 * capability SIDs are granted (`windows-restrict.ts`).
 */
export function planWindowsAccess(
  policy: { readonly writeRoots: readonly string[]; readonly readRoots: readonly string[]; readonly denyWrite: readonly string[]; readonly denyRead: readonly string[] },
  heldWrite: ReadonlyMap<string, string>,
  heldRead: ReadonlySet<string>,
  exists: (path: string) => boolean,
): WindowsAccessPlan {
  const grantWrite = policy.writeRoots.filter(root => !heldWrite.has(windowsKey(root)))
  const grantRead = policy.readRoots.filter(root => !heldRead.has(windowsKey(root)) && !heldWrite.has(windowsKey(root)) && !grantWrite.some(write => windowsKey(write) === windowsKey(root)))
  const granted = [...heldWrite.values(), ...grantWrite, ...policy.readRoots]
  const below = (path: string) => granted.some(root => windowsWithin(root, path))
  return {
    grantWrite,
    grantRead,
    denyRead: policy.denyRead.filter(path => exists(path) && below(path)),
    denyWrite: policy.denyWrite.filter(path => exists(path) && below(path)),
  }
}

/** Progress records would reach stderr as CLIXML noise on every command. */
export const PROGRESS_OFF = "$ProgressPreference = 'SilentlyContinue'"

/**
 * Windows PowerShell 5.1 (.NET Framework) does not read `HTTPS_PROXY` /
 * `HTTP_PROXY`, so `Invoke-WebRequest` and `WebClient` would connect
 * directly and hit the network filter: point its default proxy at the
 * sandbox's proxy, with the credentials in the URL.
 */
export const WINDOWS_POWERSHELL_PROXY = [
  "$__nxp = if ($env:HTTPS_PROXY) { $env:HTTPS_PROXY } else { $env:HTTP_PROXY }",
  "if ($__nxp) { $__nxu = [Uri]$__nxp; $__nxw = New-Object System.Net.WebProxy(('{0}://{1}:{2}' -f $__nxu.Scheme, $__nxu.Host, $__nxu.Port)); if ($__nxu.UserInfo) { $__nxi = $__nxu.UserInfo.Split([char]':', 2); $__nxw.Credentials = New-Object System.Net.NetworkCredential([Uri]::UnescapeDataString($__nxi[0]), [Uri]::UnescapeDataString($__nxi[-1])) }; [System.Net.WebRequest]::DefaultWebProxy = $__nxw }",
  'Remove-Variable __nxp, __nxu, __nxw, __nxi -ErrorAction SilentlyContinue',
].join('\n')

/** Pure: whether a shell is Windows PowerShell 5.1 (`powershell.exe`) rather than PowerShell 7 (`pwsh.exe`). */
export function isWindowsPowerShell(shell: string): boolean {
  return /^powershell(\.exe)?$/i.test(nodePath.win32.basename(shell))
}

/** Pure: the script a sandboxed PowerShell runs: quiet progress, the 5.1 proxy, the variables, then `script`. */
export function sandboxScript(script: string, env: Readonly<Record<string, string>> | undefined, windowsPowerShell: boolean): string {
  return [PROGRESS_OFF, ...(windowsPowerShell ? [WINDOWS_POWERSHELL_PROXY] : []), withEnvironment(script, env)].join('\n')
}

/** The absolute shell to start: `shell` (default the PowerShell commands use) on `PATH`, else Windows PowerShell. */
function shellExe(shell: string | undefined): string {
  const name = shell ?? currentPowerShell().program
  if (nodePath.win32.isAbsolute(name)) return name
  const file = name.toLowerCase().endsWith('.exe') ? name : `${name}.exe`
  for (const dir of (process.env.PATH ?? '').split(';')) {
    if (dir === '') continue
    const candidate = nodePath.win32.join(dir, file)
    if (existsSync(candidate)) return candidate
  }
  return nodePath.win32.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
}

function realOrUndefined(path: string): string | undefined {
  try {
    return realpathSync(path)
  } catch {
    return undefined
  }
}

async function start(lib: WindowsLibrary): Promise<WinBackend> {
  const gate = new NetworkGate()
  // Asked first: the library's own dependency check reports a missing install as a plain error.
  try {
    const user = await lib.srt.userStatus()
    if (!user.provisioned || !user.credPresent) return { lib, gate, failure: WINDOWS_NOT_INSTALLED, installable: true }
  } catch (error) {
    return { lib, gate, failure: reasonFrom(error) }
  }
  try {
    await lib.manager.initialize({ ...GLOBAL_CONFIG, windows: { srtWin: { path: lib.srt.exe } } }, gate.decide, false)
  } catch (error) {
    const code = (error as { code?: unknown }).code
    const message = reasonFrom(error)
    if (code === 'not_provisioned' || /not provisioned/i.test(message)) return { lib, gate, failure: WINDOWS_NOT_INSTALLED, installable: true }
    // A machine whose filter went missing is repaired by installing again.
    return { lib, gate, failure: message, installable: (typeof code === 'string' && code.startsWith('wfp_')) || /\bWFP\b/.test(message) }
  }
  let sid: string
  try {
    const user = await lib.srt.userStatus()
    if (user.sid === undefined) return { lib, gate, failure: 'the Windows sandbox account has no SID', installable: true }
    sid = user.sid
  } catch (error) {
    return { lib, gate, failure: reasonFrom(error) }
  }
  // ACEs a crashed process left for the account.
  try {
    lib.srt.recover(sid)
  } catch {
    // best effort
  }
  try {
    const tools = await lib.tools()
    lib.srt.grant(sid, [], [tools.dir])
    grantees.add(sid)
    grantedRead.add(windowsKey(tools.dir))
    if (exitHook === undefined) {
      exitHook = () => revokeAll(lib)
      process.once('exit', exitHook)
    }
    return { lib, gate, sid, tools }
  } catch (error) {
    return { lib, gate, failure: `cannot set up the write-restricted launcher: ${reasonFrom(error)}` }
  }
}

/** The capability SID of a write directory, granted modify on it the first time. */
function capabilityFor(lib: WindowsLibrary, root: string): string {
  const key = windowsKey(root)
  const known = capabilities.get(key)
  if (known !== undefined) return known
  const sid = randomCapabilitySid()
  lib.srt.grant(sid, [root], [])
  capabilities.set(key, sid)
  grantees.add(sid)
  return sid
}

function acquire(): NonNullable<typeof shared> {
  if (shared === undefined || shared.generation !== generation) {
    shared = { generation, backend: loader().then(start, (error: unknown) => ({ gate: new NetworkGate(), failure: reasonFrom(error) })), refs: 0 }
  }
  return shared
}

/**
 * The one-time install: makes the sandbox account and the WFP filter (one
 * administrator prompt), then every Windows sandbox of this process looks
 * again on its next probe.
 */
export async function installWindowsCommandSandbox(): Promise<{ readonly kind: 'installed' } | { readonly kind: 'cancelled' } | { readonly kind: 'failed'; readonly reason: string }> {
  try {
    const lib = await loader()
    const result = await lib.srt.install()
    if (result.cancelled === true) return { kind: 'cancelled' }
    const old = shared
    shared = undefined
    generation += 1
    // The library forgot the failed initialize; reset anything a working one left.
    if (old !== undefined) await (await old.backend).lib?.manager.reset().catch(() => undefined)
    return { kind: 'installed' }
  } catch (error) {
    return { kind: 'failed', reason: reasonFrom(error) }
  }
}

/** Options of {@link createWindowsSandbox}. */
export interface WindowsSandboxOptions {
  /** Default `process.platform`. */
  readonly platform?: NodeJS.Platform
  /** Skip the trial command (tests). */
  readonly skipTrial?: boolean
  /** The user's profile directory (default `os.homedir()`). */
  readonly home?: string
}

/** Build the Windows sandbox. Cheap until {@link OsSandbox.probe} or {@link OsSandbox.wrap}. */
export function createWindowsSandbox(options: WindowsSandboxOptions = {}): OsSandbox {
  const platform = options.platform ?? process.platform
  const home = options.home ?? homedir()
  let status: { readonly generation: number; readonly status: Promise<OsSandboxStatus> } | undefined
  let heldGeneration: number | undefined
  let disposed = false
  const sandboxed = new Set<string>()
  let current: WinBackend | undefined

  function backend(): Promise<WinBackend> {
    const entry = acquire()
    if (heldGeneration !== entry.generation) {
      heldGeneration = entry.generation
      entry.refs += 1
    }
    return entry.backend
  }

  async function trial(b: WinBackend & { lib: WindowsLibrary; tools: RestrictTools }): Promise<string | undefined> {
    if (options.skipTrial === true) return undefined
    const id = randomBytes(16).toString('base64url')
    try {
      // Through the write-restricted launcher, as every command runs.
      const cmd = nodePath.win32.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'cmd.exe')
      const shell = { exe: b.tools.launcher, args: [restrictingSids(false, []), cmd, '/d', '/c'] }
      const { argv } = await b.lib.manager.wrapWithSandboxArgv('exit 0', shell, { filesystem: {} }, undefined, tmpdir(), { commandId: id, commandText: 'exit 0' })
      return await new Promise<string | undefined>(resolve => {
        const child = spawn(argv[0]!, argv.slice(1), { cwd: tmpdir(), stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true })
        let stderr = ''
        child.stderr.on('data', (chunk: Buffer) => { if (stderr.length < 2000) stderr += chunk.toString('utf8') })
        const timer = setTimeout(() => { child.kill(); resolve('the trial command timed out') }, 60_000)
        child.once('error', error => { clearTimeout(timer); resolve(reasonFrom(error)) })
        child.once('exit', code => {
          clearTimeout(timer)
          resolve(code === 0 ? undefined : `the trial command failed (exit ${String(code)}): ${stderr.trim().split('\n')[0] ?? ''}`)
        })
      })
    } catch (error) {
      return reasonFrom(error)
    } finally {
      b.lib.manager.cleanupAfterCommand()
    }
  }

  const probe = (): Promise<OsSandboxStatus> => {
    if (status === undefined || status.generation !== generation) {
      status = {
        generation,
        status: (async (): Promise<OsSandboxStatus> => {
          if (platform !== 'win32') return { kind: 'none', reason: `the Windows sandbox does not run on ${platform}` }
          const b = await backend()
          current = b
          if (b.failure !== undefined || b.lib === undefined) return { kind: 'none', reason: b.failure ?? 'the sandbox library did not load', ...(b.installable === true ? { installable: true } : {}) }
          const failure = await trial(b as WinBackend & { lib: WindowsLibrary; tools: RestrictTools })
          return failure === undefined ? { kind: 'active', platform: 'windows' } : { kind: 'none', reason: failure }
        })(),
      }
    }
    return status.status
  }

  return {
    probe,
    async wrap(script, policy, signal): Promise<OsSandboxWrap> {
      if (disposed) return { kind: 'unavailable', reason: 'the sandbox was disposed' }
      const found = await probe()
      if (found.kind === 'none') return { kind: 'unavailable', reason: found.reason }
      if (policy.commandId.length < MIN_COMMAND_ID_LENGTH) return { kind: 'unavailable', reason: 'the command id is too short to bind a network allow list' }
      const b = current as WinBackend & { lib: WindowsLibrary; sid: string; tools: RestrictTools }
      try {
        const real = (root: string) => realOrUndefined(root) ?? root
        const readRoots = [
          ...(policy.readRoots ?? []).map(real),
          ...(policy.allowRead ?? []).map(real),
          ...toolReadDirs((process.env.PATH ?? '').split(';'), home, [nodePath.dirname(process.execPath)], policy.denyRead, realOrUndefined),
        ]
        const plan = planWindowsAccess(
          { writeRoots: policy.writeRoots.map(real), readRoots, denyWrite: policy.denyWrite, denyRead: policy.denyRead },
          grantedWrite, grantedRead, existsSync,
        )
        if (plan.grantWrite.length > 0 || plan.grantRead.length > 0) {
          b.lib.srt.grant(b.sid, plan.grantWrite, plan.grantRead)
          for (const root of plan.grantWrite) grantedWrite.set(windowsKey(root), root)
          for (const root of plan.grantRead) grantedRead.add(windowsKey(root))
        }
        // A read-only command writes only where its own capability SIDs are granted (its temp directory).
        const readOnly = policy.readOnly === true
        const caps = readOnly ? policy.writeRoots.map(root => capabilityFor(b.lib, real(root))) : []
        const exe = shellExe(policy.shell)
        registerNetwork({ manager: b.lib.manager, gate: b.gate }, policy)
        const { argv, env } = await b.lib.manager.wrapWithSandboxArgv(
          sandboxScript(script, { CURL_HOME: b.tools.dir, ...policy.env }, isWindowsPowerShell(exe)),
          { exe: b.tools.launcher, args: [restrictingSids(readOnly, caps), exe, '-NoProfile', '-NonInteractive', '-Command'] },
          { filesystem: { denyRead: plan.denyRead, denyWrite: plan.denyWrite } },
          signal,
          policy.cwd,
          { commandId: policy.commandId, commandText: script },
        )
        sandboxed.add(policy.commandId)
        // The library asks for `srt-win` to start with its env; pass on what it adds to ours (never our secrets twice).
        const added = Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined && process.env[entry[0]] !== entry[1]))
        return { kind: 'wrapped', program: argv[0]!, args: argv.slice(1), ...(Object.keys(added).length === 0 ? {} : { env: added }) }
      } catch (error) {
        forget({ manager: b.lib.manager, gate: b.gate }, policy.commandId)
        return { kind: 'unavailable', reason: `cannot set up the Windows sandbox for this command: ${reasonFrom(error)}`, fatal: true }
      }
    },
    annotate(commandId, stderr, exitCode) {
      if (!sandboxed.has(commandId) || exitCode === null || exitCode === 0) return stderr
      if (!/Access to the path .*is denied|Access is denied|UnauthorizedAccess|Access denied|EPERM|EACCES/i.test(stderr)) return stderr
      return `${stderr.replace(/\n$/, '')}\n<sandbox_violations>\n${VIOLATION_HINT}\n</sandbox_violations>`
    },
    release(commandId) {
      sandboxed.delete(commandId)
      const lib = current?.lib
      if (lib === undefined || current === undefined) return
      forget({ manager: lib.manager, gate: current.gate }, commandId)
      try {
        lib.manager.cleanupAfterCommand()
      } catch {
        // best effort
      }
    },
    async install(): Promise<OsSandboxInstallResult> {
      if (platform !== 'win32') return { kind: 'failed', reason: `the Windows sandbox does not run on ${platform}` }
      const result = await installWindowsCommandSandbox()
      if (result.kind !== 'installed') return result
      return { kind: 'installed', status: await probe() }
    },
    async dispose() {
      if (disposed) return
      disposed = true
      if (heldGeneration === undefined || shared === undefined || shared.generation !== heldGeneration) return
      shared.refs -= 1
      if (shared.refs <= 0) {
        const last = shared
        shared = undefined
        const lib = (await last.backend).lib
        revokeAll(lib)
        await lib?.manager.reset().catch(() => undefined)
      }
    },
  }
}

/**
 * Install the command sandbox where it needs it (Windows: one
 * administrator prompt) and report the status commands now get. Hosts call
 * this when the user chooses to install; sessions pick it up with their
 * next command.
 */
export async function installCommandSandbox(platform: NodeJS.Platform = process.platform): Promise<CommandSandboxInstallResult> {
  if (platform !== 'win32') return { kind: 'failed', reason: 'only the Windows command sandbox needs an install' }
  const result = await installWindowsCommandSandbox()
  if (result.kind !== 'installed') return result
  const sandbox = createWindowsSandbox({ platform })
  try {
    const found = await sandbox.probe()
    return { kind: 'installed', status: found.kind === 'active' ? found : { kind: 'none', reason: found.reason, ...(found.installable === true ? { installable: true } : {}) } }
  } finally {
    await sandbox.dispose()
  }
}
