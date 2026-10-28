/**
 * The OS-level sandbox for commands (ADR 0022 decision 1): bubblewrap on
 * Linux, seatbelt on macOS, through `@anthropic-ai/sandbox-runtime`
 * (Apache-2.0, pinned). Nothing else in Nexgent knows how the platform
 * sandbox works; the shell tool asks {@link OsSandbox.wrap} for the argv to
 * run and gets `unavailable` (never an exception) where there is no sandbox.
 *
 * ## How the library's global state is handled
 *
 * `SandboxManager` is a process-wide singleton: one `initialize()` starts a
 * local filtering proxy (and on Linux two `socat` bridges) and installs one
 * config. Nexgent sessions of different projects share one process (desktop
 * app, SDK), so no per-project policy may live in that global config.
 * Instead:
 *
 * - the global config is initialised once, lazily, with the *minimum*: an
 *   empty network allow list (so every sandboxed command has no direct route
 *   out and reaches the network only through the library's proxy) and no
 *   filesystem rules;
 * - everything that depends on the project or the session is passed per
 *   call: writable roots and read / write denies as `customConfig` of
 *   `wrapWithSandbox`, and the command's host allow list registered under
 *   its random command id (`registerCommandNetworkLists`, which the proxy
 *   matches by the id the command presents). A host on no list goes to the
 *   ask callback, a {@link NetworkGate} that puts it to the command's
 *   session (`network-policy.ts`);
 * - a wrap call reads its config once, so concurrent commands of different
 *   projects cannot see each other's roots. No re-initialisation per command.
 *
 * The singleton is reference counted across {@link OsSandbox} instances:
 * `reset()` runs when the last instance is disposed. A library bug or an
 * environment that refuses user namespaces shows up in {@link OsSandbox.probe}
 * (it runs one real wrapped command) and yields `kind: 'none'` with the reason.
 */
import { spawn } from 'node:child_process'
import { accessSync, constants, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
// Type-only: this module loads without the rest of the package (a test runs it with plain Node).
import type { NetworkMode } from './network-policy.js'

/** Whether commands run in an OS sandbox on this host. */
export type OsSandboxStatus =
  | { readonly kind: 'active'; readonly platform: 'linux' | 'macos' | 'windows' }
  /** `installable`: a one-time install (Windows: an administrator prompt) would make it work, see {@link OsSandbox.install}. */
  | { readonly kind: 'none'; readonly reason: string; readonly installable?: boolean }

/** What one command is allowed. Paths are absolute. */
export interface OsSandboxPolicy {
  /** Directories the command may write (project root, session temp dir, session-approved directories). Empty = read-only. */
  readonly writeRoots: readonly string[]
  /** Paths below a write root that stay read-only (see {@link defaultWriteDenies}). */
  readonly denyWrite: readonly string[]
  /** Paths the command can neither read nor write (`<NEXGENT_HOME>`, credential directories). */
  readonly denyRead: readonly string[]
  /** Paths inside {@link denyRead} that stay readable. */
  readonly allowRead?: readonly string[]
  /** Where the command may connect: `true` = any host, `false` = none, or the full setting. */
  readonly network: boolean | OsSandboxNetwork
  /** Unique id of this invocation, used to attribute violations (a tool call id). */
  readonly commandId: string
  /** The shell the script is run with inside the sandbox (default: library default, `/bin/bash`). */
  readonly shell?: string
  /** Windows: directories the command must be able to read (the project in read-only mode); elsewhere reads are open. */
  readonly readRoots?: readonly string[]
  /** Windows: read-only / plan mode; directories this process granted for writing earlier are denied to the command. */
  readonly readOnly?: boolean
  /** Windows: the working directory the command will be started in. */
  readonly cwd?: string
  /**
   * Windows: variables the command needs. The sandboxed process starts
   * with the sandbox account's own environment, so these are set by the
   * script itself; elsewhere the caller passes them when spawning.
   */
  readonly env?: Readonly<Record<string, string>>
}

/** A command's network setting (`network-policy.ts`). */
export interface OsSandboxNetwork {
  readonly mode: NetworkMode
  /** Hosts it reaches without asking (`allowlist`). */
  readonly allowedDomains?: readonly string[]
  /** Whose question a host off the list is (the session id). */
  readonly owner?: string
  /** Ask the user about a host off the list; absent = such hosts are refused. */
  readonly ask?: (host: string, port: number | undefined) => Promise<boolean>
}

/** The result of {@link OsSandbox.wrap}. */
export type OsSandboxWrap =
  | {
    readonly kind: 'wrapped'
    readonly program: string
    readonly args: string[]
    /** Variables to add to the wrapper's own environment (Windows: the library's proxy settings for `srt-win`). */
    readonly env?: Readonly<Record<string, string>>
  }
  /** `fatal`: the sandbox works here but could not be set up for this command; it must not run unsandboxed. */
  | { readonly kind: 'unavailable'; readonly reason: string; readonly fatal?: boolean }

/** The slice of `SandboxManager` this module uses (tests inject a fake). */
export interface SandboxManagerLike {
  checkDependencies(): { errors: string[]; warnings: string[] }
  initialize(config: unknown, askCallback?: unknown, enableLogMonitor?: boolean): Promise<void>
  wrapWithSandbox(
    command: string,
    binShell?: string,
    customConfig?: unknown,
    abortSignal?: AbortSignal,
    options?: { commandId?: string; commandText?: string },
  ): Promise<string>
  annotateStderrWithSandboxFailures(command: string, stderr: string): string
  cleanupAfterCommand(): void
  registerCommandNetworkLists?(commandId: string, lists: { allowedDomains?: string[] }): void
  unregisterCommandNetworkLists?(commandId: string): void
  reset(): Promise<void>
}

/** Options of {@link createOsSandbox}. */
export interface OsSandboxOptions {
  /** Default `process.platform`. */
  readonly platform?: NodeJS.Platform
  /** Replaces the real library (tests). A manager given here is private to the instance. */
  readonly manager?: SandboxManagerLike
  /** Skip the real trial command of {@link OsSandbox.probe} (tests with a fake manager). */
  readonly skipTrial?: boolean
}

/** One sandbox per host process role; cheap to create, initialises lazily. */
export interface OsSandbox {
  /** Whether wrapping works here. Runs the dependency check and one trial command, once; never throws. */
  probe(): Promise<OsSandboxStatus>
  /** The argv that runs `script` under `policy`; `unavailable` when there is no sandbox. Never throws. */
  wrap(script: string, policy: OsSandboxPolicy, signal?: AbortSignal): Promise<OsSandboxWrap>
  /** Append the sandbox's account of blocked operations (macOS / Linux monitor) and a generic hint to `stderr`, when the command failed. */
  annotate(commandId: string, stderr: string, exitCode: number | null): string
  /** Release per-command resources (mount points bubblewrap left behind). */
  release(commandId: string): void
  /** Release this instance's share of the library; the last instance resets it. */
  dispose(): Promise<void>
  /** Where the sandbox needs a one-time install (Windows): run it; the next probe looks again. */
  install?(): Promise<OsSandboxInstallResult>
}

/** What {@link OsSandbox.install} did. */
export type OsSandboxInstallResult =
  | { readonly kind: 'installed'; readonly status: OsSandboxStatus }
  /** The user dismissed the administrator prompt. */
  | { readonly kind: 'cancelled' }
  | { readonly kind: 'failed'; readonly reason: string }

/** `.nexgent/`, `.git/hooks` and `.git/config` of a project: read-only for commands (ADR 0022 decision 1). */
export function defaultWriteDenies(projectRoot: string): string[] {
  return [join(projectRoot, '.nexgent'), join(projectRoot, '.git', 'hooks'), join(projectRoot, '.git', 'config')]
}

/** How the library's ask is answered: `true` lets the connection through. */
export type NetworkAnswer = true | { readonly allow: false; readonly reason: string }

/** One running sandboxed command, as the gate knows it. */
export interface NetworkGateEntry {
  /** Whose question it is (the session id). */
  readonly owner: string
  readonly mode: NetworkMode
  /** Ask the user about a host (absent: the command cannot ask, e.g. it runs in the background). `true` = allowed. */
  readonly ask?: (host: string, port: number | undefined) => Promise<boolean>
  /** The user allowed `host`: add it to the command's own list, so its later connections pass without asking. */
  readonly allow?: (host: string) => void
}

/** The library's view of a request it could not decide. */
export interface NetworkRequest {
  readonly host: string
  readonly port: number | undefined
}

const deny = (reason: string): NetworkAnswer => ({ allow: false, reason })

/** Answers the library's questions about hosts no list decided, for the commands that are running. */
export class NetworkGate {
  private readonly entries = new Map<string, NetworkGateEntry>()
  /** One question per session and host at a time; concurrent connections wait for the same answer. */
  private readonly asking = new Map<string, Promise<boolean>>()

  register(commandId: string, entry: NetworkGateEntry): void {
    this.entries.set(commandId, entry)
  }

  unregister(commandId: string): void {
    this.entries.delete(commandId)
  }

  /** The ask callback handed to the library. */
  readonly decide = async (request: NetworkRequest): Promise<NetworkAnswer> => {
    const running = [...this.entries.values()]
    if (running.length === 0) return deny('no sandboxed command of this app is waiting for the network')
    const kinds = new Set(running.map(entry => `${entry.mode}\u0000${entry.mode === 'allowlist' ? entry.owner : ''}`))
    if (kinds.size > 1) {
      return deny('commands of more than one session use the network at the same moment, so this host could not be put to the right one; run the command again')
    }
    const first = running[0]!
    if (first.mode === 'any') return true
    if (first.mode === 'off') return deny('commands have no network in this project (commands.network is "off")')
    const asker = running.find(entry => entry.ask !== undefined)
    if (asker === undefined) return deny(`${request.host} is not on the allow list, and a background command cannot ask; run it in the foreground once, or add the host to commands.allowedDomains`)
    const key = `${first.owner}\u0000${request.host.toLowerCase()}`
    let pending = this.asking.get(key)
    if (pending === undefined) {
      pending = asker.ask!(request.host, request.port).catch(() => false).finally(() => this.asking.delete(key))
      this.asking.set(key, pending)
    }
    if (!(await pending)) return deny(`the user did not allow ${request.host}`)
    for (const entry of this.entries.values()) if (entry.owner === first.owner) entry.allow?.(request.host)
    return true
  }
}

/** A started (or failed) manager: `failure` is the reason it cannot be used; `gate` answers its questions about hosts. */
interface Backend { readonly manager: SandboxManagerLike; readonly failure: string | undefined; readonly gate: NetworkGate }

// Shared, reference-counted library state for the real SandboxManager.
let shared: { backend: Promise<Backend>; refs: number } | undefined

/** Shortest id the library registers a per-command allow list under; Nexgent ids are 16 random bytes. */
export const MIN_COMMAND_ID_LENGTH = 22

export function reasonFrom(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

async function loadManager(): Promise<SandboxManagerLike> {
  const module = await import('@anthropic-ai/sandbox-runtime')
  return module.SandboxManager as unknown as SandboxManagerLike
}

/** The minimal global config: an empty allow list (every command goes through the proxy), no filesystem rules. */
export const GLOBAL_CONFIG = { network: { allowedDomains: [], deniedDomains: [] }, filesystem: { denyRead: [], allowRead: [], allowWrite: [], denyWrite: [] } }

/** An executable on `PATH`, or undefined. */
function onPath(name: string): string | undefined {
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (dir === '') continue
    const path = join(dir, name)
    try {
      accessSync(path, constants.X_OK)
      return path
    } catch {
      // not here
    }
  }
  return undefined
}

/**
 * Linux: the library keeps `socat` bridges running for the life of the
 * process. Killed hard, the process would leave them behind, so the bridges
 * start through `setpriv --pdeathsig KILL` and die with it. Returns the
 * wrapper's path, or undefined where `setpriv` or `socat` is missing (the
 * library's plain `socat` then). One wrapper per process: the library keeps
 * the path across `reset()`, so it lives until the process exits.
 */
let socatWrapper: { readonly path: string } | undefined | null = null
function deathLinkedSocat(): { readonly path: string } | undefined {
  if (socatWrapper !== null) return socatWrapper
  socatWrapper = makeSocatWrapper()
  return socatWrapper
}

function makeSocatWrapper(): { readonly path: string } | undefined {
  const setpriv = onPath('setpriv')
  const socat = onPath('socat')
  if (setpriv === undefined || socat === undefined) return undefined
  try {
    const dir = mkdtempSync(join(tmpdir(), 'nexgent-socat-'))
    const path = join(dir, 'socat')
    const quote = (text: string) => `'${text.replaceAll("'", `'\\''`)}'`
    writeFileSync(path, `#!/bin/sh\nexec ${quote(setpriv)} --pdeathsig KILL -- ${quote(socat)} "$@"\n`, { mode: 0o755 })
    process.once('exit', () => rmSync(dir, { recursive: true, force: true }))
    return { path }
  } catch {
    return undefined
  }
}

function existing(paths: readonly string[]): string[] {
  const out: string[] = []
  for (const path of paths) {
    try {
      if (existsSync(path)) out.push(realpathSync(path))
    } catch {
      // a path that cannot be resolved cannot be bound either
    }
  }
  return [...new Set(out)]
}

function customConfigFor(policy: OsSandboxPolicy): unknown {
  return {
    filesystem: {
      denyRead: existing(policy.denyRead),
      allowRead: existing(policy.allowRead ?? []),
      allowWrite: existing(policy.writeRoots),
      denyWrite: existing(policy.denyWrite),
    },
  }
}

/** Pure: a policy's network setting in full. */
export function networkOf(policy: Pick<OsSandboxPolicy, 'network'>): OsSandboxNetwork {
  if (policy.network === true) return { mode: 'any' }
  if (policy.network === false) return { mode: 'off' }
  return policy.network
}

/** The hint appended to the stderr of a sandboxed command that failed on a refused write or read. */
export const VIOLATION_HINT =
  'The command failed inside the OS sandbox: it may write only to the project, the session temp directory and directories ' +
  'approved for this session, and cannot read or write the Nexgent home and credential directories. If it genuinely needs more, ' +
  'rerun it with sandbox:false (the user is asked to approve).'

/** Build an OS sandbox. Cheap: nothing is loaded or started until {@link OsSandbox.probe} or {@link OsSandbox.wrap}. */
/**
 * The library hands every wrapped command `TMPDIR=/tmp/claude` (or
 * `$CLAUDE_CODE_TMPDIR`) and allows writing there, but never creates it: on a
 * fresh machine `mkdtemp(os.tmpdir())` inside a command then fails with ENOENT.
 */
function ensureSandboxTmpdir(): void {
  const dir = process.env['CLAUDE_CODE_TMPDIR'] ?? process.env['CLAUDE_TMPDIR'] ?? '/tmp/claude'
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 })
  } catch {
    // Not fatal: commands that never write temp files still run.
  }
}

/**
 * Put a command's allow list and gate entry in place, before it can open
 * a connection; a host the user allows later joins its list.
 */
export function registerNetwork(b: { readonly manager: Pick<SandboxManagerLike, 'registerCommandNetworkLists'>; readonly gate: NetworkGate }, policy: Pick<OsSandboxPolicy, 'network' | 'commandId'>): void {
  const network = networkOf(policy)
  const lists = network.mode === 'allowlist' ? [...(network.allowedDomains ?? [])] : []
  b.manager.registerCommandNetworkLists?.(policy.commandId, { allowedDomains: lists })
  b.gate.register(policy.commandId, {
    owner: network.owner ?? policy.commandId,
    mode: network.mode,
    ...(network.ask === undefined ? {} : { ask: network.ask }),
    allow: host => {
      if (lists.includes(host)) return
      lists.push(host)
      try {
        b.manager.registerCommandNetworkLists?.(policy.commandId, { allowedDomains: lists })
      } catch {
        // the gate still answers this command's next connection to the host
      }
    },
  })
}

/** Drop a command's allow list and gate entry. */
export function forget(b: { readonly manager: Pick<SandboxManagerLike, 'unregisterCommandNetworkLists'>; readonly gate: NetworkGate }, commandId: string): void {
  b.gate.unregister(commandId)
  try {
    b.manager.unregisterCommandNetworkLists?.(commandId)
  } catch {
    // best effort
  }
}

export function createOsSandbox(options: OsSandboxOptions = {}): OsSandbox {
  const platform = options.platform ?? process.platform
  const injected = options.manager
  let backend: Promise<Backend> | undefined
  let acquired = false
  let status: Promise<OsSandboxStatus> | undefined
  let disposed = false
  const sandboxedIds = new Set<string>()
  let manager: SandboxManagerLike | undefined
  let gate: NetworkGate | undefined

  const unsupported = platform !== 'linux' && platform !== 'darwin'
    ? (platform === 'win32'
        ? 'Windows has no system sandbox; commands run under the command policy only'
        : `no system sandbox for platform ${platform}`)
    : undefined

  async function start(manager: SandboxManagerLike, socat?: { readonly path: string }): Promise<Backend> {
    const gate = new NetworkGate()
    try {
      const check = manager.checkDependencies()
      if (check.errors.length > 0) return { manager, failure: check.errors.join('; '), gate }
      await manager.initialize(socat === undefined ? GLOBAL_CONFIG : { ...GLOBAL_CONFIG, socatPath: socat.path }, gate.decide, true)
      ensureSandboxTmpdir()
      return { manager, failure: undefined, gate }
    } catch (error) {
      return { manager, failure: reasonFrom(error), gate }
    }
  }

  function acquire(): Promise<Backend> {
    if (backend !== undefined) return backend
    if (injected !== undefined) {
      backend = start(injected)
    } else {
      if (shared === undefined) {
        const socat = platform === 'linux' ? deathLinkedSocat() : undefined
        shared = { backend: loadManager().then(manager => start(manager, socat)), refs: 0 }
      }
      shared.refs += 1
      acquired = true
      backend = shared.backend
    }
    return backend
  }

  async function trial(b: Backend): Promise<string | undefined> {
    if (options.skipTrial === true) return undefined
    try {
      const wrapped = await b.manager.wrapWithSandbox('true', undefined, customConfigFor({
        writeRoots: [], denyWrite: [], denyRead: [], network: false, commandId: 'nexgent-probe',
      }), undefined, { commandId: 'nexgent-probe', commandText: 'true' })
      return await new Promise<string | undefined>(resolve => {
        const child = spawn('sh', ['-c', wrapped], { stdio: ['ignore', 'ignore', 'pipe'] })
        let stderr = ''
        child.stderr.on('data', (chunk: Buffer) => { if (stderr.length < 2000) stderr += chunk.toString('utf8') })
        const timer = setTimeout(() => { child.kill('SIGKILL'); resolve('the trial command timed out') }, 15_000)
        child.once('error', error => { clearTimeout(timer); resolve(reasonFrom(error)) })
        child.once('exit', code => {
          clearTimeout(timer)
          resolve(code === 0 ? undefined : `the trial command failed (exit ${String(code)}): ${stderr.trim().split('\n')[0] ?? ''}`)
        })
      })
    } catch (error) {
      return reasonFrom(error)
    } finally {
      b.manager.cleanupAfterCommand()
    }
  }

  const probe = (): Promise<OsSandboxStatus> => {
    status ??= (async (): Promise<OsSandboxStatus> => {
      if (unsupported !== undefined) return { kind: 'none', reason: unsupported }
      try {
        const b = await acquire()
        manager = b.manager
        gate = b.gate
        const failure = b.failure ?? (await trial(b))
        return failure === undefined
          ? { kind: 'active', platform: platform === 'darwin' ? 'macos' : 'linux' }
          : { kind: 'none', reason: failure }
      } catch (error) {
        return { kind: 'none', reason: reasonFrom(error) }
      }
    })()
    return status
  }

  return {
    probe,
    async wrap(script, policy, signal) {
      if (disposed) return { kind: 'unavailable', reason: 'the sandbox was disposed' }
      const current = await probe()
      if (current.kind === 'none') return { kind: 'unavailable', reason: current.reason }
      if (policy.commandId.length < MIN_COMMAND_ID_LENGTH) return { kind: 'unavailable', reason: 'the command id is too short to bind a network allow list' }
      const b = await acquire()
      try {
        registerNetwork(b, policy)
        const wrapped = await b.manager.wrapWithSandbox(
          script, policy.shell, customConfigFor(policy), signal, { commandId: policy.commandId, commandText: script },
        )
        sandboxedIds.add(policy.commandId)
        return { kind: 'wrapped', program: 'sh', args: ['-c', wrapped] }
      } catch (error) {
        forget(b, policy.commandId)
        return { kind: 'unavailable', reason: reasonFrom(error) }
      }
    },
    annotate(commandId, stderr, exitCode) {
      if (!sandboxedIds.has(commandId) || manager === undefined) return stderr
      let annotated = stderr
      try {
        annotated = manager.annotateStderrWithSandboxFailures(commandId, stderr)
      } catch {
        // keep the plain stderr
      }
      if (annotated === stderr && exitCode !== null && exitCode !== 0
        && /Read-only file system|Operation not permitted|Permission denied/.test(stderr)) {
        annotated = `${stderr.replace(/\n$/, '')}\n<sandbox_violations>\n${VIOLATION_HINT}\n</sandbox_violations>`
      }
      return annotated
    },
    release(commandId) {
      sandboxedIds.delete(commandId)
      if (manager !== undefined && gate !== undefined) forget({ manager, gate }, commandId)
      try {
        manager?.cleanupAfterCommand()
      } catch {
        // best effort
      }
    },
    async dispose() {
      if (disposed) return
      disposed = true
      if (backend === undefined) return
      if (injected !== undefined) {
        await injected.reset().catch(() => undefined)
      } else if (acquired && shared !== undefined) {
        shared.refs -= 1
        if (shared.refs <= 0) {
          const last = shared
          shared = undefined
          const { manager: real } = await last.backend
          await real.reset().catch(() => undefined)
        }
      }
    },
  }
}
