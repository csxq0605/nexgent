/**
 * TEMPORARY diagnostics on a Windows runner: how Windows PowerShell 5.1 answers
 * a proxy's 407 to CONNECT. Runs outside the sandbox against a local mock proxy.
 * Prints, asserts nothing.
 */
import { spawn } from 'node:child_process'
import { createServer, type Socket } from 'node:net'
import type { AddressInfo } from 'node:net'
import * as nodePath from 'node:path'
import { describe, it } from 'vitest'
import { WINDOWS_POWERSHELL_PROXY } from '../src/index.js'

const enabled = process.platform === 'win32' && process.env.NEXGENT_WINDOWS_SANDBOX_TEST === '1'

type Variant = 'srt' | 'cl0' | 'close' | 'srt+warm'

function mock(variant: Variant, log: string[]): Promise<{ port: number; close: () => void }> {
  const server = createServer((socket: Socket) => {
    let buffer = ''
    socket.on('error', () => {})
    socket.on('data', chunk => {
      buffer += chunk.toString('latin1')
      for (;;) {
        const end = buffer.indexOf('\r\n\r\n')
        if (end < 0) return
        const head = buffer.slice(0, end)
        buffer = buffer.slice(end + 4)
        const [line] = head.split('\r\n')
        const auth = /\r\nproxy-authorization:/i.test(head)
        log.push(`${line} auth=${auth}`)
        const method = line!.split(' ')[0]
        if (method === 'CONNECT' && !auth) {
          if (variant === 'srt' || variant === 'srt+warm') socket.end('HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="srt"\r\n\r\n')
          else if (variant === 'cl0') socket.end('HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="srt"\r\nContent-Length: 0\r\n\r\n')
          else socket.end('HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="srt"\r\nContent-Length: 0\r\nConnection: close\r\n\r\n')
          return
        }
        if (!auth) {
          socket.write('HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="srt"\r\nContent-Length: 0\r\n\r\n')
          continue
        }
        socket.end('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n')
        return
      }
    })
  })
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({ port: (server.address() as AddressInfo).port, close: () => server.close() })))
}

describe.runIf(enabled)('5.1 proxy diagnostics', () => {
  it('prints how 5.1 answers a 407', async () => {
    const ps = nodePath.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    for (const variant of ['srt', 'cl0', 'close', 'srt+warm'] as Variant[]) {
      const log: string[] = []
      const { port, close } = await mock(variant, log)
      const warm = variant === 'srt+warm' ? 'try { $null = Invoke-WebRequest -UseBasicParsing -Uri http://warm.invalid/ -TimeoutSec 5 } catch { "warm: " + $_.Exception.Message }' : ''
      const script = [
        WINDOWS_POWERSHELL_PROXY,
        warm,
        'try { (Invoke-WebRequest -UseBasicParsing -Uri https://example.com/ -TimeoutSec 10).StatusCode } catch { "ERR " + $_.Exception.Message + " | " + $_.Exception.InnerException }',
      ].join('\n')
      const out = await new Promise<string>(resolve => {
        const child = spawn(ps, ['-NoProfile', '-NonInteractive', '-Command', script], {
          env: { ...process.env, HTTPS_PROXY: `http://cmd%2Fid:tok@127.0.0.1:${port}` },
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true,
        })
        let text = ''
        child.stdout.on('data', (c: Buffer) => { text += c.toString() })
        child.stderr.on('data', (c: Buffer) => { text += `[err]${c.toString()}` })
        const timer = setTimeout(() => { child.kill(); resolve(`TIMEOUT ${text}`) }, 40_000)
        child.on('exit', () => { clearTimeout(timer); resolve(text) })
      })
      close()
      console.log('DIAG', variant, JSON.stringify(out.slice(0, 800)), JSON.stringify(log))
    }
  }, 240_000)
})
