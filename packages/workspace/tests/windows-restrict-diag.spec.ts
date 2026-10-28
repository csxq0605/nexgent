/**
 * TEMPORARY diagnostics on a Windows runner: which token change makes Schannel
 * fail (SEC_E_NO_CREDENTIALS) for HTTPS from the launcher. Runs as the runner's
 * own user, outside srt-win. Prints, asserts nothing.
 */
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import * as nodePath from 'node:path'
import { describe, it } from 'vitest'
import { buildRestrictLauncher, RESTRICT_SOURCE } from '../src/index.js'

const enabled = process.platform === 'win32' && process.env.NEXGENT_WINDOWS_SANDBOX_TEST === '1'

function run(exe: string, args: string[]): Promise<string> {
  return new Promise(resolve => {
    const child = spawn(exe, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    let out = ''
    child.stdout.on('data', (c: Buffer) => { out += c.toString() })
    child.stderr.on('data', (c: Buffer) => { out += `[err]${c.toString()}` })
    const timer = setTimeout(() => { child.kill(); resolve(`TIMEOUT ${out}`) }, 40_000)
    child.on('exit', code => { clearTimeout(timer); resolve(`exit ${String(code)} ${out}`) })
    child.on('error', error => { clearTimeout(timer); resolve(`spawn error ${error.message}`) })
  })
}

describe.runIf(enabled)('launcher Schannel diagnostics', () => {
  it('prints which tokens can open HTTPS', async () => {
    const curl = nodePath.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'curl.exe')
    const target = ['-sS', '-o', 'NUL', '-w', '%{http_code}', 'https://registry.npmjs.org/']
    console.log('DIAG plain', JSON.stringify(await run(curl, target)))
    const variants: Array<[string, string, string]> = [
      ['current', RESTRICT_SOURCE, 'USER'],
      ['write-restricted only', RESTRICT_SOURCE.replace('CreateRestrictedToken(token, 0x1 | 0x8', 'CreateRestrictedToken(token, 0x8'), 'USER'],
      ['privileges only', RESTRICT_SOURCE.replace('CreateRestrictedToken(token, 0x1 | 0x8, 0, IntPtr.Zero, 0, IntPtr.Zero, (uint)restrict.Length, restrict,', 'CreateRestrictedToken(token, 0x1, 0, IntPtr.Zero, 0, IntPtr.Zero, 0, null,'), 'USER'],
      ['plus Authenticated Users', RESTRICT_SOURCE, 'USER,S-1-5-11'],
      ['plus SYSTEM, Users, Admins', RESTRICT_SOURCE, 'USER,S-1-5-18,S-1-5-32-545,S-1-5-32-544'],
      ['no default DACL change', RESTRICT_SOURCE.replace('int allowed = AllowRestrictedByDefault(restricted, restrictedSid);', 'int allowed = 0;'), 'USER'],
    ]
    for (const [name, source, sids] of variants) {
      try {
        const tools = await buildRestrictLauncher(nodePath.join(tmpdir(), 'nxdiag'), source)
        console.log('DIAG', name, JSON.stringify(await run(tools.launcher, [sids, curl, ...target])))
      } catch (error) {
        console.log('DIAG', name, 'build failed', String(error))
      }
    }
  }, 600_000)
})
