/**
 * Follow-up policies of the bench harness: after `nexgent run` ends, decide
 * whether to send the session one more user message with
 * `nexgent resume <sessionId> --task <text>`. They live here, outside
 * Nexgent: the product only offers its usual interface (a session that can be
 * resumed with a new message, and the `--json` event stream to read), and
 * the harness plays the user, the way other agent benchmarks send a fixed
 * "please continue" reply (OpenHands `fake_user_response`) or check for a
 * submit word (mini-SWE-agent).
 *
 * Policies (`--followup a,b`; none by default):
 * - `run-reminder`: the run changed code and ran nothing afterwards (from
 *   its `tool.start` events), so ask once to run a reproduction and the
 *   existing tests before finishing;
 * - `auto-continue[:N]` (N defaults to 3): while the last reply does not
 *   contain `TASK_COMPLETE`, ask to keep working and to reply with that word
 *   once done, at most N times.
 *
 * The policies only read the events; both are measurement conditions, not
 * product behavior.
 */

export const COMPLETE_WORD = 'TASK_COMPLETE'

export const RUN_REMINDER_TEXT = 'You changed code and have not run anything since. Before you finish, run a short reproduction of the task\'s problem and the existing tests that cover the code you changed, and fix what fails.'

export const AUTO_CONTINUE_TEXT = `Please continue working on the task on whatever approach you think is suitable. When you are sure you have solved it, reply with the single word ${COMPLETE_WORD} and no tool calls. You should never ask for human help.`

/** Parse `--followup run-reminder,auto-continue:3`. Throws on an unknown policy. */
export function parseFollowups(spec) {
  const policies = { runReminder: false, autoContinue: 0 }
  for (const part of (spec ?? '').split(',').map(s => s.trim()).filter(Boolean)) {
    const [name, count] = part.split(':')
    if (name === 'run-reminder' && count === undefined) policies.runReminder = true
    else if (name === 'auto-continue' && (count === undefined || /^[1-9]\d*$/.test(count))) policies.autoContinue = count === undefined ? 3 : Number(count)
    else throw new Error(`unknown --followup policy: ${part} (run-reminder, auto-continue[:N])`)
  }
  return policies
}

/** Whether any policy is on. */
export function anyFollowup(policies) {
  return policies.runReminder || policies.autoContinue > 0
}

/** The JSON lines of `nexgent ... --json` output, skipping anything that is not JSON. */
export function parseEvents(stdout) {
  const events = []
  for (const line of stdout.split('\n')) {
    if (line.trim() === '') continue
    try { events.push(JSON.parse(line)) } catch { /* not an event line */ }
  }
  return events
}

/** The session id from the opening `session` event. */
export function sessionIdOf(events) {
  return events.find(event => event.type === 'session')?.sessionId
}

/** Text of the last model reply: the `text.delta`s after the last `step.start`. */
export function lastReplyText(events) {
  let text = ''
  for (const event of events) {
    if (event.type === 'step.start') text = ''
    else if (event.type === 'text.delta' && typeof event.text === 'string') text += event.text
  }
  return text
}

/** Whether, by the end of these events, code was changed and nothing was run after the change. */
export function editedSinceRun(events) {
  let edited = false
  for (const event of events) {
    if (event.type !== 'tool.start') continue
    let parsed = {}
    try { parsed = JSON.parse(event.arguments ?? '{}') ?? {} } catch { /* keep {} */ }
    const command = event.name === 'bash' || event.name === 'pwsh' ? String(parsed.command ?? '') : ''
    const edit = event.name === 'write_file' || event.name === 'str_replace' || /sed -i|<<|\.write\(|>\s*[\w./-]+\.py/.test(command)
    const ran = command !== '' && !edit && /python|pytest|runtests|\.test\(/.test(command)
    if (edit) edited = true
    if (ran) edited = false
  }
  return edited
}

/**
 * The next follow-up message, or undefined to stop. `events` are all events
 * of the instance so far (every run and resume, in order); `state` counts
 * what was sent (`{ reminded, continues }`, updated here).
 */
export function nextFollowup(policies, state, events) {
  const last = lastTurnEvents(events)
  if (last.some(event => event.type === 'turn.end' && event.reason?.kind !== 'completed')) return undefined
  if (policies.runReminder && !state.reminded && editedSinceRun(events)) {
    state.reminded = true
    return RUN_REMINDER_TEXT
  }
  if (state.continues < policies.autoContinue && !lastReplyText(last).includes(COMPLETE_WORD)) {
    state.continues += 1
    return AUTO_CONTINUE_TEXT
  }
  return undefined
}

/** The events from the last `turn.start` on. */
function lastTurnEvents(events) {
  const start = events.findLastIndex(event => event.type === 'turn.start')
  return start < 0 ? events : events.slice(start)
}
