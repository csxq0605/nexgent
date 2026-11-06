// @vitest-environment jsdom
/**
 * Organization redo in the renderer: the user starts a thread themselves,
 * picks how threads work together in the settings, and a coordinator task
 * shows its collaboration trial in one line.
 */
import { fireEvent, screen, waitFor } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { trialNoteText } from '../strings.js'
import { FakeBridge, SESSION } from '../testing/fake-bridge.js'
import { emit, renderApp } from './helpers.js'

describe('collaboration', () => {
  it('starts a thread of the coordinator conversation from the sidebar and opens it', async () => {
    const bridge = new FakeBridge()
    bridge.sessions = [SESSION]
    await renderApp(bridge)
    fireEvent.click(await screen.findByTestId('new-thread'))
    const start = screen.getByTestId('new-thread-start') as HTMLButtonElement
    expect(start.disabled).toBe(true)
    fireEvent.change(screen.getByTestId('new-thread-title'), { target: { value: '修登录' } })
    fireEvent.change(screen.getByTestId('new-thread-task'), { target: { value: '登录页一直跳转，修好它。' } })
    fireEvent.click(start)
    await waitFor(() => expect(bridge.callsOf('threads.start')).toEqual([expect.objectContaining({ sessionId: 's1', title: '修登录', task: '登录页一直跳转，修好它。' })]))
    await waitFor(() => expect(bridge.callsOf('sessions.open')).toContainEqual(expect.objectContaining({ sessionId: 't9' })))
    expect(screen.queryByTestId('new-thread-dialog')).toBeNull()
  })

  it('says in one line which collaboration a task tries and how it ended', async () => {
    const { bridge } = await renderApp()
    emit(bridge, { type: 'turn.start', turn: 1, source: 'user', trial: { status: 'trying', variable: 'overlap', value: 'sequence' } })
    expect(screen.getByTestId('turn-trial').textContent).toBe('这次试一种协作方式：改同一批文件的讨论串先后进行')
    expect(trialNoteText({ status: 'kept', variable: 'handoff', value: 'manifest' })).toBe('以后都这样协作：新讨论串拿到前面讨论串带进来的文件清单')
    expect(trialNoteText({ status: 'reverted', variable: 'overlap', value: 'sequence' })).toBe('试过没变好，已改回：改同一批文件的讨论串先后进行')
  })
})
