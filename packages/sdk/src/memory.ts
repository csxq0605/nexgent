/**
 * Project memory (user, 2026-11-07): while tasks run, the host keeps what it
 * counted about the project, finds problems that keep coming back, and tells
 * the user with the evidence; the user decides what to keep.
 *
 * - {@link taskFacts} (pure): one task's facts from the run records: the
 *   user's corrections, the files the threads had trouble with, how the
 *   split went, calls that failed again and again.
 * - {@link findPatterns} (pure): the recurring patterns of the latest tasks,
 *   by counts and thresholds the host fixes ({@link PROJECT_MEMORY_LIMITS}).
 * - {@link mergeObservations} (pure): patterns found again keep their id and
 *   the user's decision; a dismissed one is never shown again.
 * - {@link ProjectMemory}: the files (`<dataDir>/memory/`), one model request
 *   per task end that found something new (a suggestion in one or two
 *   sentences; without it the observation still shows its evidence), and
 *   the user's decisions.
 *
 * Counting never asks a model; spend and time are recorded, never judged.
 */
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import {
  OBSERVATIONS_FILE,
  PROJECT_MEMORY_DIR,
  PROJECT_MEMORY_LIMITS,
  TASK_FACTS_FILE,
  type CollabEntry,
  type LLMProvider,
  type ObservationEvidence,
  type ObservationKind,
  type ObservationsFile,
  type ObservationStatus,
  type ObservationTask,
  type ProjectObservation,
  type SessionRecord,
  type TaskCorrection,
  type TaskFacts,
  type TaskFileFacts,
  type TaskLoop,
} from '@nexgent/kernel'
import { jaccard, termSet } from '@nexgent/capabilities'
import { asksRedo, withinOwns } from '@nexgent/workflow'

const L = PROJECT_MEMORY_LIMITS

function cut(text: string, max: number): string {
  const chars = [...text.replace(/\s+/g, ' ').trim()]
  return chars.length <= max ? chars.join('') : `${chars.slice(0, max - 1).join('')}…`
}

function slash(path: string): string {
  return path.replace(/\\/g, '/').replace(/^\.\//, '')
}

function args(call: { readonly arguments: string }): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(call.arguments)
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
  } catch {
    return {}
  }
}

/** Whether a message says enough to be compared with others. */
function meaningful(text: string): boolean {
  return termSet(text).size >= L.minCorrectionTerms
}

/** Files a session read again, unchanged, in one of `turns` (successful reads of the same range, no write between). */
function rereadPaths(records: readonly SessionRecord[], turns: ReadonlySet<number>): Set<string> {
  const failed = new Set<string>()
  for (const record of records) if (record.type === 'tool.result' && turns.has(record.turn) && record.isError) failed.add(record.toolCallId)
  const again = new Set<string>()
  for (const turn of turns) {
    const reads = new Map<string, Set<string>>()
    for (const record of records) {
      if (record.type !== 'assistant.message' || record.turn !== turn) continue
      for (const call of record.toolCalls ?? []) {
        const input = args(call)
        if (typeof input.path !== 'string' || input.path === '') continue
        const path = slash(input.path)
        if (call.name === 'read_file') {
          if (failed.has(call.id)) continue
          const range = JSON.stringify([input.offset ?? null, input.limit ?? null])
          const seen = reads.get(path) ?? new Set<string>()
          if (seen.has(range)) again.add(path)
          seen.add(range)
          reads.set(path, seen)
        } else if (call.name === 'write_file' || call.name === 'str_replace') {
          reads.delete(path)
        }
      }
    }
  }
  return again
}

/**
 * Pure: the same call (tool and input) failing with the same error at least
 * {@link PROJECT_MEMORY_LIMITS.stuckRepeats} times in a turn of `turns`.
 */
export function loopsOf(records: readonly SessionRecord[], turns: ReadonlySet<number>, who: string): TaskLoop[] {
  const calls = new Map<string, { readonly name: string; readonly input: string }>()
  for (const record of records) {
    if (record.type !== 'assistant.message' || !turns.has(record.turn)) continue
    for (const call of record.toolCalls ?? []) calls.set(call.id, { name: call.name, input: JSON.stringify(args(call)) })
  }
  const counts = new Map<string, { tool: string; code?: string; count: number }>()
  for (const record of records) {
    if (record.type !== 'tool.result' || !turns.has(record.turn) || !record.isError) continue
    const call = calls.get(record.toolCallId)
    if (call === undefined) continue
    const code = record.error?.code
    const key = `${record.turn}\u0000${call.name}\u0000${call.input}\u0000${code ?? ''}`
    const item = counts.get(key) ?? { tool: call.name, ...(code === undefined ? {} : { code }), count: 0 }
    item.count += 1
    counts.set(key, item)
  }
  const out: TaskLoop[] = []
  for (const item of counts.values()) {
    if (item.count < L.stuckRepeats) continue
    const same = out.find(loop => loop.tool === item.tool && loop.code === item.code)
    if (same === undefined) out.push({ who, tool: item.tool, ...(item.code === undefined ? {} : { code: item.code }), count: item.count })
  }
  return out
}

/** What {@link taskFacts} reads. */
export interface TaskFactsInput {
  readonly coordinatorSessionId: string
  /** The coordinator turn the user started, and the turns of the task. */
  readonly owner: number
  readonly turns: ReadonlySet<number>
  readonly records: readonly SessionRecord[]
  /** The threads' records, by session id. */
  readonly children: ReadonlyMap<string, readonly SessionRecord[]>
  readonly completed: boolean | 'unknown'
  readonly checkFailed: boolean
  readonly idle: number
  readonly unanswered: number
  readonly usd?: number
  readonly ms?: number
  readonly at: string
}

/** Pure: one task's facts, from the coordinator's and the threads' records. */
export function taskFacts(input: TaskFactsInput): TaskFacts {
  const { records, turns } = input
  const first = records.find(record => record.type === 'user.message' && record.source === 'user' && record.turn === input.owner)
  const startTs = first?.ts ?? ''
  const corrections: TaskCorrection[] = []
  // The task's first message says the previous result was wrong: that result is redone.
  const earlier = records.some(record => record.type === 'user.message' && record.source === 'user' && record.turn < input.owner)
  if (first?.type === 'user.message' && earlier && asksRedo(first.content)) corrections.push({ text: cut(first.content, L.quoteChars), to: 'coordinator', kind: 'redo', at: first.ts })
  const seen = new Set<number>()
  for (const record of records) {
    if (record.type !== 'user.message' || record.source === 'inject') continue
    const opening = !seen.has(record.turn)
    seen.add(record.turn)
    if (record.source === 'user' && turns.has(record.turn) && !opening && meaningful(record.content)) corrections.push({ text: cut(record.content, L.quoteChars), to: 'coordinator', kind: 'mid', at: record.ts })
  }
  const titles = new Map<string, string>()
  for (const [id, child] of input.children) {
    const start = child[0]
    titles.set(id, start?.type === 'session.start' && start.thread !== undefined ? start.thread.title : id)
  }
  // Each thread's own turns of this task, and what the user said to it directly meanwhile.
  const childTurns = new Map<string, Set<number>>()
  for (const record of records) {
    if (record.type !== 'subagent.start' || record.executionForm !== 'thread' || !turns.has(record.turn)) continue
    const set = childTurns.get(record.childSessionId) ?? new Set<number>()
    set.add(record.childTurn)
    childTurns.set(record.childSessionId, set)
  }
  for (const [id, child] of input.children) {
    for (const record of child) {
      if (record.type === 'user.message' && record.source === 'user' && record.ts >= startTs && meaningful(record.content)) {
        corrections.push({ text: cut(record.content, L.quoteChars), to: titles.get(id) ?? id, kind: 'mid', at: record.ts })
      }
    }
  }
  // Files: who brought each in, conflicts, outside the thread's files, read again.
  const files = new Map<string, { threads: Set<string>; conflicts: number; outside: boolean; reread: boolean }>()
  const file = (path: string) => {
    const key = slash(path)
    const item = files.get(key) ?? { threads: new Set<string>(), conflicts: 0, outside: false, reread: false }
    files.set(key, item)
    return item
  }
  for (const record of records) {
    if (record.type !== 'subagent.end' || !childTurns.get(record.childSessionId)?.has(record.childTurn)) continue
    const merge = record.result.merge
    if (merge === undefined) continue
    const title = titles.get(record.childSessionId) ?? record.childSessionId
    const start = input.children.get(record.childSessionId)?.[0]
    const owns = start?.type === 'session.start' ? start.thread?.owns : undefined
    for (const conflict of merge.conflicts) file(conflict.path).conflicts += 1
    if (merge.held === true) continue
    for (const path of merge.applied) {
      if (merge.conflicts.some(conflict => conflict.path === path)) continue
      const item = file(path)
      item.threads.add(title)
      if (owns !== undefined && owns.length > 0 && !withinOwns(path, owns)) item.outside = true
    }
  }
  const loops: TaskLoop[] = [...loopsOf(records, turns, 'coordinator')]
  for (const [id, child] of input.children) {
    const own = childTurns.get(id) ?? new Set<number>()
    for (const path of rereadPaths(child, own)) file(path).reread = true
    loops.push(...loopsOf(child, own, titles.get(id) ?? id))
  }
  const trouble = (item: { threads: Set<string>; conflicts: number; outside: boolean; reread: boolean }) => item.conflicts * 2 + (item.threads.size > 1 ? 2 : 0) + (item.outside ? 1 : 0) + (item.reread ? 1 : 0)
  const kept: TaskFileFacts[] = [...files.entries()]
    .sort((a, b) => trouble(b[1]) - trouble(a[1]) || a[0].localeCompare(b[0]))
    .slice(0, L.filesPerTask)
    .map(([path, item]) => ({ path, threads: [...item.threads].sort(), conflicts: item.conflicts, outside: item.outside, reread: item.reread }))
  return {
    formatVersion: 1,
    key: `${input.coordinatorSessionId}:${input.owner}`,
    coordinatorSessionId: input.coordinatorSessionId,
    turn: input.owner,
    at: input.at,
    task: first?.type === 'user.message' ? cut(first.content, L.taskChars) : '',
    threads: childTurns.size,
    completed: input.completed,
    checkFailed: input.checkFailed,
    idle: input.idle,
    unanswered: input.unanswered,
    corrections,
    files: kept,
    loops,
    ...(input.usd === undefined ? {} : { usd: input.usd }),
    ...(input.ms === undefined ? {} : { ms: input.ms }),
  }
}

/** A pattern the host found. */
export interface FoundPattern {
  readonly kind: ObservationKind
  readonly key: string
  readonly evidence: ObservationEvidence
}

function taskOf(facts: TaskFacts): ObservationTask {
  return { key: facts.key, at: facts.at, task: facts.task }
}

/** Whether a file had trouble in a task. */
function troubled(item: TaskFileFacts): boolean {
  return item.conflicts > 0 || item.threads.length > 1 || item.outside || item.reread
}

function parentOf(path: string): string {
  const at = path.lastIndexOf('/')
  return at <= 0 ? '' : path.slice(0, at)
}

/**
 * Pure: the recurring patterns of the latest {@link PROJECT_MEMORY_LIMITS.window}
 * tasks (`facts` oldest first):
 *
 * - `drift`: the user said the same thing (term similarity at least
 *   `sameSimilarity`) while the work ran, or asked for it to be redone, in
 *   `driftTasks` different tasks or more;
 * - `hotspot`: a file had trouble (conflicts, two threads bringing it in,
 *   brought in outside a thread's files, read again unchanged) in
 *   `hotspotTasks` tasks or more; two or more such files under one
 *   directory are one pattern about the directory;
 * - `split`: of the tasks with two or more threads, `splitTasks` or more
 *   (and at least half) ended with the final check failing, a thread
 *   waiting for another, a message unanswered, a conflict, or not done;
 * - `stuck`: the same failing call looped on the same tool in `stuckTasks`
 *   tasks or more.
 */
export function findPatterns(all: readonly TaskFacts[]): FoundPattern[] {
  const facts = all.slice(-L.window)
  const out: FoundPattern[] = []

  // drift: group corrections that say the same thing.
  const groups: { terms: Set<string>[]; items: { facts: TaskFacts; correction: TaskCorrection }[] }[] = []
  for (const item of facts) {
    for (const correction of item.corrections) {
      const terms = termSet(correction.text)
      const group = groups.find(candidate => candidate.terms.some(other => jaccard(terms, other) >= L.sameSimilarity))
      if (group === undefined) groups.push({ terms: [terms], items: [{ facts: item, correction }] })
      else {
        group.terms.push(terms)
        group.items.push({ facts: item, correction })
      }
    }
  }
  for (const group of groups) {
    const tasks = [...new Map(group.items.map(item => [item.facts.key, item.facts])).values()]
    if (tasks.length < L.driftTasks) continue
    const quotes = [...new Set([...group.items].reverse().map(item => item.correction.text))]
    out.push({ kind: 'drift', key: [...group.terms[0]!].sort().join(' '), evidence: { tasks: [...tasks].reverse().map(taskOf), quotes } })
  }

  // hotspot: files, then directories with two or more of them.
  const byFile = new Map<string, { tasks: TaskFacts[]; conflicts: number; threads: number; outside: number; reread: number }>()
  for (const item of facts) {
    for (const entry of item.files) {
      if (!troubled(entry)) continue
      const hot = byFile.get(entry.path) ?? { tasks: [], conflicts: 0, threads: 0, outside: 0, reread: 0 }
      if (!hot.tasks.includes(item)) hot.tasks.push(item)
      hot.conflicts += entry.conflicts
      hot.threads += entry.threads.length > 1 ? 1 : 0
      hot.outside += entry.outside ? 1 : 0
      hot.reread += entry.reread ? 1 : 0
      byFile.set(entry.path, hot)
    }
  }
  const hotFiles = [...byFile.entries()].filter(([, hot]) => hot.tasks.length >= L.hotspotTasks)
  const byDir = new Map<string, string[]>()
  for (const [path] of hotFiles) {
    const dir = parentOf(path)
    if (dir !== '') byDir.set(dir, [...(byDir.get(dir) ?? []), path])
  }
  const grouped = new Set<string>()
  for (const [dir, paths] of byDir) {
    if (paths.length < 2) continue
    paths.forEach(path => grouped.add(path))
    const hots = paths.map(path => byFile.get(path)!)
    const tasks = facts.filter(item => hots.some(hot => hot.tasks.includes(item)))
    out.push({
      kind: 'hotspot',
      key: `${dir}/`,
      evidence: {
        tasks: [...tasks].reverse().map(taskOf),
        files: paths.sort(),
        trouble: hots.reduce((sum, hot) => ({ conflicts: sum.conflicts + hot.conflicts, threads: sum.threads + hot.threads, outside: sum.outside + hot.outside, reread: sum.reread + hot.reread }), { conflicts: 0, threads: 0, outside: 0, reread: 0 }),
      },
    })
  }
  for (const [path, hot] of hotFiles) {
    if (grouped.has(path)) continue
    out.push({ kind: 'hotspot', key: path, evidence: { tasks: [...hot.tasks].reverse().map(taskOf), files: [path], trouble: { conflicts: hot.conflicts, threads: hot.threads, outside: hot.outside, reread: hot.reread } } })
  }

  // split: tasks with two or more threads whose split went wrong.
  const split = facts.filter(item => item.threads >= 2)
  const wrong = split.filter(item => item.checkFailed || item.idle > 0 || item.unanswered > 0 || item.completed === false || item.files.some(entry => entry.conflicts > 0))
  if (wrong.length >= L.splitTasks && wrong.length * 2 >= split.length) {
    out.push({
      kind: 'split',
      key: 'split',
      evidence: {
        tasks: [...wrong].reverse().map(taskOf),
        of: split.length,
        problems: {
          checkFailed: wrong.filter(item => item.checkFailed).length,
          idle: wrong.filter(item => item.idle > 0).length,
          unanswered: wrong.filter(item => item.unanswered > 0).length,
          conflicts: wrong.filter(item => item.files.some(entry => entry.conflicts > 0)).length,
          notDone: wrong.filter(item => item.completed === false).length,
        },
      },
    })
  }

  // stuck: the same tool looping in several tasks.
  const byTool = new Map<string, { tasks: TaskFacts[]; code?: string }>()
  for (const item of facts) {
    for (const loop of item.loops) {
      const entry = byTool.get(loop.tool) ?? { tasks: [], ...(loop.code === undefined ? {} : { code: loop.code }) }
      if (!entry.tasks.includes(item)) entry.tasks.push(item)
      byTool.set(loop.tool, entry)
    }
  }
  for (const [tool, entry] of byTool) {
    if (entry.tasks.length < L.stuckTasks) continue
    out.push({ kind: 'stuck', key: tool, evidence: { tasks: [...entry.tasks].reverse().map(taskOf), tool, ...(entry.code === undefined ? {} : { code: entry.code }) } })
  }
  return out
}

/** Whether a found pattern is the one an observation keeps. */
function samePattern(observation: ProjectObservation, found: FoundPattern): boolean {
  if (observation.kind !== found.kind) return false
  if (observation.key === found.key) return true
  if (found.kind !== 'drift') return false
  const quotes = observation.evidence.quotes ?? []
  return (found.evidence.quotes ?? []).some(quote => quotes.some(other => jaccard(termSet(quote), termSet(other)) >= L.sameSimilarity))
}

/**
 * Pure: the observations after a task's end found `found`. A pattern found
 * again keeps its id, status and suggestion and gets the new evidence; a
 * new one is `open`. Returns the ids of new observations (they get a
 * suggestion) and keeps at most {@link PROJECT_MEMORY_LIMITS.kept}.
 */
export function mergeObservations(existing: readonly ProjectObservation[], found: readonly FoundPattern[], taskKey: string, at: string, id: () => string = randomUUID): { readonly observations: ProjectObservation[]; readonly fresh: string[] } {
  const observations = [...existing]
  const fresh: string[] = []
  for (const pattern of found) {
    const index = observations.findIndex(observation => samePattern(observation, pattern))
    if (index >= 0) {
      const old = observations[index]!
      if (JSON.stringify(old.evidence.tasks.map(task => task.key)) === JSON.stringify(pattern.evidence.tasks.map(task => task.key))) continue
      observations[index] = { ...old, evidence: pattern.evidence, taskKey, updatedAt: at }
      continue
    }
    const created: ProjectObservation = { id: id(), kind: pattern.kind, key: pattern.key, evidence: pattern.evidence, status: 'open', taskKey, createdAt: at, updatedAt: at }
    observations.push(created)
    fresh.push(created.id)
  }
  // Keep the latest; open ones first when cutting.
  const sorted = observations.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  return { observations: sorted.slice(0, L.kept), fresh: fresh.filter(fid => sorted.slice(0, L.kept).some(observation => observation.id === fid)) }
}

/**
 * Pure: the coordinator's lines about the project's hotspots and splits it
 * has not been told to ignore (so it can split around them), at most five.
 */
export function observationLines(observations: readonly ProjectObservation[]): string[] {
  const lines: string[] = []
  for (const observation of observations) {
    if (observation.status === 'dismissed' || (observation.kind !== 'hotspot' && observation.kind !== 'split')) continue
    const tasks = observation.evidence.tasks.length
    if (observation.kind === 'hotspot') {
      const trouble = observation.evidence.trouble
      const kinds = trouble === undefined ? '' : [trouble.conflicts > 0 ? `${trouble.conflicts} merge conflicts` : '', trouble.threads > 0 ? `several threads changed it ${trouble.threads} times` : '', trouble.outside > 0 ? `changed outside a thread's files ${trouble.outside} times` : '', trouble.reread > 0 ? `read again unchanged ${trouble.reread} times` : ''].filter(part => part !== '').join(', ')
      lines.push(`- ${observation.key}: trouble in ${tasks} of the latest tasks${kinds === '' ? '' : ` (${kinds})`}. Give it to one thread at a time.`)
    } else {
      const p = observation.evidence.problems
      const kinds = p === undefined ? '' : [p.checkFailed > 0 ? `the final check failed ${p.checkFailed} times` : '', p.idle > 0 ? `threads waited for each other ${p.idle} times` : '', p.unanswered > 0 ? `messages went unanswered ${p.unanswered} times` : '', p.conflicts > 0 ? `conflicts ${p.conflicts} times` : '', p.notDone > 0 ? `not done ${p.notDone} times` : ''].filter(part => part !== '').join(', ')
      lines.push(`- Splitting into threads went wrong in ${tasks} of ${observation.evidence.of ?? tasks} recent tasks with two or more threads${kinds === '' ? '' : ` (${kinds})`}.${observation.rule !== undefined && observation.status === 'adopted' ? '' : ' Prefer fewer threads with clearly separate files.'}`)
    }
    if (lines.length === 5) break
  }
  return lines
}

/**
 * Pure: a note for the model when its latest calls are the same call
 * failing the same way {@link PROJECT_MEMORY_LIMITS.stuckRepeats} times in a
 * row (`undefined` otherwise).
 */
export function loopNote(records: readonly SessionRecord[]): { readonly note: string; readonly at: number } | undefined {
  const calls = new Map<string, string>()
  const results: { key: string; isError: boolean; code?: string; seq: number; name: string }[] = []
  let turn = 0
  for (const record of records) if (record.type === 'turn.start') turn = record.turn
  for (const record of records) {
    if (!('turn' in record) || record.turn !== turn) continue
    if (record.type === 'assistant.message') for (const call of record.toolCalls ?? []) calls.set(call.id, `${call.name}\u0000${JSON.stringify(args(call))}`)
    if (record.type === 'tool.result') results.push({ key: calls.get(record.toolCallId) ?? record.toolCallId, isError: record.isError, ...(record.error?.code === undefined ? {} : { code: record.error.code }), seq: record.seq, name: record.name })
  }
  const tail = results.slice(-L.stuckRepeats)
  if (tail.length < L.stuckRepeats) return undefined
  const head = tail[0]!
  if (!tail.every(result => result.isError && result.key === head.key && result.code === head.code)) return undefined
  return {
    at: tail.at(-1)!.seq,
    note: `The last ${L.stuckRepeats} calls of ${head.name} had the same input and failed the same way${head.code === undefined ? '' : ` (${head.code})`}. Do not repeat it: change the approach, or say what blocks you.`,
  }
}

/** What {@link ProjectMemory} needs. */
export interface ProjectMemoryOptions {
  /** The project's data directory. */
  readonly dataDir: string
  /** The model client and model for the one suggestion request; leave out to write none. */
  readonly llm?: () => { readonly llm: LLMProvider; readonly model: string } | undefined
  /** New or changed observations (the windows refresh). */
  readonly onChange?: () => void
  readonly now?: () => Date
}

/** The suggestion request's output budget. */
const SUGGESTION_MAX_TOKENS = 1_200

/** The system prompt of the suggestion request. */
export const OBSERVATION_PROMPT = [
  'You help a user understand problems that keep coming back in their project. The host counted each pattern from the run records; the counts are facts.',
  'For each pattern, write one or two plain sentences: what it probably means and what to do about it. Write in the language of the user\'s quoted words and task messages.',
  'For a "drift" pattern (the user kept saying the same thing), also give "rule": one short line saying, in the user\'s own words and values, what should hold from now on, and "appliesTo" only if the words name a narrower range.',
  'For a "split" pattern (splitting work into threads kept going wrong), also give "rule": one short line on how to split this kind of work next time.',
  'Base everything on the evidence given; do not invent files, values or causes. Reply with JSON only: {"items":[{"id":"…","suggestion":"…","rule":"…","appliesTo":"…"}]}.',
].join('\n')

/** Pure: the user message of the suggestion request. */
export function observationRequest(observations: readonly ProjectObservation[]): string {
  return JSON.stringify({
    patterns: observations.map(observation => ({
      id: observation.id,
      kind: observation.kind,
      key: observation.key,
      tasks: observation.evidence.tasks.map(task => task.task),
      ...(observation.evidence.quotes === undefined ? {} : { quotes: observation.evidence.quotes }),
      ...(observation.evidence.files === undefined ? {} : { files: observation.evidence.files }),
      ...(observation.evidence.trouble === undefined ? {} : { trouble: observation.evidence.trouble }),
      ...(observation.evidence.problems === undefined ? {} : { problems: observation.evidence.problems, of: observation.evidence.of }),
      ...(observation.evidence.tool === undefined ? {} : { tool: observation.evidence.tool, code: observation.evidence.code }),
    })),
  }, null, 1)
}

/** Pure: the suggestions of a reply, by observation id (bad items are dropped). */
export function parseSuggestions(reply: string): Map<string, { suggestion?: string; rule?: string; appliesTo?: string }> {
  const out = new Map<string, { suggestion?: string; rule?: string; appliesTo?: string }>()
  const start = reply.indexOf('{')
  const end = reply.lastIndexOf('}')
  if (start < 0 || end <= start) return out
  let value: unknown
  try {
    value = JSON.parse(reply.slice(start, end + 1))
  } catch {
    return out
  }
  const items = (value as { items?: unknown }).items
  if (!Array.isArray(items)) return out
  const text = (raw: unknown, max: number) => (typeof raw === 'string' && raw.trim() !== '' ? cut(raw, max) : undefined)
  for (const item of items) {
    if (item === null || typeof item !== 'object') continue
    const record = item as Record<string, unknown>
    if (typeof record.id !== 'string') continue
    const suggestion = text(record.suggestion, L.suggestionChars)
    const rule = text(record.rule, 600)
    const appliesTo = text(record.appliesTo, 120)
    out.set(record.id, { ...(suggestion === undefined ? {} : { suggestion }), ...(rule === undefined ? {} : { rule }), ...(appliesTo === undefined ? {} : { appliesTo }) })
  }
  return out
}

/** The project's memory files and the user's decisions on observations. */
export class ProjectMemory {
  readonly #options: ProjectMemoryOptions
  #chain: Promise<unknown> = Promise.resolve()
  readonly #jobs = new Set<{ readonly controller: AbortController; readonly done: Promise<void> }>()

  constructor(options: ProjectMemoryOptions) {
    this.#options = options
  }

  get dir(): string {
    return join(this.#options.dataDir, PROJECT_MEMORY_DIR)
  }

  #now(): string {
    return (this.#options.now?.() ?? new Date()).toISOString()
  }

  /** One writer at a time. */
  #serial<T>(work: () => Promise<T>): Promise<T> {
    const next = this.#chain.then(work, work)
    this.#chain = next.catch(() => undefined)
    return next
  }

  async #write(file: string, text: string): Promise<void> {
    await mkdir(dirname(file), { recursive: true })
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
    await writeFile(tmp, text, 'utf8')
    await rename(tmp, file)
  }

  /** The tasks' facts, oldest first, one per task (the latest line of a task wins). */
  async facts(): Promise<TaskFacts[]> {
    let text: string
    try {
      text = await readFile(join(this.dir, TASK_FACTS_FILE), 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
    const byKey = new Map<string, TaskFacts>()
    for (const line of text.split('\n')) {
      if (line.trim() === '') continue
      try {
        const facts = JSON.parse(line) as TaskFacts
        if (facts?.formatVersion !== 1 || typeof facts.key !== 'string') continue
        byKey.delete(facts.key)
        byKey.set(facts.key, facts)
      } catch {
        // a torn last line is skipped
      }
    }
    return [...byKey.values()]
  }

  /** The observations, latest change first. */
  async observations(): Promise<ProjectObservation[]> {
    try {
      const file = JSON.parse(await readFile(join(this.dir, OBSERVATIONS_FILE), 'utf8')) as ObservationsFile
      return Array.isArray(file?.observations) ? [...file.observations] : []
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT' || error instanceof SyntaxError) return []
      throw error
    }
  }

  async #saveObservations(observations: readonly ProjectObservation[]): Promise<void> {
    const file: ObservationsFile = { formatVersion: 1, observations }
    await this.#write(join(this.dir, OBSERVATIONS_FILE), `${JSON.stringify(file, null, 2)}\n`)
  }

  /**
   * A task ended: keep its facts, look for patterns, keep what is new, and
   * (in the background) ask for a suggestion on the new ones.
   * Resolves once the facts and observations are written.
   */
  async noteTask(facts: TaskFacts): Promise<void> {
    const fresh = await this.#serial(async () => {
      const all = [...(await this.facts()).filter(item => item.key !== facts.key), facts].slice(-L.factsKept)
      await this.#write(join(this.dir, TASK_FACTS_FILE), all.map(item => JSON.stringify(item)).join('\n') + '\n')
      const before = await this.observations()
      const merged = mergeObservations(before, findPatterns(all), facts.key, this.#now())
      if (merged.observations.length === before.length && merged.fresh.length === 0 && JSON.stringify(merged.observations) === JSON.stringify(before)) return []
      await this.#saveObservations(merged.observations)
      this.#options.onChange?.()
      return merged.observations.filter(observation => merged.fresh.includes(observation.id))
    })
    if (fresh.length > 0) this.#suggest(fresh)
  }

  /** One request for the new observations' suggestions; a failure leaves them with their evidence only. */
  #suggest(fresh: readonly ProjectObservation[]): void {
    const client = this.#options.llm?.()
    if (client === undefined) return
    const controller = new AbortController()
    const done = (async () => {
      let text = ''
      let failed = false
      for await (const event of client.llm.complete({
        requestId: randomUUID(),
        model: client.model,
        thinking: 'off',
        maxTokens: SUGGESTION_MAX_TOKENS,
        messages: [
          { role: 'system', content: OBSERVATION_PROMPT },
          { role: 'user', content: observationRequest(fresh.slice(0, L.shown)) },
        ],
        signal: controller.signal,
      }, { purpose: 'auxiliary' })) {
        if (event.type === 'text.delta') text += event.text
        else if (event.type === 'error') failed = true
      }
      if (failed || controller.signal.aborted) return
      const suggestions = parseSuggestions(text)
      if (suggestions.size === 0) return
      await this.#serial(async () => {
        const observations = await this.observations()
        const next = observations.map(observation => {
          const got = suggestions.get(observation.id)
          if (got === undefined || observation.suggestion !== undefined) return observation
          const rule = observation.kind === 'drift' || observation.kind === 'split' ? got.rule : undefined
          return { ...observation, ...(got.suggestion === undefined ? {} : { suggestion: got.suggestion }), ...(rule === undefined ? {} : { rule }), ...(rule === undefined || got.appliesTo === undefined ? {} : { appliesTo: got.appliesTo }) }
        })
        await this.#saveObservations(next)
      })
      this.#options.onChange?.()
    })().catch(() => undefined)
    const job = { controller, done }
    this.#jobs.add(job)
    void done.finally(() => this.#jobs.delete(job))
  }

  /** Settles once no suggestion request is running. */
  async idle(): Promise<void> {
    while (this.#jobs.size > 0) await Promise.allSettled([...this.#jobs].map(job => job.done))
    await this.#chain
  }

  get busy(): boolean {
    return this.#jobs.size > 0
  }

  /** Stop the running requests (the project closes). */
  async dispose(): Promise<void> {
    for (const job of this.#jobs) job.controller.abort()
    await Promise.allSettled([...this.#jobs].map(job => job.done))
  }

  /** The user's decision on an observation (`entryId`: what they kept from it). */
  async setStatus(id: string, status: ObservationStatus, entryId?: string): Promise<ProjectObservation | undefined> {
    const changed = await this.#serial(async () => {
      const observations = await this.observations()
      const index = observations.findIndex(observation => observation.id === id)
      if (index < 0) return undefined
      const next = { ...observations[index]!, status, updatedAt: this.#now(), ...(entryId === undefined ? {} : { entryId }) }
      observations[index] = next
      await this.#saveObservations(observations)
      return next
    })
    if (changed !== undefined) this.#options.onChange?.()
    return changed
  }
}
