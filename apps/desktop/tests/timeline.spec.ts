import { describe, expect, it } from 'vitest'
import type { HistoryItem } from '@nexgent/sdk'
import { fromHistory, openingMessages, userMarks } from '../src/renderer/timeline.js'

const user = (turn: number, text: string): HistoryItem => ({ kind: 'user', turn, text, source: 'user', materials: [] })

describe('user message marks', () => {
  it('marks the words the last compaction keeps and the messages sent while a turn ran', () => {
    const entries = fromHistory([
      user(1, 'Indent with tabs.'),
      user(2, 'Now the table.'),
      user(2, 'Also sort it by date.'),
      { kind: 'compaction', turn: 3, userWords: { turns: [2], dropped: 1 } },
      user(3, 'Go on.'),
      user(3, 'Stop after the table.'),
    ])
    const keys = entries.flatMap(entry => (entry.kind === 'user' ? [entry.key] : []))
    const marks = userMarks(entries, openingMessages(entries))
    expect(keys.map(key => marks.get(key))).toEqual([undefined, 'kept', 'kept', undefined, 'steered'])
    expect(entries.find(entry => entry.kind === 'compaction')).toMatchObject({ userWords: { turns: [2], dropped: 1 } })
  })

  it('marks nothing as kept when the compaction kept no words', () => {
    const entries = fromHistory([user(1, 'Hello.'), { kind: 'compaction', turn: 2 }])
    expect(userMarks(entries, openingMessages(entries)).size).toBe(0)
  })
})
