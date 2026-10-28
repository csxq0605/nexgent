/**
 * Where sandboxed commands may connect: the setting, the allow list a
 * command gets, and the questions about hosts off the list.
 */
import { describe, expect, it } from 'vitest'
import {
  commandAllowList,
  DEFAULT_ALLOWED_DOMAINS,
  isAllowedDomainEntry,
  NETWORK_GRANT,
  NetworkGate,
  networkMode,
  validateProjectConfig,
} from '../src/index.js'

describe('commands.network', () => {
  it('defaults to the allow list; true and false keep their old meaning', () => {
    expect(networkMode(undefined)).toBe('allowlist')
    expect(networkMode(true)).toBe('any')
    expect(networkMode(false)).toBe('off')
    expect(networkMode('off')).toBe('off')
  })

  it('accepts host patterns and refuses anything else', () => {
    expect(() => validateProjectConfig({ commands: { network: 'allowlist', allowedDomains: ['mirror.example.com', '*.corp.example', 'cache.local.test:8443'] } })).not.toThrow()
    for (const bad of ['*', 'http://x.com', 'x', 'a..b', 'x.com:0', '*.*.com']) {
      expect(() => validateProjectConfig({ commands: { allowedDomains: [bad] } }), bad).toThrow(/allowedDomains/)
    }
    expect(() => validateProjectConfig({ commands: { network: 'sometimes' } })).toThrow(/commands.network/)
    expect(isAllowedDomainEntry('pypi.org')).toBe(true)
  })

  it('gives a command the package sources, the configured hosts and the hosts the user allowed', () => {
    const grants = [
      { tool: NETWORK_GRANT, pattern: 'mirror.example.com', grantedAt: 'x' },
      { tool: 'bash', pattern: 'git push', grantedAt: 'x' },
    ]
    const list = commandAllowList('allowlist', ['cache.example.org'], grants)
    expect(list).toEqual(expect.arrayContaining([...DEFAULT_ALLOWED_DOMAINS, 'cache.example.org', 'mirror.example.com']))
    expect(list).not.toContain('git push')
    expect(commandAllowList('off', ['cache.example.org'], grants)).toEqual([])
  })
})

describe('NetworkGate', () => {
  const request = { host: 'mirror.example.com', port: 443 }

  it('asks the session of the running command once for concurrent connections, and tells every command of it', async () => {
    const gate = new NetworkGate()
    let asks = 0
    const allowed: string[] = []
    gate.register('a', { owner: 's1', mode: 'allowlist', ask: async () => { asks += 1; return true }, allow: host => allowed.push(`a:${host}`) })
    gate.register('b', { owner: 's1', mode: 'allowlist', allow: host => allowed.push(`b:${host}`) })
    expect(await Promise.all([gate.decide(request), gate.decide(request)])).toEqual([true, true])
    expect(asks).toBe(1)
    expect(allowed.sort()).toEqual(['a:mirror.example.com', 'a:mirror.example.com', 'b:mirror.example.com', 'b:mirror.example.com'])
  })

  it('refuses a host it cannot put to one session, and answers off and any without asking', async () => {
    const gate = new NetworkGate()
    gate.register('a', { owner: 's1', mode: 'allowlist', ask: async () => true })
    gate.register('b', { owner: 's2', mode: 'allowlist', ask: async () => true })
    expect(await gate.decide(request)).toMatchObject({ allow: false, reason: expect.stringContaining('more than one session') })
    gate.unregister('a')
    gate.unregister('b')
    gate.register('c', { owner: 's1', mode: 'off', ask: async () => true })
    expect(await gate.decide(request)).toMatchObject({ allow: false, reason: expect.stringContaining('off') })
    gate.unregister('c')
    gate.register('d', { owner: 's1', mode: 'any' })
    gate.register('e', { owner: 's2', mode: 'any' })
    expect(await gate.decide(request)).toBe(true)
  })

  it('refuses a host for a command that cannot ask, and when the user says no', async () => {
    const gate = new NetworkGate()
    gate.register('a', { owner: 's1', mode: 'allowlist' })
    expect(await gate.decide(request)).toMatchObject({ allow: false, reason: expect.stringContaining('background') })
    gate.unregister('a')
    gate.register('b', { owner: 's1', mode: 'allowlist', ask: async () => false })
    expect(await gate.decide(request)).toMatchObject({ allow: false, reason: expect.stringContaining('did not allow') })
  })
})
