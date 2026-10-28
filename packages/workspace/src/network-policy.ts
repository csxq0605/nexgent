/**
 * Where sandboxed commands may connect (`permissions.md` §系统沙箱, 网络).
 *
 * Every sandboxed command reaches the network only through the sandbox
 * library's local proxy, which checks each host. A host passes when it is
 * on the command's allow list: the package sources and code hosts below,
 * `commands.allowedDomains`, and hosts the user allowed for the session or
 * the project. Any other host is put to the user once, as an approval of
 * the command's session (`once` lets this command reach it; `session` and
 * `project` are remembered as `network` grants).
 *
 * The library asks about a host without saying which command opened the
 * connection, so the OS sandbox's `NetworkGate` keeps the commands that are
 * running and puts the question to their session; when commands of more
 * than one session run at the same moment and they would be answered
 * differently, the host is refused with a reason (the command can simply
 * be run again).
 *
 * Nothing here depends on the kind of task.
 */
import type { ApprovalGrant } from '@nexgent/kernel'

/** `commands.network`: `allowlist` (default) asks about hosts off the list, `any` lets every host through, `off` none. */
export type NetworkMode = 'allowlist' | 'any' | 'off'

/** Accepted `commands.network` values (`true` reads as `any`, `false` as `off`). */
export const NETWORK_MODES: readonly NetworkMode[] = ['allowlist', 'any', 'off']

/** Tool name of the grants that remember an allowed host (`pattern` = the host). */
export const NETWORK_GRANT = 'network'

/**
 * Hosts every sandboxed command may reach without asking: package
 * registries and source hosts that installing and building commonly needs.
 */
export const DEFAULT_ALLOWED_DOMAINS: readonly string[] = Object.freeze([
  // JavaScript
  'registry.npmjs.org', '*.npmjs.org', 'registry.yarnpkg.com', 'repo.yarnpkg.com', 'jsr.io', '*.jsr.io', 'deno.land', '*.deno.land',
  // Python
  'pypi.org', '*.pypi.org', 'files.pythonhosted.org', '*.pythonhosted.org', 'conda.anaconda.org', 'repo.anaconda.com',
  // Rust, Go, Ruby, Java, .NET, PHP
  'crates.io', '*.crates.io', 'static.rust-lang.org', 'proxy.golang.org', 'sum.golang.org', 'rubygems.org', '*.rubygems.org',
  'repo.maven.apache.org', 'repo1.maven.org', 'plugins.gradle.org', 'services.gradle.org', 'api.nuget.org', '*.nuget.org',
  'repo.packagist.org', 'packagist.org',
  // Source hosts
  'github.com', '*.github.com', '*.githubusercontent.com', 'gitlab.com', '*.gitlab.com', 'bitbucket.org', '*.bitbucket.org',
])

const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i

/** Pure: whether `entry` is a host pattern `commands.allowedDomains` accepts: `host`, `*.host`, optionally `:port`. */
export function isAllowedDomainEntry(entry: string): boolean {
  const match = /^(.*?)(?::(\d{1,5}))?$/.exec(entry)
  if (match === null) return false
  const [, host = '', port] = match
  if (port !== undefined && (Number(port) < 1 || Number(port) > 65_535)) return false
  const name = host.startsWith('*.') ? host.slice(2) : host
  const labels = name.split('.')
  return labels.length >= 2 && labels.every(label => LABEL.test(label))
}

/** Pure: the hosts the user allowed (`network` grants of the session and the project). */
export function grantedDomains(grants: readonly ApprovalGrant[]): string[] {
  return grants.filter(grant => grant.tool === NETWORK_GRANT && grant.pattern !== undefined && isAllowedDomainEntry(grant.pattern)).map(grant => grant.pattern!)
}

/** Pure: a command's allow list (empty for `off`; `any` passes every host through the gate instead). */
export function commandAllowList(mode: NetworkMode, configured: readonly string[], grants: readonly ApprovalGrant[]): string[] {
  if (mode === 'off') return []
  return [...new Set([...DEFAULT_ALLOWED_DOMAINS, ...configured, ...grantedDomains(grants)])]
}
