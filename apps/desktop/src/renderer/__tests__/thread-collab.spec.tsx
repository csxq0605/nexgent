// @vitest-environment jsdom
/** Organization redo in the renderer: collaboration lines, the thread-naming panel, queued and shared threads, and stopping a thread. */
import { fireEvent, screen, waitFor } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { FakeBridge, SESSION, memberRun } from '../testing/fake-bridge.js'
import { collabLineText } from '../strings.js'
import { fromHistory, applyEvent } from '../timeline.js'
import { emit, renderApp } from './helpers.js'

const entry = (over: Record<string, unknown>) => ({ seq: 1, at: '2026-01-01T00:00:00Z', from: 't1', fromTitle: 'Docs', kind: 'message', text: 'api changed', ...over })
const THREAD = { ...SESSION, sessionId: 't1', title: 'Docs', thread: { coordinatorSessionId: 's1', title: 'Docs' } }
const info = (over: Record<string, unknown> = {}) => ({ threadId: 't1', title: 'Docs', coordinatorSessionId: 's1', status: 'running' as const, turns: 1, createdAt: SESSION.createdAt, updatedAt: SESSION.updatedAt, ...over })

describe('collab lines', () => {
  it('words a message, a merge with its lines, and the coordinator', () => {
    expect(collabLineText(entry({ toTitle: 'API' }) as never)).toEqual({ who: 'Docs → API', body: 'api changed' })
    expect(collabLineText(entry({ kind: 'merged', stat: [{ path: 'a.ts', added: 12, removed: 3 }] }) as never)).toEqual({ who: 'Docs 合入', body: 'a.ts +12 −3' })
    expect(collabLineText(entry({ kind: 'ask', fromTitle: 'coordinator' }) as never).who).toBe('协调者 → 协调者 问')
  })

  it('takes a collab history item and a live event once each', () => {
    const e = entry({ seq: 4 }) as never
    const list = fromHistory([{ kind: 'collab', turn: 1, entry: e } as never])
    expect(list).toHaveLength(1)
    expect(applyEvent(list, { type: 'collab', entry: e } as never)).toHaveLength(1)
  })

  it('shows a live entry as one line', async () => {
    const { bridge } = await renderApp()
    emit(bridge, { type: 'collab', entry: entry({ toTitle: 'API', to: 't2' }) })
    expect(screen.getByTestId('collab-line').textContent).toContain('api changed')
  })
})

describe('thread status', () => {
  it('marks a queued thread, a shared copy, and stops a running one', async () => {
    const bridge = new FakeBridge()
    bridge.sessions = [SESSION, THREAD]
    bridge.threads = [info({ status: 'queued', isolated: false })]
    await renderApp(bridge)
    emit(bridge, { type: 'turn.start', turn: 1, source: 'user' })
    emit(bridge, { type: 'member.start', turn: 1, run: memberRun({ name: 'docs', childSessionId: 't1', executionForm: 'thread' }) })
    expect(screen.getByTestId('thread-status').textContent).toBe('排队中')
    expect(screen.getByTestId('thread-shared').getAttribute('title')).toContain('直接改项目')
    fireEvent.click(screen.getByTestId('thread-stop'))
    await waitFor(() => expect(bridge.callsOf('threads.stop')).toContainEqual(expect.objectContaining({ sessionId: 's1', threadId: 't1' })))
  })
})

describe('naming threads', () => {
  it('sends the named threads with the message', async () => {
    const { bridge } = await renderApp()
    fireEvent.click(screen.getByTestId('plan-threads'))
    fireEvent.change(screen.getByTestId('plan-title'), { target: { value: '接口' } })
    fireEvent.change(screen.getByTestId('plan-task'), { target: { value: '改接口' } })
    fireEvent.click(screen.getByTestId('plan-exact'))
    fireEvent.change(screen.getByTestId('composer-input'), { target: { value: '开始' } })
    fireEvent.click(screen.getByTestId('send'))
    await waitFor(() => expect(bridge.callsOf('turns.send')).toHaveLength(1))
    expect(bridge.callsOf('turns.send')[0]).toMatchObject({ threads: [{ title: '接口', task: '改接口' }], exactThreads: false })
  })

  it('sends no thread fields when none are named', async () => {
    const { bridge } = await renderApp()
    fireEvent.change(screen.getByTestId('composer-input'), { target: { value: '开始' } })
    fireEvent.click(screen.getByTestId('send'))
    await waitFor(() => expect(bridge.callsOf('turns.send')).toHaveLength(1))
    expect(bridge.callsOf('turns.send')[0]).not.toHaveProperty('threads')
  })
})
