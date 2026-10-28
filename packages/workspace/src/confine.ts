/**
 * The OS sandbox for programs other than the shell tools (`permissions.md`
 * §代码执行进程): `run_code`, function modules and workflow scripts run
 * their Node process inside the same system sandbox as `bash` / `pwsh`,
 * under the session's network setting, with only the session temp
 * directory writable (their file access goes through host functions,
 * which run in the host).
 *
 * The workspace services register what they built for a sandbox here, so a
 * package that only holds `ctx.sandbox` can confine a process the same way.
 */
import { randomBytes } from 'node:crypto'
import { NexgentError, type ToolContext } from '@nexgent/kernel'
import { currentPowerShell } from './shell-check.js'
import { commandNetwork, type ShellSandboxDeps } from './tools/shell.js'
import { ensureSessionTempDir } from './workspace.js'

/** How to start a confined program, and what to call once it has ended. */
export type Confinement =
  | { readonly kind: 'wrapped'; readonly program: string; readonly args: readonly string[]; readonly env?: Readonly<Record<string, string>>; release(): void }
  | { readonly kind: 'plain'; release(): void }

/** The program to confine; `temp` is the session temp directory (writable inside the sandbox). */
export type ConfinedCommand = (temp: string) => Promise<{
  readonly program: string
  readonly args: readonly string[]
  /** Variables the program needs (Windows: set inside the sandbox, whose process starts with its own environment). */
  readonly env?: Readonly<Record<string, string>>
}>

interface Registered {
  readonly os: ShellSandboxDeps
  readonly tempBase?: string
}

const registry = new WeakMap<object, Registered>()

/** Called by the workspace services for the sandbox they provide. */
export function registerConfinement(sandbox: object, os: ShellSandboxDeps, tempBase?: string): void {
  registry.set(sandbox, { os, ...(tempBase === undefined ? {} : { tempBase }) })
}

/** Pure: one POSIX shell word. */
export function shellQuote(word: string): string {
  return `'${word.replaceAll("'", `'\\''`)}'`
}

/** Pure: one PowerShell literal string. */
export function powerShellQuote(word: string): string {
  return `'${word.replaceAll("'", "''")}'`
}

/** Pure: the script that runs `program args` and exits with its code, in the shell of `platform`. */
export function programScript(program: string, args: readonly string[], platform: NodeJS.Platform): string {
  if (platform === 'win32') return `& ${[program, ...args].map(powerShellQuote).join(' ')}\nexit $LASTEXITCODE`
  return ['exec', program, ...args].map((word, index) => (index === 0 ? word : shellQuote(word))).join(' ')
}

const plain: Confinement = { kind: 'plain', release: () => undefined }

/**
 * Wrap the program `build` gives for the calling session. `plain` where
 * commands run unsandboxed (`full-access`, `systemSandbox: 'off'`, no
 * system sandbox on this host); `systemSandbox: 'required'` without a
 * working sandbox, or a sandbox that could not be set up for this program,
 * throws `sandbox/denied`, as for `bash`. `label` names the program in a
 * question about a network host.
 */
export async function confineProgram(sandbox: object, context: ToolContext, label: string, build: ConfinedCommand, platform: NodeJS.Platform = process.platform): Promise<Confinement> {
  const registered = registry.get(sandbox)
  if (registered === undefined) return plain
  const inputs = registered.os.inputs(context)
  if (!inputs.enabled) return plain
  const temp = await ensureSessionTempDir(context.sessionId, registered.tempBase)
  const command = await build(temp)
  const commandId = randomBytes(16).toString('base64url')
  const wrapped = await registered.os.sandbox.wrap(programScript(command.program, command.args, platform), {
    writeRoots: [temp],
    denyWrite: [],
    denyRead: inputs.denyRead,
    ...(inputs.allowRead === undefined ? {} : { allowRead: inputs.allowRead }),
    network: commandNetwork(inputs.network, context, label, false),
    commandId,
    readRoots: [inputs.projectRoot],
    readOnly: true,
    cwd: context.workspace.root,
    ...(command.env === undefined ? {} : { env: command.env }),
    // The PowerShell commands use (Windows PowerShell 5.1 when PowerShell 7 is missing).
    ...(platform === 'win32' ? { shell: currentPowerShell().program } : {}),
  }, context.signal)
  if (wrapped.kind === 'wrapped') {
    return { kind: 'wrapped', program: wrapped.program, args: wrapped.args, ...(wrapped.env === undefined ? {} : { env: wrapped.env }), release: () => registered.os.sandbox.release(commandId) }
  }
  if (inputs.required === true || wrapped.fatal === true) {
    throw new NexgentError('sandbox/denied', `SANDBOX_DENIED: no system sandbox for ${label} (${wrapped.reason})`, {
      details: { mode: context.sandboxMode, command: label, code: 'SYSTEM_SANDBOX_REQUIRED' },
    })
  }
  return plain
}
