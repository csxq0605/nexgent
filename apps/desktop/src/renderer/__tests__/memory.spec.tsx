// @vitest-environment jsdom
/**
 * Project memory: the page (rules, practices and notes with their source),
 * the observations card in the coordinator conversation, and the 要记住吗
 * card shown with `propose_memory`.
 */
import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { HandbookEntryView, ObservationView } from '@nexgent/sdk'
import { M } from '../strings.js'
import { FakeBridge, SESSION } from '../testing/fake-bridge.js'
import { renderApp } from './helpers.js'

const RULE = 'b0000000-0000-4000-8000-000000000001'
const PENDING = 'b0000000-0000-4000-8000-000000000002'

const rule = (overrides: Partial<HandbookEntryView> & Pick<HandbookEntryView, 'id' | 'text'>): HandbookEntryView => ({
  keywords: [], scope: 'project', projectId: 'p1', status: 'active', kind: 'rule', helpful: 0, harmful: 0, sources: [], supersedes: [],
  createdAt: '2026-11-05T08:00:00.000Z', updatedAt: '2026-11-05T08:00:00.000Z', retrievable: true, ...overrides,
})

const task = (n: number) => ({ key: `s1:${n}`, at: '2026-11-0' + n + 'T08:00:00.000Z', task: `任务 ${n}` })

const observation = (overrides: Partial<ObservationView> & Pick<ObservationView, 'id' | 'kind' | 'key' | 'evidence'>): ObservationView => ({
  status: 'open', taskKey: 's1:3', createdAt: '2026-11-07T08:00:00.000Z', updatedAt: '2026-11-07T08:00:00.000Z', ...overrides,
})

function memoryBridge(): FakeBridge {
  const bridge = new FakeBridge()
  bridge.userSettings = { ...bridge.userSettings, learning: { noticeAcknowledgedAt: '2026-10-16T08:00:00.000Z' } }
  bridge.sessions = [{ ...SESSION, coordinator: true }]
  bridge.handbook = [rule({ id: RULE, text: '接口改名时同步改文档', appliesTo: 'packages/sdk', quote: '你又没改文档', files: ['docs/old.md'], missing: ['docs/old.md'] })]
  return bridge
}

async function openPage(): Promise<HTMLElement> {
  fireEvent.click(screen.getByTestId('nav-capabilities'))
  return screen.findByTestId('capabilities-page')
}

describe('项目记忆页', () => {
  it('shows a rule with its range, the user\'s words and files gone; adds, edits and saves notes', async () => {
    const { bridge } = await renderApp(memoryBridge())
    const page = await openPage()
    const rules = await within(page).findByTestId('memory-rules')
    const row = within(rules).getByTestId('memory-entry')
    expect(row.textContent).toContain('接口改名时同步改文档')
    expect(row.textContent).toContain('适用于：packages/sdk')
    expect(within(row).getByTestId('memory-quote').textContent).toBe(M.quote('你又没改文档'))
    expect(within(row).getByTestId('memory-outdated').textContent).toBe(M.outdated(['docs/old.md']))

    fireEvent.click(within(rules).getByTestId('memory-rules-add'))
    fireEvent.change(screen.getByTestId('memory-add-text'), { target: { value: '提交前跑类型检查' } })
    fireEvent.click(screen.getByTestId('memory-add-save'))
    await waitFor(() => expect(within(rules).getAllByTestId('memory-entry')).toHaveLength(2))
    expect(bridge.calls.find(call => call.method === 'handbook.add')?.input).toMatchObject({ text: '提交前跑类型检查', kind: 'rule' })

    fireEvent.click(within(row).getByTestId('memory-edit-open'))
    fireEvent.change(screen.getByTestId('memory-edit-text'), { target: { value: '接口改名时同步改文档和 README' } })
    fireEvent.click(screen.getByTestId('memory-edit-save'))
    await waitFor(() => expect(within(rules).getByText('接口改名时同步改文档和 README')).toBeTruthy())
    expect(bridge.calls.find(call => call.method === 'handbook.edit')?.input).toMatchObject({ entryId: RULE, text: '接口改名时同步改文档和 README' })

    const notes = within(page).getByTestId('memory-notes')
    fireEvent.click(within(notes).getByTestId('memory-notes-edit'))
    fireEvent.change(within(notes).getByTestId('memory-notes-text'), { target: { value: '发布走手动 CI' } })
    fireEvent.click(within(notes).getByTestId('memory-notes-save'))
    await waitFor(() => expect(within(notes).getByText('发布走手动 CI')).toBeTruthy())
    expect(bridge.notes.text).toBe('发布走手动 CI')
  })
})

describe('项目观察', () => {
  it('keeps a drift as a rule with the user\'s text, sends a hotspot to the coordinator, and dismisses', async () => {
    const bridge = memoryBridge()
    bridge.observations = [
      observation({ id: 'o1', kind: 'drift', key: '文档 同步', evidence: { tasks: [task(2), task(1)], quotes: ['改接口记得同步文档', '文档又没同步'] }, rule: '改接口时同步改文档' }),
      observation({ id: 'o2', kind: 'hotspot', key: 'packages/sdk/src', evidence: { tasks: [task(3), task(2), task(1)], files: ['packages/sdk/src/a.ts', 'packages/sdk/src/b.ts'], trouble: { conflicts: 3, threads: 0, outside: 0, reread: 0 } } }),
      observation({ id: 'o3', kind: 'stuck', key: 'bash', evidence: { tasks: [task(2), task(1)], tool: 'bash', code: 'tool/timeout' } }),
    ]
    await renderApp(bridge)
    const card = await screen.findByTestId('observation-card')
    const items = within(card).getAllByTestId('observation')
    expect(items.map(item => item.dataset['kind'])).toEqual(['drift', 'hotspot', 'stuck'])
    expect(items[0]!.textContent).toContain(M.driftTitle(2))
    expect(items[0]!.textContent).toContain('“文档又没同步”')

    fireEvent.click(within(items[0]!).getByTestId('observation-act'))
    expect((within(items[0]!).getByTestId('observation-keep-text') as HTMLTextAreaElement).value).toBe('改接口时同步改文档')
    fireEvent.change(within(items[0]!).getByTestId('observation-keep-text'), { target: { value: '改接口时同步改 docs' } })
    fireEvent.click(within(items[0]!).getByTestId('observation-keep-save'))
    await waitFor(() => expect(bridge.calls.find(call => call.method === 'memory.resolve')?.input).toMatchObject({ observationId: 'o1', status: 'adopted', text: '改接口时同步改 docs' }))

    fireEvent.click(within(screen.getAllByTestId('observation').find(item => item.dataset['kind'] === 'hotspot')!).getByTestId('observation-act'))
    await waitFor(() => expect(bridge.calls.some(call => call.method === 'turns.send')).toBe(true))
    const sent = bridge.calls.find(call => call.method === 'turns.send')!.input as { text: string }
    expect(sent.text).toBe(M.askSplitText('packages/sdk/src', 3, '合并冲突 3 次'))
    await waitFor(() => expect(bridge.calls.filter(call => call.method === 'memory.resolve').map(call => (call.input as { observationId: string }).observationId)).toContain('o2'))

    fireEvent.click(within(screen.getAllByTestId('observation').find(item => item.dataset['kind'] === 'stuck')!).getByTestId('observation-dismiss'))
    await waitFor(() => expect(screen.queryByTestId('observation-card')).toBeNull())
    expect(bridge.observations.map(item => item.status)).toEqual(['adopted', 'adopted', 'dismissed'])
  })
})

describe('要记住吗', () => {
  const proposed = (id: string) => ({
    kind: 'tool' as const, turn: 1, step: 1, call: { id: `c-${id}`, name: 'propose_memory', arguments: JSON.stringify({ text: '回复一律用中文', quote: '以后都用中文回复' }) },
    content: `Proposed to the user as project memory (entry ${id}). Carry on.`, isError: false, durationMs: 5,
  })

  it('keeps, edits or drops the proposed rule', async () => {
    const bridge = memoryBridge()
    const second = 'b0000000-0000-4000-8000-000000000003'
    bridge.handbook = [
      rule({ id: PENDING, text: '回复一律用中文', status: 'trial', pending: true, quote: '以后都用中文回复', retrievable: false }),
      rule({ id: second, text: '回复一律用中文', status: 'trial', pending: true, retrievable: false }),
    ]
    bridge.view = { ...bridge.view, items: [proposed(PENDING), { ...proposed(second), step: 2 }] as never }
    await renderApp(bridge)
    const cards = await screen.findAllByTestId('proposal-card')
    expect(cards.map(card => card.dataset['state'])).toEqual(['pending', 'pending'])
    expect(cards[0]!.textContent).toContain(M.quote('以后都用中文回复'))

    fireEvent.click(within(cards[0]!).getByTestId('proposal-keep'))
    await waitFor(() => expect(screen.getAllByTestId('proposal-card')[0]!.dataset['state']).toBe('kept'))

    fireEvent.click(within(screen.getAllByTestId('proposal-card')[1]!).getByTestId('proposal-drop'))
    await waitFor(() => expect(screen.getAllByTestId('proposal-card')[1]!.dataset['state']).toBe('dropped'))
    expect(bridge.handbook.map(entry => entry.status)).toEqual(['active', 'retired'])
  })

  it('edits before keeping', async () => {
    const bridge = memoryBridge()
    bridge.handbook = [rule({ id: PENDING, text: '回复一律用中文', status: 'trial', pending: true, retrievable: false })]
    bridge.view = { ...bridge.view, items: [proposed(PENDING)] as never }
    await renderApp(bridge)
    const card = await screen.findByTestId('proposal-card')
    fireEvent.click(within(card).getByTestId('proposal-edit-open'))
    fireEvent.change(within(card).getByTestId('proposal-edit-text'), { target: { value: '回复和提交说明一律用中文' } })
    fireEvent.click(within(card).getByTestId('proposal-edit-save'))
    await waitFor(() => expect(screen.getByTestId('proposal-card').dataset['state']).toBe('kept'))
    expect(bridge.handbook[0]!.text).toBe('回复和提交说明一律用中文')
  })
})
