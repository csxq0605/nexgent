import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { THREAD_LIMITS, type CollabEntry } from '@nexgent/kernel'
import { afterEach, describe, expect, it } from 'vitest'
import { CollabLog, collabDelivery, hopsOf, logEvents, renderCollabEntry, waitCycle } from '../src/collab.js'

const COORD = 'coord'
const hybrid = { mode: 'hybrid', handoff: 'changed' } as const
let seqCounter = 0
const entry = (patch: Partial<CollabEntry> & Pick<CollabEntry, 'kind' | 'from'>): CollabEntry => ({ seq: ++seqCounter, at: '2026-01-01T00:00:00Z', fromTitle: patch.from, text: 't', ...patch })

const dirs: string[] = []
async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'collab-'))
  dirs.push(dir)
  return dir
}
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

describe('collab identity and delivery', () => {
  it('treats only the coordinator session as the coordinator', () => {
    const fake = entry({ kind: 'note', from: 'thread-x', fromTitle: 'coordinator' })
    const real = entry({ kind: 'note', from: COORD, fromTitle: 'coordinator' })
    expect(renderCollabEntry(fake, 'me', COORD)).toContain('"coordinator" notes')
    expect(renderCollabEntry(real, 'me', COORD)).toContain('the coordinator notes')
    const central = { mode: 'central', handoff: 'brief' } as const
    const text = collabDelivery({ entries: [fake, real], reader: { sessionId: 'me' }, coordinatorSessionId: COORD, cursor: 0, collaboration: central, compacted: false, working: () => false })
    expect(text).toContain('the coordinator notes')
    expect(text).not.toContain('"coordinator" notes')
  })

  it('renders merged with stat and hint, re, release and stopped', () => {
    const merged = entry({ kind: 'merged', from: 't1', fromTitle: 'A', paths: ['a.ts'], stat: [{ path: 'a.ts', added: 12, removed: 3 }], text: '' })
    expect(renderCollabEntry(merged, 'me', COORD)).toMatch(/a\.ts \+12 −3.*read_merged/)
    const partial = entry({ kind: 'merged', from: 't1', fromTitle: 'A', paths: ['a.ts', 'b.ts'], stat: [{ path: 'a.ts', added: 1, removed: 0 }], text: '' })
    expect(renderCollabEntry(partial, 'me', COORD)).toContain('[a.ts +1 −0, b.ts]')
    expect(renderCollabEntry(entry({ kind: 'message', from: 't1', fromTitle: 'A', to: 'me', re: 4, text: 'x' }), 'me', COORD)).toContain('to you (re #4): x')
    expect(renderCollabEntry(entry({ kind: 'release', from: 't1', fromTitle: 'A', paths: ['a'] }), 'me', COORD)).toContain('no longer stand')
    expect(renderCollabEntry(entry({ kind: 'stopped', from: 't1', fromTitle: 'A', text: 'wrong way' }), 'me', COORD)).toContain('was stopped: wrong way')
  })

  it('gives the coordinator thread writes but not host entries, and hybrid notes by paths', () => {
    const entries = [
      entry({ kind: 'merged', from: 't1', paths: ['a'] }),
      entry({ kind: 'ask', from: 't1' }),
      entry({ kind: 'message', from: 't1', to: 't2', text: 'hi' }),
      entry({ kind: 'stopped', from: 't2' }),
    ]
    const text = collabDelivery({ entries, reader: { sessionId: COORD, coordinator: true }, coordinatorSessionId: COORD, cursor: 0, collaboration: hybrid, compacted: false, working: () => false })!
    expect(text).toContain('to "t2"')
    expect(text).toContain('was stopped')
    expect(text).not.toContain('merged')
    expect(text).not.toContain('asks')
    const notes = [entry({ kind: 'note', from: 't1', paths: ['other/x.ts'] }), entry({ kind: 'note', from: 't1', paths: ['other/y.ts'], waitsFor: 'me' }), entry({ kind: 'note', from: 't1' })]
    const mine = collabDelivery({ entries: notes, reader: { sessionId: 'me', owns: ['mine/'] }, coordinatorSessionId: COORD, cursor: 0, collaboration: hybrid, compacted: false, working: () => true })!
    expect(mine).toContain('other/y.ts')
    expect(mine).toContain('1 other new entry is not about your paths')
    const touched = collabDelivery({ entries: notes.slice(0, 1), reader: { sessionId: 'me', owns: ['mine/'], touched: ['other/x.ts'] }, coordinatorSessionId: COORD, cursor: 0, collaboration: hybrid, compacted: false, working: () => true })!
    expect(touched).toContain('other/x.ts')
  })

  it('cuts a delivery to the entry and character budget', () => {
    const many = Array.from({ length: THREAD_LIMITS.collabDelivered + 5 }, (_, index) => entry({ kind: 'note', from: COORD, text: `n${index}` }))
    const byCount = collabDelivery({ entries: many, reader: { sessionId: 'me' }, coordinatorSessionId: COORD, cursor: 0, collaboration: hybrid, compacted: false, working: () => true })!
    expect(byCount).toContain('(5 earlier new entries left out')
    const big = Array.from({ length: 10 }, () => entry({ kind: 'note', from: COORD, text: 'x'.repeat(THREAD_LIMITS.peerChars) }))
    const byChars = collabDelivery({ entries: big, reader: { sessionId: 'me' }, coordinatorSessionId: COORD, cursor: 0, collaboration: hybrid, compacted: false, working: () => true })!
    expect(byChars.length).toBeLessThanOrEqual(THREAD_LIMITS.collabDeliveredChars + 400)
    expect(byChars).toContain('earlier new entries left out')
  })
})

describe('collab pure helpers', () => {
  it('counts hops, wait cycles and unanswered messages', () => {
    seqCounter = 0
    const m1 = entry({ kind: 'message', from: 'a', to: 'b', hops: 1 })
    expect(hopsOf([m1], m1.seq)).toBe(2)
    expect(hopsOf([m1], undefined)).toBe(1)
    const blocker = entry({ kind: 'blocker', from: 'b', waitsFor: 'a' })
    expect(waitCycle([m1, blocker], 'a', 'b', () => true)).toEqual(['b', 'a'])
    expect(waitCycle([m1, blocker], 'a', 'b', id => id !== 'b')).toBeUndefined()
    expect(waitCycle([m1, blocker, entry({ kind: 'release', from: 'b' })], 'a', 'b', () => true)).toBeUndefined()
    expect(waitCycle([m1], 'a', 'a', () => true)).toEqual(['a'])
    const ask = entry({ kind: 'ask', from: 'c' })
    expect(logEvents([m1, blocker, ask], { coordinatorSessionId: COORD, lastTurnWaiting: id => id === 'b' })).toEqual({ unanswered: 2, idle: 1 })
    const reply = entry({ kind: 'message', from: 'b', to: 'a' })
    const answer = entry({ kind: 'message', from: COORD, to: 'c' })
    expect(logEvents([m1, reply, ask, answer], { coordinatorSessionId: COORD }).unanswered).toBe(0)
  })
})

describe('CollabLog', () => {
  const make = (text: string) => () => ({ from: 't', fromTitle: 'T', kind: 'note' as const, text })

  it('serializes appends of two instances over one file', async () => {
    const dir = await tempDir()
    const seen: number[] = []
    const one = new CollabLog(() => dir, { onAppend: (_coord, written) => seen.push(written.seq) })
    const two = new CollabLog(() => dir)
    const writes = Array.from({ length: 30 }, (_, index) => (index % 2 === 0 ? one : two).append(COORD, make(`m${index}`)))
    const written = await Promise.all(writes)
    expect(new Set(written.map(item => item.seq)).size).toBe(30)
    const read = await new CollabLog(() => dir).entries(COORD)
    expect(read.map(item => item.seq)).toEqual(Array.from({ length: 30 }, (_, index) => index + 1))
    expect(seen).toHaveLength(15)
    expect((await readdir(dir)).some(name => name.endsWith('.lock'))).toBe(false)
  })

  it('removes a stale lock', async () => {
    const dir = await tempDir()
    const { mkdir, writeFile, utimes } = await import('node:fs/promises')
    await mkdir(dir, { recursive: true })
    const lock = join(dir, `${COORD}.lock`)
    await writeFile(lock, '1 0\n')
    const old = new Date(Date.now() - 60_000)
    await utimes(lock, old, old)
    const log = new CollabLog(() => dir)
    expect((await log.append(COORD, make('a'))).seq).toBe(1)
  })

  it('starts an entry on its own line after a partial last line', async () => {
    const dir = await tempDir()
    const log = new CollabLog(() => dir)
    await log.append(COORD, make('a'))
    const { appendFile } = await import('node:fs/promises')
    await appendFile(join(dir, `${COORD}.jsonl`), '{"seq":')
    expect((await log.append(COORD, make('b'))).seq).toBe(2)
    expect((await new CollabLog(() => dir).entries(COORD)).map(item => item.text)).toEqual(['a', 'b'])
  })

  it('archives earlier tasks past the limit and reads them with all', async () => {
    const dir = await tempDir()
    const log = new CollabLog(() => dir)
    const other = new CollabLog(() => dir)
    const first = THREAD_LIMITS.collabArchiveAt
    for (let index = 0; index < first; index++) await log.append(COORD, make(`old${index}`))
    await log.markTask(COORD)
    // The task entry closes the earlier task, which moves out at once.
    expect((await log.entries(COORD)).map(item => item.kind)).toEqual(['task'])
    const current = await log.append(COORD, make('current'))
    expect(current.seq).toBe(first + 2)
    expect(await readdir(dir)).toContain(`${COORD}.1.jsonl`)
    const now = await log.entries(COORD)
    expect(now.map(item => item.text)).toEqual(['', 'current'])
    // Another instance with an older cache sees the new file and keeps counting seq.
    expect((await other.append(COORD, make('next'))).seq).toBe(first + 3)
    expect((await log.entries(COORD)).map(item => item.text)).toEqual(['', 'current', 'next'])
    const all = await log.entries(COORD, true)
    expect(all).toHaveLength(first + 3)
    expect(all.map(item => item.seq)).toEqual(Array.from({ length: first + 3 }, (_, index) => index + 1))
  }, 60_000)

  it('keeps cursors across instances', async () => {
    const dir = await tempDir()
    await new CollabLog(() => dir).setCursor(COORD, 's1', 4)
    await new CollabLog(() => dir).setCursor(COORD, 's2', 7)
    const reader = new CollabLog(() => dir)
    expect(await reader.cursor(COORD, 's1')).toBe(4)
    expect(await reader.cursor(COORD, 's2')).toBe(7)
  })
})
