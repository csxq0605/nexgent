import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { CollabEntry, SessionRecord } from '@nexgent/kernel'
import { historyItems } from '../src/history.js'
import { readSettings, updateSettings } from '../src/settings.js'

const base = { v: 1, sessionId: 's' }
function records(): SessionRecord[] {
  const at = (n: number): string => `2026-01-01T00:00:0${n}.000Z`
  return [
    { ...base, seq: 1, ts: at(1), type: 'turn.start', turn: 1 },
    { ...base, seq: 2, ts: at(2), type: 'user.message', turn: 1, content: 'hi', source: 'user' },
    { ...base, seq: 3, ts: at(5), type: 'turn.end', turn: 1, reason: { kind: 'completed' } },
    { ...base, seq: 4, ts: at(7), type: 'turn.start', turn: 2 },
    { ...base, seq: 5, ts: at(8), type: 'turn.end', turn: 2, reason: { kind: 'completed' } },
  ] as unknown as SessionRecord[]
}
const entry = (seq: number, at: string): CollabEntry => ({ seq, at, from: 'a', fromTitle: 'A', kind: 'note', text: `n${seq}` })

describe('history collab items', () => {
  it('places entries by time and names the running turn', () => {
    const items = historyItems(records(), [entry(2, '2026-01-01T00:00:06.000Z'), entry(1, '2026-01-01T00:00:03.000Z'), entry(3, '2026-01-01T00:00:09.000Z')])
    const kinds = items.map(item => (item.kind === 'collab' ? `collab${item.turn ?? '-'}` : item.kind))
    expect(kinds).toEqual(['user', 'collab1', 'turn.end', 'collab-', 'turn.end', 'collab-'])
  })
})

describe('settings threads.maxRunning', () => {
  it('reads the default and patches it', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'nx-settings-'))
    const file = join(dir, 'config.json')
    await writeFile(file, JSON.stringify({ version: 1 }))
    const where = { env: {}, home: dir }
    expect((await readSettings(file, where)).threads?.maxRunning).toBeGreaterThan(0)
    expect((await updateSettings(file, { threads: { maxRunning: 2 } }, where)).threads?.maxRunning).toBe(2)
    await expect(updateSettings(file, { threads: { maxRunning: 0 } }, where)).rejects.toThrow()
  })
})
