/**
 * Project memory: what the host keeps about a project across its tasks, so
 * it can tell the user about problems that keep coming back. After each task
 * of the coordinator conversation, the host appends the task's facts (the
 * user's corrections, the files the threads had trouble with, how the split
 * went, calls that failed again and again), counted from the run records,
 * never from what a model says. From the latest tasks it finds recurring
 * patterns and keeps them as observations, each with its evidence, for the
 * user to adopt or dismiss. Nothing here changes code or rules by itself.
 *
 * Normative text: `docs/spec/data-formats.md` §项目记忆.
 */

/** Directory under the project's data directory. */
export const PROJECT_MEMORY_DIR = 'memory'
/** One {@link TaskFacts} per line, the latest line of a task key wins. */
export const TASK_FACTS_FILE = 'facts.jsonl'
/** {@link ObservationsFile}. */
export const OBSERVATIONS_FILE = 'observations.json'

/** What a recurring pattern is about. */
export type ObservationKind = 'drift' | 'hotspot' | 'split' | 'stuck'

/** Every {@link ObservationKind}. */
export const OBSERVATION_KINDS: readonly ObservationKind[] = ['drift', 'hotspot', 'split', 'stuck']

/** Where an observation stands with the user. */
export type ObservationStatus = 'open' | 'adopted' | 'dismissed'

/** Every {@link ObservationStatus}. */
export const OBSERVATION_STATUSES: readonly ObservationStatus[] = ['open', 'adopted', 'dismissed']

/** Bounds and thresholds the host uses. */
export const PROJECT_MEMORY_LIMITS = {
  /** Tasks read when looking for patterns (the latest ones). */
  window: 12,
  /** Lines `facts.jsonl` keeps (older ones are dropped when it is rewritten). */
  factsKept: 200,
  /** Characters kept of a correction, and of the task's first message. */
  quoteChars: 300,
  taskChars: 120,
  /** Files kept per task. */
  filesPerTask: 40,
  /** A correction says something only with at least this many terms. */
  minCorrectionTerms: 3,
  /** Two corrections say the same thing at this term similarity or more. */
  sameSimilarity: 0.3,
  /** Different tasks a correction must come back in to be a pattern. */
  driftTasks: 2,
  /** Different tasks a file (or directory) must have trouble in. */
  hotspotTasks: 3,
  /** Tasks with two or more threads whose split went wrong. */
  splitTasks: 2,
  /** The same failing call this many times in a row is a loop. */
  stuckRepeats: 3,
  /** Different tasks a loop on the same tool must come back in. */
  stuckTasks: 2,
  /** Observations shown at once at the end of a task. */
  shown: 3,
  /** Observations kept in the file. */
  kept: 60,
  /** Characters of a model-written suggestion. */
  suggestionChars: 400,
} as const

/** A message of the user that corrected or redid the work. */
export interface TaskCorrection {
  /** The user's words, cut to {@link PROJECT_MEMORY_LIMITS.quoteChars}. */
  readonly text: string
  /** Who it was said to: `coordinator`, or a thread's title. */
  readonly to: string
  /** `mid`: while the work ran; `redo`: the task's first message says the previous result was wrong. */
  readonly kind: 'mid' | 'redo'
  readonly at: string
}

/** What happened to one file in a task. */
export interface TaskFileFacts {
  /** Project-relative, forward slashes. */
  readonly path: string
  /** Threads that brought it into the project. */
  readonly threads: readonly string[]
  /** Merge conflicts on it. */
  readonly conflicts: number
  /** A thread brought it in outside the files it was given. */
  readonly outside: boolean
  /** Read again, unchanged, by the same thread in one turn. */
  readonly reread: boolean
}

/** The same call failing again and again in one turn. */
export interface TaskLoop {
  /** `coordinator` or a thread's title. */
  readonly who: string
  readonly tool: string
  readonly code?: string
  readonly count: number
}

/** One line of `facts.jsonl`: one task of the coordinator conversation. */
export interface TaskFacts {
  readonly formatVersion: 1
  /** `<coordinatorSessionId>:<turn the user started>`. */
  readonly key: string
  readonly coordinatorSessionId: string
  readonly turn: number
  readonly at: string
  /** The task's first message, cut. */
  readonly task: string
  /** Threads that ran in it. */
  readonly threads: number
  readonly completed: boolean | 'unknown'
  /** The final whole-project check did not pass. */
  readonly checkFailed: boolean
  /** Threads that ended waiting for another thread. */
  readonly idle: number
  /** Messages between threads, or questions to the coordinator, left without an answer. */
  readonly unanswered: number
  readonly corrections: readonly TaskCorrection[]
  readonly files: readonly TaskFileFacts[]
  readonly loops: readonly TaskLoop[]
  /** For the record only: never part of a judgement. */
  readonly usd?: number
  readonly ms?: number
}

/** One task an observation cites. */
export interface ObservationTask {
  readonly key: string
  readonly at: string
  readonly task: string
}

/** What a pattern rests on, as the host counted it. */
export interface ObservationEvidence {
  /** Tasks it came back in, latest first. */
  readonly tasks: readonly ObservationTask[]
  /** `drift`: the user's words, latest first. */
  readonly quotes?: readonly string[]
  /** `hotspot`: the files; `drift`, `stuck`: files named, if any. */
  readonly files?: readonly string[]
  /** `hotspot`: how often each kind of trouble came up. */
  readonly trouble?: { readonly conflicts: number; readonly threads: number; readonly outside: number; readonly reread: number }
  /** `split`: how often each kind of problem came up. */
  readonly problems?: { readonly checkFailed: number; readonly idle: number; readonly unanswered: number; readonly conflicts: number; readonly notDone: number }
  /** `split`: tasks with two or more threads in the window. */
  readonly of?: number
  /** `stuck`: the tool and its error. */
  readonly tool?: string
  readonly code?: string
}

/** A recurring pattern kept for the user. */
export interface ProjectObservation {
  /** Lowercase uuid v4. */
  readonly id: string
  readonly kind: ObservationKind
  /** What makes two findings the same pattern: the file or directory, the tool, or `split`; for `drift` the first quote's terms. */
  readonly key: string
  readonly evidence: ObservationEvidence
  /** A model-written suggestion (one or two sentences), when one was written. */
  readonly suggestion?: string
  /** `drift`, `split`: the rule it suggests, ready to be kept as is or edited. */
  readonly rule?: string
  readonly appliesTo?: string
  readonly status: ObservationStatus
  /** The task whose end found or last updated it. */
  readonly taskKey: string
  readonly createdAt: string
  readonly updatedAt: string
  /** The entry the user kept from it. */
  readonly entryId?: string
}

/** `observations.json`. */
export interface ObservationsFile {
  readonly formatVersion: 1
  readonly observations: readonly ProjectObservation[]
}
