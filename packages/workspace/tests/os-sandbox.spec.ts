import { spawn, spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import * as nodePath from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createOsSandbox, defaultWriteDenies, type OsSandbox, type OsSandboxPolicy, type SandboxManagerLike } from '../src/os-sandbox.js'
import { tempDir } from './helpers.js'

async function run(sandbox: OsSandbox, script: string, policy: OsSandboxPolicy, cwd: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const wrapped = await sandbox.wrap(script, policy)
  if (wrapped.kind !== 'wrapped') throw new Error(`not wrapped: ${wrapped.reason}`)
  return await new Promise(resolve => {
    const child = spawn(wrapped.program, wrapped.args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (c: Buffer) => { stdout += c.toString() })
    child.stderr.on('data', (c: Buffer) => { stderr += c.toString() })
    const timer = setTimeout(() => child.kill('SIGKILL'), 20_000)
    child.on('exit', code => { clearTimeout(timer); resolve({ code, stdout, stderr }) })
  })
}

const newId = (): string => randomBytes(16).toString('base64url')

const hasBwrap = process.platform === 'linux' && spawnSync('bwrap', ['--version']).status === 0 && spawnSync('socat', ['-V']).status === 0

describe('status none fallback', () => {
  it('reports Windows as having no system sandbox without loading the library', async () => {
    const sandbox = createOsSandbox({ platform: 'win32' })
    const status = await sandbox.probe()
    expect(status).toMatchObject({ kind: 'none' })
    expect((status as { reason: string }).reason).toContain('Windows')
    expect(await sandbox.wrap('echo hi', { writeRoots: [], denyWrite: [], denyRead: [], network: true, commandId: 'a' })).toMatchObject({ kind: 'unavailable' })
    await sandbox.dispose()
  })

  it('reports a missing dependency with its reason and never throws', async () => {
    const manager = fakeManager({ errors: ['bubblewrap (bwrap) not installed'] })
    const sandbox = createOsSandbox({ platform: 'linux', manager, skipTrial: true })
    expect(await sandbox.probe()).toEqual({ kind: 'none', reason: 'bubblewrap (bwrap) not installed' })
    const wrapped = await sandbox.wrap('ls', { writeRoots: [], denyWrite: [], denyRead: [], network: true, commandId: 'b' })
    expect(wrapped).toEqual({ kind: 'unavailable', reason: 'bubblewrap (bwrap) not installed' })
    expect(manager.calls.initialize).toBe(0)
    await sandbox.dispose()
  })

  it('reports an initialisation failure as none', async () => {
    const manager = fakeManager({ initializeError: new Error('user namespaces are not permitted') })
    const sandbox = createOsSandbox({ platform: 'linux', manager, skipTrial: true })
    expect(await sandbox.probe()).toEqual({ kind: 'none', reason: 'user namespaces are not permitted' })
    await sandbox.dispose()
  })

  it('initialises once and passes the policy per call', async () => {
    const root = await tempDir()
    const other = await tempDir()
    const manager = fakeManager({})
    const sandbox = createOsSandbox({ platform: 'linux', manager, skipTrial: true })
    const [first, second] = [newId(), newId()]
    await sandbox.wrap('a', { writeRoots: [root], denyWrite: [], denyRead: [], network: { mode: 'allowlist', allowedDomains: ['pypi.org'] }, commandId: first })
    await sandbox.wrap('b', { writeRoots: [other], denyWrite: [], denyRead: [], network: false, commandId: second })
    expect(manager.calls.initialize).toBe(1)
    // Every command goes through the proxy: the global allow list is empty, each command's own list is registered under its id.
    expect(manager.initialized).toMatchObject({ network: { allowedDomains: [] } })
    expect(manager.wraps[0]!.custom).toMatchObject({ filesystem: { allowWrite: [root] } })
    expect(manager.wraps[1]!.custom).toMatchObject({ filesystem: { allowWrite: [other] } })
    expect(manager.lists.get(first)).toEqual(['pypi.org'])
    expect(manager.lists.get(second)).toEqual([])
    sandbox.release(first)
    expect(manager.lists.has(first)).toBe(false)
    await sandbox.dispose()
    expect(manager.calls.reset).toBe(1)
  })

  it('puts a host off the list to the session of the running command, and remembers the answer for that command', async () => {
    const manager = fakeManager({})
    const sandbox = createOsSandbox({ platform: 'linux', manager, skipTrial: true })
    const asked: string[] = []
    const id = newId()
    await sandbox.wrap('pip install x', {
      writeRoots: [], denyWrite: [], denyRead: [], commandId: id,
      network: { mode: 'allowlist', allowedDomains: [], owner: 's1', ask: async host => { asked.push(host); return host === 'mirror.example.com' } },
    })
    expect(await manager.ask!({ host: 'mirror.example.com', port: 443 })).toBe(true)
    expect(manager.lists.get(id)).toEqual(['mirror.example.com'])
    expect(await manager.ask!({ host: 'evil.example.net', port: 443 })).toMatchObject({ allow: false })
    expect(asked).toEqual(['mirror.example.com', 'evil.example.net'])
    sandbox.release(id)
    // With no command running, nothing is asked.
    expect(await manager.ask!({ host: 'mirror.example.com', port: 443 })).toMatchObject({ allow: false })
    await sandbox.dispose()
  })

  it('lists the default write protections of a project', () => {
    expect(defaultWriteDenies('/p')).toEqual([nodePath.join('/p', '.nexgent'), nodePath.join('/p', '.git', 'hooks'), nodePath.join('/p', '.git', 'config')])
  })
})

type Ask = (request: { host: string; port: number | undefined }) => Promise<unknown>

function fakeManager(options: { errors?: string[]; initializeError?: Error }): SandboxManagerLike & {
  calls: { initialize: number; reset: number }
  wraps: { command: string; custom: unknown }[]
  lists: Map<string, string[]>
  initialized?: unknown
  ask?: Ask
} {
  const calls = { initialize: 0, reset: 0 }
  const wraps: { command: string; custom: unknown }[] = []
  const lists = new Map<string, string[]>()
  const fake: ReturnType<typeof fakeManager> = {
    calls,
    wraps,
    lists,
    checkDependencies: () => ({ errors: options.errors ?? [], warnings: [] }),
    initialize: async (config, ask) => {
      calls.initialize += 1
      fake.initialized = config
      fake.ask = ask as Ask
      if (options.initializeError !== undefined) throw options.initializeError
    },
    registerCommandNetworkLists: (id, given) => { lists.set(id, [...(given.allowedDomains ?? [])]) },
    unregisterCommandNetworkLists: id => { lists.delete(id) },
    wrapWithSandbox: async (command, _shell, custom) => {
      wraps.push({ command, custom })
      return command
    },
    annotateStderrWithSandboxFailures: (_c, stderr) => stderr,
    cleanupAfterCommand: () => undefined,
    reset: async () => { calls.reset += 1 },
  }
  return fake
}

describe.skipIf(!hasBwrap)('bubblewrap sandbox (real)', () => {
  let sandbox: OsSandbox
  let root: string
  let project: string
  let home: string
  let nexgentHome: string
  let outside: string
  let temp: string
  let policy: OsSandboxPolicy

  beforeAll(async () => {
    sandbox = createOsSandbox()
    root = await realpath(await mkdtemp(nodePath.join(tmpdir(), 'nxos-')))
    project = nodePath.join(root, 'proj')
    home = nodePath.join(root, 'home')
    nexgentHome = nodePath.join(root, 'nexgent-home')
    outside = nodePath.join(root, 'outside')
    temp = nodePath.join(root, 'tmp')
    await Promise.all([
      mkdir(nodePath.join(project, '.nexgent'), { recursive: true }),
      mkdir(nodePath.join(project, '.git', 'hooks'), { recursive: true }),
      mkdir(nodePath.join(home, '.ssh'), { recursive: true }),
      mkdir(nexgentHome, { recursive: true }),
      mkdir(outside, { recursive: true }),
      mkdir(temp, { recursive: true }),
    ])
    await writeFile(nodePath.join(home, '.ssh', 'id_rsa'), 'PRIVATE-KEY-MATERIAL')
    await writeFile(nodePath.join(nexgentHome, 'credentials.json'), '{"key":"secret"}')
    await writeFile(nodePath.join(project, '.nexgent', 'config.json'), '{}')
    await writeFile(nodePath.join(project, '.git', 'config'), '[core]\n')
    policy = {
      writeRoots: [project, temp],
      denyWrite: defaultWriteDenies(project),
      denyRead: [nodePath.join(home, '.ssh'), nexgentHome],
      network: true,
      commandId: newId(),
    }
  }, 60_000)

  afterAll(async () => {
    await sandbox.dispose()
    await rm(root, { recursive: true, force: true })
  })

  const id = newId
  const go = (script: string, extra: Partial<OsSandboxPolicy> = {}) => {
    const commandId = id()
    return run(sandbox, script, { ...policy, ...extra, commandId }, project).finally(() => sandbox.release(commandId))
  }

  it('is active here', async () => {
    expect(await sandbox.probe()).toEqual({ kind: 'active', platform: 'linux' })
  })

  it('allows reading and writing inside the project and the session temp dir', async () => {
    const result = await go(`echo hello > made.txt && cat made.txt && echo t > ${temp}/t.txt && cat ${temp}/t.txt`)
    expect(result).toMatchObject({ code: 0, stdout: 'hello\nt\n' })
    expect(await readFile(nodePath.join(project, 'made.txt'), 'utf8')).toBe('hello\n')
  })

  it('blocks reading a credential file', async () => {
    const result = await go(`cat ${home}/.ssh/id_rsa`)
    expect(result.code).not.toBe(0)
    expect(result.stdout).not.toContain('PRIVATE-KEY-MATERIAL')
  })

  it('blocks deleting or reading the Nexgent home', async () => {
    const rm = await go(`rm -rf ${nexgentHome}; ls ${nexgentHome} | wc -l`)
    expect(rm.stdout.trim().split('\n').pop()).toBe('0')
    const cat = await go(`cat ${nexgentHome}/credentials.json`)
    expect(cat.code).not.toBe(0)
    expect(await readFile(nodePath.join(nexgentHome, 'credentials.json'), 'utf8')).toBe('{"key":"secret"}')
  })

  it('blocks writes outside the project, even through sh -c', async () => {
    const result = await go(`sh -c 'echo x > ${outside}/file'`)
    expect(result.code).not.toBe(0)
    expect(result.stderr).toMatch(/Read-only file system|not permitted|Permission denied/i)
    await expect(readFile(nodePath.join(outside, 'file'), 'utf8')).rejects.toThrow()
  })

  it('keeps .nexgent/, .git/hooks and .git/config read-only inside the project', async () => {
    const result = await go(
      `echo x > .nexgent/new.json; echo "e1=$?"; echo x >> .nexgent/config.json; echo "e2=$?"; echo x > .git/hooks/pre-commit; echo "e3=$?"; echo x >> .git/config; echo "e4=$?"; rm -f .nexgent/config.json; echo "e5=$?"`,
    )
    for (const n of [1, 2, 3, 4, 5]) expect(result.stdout).not.toContain(`e${n}=0`)
    expect(await readFile(nodePath.join(project, '.nexgent', 'config.json'), 'utf8')).toBe('{}')
    expect(await readFile(nodePath.join(project, '.git', 'config'), 'utf8')).toBe('[core]\n')
  })

  it('annotates a blocked write for the model', async () => {
    const commandId = id()
    const result = await run(sandbox, `echo x > ${outside}/f`, { ...policy, commandId }, project)
    const annotated = sandbox.annotate(commandId, result.stderr, result.code)
    sandbox.release(commandId)
    expect(annotated).toContain('sandbox_violations')
    expect(annotated).toContain(`${outside}/f`)
  })

  it('read-only policy: only the session temp dir is writable', async () => {
    const result = await go(`echo a > ro.txt; echo "p=$?"; echo b > ${temp}/ok.txt; echo "t=$?"`, { writeRoots: [temp], denyWrite: [] })
    expect(result.stdout).toContain('t=0')
    expect(result.stdout).not.toContain('p=0')
  })

  it('has no direct route out in any network mode', async () => {
    const off = await go(`timeout 5 bash -c 'exec 3<>/dev/tcp/1.1.1.1/80' 2>&1; echo "rc=$?"`, { network: false })
    expect(off.stdout).not.toContain('rc=0')
    expect(off.stdout).toMatch(/unreachable|rc=[1-9]/)
    const nets = (script: string, network: boolean) => go(script, { network }).then(r => r.stdout.trim())
    const list = "awk 'NR>2{print $1}' /proc/net/dev"
    expect(await nets(list, true)).toBe('lo:')
    expect(await nets(list, false)).toBe('lo:')
  })

  describe('hosts through the proxy', () => {
    let server: Server
    let port = 0
    beforeAll(async () => {
      server = createServer((_req, res) => res.end('reached'))
      await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
      port = (server.address() as AddressInfo).port
    })
    afterAll(() => new Promise<void>(resolve => server.close(() => resolve())))
    // --noproxy '' sends even a loopback address through the proxy, as any outside host goes.
    const fetchIt = () => `curl -s --max-time 10 --noproxy '' http://127.0.0.1:${port}/; echo " rc=$?"`

    it('reaches a host on the command\'s allow list without asking', async () => {
      const asked: string[] = []
      const result = await go(fetchIt(), { network: { mode: 'allowlist', allowedDomains: [`127.0.0.1:${port}`], owner: 's', ask: async host => { asked.push(host); return false } } })
      expect(result.stdout).toContain('reached')
      expect(asked).toEqual([])
    })

    it('asks about a host off the list once per command, and refuses it when the user says no', async () => {
      const asked: string[] = []
      const yes = await go(`${fetchIt()}; ${fetchIt()}`, { network: { mode: 'allowlist', allowedDomains: [], owner: 's', ask: async host => { asked.push(host); return true } } })
      expect(yes.stdout.match(/reached/g)).toHaveLength(2)
      expect(asked).toEqual(['127.0.0.1'])
      const no = await go(fetchIt(), { network: { mode: 'allowlist', allowedDomains: [], owner: 's', ask: async () => false } })
      expect(no.stdout).not.toContain('reached')
    })

    it('refuses every host when the network is off, and lets every host through for any', async () => {
      const off = await go(fetchIt(), { network: { mode: 'off', ask: async () => true } })
      expect(off.stdout).not.toContain('reached')
      const any = await go(fetchIt(), { network: true })
      expect(any.stdout).toContain('reached')
    })
  })

  it('node fetch fails without network', async () => {
    const result = await go(
      `node -e "fetch('http://1.1.1.1/').then(()=>process.exit(0),()=>process.exit(3))"`,
      { network: false },
    )
    expect(result.code).toBe(3)
  })

  it('serves two projects with different roots in one process, concurrently', async () => {
    const other = nodePath.join(root, 'proj2')
    await mkdir(other, { recursive: true })
    const [a, b] = await Promise.all([
      go(`echo a > mine.txt; echo "w=$?"; echo b > ${other}/theirs.txt; echo "x=$?"`),
      (async () => {
        const commandId = id()
        return run(sandbox, `echo a > mine.txt; echo "w=$?"; echo b > ${project}/theirs.txt; echo "x=$?"`, { ...policy, writeRoots: [other, temp], denyWrite: [], commandId }, other).finally(() => sandbox.release(commandId))
      })(),
    ])
    expect(a.stdout).toContain('w=0')
    expect(a.stdout).not.toContain('x=0')
    expect(b.stdout).toContain('w=0')
    expect(b.stdout).not.toContain('x=0')
  })

  it('re-allows reading the project materials inside the Nexgent home, and nothing else there', async () => {
    const materials = nodePath.join(nexgentHome, 'projects', 'p1', 'materials')
    await mkdir(materials, { recursive: true })
    await writeFile(nodePath.join(materials, 'orders.csv'), 'id,amount\n1,2\n')
    const result = await go(`cat ${materials}/orders.csv; cat ${nexgentHome}/credentials.json; echo "rc=$?"; echo x > ${materials}/new.txt; echo "w=$?"`, { allowRead: [materials] })
    expect(result.stdout).toContain('1,2')
    expect(result.stdout).not.toContain('secret')
    expect(result.stdout).toContain('rc=1')
    expect(result.stdout).not.toContain('w=0')
  })

  it('extra approved write roots become writable', async () => {
    const result = await go(`echo y > ${outside}/approved.txt && cat ${outside}/approved.txt`, { writeRoots: [project, temp, outside] })
    expect(result).toMatchObject({ code: 0, stdout: 'y\n' })
  })
})

const hasSetpriv = hasBwrap && spawnSync('setpriv', ['--help']).status === 0

describe.skipIf(!hasSetpriv)('network bridge lifetime (real)', () => {
  it('the bridge processes die with a host process that is killed hard', async () => {
    const dist = nodePath.resolve(import.meta.dirname, '..', 'src', 'os-sandbox.ts')
    const script = `
      const { createOsSandbox } = await import(${JSON.stringify(dist)})
      const { execFileSync } = await import('node:child_process')
      const sandbox = createOsSandbox()
      await sandbox.probe()
      const children = execFileSync('ps', ['-o', 'pid=,args=', '--ppid', String(process.pid)], { encoding: 'utf8' })
      console.log(JSON.stringify(children.split('\\n').filter(line => line.includes('socat')).map(line => Number(line.trim().split(' ')[0]))))
      setInterval(() => {}, 1000)
    `
    const child = spawn(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', script], { stdio: ['ignore', 'pipe', 'inherit'] })
    const pids = await new Promise<number[]>(resolve => child.stdout.once('data', (c: Buffer) => resolve(JSON.parse(c.toString()) as number[])))
    expect(pids.length).toBeGreaterThan(0)
    child.kill('SIGKILL')
    await new Promise(resolve => child.once('exit', resolve))
    const alive = (pid: number) => {
      try {
        process.kill(pid, 0)
      } catch {
        return false
      }
      const stat = spawnSync('cat', [`/proc/${pid}/stat`], { encoding: 'utf8' }).stdout
      return !/\) [ZX] /.test(stat)
    }
    const deadline = Date.now() + 3000
    while (pids.some(alive) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50))
    expect(pids.filter(alive)).toEqual([])
  }, 30_000)
})
