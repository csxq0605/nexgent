/**
 * The OS sandbox for programs other than the shell tools (`permissions.md`
 * §代码执行进程): `run_code` and function modules run their Node process
 * inside the same system sandbox as `bash`, under the session's network
 * setting, with only the session temp directory writable (their file
 * access goes through host functions, which run in the host).
 *
 * The workspace services register what they built for a sandbox here, so a
 * package that only holds `ctx.sandbox` can confine a process the same way.
 */
import { randomBytes } from 'node:crypto'
import { NexgentError, type ToolContext } from '@nexgent/kernel'
import { commandNetwork, type ShellSandboxDeps } from './tools/shell.js'
import { ensureSessionTempDir } from './workspace.js'

/** How to start a confined program, and what to call once it has ended. */
export type Confinement =
  | { readonly kind: 'wrapped'; readonly program: string; readonly args: readonly string[]; release(): void }
  /** Windows: start the program itself, with a restricted token carrying these capability SIDs. */
  | { readonly kind: 'restricted'; readonly capabilities: readonly string[]; release(): void }
  | { readonly kind: 'plain'; release(): void }

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

const plain: Confinement = { kind: 'plain', release: () => undefined }

/**
 * Wrap `program args` for the calling session. `plain` where commands run
 * unsandboxed (`full-access`, `systemSandbox: 'off'`, no system sandbox on
 * this host); `systemSandbox: 'required'` without a working sandbox throws
 * `sandbox/denied`, as for `bash`. `label` names the program in a question
 * about a network host.
 */
export async function confineProgram(sandbox: object, context: ToolContext, label: string, program: string, args: readonly string[]): Promise<Confinement> {
  const registered = registry.get(sandbox)
  if (registered === undefined) return plain
  const inputs = registered.os.inputs(context)
  if (!inputs.enabled) return plain
  const temp = await ensureSessionTempDir(context.sessionId, registered.tempBase)
  const commandId = randomBytes(16).toString('base64url')
  const wrapped = await registered.os.sandbox.wrap(['exec', program, ...args].map((word, index) => (index === 0 ? word : shellQuote(word))).join(' '), {
    writeRoots: [temp],
    denyWrite: [],
    denyRead: inputs.denyRead,
    ...(inputs.allowRead === undefined ? {} : { allowRead: inputs.allowRead }),
    network: commandNetwork(inputs.network, context, label, false),
    commandId,
  }, context.signal)
  if (wrapped.kind === 'wrapped') {
    const release = () => registered.os.sandbox.release(commandId)
    return wrapped.capabilities === undefined
      ? { kind: 'wrapped', program: wrapped.program, args: wrapped.args, release }
      : { kind: 'restricted', capabilities: wrapped.capabilities, release }
  }
  if (inputs.required === true || wrapped.fatal === true) {
    throw new NexgentError('sandbox/denied', `SANDBOX_DENIED: commands.systemSandbox is "required" but no system sandbox is available (${wrapped.reason})`, {
      details: { mode: context.sandboxMode, command: label, code: 'SYSTEM_SANDBOX_REQUIRED' },
    })
  }
  return plain
}
