/**
 * `@nexgent/sdk` — the in-process API the CLI and the desktop app share:
 * the frozen interface (`api.ts`) and its implementation (`createSdk`).
 */
export * from './api.js'
export { createSdk, LocalNexgentSdk, READ_TEXT_MAX_BYTES, writeDefaultConfig } from './sdk.js'
export type { LocalSdkOptions, ProjectAgentEvent, StartedTurn, StartTurnInput } from './sdk.js'
export { bootProjectApp, COMPACTION_THRESHOLD_ENV, ROOT_SESSION_RECOVERIES, step2ProfileRows, step3ProfileRows, step4ProfileRows, step5ProfileRows } from './boot.js'
export type { BootOptions, SessionRecovery } from './boot.js'
export { EXPORT_FILES, EXPORT_FORMAT_VERSION, REDACTED, redactSecrets, writeExportBundle } from './export.js'
export type { ExportInput } from './export.js'
export { listProjectFiles } from './files.js'
export { checkRetryOf, collaborationView, historyItems, memberRunView, runKey, sessionSummary, turnUsage } from './history.js'
export { COORDINATOR_NOTES_FILE, COORDINATOR_PROMPT, OBSERVATIONS_LEAD, coordinatorProvider, coordinatorSections, projectNotesTool, UPDATE_PROJECT_NOTES_DESCRIPTION, LIST_THREADS_DESCRIPTION, MESSAGE_THREAD_DESCRIPTION, READ_THREAD_DESCRIPTION, SdkThreadHost, START_THREAD_DESCRIPTION, THREADS_PLUGIN_NAME, checkPlan, collabProvider, ownsOverlap, peerTools, taskCollaboration, threadInfoOf, threadRunName, threadStatusOf, threadsPlugin, threadTools } from './threads.js'
export type { SdkThreadHostOptions, ThreadRuntime } from './threads.js'
export { findPatterns, loopNote, loopsOf, mergeObservations, OBSERVATION_PROMPT, observationLines, observationRequest, parseSuggestions, ProjectMemory, taskFacts, type FoundPattern, type ProjectMemoryOptions, type TaskFactsInput } from './memory.js'
export { RECENT_PROJECTS_FILE, RECENT_PROJECTS_LIMIT, RecentProjects } from './recent.js'
export type { RecentProjectEntry } from './recent.js'
export { describeApiKey, readSettings, secretValues, setApiKey, updateSettings } from './settings.js'
export type { CredentialEnv } from './settings.js'
export { CollabLog, collabDelivery, collabRelevance, currentTaskEntries, hopsOf, logEvents, readerPaths, renderCollabEntry, taskStartSeq, waitCycle, type CollabDeliveryInput, type CollabLogOptions, type CollabReader, type LogEvents, type LogEventsInput } from './collab.js'
