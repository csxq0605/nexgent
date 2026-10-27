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
import { spawn } from 'node:child_process'
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
  /** Additive, process-held ACEs for the account. Throws when `srt-win` fails. */
  grant(sandboxUserSid: string, write: readonly string[], read: readonly string[]): void
  /** The one-time machine install (one administrator prompt). */
  install(): Promise<{ readonly cancelled?: true }>
}

/** The library as this module uses it. */
export interface WindowsLibrary {
  readonly manager: WindowsManagerLike
  readonly srt: SrtWinLike
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
      install: async () => {
        const result = await lib.installWindowsSandboxAsync({ srtWin: srtWin() })
        return result.cancelled === true ? { cancelled: true } : {}
      },
    },
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
}

// One per process: the library's manager is a singleton. `generation` moves on after an install.
let shared: { readonly generation: number; readonly backend: Promise<WinBackend>; refs: number } | undefined
let generation = 0
let loader: () => Promise<WindowsLibrary> = loadLibrary
// What this process granted the account already, by comparable path.
const grantedWrite = new Map<string, string>()
const grantedRead = new Set<string>()

/** Tests: the library to use instead of `@anthropic-ai/sandbox-runtime`; resets the process state. */
export function setWindowsSandboxLibrary(load: (() => Promise<WindowsLibrary>) | undefined): void {
  loader = load ?? loadLibrary
  shared = undefined
  generation += 1
  grantedWrite.clear()
  grantedRead.clear()
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
  /** Paths the command may not write: its protected paths, and in read-only mode every directory granted for writing that is not its own. */
  readonly denyWrite: string[]
}

/**
 * Pure: the grants and per-command denies for one command, given what the
 * process granted before (`heldWrite` and `heldRead` by {@link windowsKey})
 * and which paths exist.
 */
export function planWindowsAccess(
  policy: { readonly writeRoots: readonly string[]; readonly readRoots: readonly string[]; readonly denyWrite: readonly string[]; readonly denyRead: readonly string[]; readonly readOnly: boolean },
  heldWrite: ReadonlyMap<string, string>,
  heldRead: ReadonlySet<string>,
  exists: (path: string) => boolean,
): WindowsAccessPlan {
  const grantWrite = policy.writeRoots.filter(root => !heldWrite.has(windowsKey(root)))
  const grantRead = policy.readRoots.filter(root => !heldRead.has(windowsKey(root)) && !heldWrite.has(windowsKey(root)) && !grantWrite.some(write => windowsKey(write) === windowsKey(root)))
  const granted = [...heldWrite.values(), ...grantWrite, ...policy.readRoots]
  const below = (path: string) => granted.some(root => windowsWithin(root, path))
  const denyRead = policy.denyRead.filter(path => exists(path) && below(path))
  const denyWrite = policy.denyWrite.filter(path => exists(path) && below(path))
  if (policy.readOnly) {
    for (const root of heldWrite.values()) {
      // Never deny a directory at or above the command's own write roots: that would take them away too.
      if (policy.writeRoots.some(own => windowsWithin(root, own))) continue
      if (!denyWrite.some(path => windowsKey(path) === windowsKey(root))) denyWrite.push(root)
    }
  }
  return { grantWrite, grantRead, denyRead, denyWrite }
}

/** The shell for the library: an absolute `pwsh.exe` / `powershell.exe` with our flags when it can be found. */
function shellFor(shell: string | undefined): string | { exe: string; args: readonly string[] } {
  const flags = ['-NoProfile', '-NonInteractive', '-Command']
  const name = shell ?? 'pwsh'
  if (nodePath.win32.isAbsolute(name)) return { exe: name, args: flags }
  const file = name.toLowerCase().endsWith('.exe') ? name : `${name}.exe`
  for (const dir of (process.env.PATH ?? '').split(';')) {
    if (dir === '') continue
    const candidate = nodePath.win32.join(dir, file)
    if (existsSync(candidate)) return { exe: candidate, args: flags }
  }
  return name
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
  try {
    await lib.manager.initialize({ ...GLOBAL_CONFIG, windows: { srtWin: { path: lib.srt.exe } } }, gate.decide, false)
  } catch (error) {
    const code = (error as { code?: unknown }).code
    if (code === 'not_provisioned') return { lib, gate, failure: WINDOWS_NOT_INSTALLED, installable: true }
    // A machine whose filter went missing is repaired by installing again.
    return { lib, gate, failure: reasonFrom(error), installable: typeof code === 'string' && code.startsWith('wfp_') }
  }
  try {
    const user = await lib.srt.userStatus()
    if (user.sid === undefined) return { lib, gate, failure: 'the Windows sandbox account has no SID', installable: true }
    return { lib, gate, sid: user.sid }
  } catch (error) {
    return { lib, gate, failure: reasonFrom(error) }
  }
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
    grantedWrite.clear()
    grantedRead.clear()
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

  async function trial(b: WinBackend & { lib: WindowsLibrary }): Promise<string | undefined> {
    if (options.skipTrial === true) return undefined
    const id = randomBytes(16).toString('base64url')
    try {
      const { argv } = await b.lib.manager.wrapWithSandboxArgv('exit 0', undefined, { filesystem: {} }, undefined, tmpdir(), { commandId: id, commandText: 'exit 0' })
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
          const failure = await trial(b as WinBackend & { lib: WindowsLibrary })
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
      const b = current as WinBackend & { lib: WindowsLibrary; sid: string }
      try {
        const real = (root: string) => realOrUndefined(root) ?? root
        const readRoots = [
          ...(policy.readRoots ?? []).map(real),
          ...(policy.allowRead ?? []).map(real),
          ...toolReadDirs((process.env.PATH ?? '').split(';'), home, [nodePath.dirname(process.execPath)], policy.denyRead, realOrUndefined),
        ]
        const plan = planWindowsAccess(
          { writeRoots: policy.writeRoots.map(real), readRoots, denyWrite: policy.denyWrite, denyRead: policy.denyRead, readOnly: policy.readOnly === true },
          grantedWrite, grantedRead, existsSync,
        )
        if (plan.grantWrite.length > 0 || plan.grantRead.length > 0) {
          b.lib.srt.grant(b.sid, plan.grantWrite, plan.grantRead)
          for (const root of plan.grantWrite) grantedWrite.set(windowsKey(root), root)
          for (const root of plan.grantRead) grantedRead.add(windowsKey(root))
        }
        registerNetwork({ manager: b.lib.manager, gate: b.gate }, policy)
        const { argv, env } = await b.lib.manager.wrapWithSandboxArgv(
          withEnvironment(script, policy.env),
          shellFor(policy.shell),
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
        grantedWrite.clear()
        grantedRead.clear()
        // Removes this process's ACEs too.
        await (await last.backend).lib?.manager.reset().catch(() => undefined)
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
