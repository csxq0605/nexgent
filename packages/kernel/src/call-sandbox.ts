/**
 * The sandbox one tool call is checked against, shared by every tool that
 * checks paths itself (file, spreadsheet, document and code tools): the
 * directory the session works in counts as the project (a thread's or
 * member's own copy, rework K4 D4), with the call's mode and only the
 * call's session temp directory. One rule, so a tool writing a session's
 * copy is never asked about as a write outside the project while another
 * tool doing the same is not.
 */
import type { ToolContext } from './contracts/tools.js'
import type { Sandbox, SandboxMode } from './contracts/workspace.js'

/** What the workspace's `LocalSandbox` offers beyond {@link Sandbox}; each part is optional. */
interface ScopableSandbox extends Sandbox {
  forRoot?(root: string): Sandbox
  withMode?(mode: SandboxMode): Sandbox
  forSession?(sessionId: string | undefined): Sandbox
}

/** The root of the session's own copy of the project the call works in, when it has one. */
export function workingCopyRoot(context: Pick<ToolContext, 'workspace'>): string | undefined {
  const layout = context.workspace.layout as { readonly root?: string } | undefined
  return layout?.root === undefined || layout.root === context.workspace.root ? undefined : context.workspace.root
}

/** {@link Sandbox} for one call (see the file comment); a sandbox without the optional parts is used as it is. */
export function sandboxForCall(sandbox: Sandbox, context: Pick<ToolContext, 'workspace' | 'sandboxMode' | 'sessionId'>): Sandbox {
  const copy = workingCopyRoot(context)
  let scoped = sandbox as ScopableSandbox
  if (copy !== undefined && typeof scoped.forRoot === 'function') scoped = scoped.forRoot(copy) as ScopableSandbox
  if (typeof scoped.withMode === 'function') scoped = scoped.withMode(context.sandboxMode) as ScopableSandbox
  if (typeof scoped.forSession === 'function') scoped = scoped.forSession(context.sessionId) as ScopableSandbox
  return scoped
}
