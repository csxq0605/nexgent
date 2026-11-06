/**
 * `nexgent thread start|list|stop`: the project's coordinator threads from the
 * command line, through the same SDK calls the desktop app uses.
 */
import { createSdk } from '@nexgent/sdk'
import type { ThreadInfo } from '@nexgent/kernel'
import { requireApiKey } from './credentials.js'
import { EXIT, type ExitCode } from './exit-codes.js'
import { initProjectLayout } from './layout.js'
import type { CliDeps, CliIo } from './main.js'
import { packageVersion } from './version.js'
import type { ThreadInvocation } from './args.js'

/** One line per thread: id, status, turns, title. */
export function threadLine(thread: ThreadInfo): string {
  const note = thread.blocker === undefined ? '' : ` (waiting: ${thread.blocker})`
  return `${thread.threadId}  ${thread.status}  ${thread.turns} turn${thread.turns === 1 ? '' : 's'}  ${thread.title}${note}`
}

/** Run one `thread` action; resolves with the exit code. */
export async function runThread(invocation: ThreadInvocation, io: CliIo, deps: CliDeps): Promise<ExitCode> {
  const { layout } = await initProjectLayout(invocation.project, io.cwd, io.env)
  if (invocation.action === 'start') await requireApiKey(deps.credentials ?? { env: io.env })
  const sdk = createSdk({ appVersion: packageVersion(), env: io.env, resumeThreads: invocation.action === 'start' })
  try {
    const { projectId } = await sdk.call('projects.open', { root: layout.root })
    const { sessionId } = await sdk.call('sessions.coordinator', { projectId })
    const out = (text: string, json: unknown): void => {
      io.stdout.write(invocation.json ? `${JSON.stringify(json)}\n` : `${text}\n`)
    }
    switch (invocation.action) {
      case 'list': {
        const threads = await sdk.call('threads.list', { projectId, sessionId })
        out(threads.length === 0 ? 'no threads' : threads.map(threadLine).join('\n'), { type: 'threads', threads })
        return EXIT.OK
      }
      case 'stop': {
        const info = await sdk.call('threads.stop', { projectId, sessionId, threadId: invocation.threadId, ...(invocation.reason === undefined ? {} : { reason: invocation.reason }) })
        out(threadLine(info), { type: 'thread', thread: info })
        return EXIT.OK
      }
      case 'start': {
        await sdk.openSession({ projectId, sessionId })
        const started = await sdk.call('threads.start', { projectId, sessionId, title: invocation.title, task: invocation.task })
        const interrupted = new AbortController()
        const onSignal = (): void => interrupted.abort()
        io.signals?.on('SIGINT', onSignal)
        let info: ThreadInfo = started
        try {
          // The thread runs in this process: wait until it stops.
          while (!interrupted.signal.aborted) {
            info = (await sdk.call('threads.list', { projectId, sessionId })).find(thread => thread.threadId === started.threadId) ?? info
            if (info.status !== 'running' && info.status !== 'queued') break
            await new Promise(resolve => setTimeout(resolve, 500))
          }
          if (interrupted.signal.aborted) info = await sdk.call('threads.stop', { projectId, sessionId, threadId: started.threadId, reason: 'cancelled from the command line' })
          else await waitForCoordinatorIdle(sdk, projectId, sessionId, interrupted.signal)
        } finally {
          io.signals?.off('SIGINT', onSignal)
        }
        out(threadLine(info), { type: 'thread', thread: info })
        return info.status === 'done' ? EXIT.OK : info.status === 'waiting' ? EXIT.OK : interrupted.signal.aborted ? EXIT.CANCELLED : EXIT.TASK_FAILED
      }
    }
  } finally {
    await sdk.dispose()
  }
}

/** After a thread stops the coordinator is woken and may run a follow-up turn: wait until it stays idle for a short while. */
async function waitForCoordinatorIdle(sdk: ReturnType<typeof createSdk>, projectId: string, sessionId: string, signal: AbortSignal): Promise<void> {
  let quiet = 0
  while (quiet < 3 && !signal.aborted) {
    const running = (await sdk.call('sessions.list', { projectId })).some(s => s.sessionId === sessionId && s.running)
    quiet = running ? 0 : quiet + 1
    await new Promise(resolve => setTimeout(resolve, 500))
  }
}
