/**
 * A program process inside the OS sandbox of the calling session
 * (`permissions.md` §代码执行进程): the same system sandbox and network
 * setting as `bash` / `pwsh`, only the session temp directory writable.
 * Where commands run unsandboxed, the program runs as before.
 */
import { createHash } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ToolContext } from '@nexgent/kernel'
import { confineProgram } from '@nexgent/workspace'
import { BOOTSTRAP_SOURCE } from './bootstrap.js'
import { programCommand, programEnv, runProgram, type ProgramResult, type RunProgramOptions } from './runtime.js'

/** {@link runProgram} for a tool call: confined by the session's sandbox; `label` names it in a question about a network host. */
export async function runConfinedProgram(sandbox: object, context: ToolContext, label: string, options: RunProgramOptions): Promise<ProgramResult> {
  if (options.launch !== undefined) return runProgram(options)
  const windows = process.platform === 'win32'
  const confined = await confineProgram(sandbox, context, label, async temp => {
    // Windows: the bootstrap comes from a file in the session temp directory (readable inside the sandbox),
    // not from a long `--eval` argument that would go through PowerShell's command line.
    const entryFile = windows ? join(temp, `nexgent-ptc-${createHash('sha256').update(BOOTSTRAP_SOURCE).digest('hex').slice(0, 12)}.mjs`) : undefined
    if (entryFile !== undefined) await writeFile(entryFile, BOOTSTRAP_SOURCE)
    const { node, args } = programCommand({ ...options, ...(entryFile === undefined ? {} : { entryFile }) })
    // Node's proxy support (used for the sandbox's proxy) warns that it is experimental on every start.
    return { program: node, args: ['--disable-warning=UNDICI-EHPA', ...args], env: { ...programEnv(), NODE_USE_ENV_PROXY: '1' } }
  })
  try {
    return await runProgram(confined.kind === 'wrapped' ? { ...options, launch: { program: confined.program, args: confined.args, ...(confined.env === undefined ? {} : { env: confined.env }) } } : options)
  } finally {
    confined.release()
  }
}
