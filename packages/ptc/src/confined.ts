/**
 * A program process inside the OS sandbox of the calling session
 * (`permissions.md` §代码执行进程): the same system sandbox and network
 * setting as `bash`, only the session temp directory writable (on Windows
 * a restricted token, without network filtering). Where commands run
 * unsandboxed, the program runs as before.
 */
import type { ToolContext } from '@nexgent/kernel'
import { confineProgram } from '@nexgent/workspace'
import { programCommand, runProgram, type ProgramResult, type RunProgramOptions } from './runtime.js'

/** {@link runProgram} for a tool call: confined by the session's sandbox; `label` names it in a question about a network host. */
export async function runConfinedProgram(sandbox: object, context: ToolContext, label: string, options: RunProgramOptions): Promise<ProgramResult> {
  if (options.launch !== undefined || options.capabilities !== undefined) return runProgram(options)
  const { node, args } = programCommand(options)
  // Node's proxy support (used for the sandbox's proxy) warns that it is experimental on every start.
  const confined = await confineProgram(sandbox, context, label, node, ['--disable-warning=UNDICI-EHPA', ...args])
  try {
    return await runProgram(
      confined.kind === 'wrapped' ? { ...options, launch: { program: confined.program, args: confined.args } }
        : confined.kind === 'restricted' ? { ...options, capabilities: confined.capabilities }
          : options,
    )
  } finally {
    confined.release()
  }
}
