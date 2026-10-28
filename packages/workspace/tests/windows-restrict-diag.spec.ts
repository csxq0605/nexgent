/**
 * Diagnostics for the write-restricted launcher on a Windows runner: which
 * restricting SID sets let a shell start. Prints, asserts nothing.
 */
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { tmpdir } from 'node:os'
import * as nodePath from 'node:path'
import { SandboxManager, VENDORED_SRT_WIN_EXE } from '@anthropic-ai/sandbox-runtime'
import { describe, it } from 'vitest'
import { buildRestrictLauncher, createWindowsSandbox } from '../src/index.js'

const enabled = process.platform === 'win32' && process.env.NEXGENT_WINDOWS_SANDBOX_TEST === '1'

describe.runIf(enabled)('launcher diagnostics', () => {
  it('prints what starts', async () => {
    const sandbox = createWindowsSandbox()
    console.log('probe', JSON.stringify(await sandbox.probe()), VENDORED_SRT_WIN_EXE)
    const tools = await buildRestrictLauncher()
    const sys = process.env.SystemRoot ?? 'C:\\Windows'
    const cmd = nodePath.join(sys, 'System32', 'cmd.exe')
    const ps = nodePath.join(sys, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    const cases: Array<[string, string, string[], string]> = [
      ['cmd USER', 'USER', [cmd, '/d', '/c'], 'echo hi'],
      ['cmd RESTRICTED', 'S-1-5-12', [cmd, '/d', '/c'], 'echo hi'],
      ['node RESTRICTED', 'S-1-5-12', [process.execPath, '-e'], 'console.log("hi")'],
      ['ps RESTRICTED', 'S-1-5-12', [ps, '-NoProfile', '-NonInteractive', '-Command'], 'echo hi'],
    ]
    for (const [name, sids, shell, command] of cases) {
      const id = randomBytes(16).toString('base64url')
      const { argv, env } = await (SandboxManager as unknown as { wrapWithSandboxArgv: (...a: unknown[]) => Promise<{ argv: string[]; env: NodeJS.ProcessEnv }> })
        .wrapWithSandboxArgv(command, { exe: tools.launcher, args: [sids, ...shell] }, { filesystem: {} }, undefined, tmpdir(), { commandId: id, commandText: command })
      const result = await new Promise<string>(resolve => {
        const child = spawn(argv[0]!, argv.slice(1), { cwd: tmpdir(), env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
        let out = ''
        child.stdout.on('data', (c: Buffer) => { out += c.toString() })
        child.stderr.on('data', (c: Buffer) => { out += `[err]${c.toString()}` })
        const timer = setTimeout(() => { child.kill(); resolve(`TIMEOUT ${out}`) }, 20_000)
        child.on('exit', code => { clearTimeout(timer); resolve(`exit ${String(code)} ${out}`) })
      })
      console.log('DIAG', name, JSON.stringify(result.slice(0, 600)))
    }
    await sandbox.dispose()
  }, 180_000)
})
