import { useState } from 'react'
import type { HandbookEntryView, ObservationView } from '@nexgent/sdk'
import { useAppState, useAppStore } from '../hooks.js'
import { M, dayText } from '../strings.js'
import { Icon } from './Icon.js'
import { EntryHistory, evidenceText } from './Learned.js'
import { Markdown } from './Markdown.js'

/**
 * Project memory: one page for what Nexgent keeps about the project (the
 * rules, the practices, the coordinator's notes and the observations), each
 * with where it came from, all editable; plus the two cards that ask the
 * user in the conversation (要记住吗, 项目观察).
 */

function byUser(entry: HandbookEntryView): boolean {
  return entry.sources.length === 0 && entry.quote === undefined
}

/** Below an entry: the user's words it came from and files that are gone. */
function Provenance({ entry }: { readonly entry: HandbookEntryView }): JSX.Element | null {
  if (entry.quote === undefined && (entry.missing ?? []).length === 0) return null
  return (
    <>
      {entry.quote !== undefined && <div className="muted small quote-line" data-testid="memory-quote">{M.quote(entry.quote)}</div>}
      {(entry.missing ?? []).length > 0 && <div className="small warn-text" data-testid="memory-outdated">{M.outdated(entry.missing!)}</div>}
    </>
  )
}

/** The text (and a rule's range) being written: a new entry or an edit. */
function EntryForm({ rule, text: initialText, appliesTo: initialRange, onSave, onCancel, testId }: { readonly rule: boolean; readonly text?: string; readonly appliesTo?: string; readonly onSave: (text: string, appliesTo: string) => Promise<boolean>; readonly onCancel: () => void; readonly testId: string }): JSX.Element {
  const [text, setText] = useState(initialText ?? '')
  const [appliesTo, setAppliesTo] = useState(initialRange ?? '')
  const [busy, setBusy] = useState(false)
  return (
    <form
      className="stack memory-form"
      data-testid={testId}
      onSubmit={event => {
        event.preventDefault()
        setBusy(true)
        void onSave(text, appliesTo).then(ok => {
          setBusy(false)
          if (ok) onCancel()
        })
      }}
    >
      <textarea rows={2} value={text} onChange={event => setText(event.target.value)} aria-label={rule ? M.ruleText : M.practiceText} data-testid={`${testId}-text`} autoFocus />
      {rule && <input value={appliesTo} onChange={event => setAppliesTo(event.target.value)} placeholder={M.appliesTo} aria-label={M.appliesTo} data-testid={`${testId}-range`} />}
      <div className="row">
        <button type="submit" className="primary" disabled={busy || text.trim() === ''} data-testid={`${testId}-save`}>
          {M.save}
        </button>
        <button type="button" className="ghost" onClick={onCancel}>
          {M.cancel}
        </button>
      </div>
    </form>
  )
}

/** One rule or practice: its text, range, provenance and date; edit and delete. */
function MemoryRow({ entry }: { readonly entry: HandbookEntryView }): JSX.Element {
  const store = useAppStore()
  const state = useAppState()
  const [editing, setEditing] = useState(false)
  const rule = entry.kind === 'rule'
  // A practice opens its evidence and history on click.
  const detail = state.handbookDetail?.entry.id === entry.id ? state.handbookDetail : undefined
  return (
    <li className="entry" data-testid="memory-entry" data-entry={entry.id} data-kind={rule ? 'rule' : 'practice'}>
      <span className={`dot ${rule ? 'ok' : 'learned'}`} aria-hidden="true" />
      <div className="grow">
        {editing ? (
          <EntryForm rule={rule} text={entry.text} {...(entry.appliesTo === undefined ? {} : { appliesTo: entry.appliesTo })} onSave={(text, appliesTo) => store.editMemory(entry.id, { text, appliesTo })} onCancel={() => setEditing(false)} testId="memory-edit" />
        ) : (
          <>
            {rule ? (
              <span className="entry-text">{entry.text}</span>
            ) : (
              <button type="button" className="entry-button" onClick={() => void store.toggleHandbookEntry(entry.id)} aria-expanded={detail !== undefined} data-testid="handbook-entry-open">
                <span className="entry-text">{entry.text}</span>
              </button>
            )}
            <div className="muted small">{rule ? M.ruleMeta(entry.appliesTo, dayText(entry.createdAt), byUser(entry)) : M.practiceMeta(dayText(entry.createdAt), byUser(entry))}</div>
            <Provenance entry={entry} />
            {detail !== undefined && <div className="muted small" data-testid="handbook-evidence">{evidenceText(entry)}</div>}
            {detail !== undefined && <EntryHistory keywords={detail.entry.keywords} sources={detail.entry.sources.length} ops={detail.ops} />}
          </>
        )}
      </div>
      {!editing && (
        <span className="row entry-actions">
          <button type="button" className="link small" onClick={() => setEditing(true)} data-testid="memory-edit-open">
            {M.edit}
          </button>
          <button type="button" className="link small" onClick={() => void store.setHandbookStatus(entry.id, 'retired')} data-testid="memory-delete">
            {M.delete}
          </button>
        </span>
      )}
    </li>
  )
}

/** Rules or practices in force, with a way to add one. */
export function MemoryGroup({ kind }: { readonly kind: 'rule' | 'practice' }): JSX.Element {
  const store = useAppStore()
  const all = useAppState().handbook?.entries ?? []
  const [adding, setAdding] = useState(false)
  const entries = kind === 'rule'
    ? all.filter(entry => entry.kind === 'rule' && entry.status !== 'retired' && entry.pending !== true)
    : all.filter(entry => entry.kind !== 'rule' && entry.status === 'active' && entry.scope === 'project')
  const shared = kind === 'practice' ? all.filter(entry => entry.kind !== 'rule' && entry.status === 'active' && entry.scope === 'user') : []
  const testId = kind === 'rule' ? 'memory-rules' : 'memory-practices'
  return (
    <section className="entry-group" data-testid={testId}>
      <h3 className="group-title">
        {kind === 'rule' ? M.rulesTitle : M.practicesTitle}
        {entries.length + shared.length > 0 && <span className="faint"> {entries.length + shared.length}</span>}
        <button type="button" className="link small group-action" onClick={() => setAdding(true)} data-testid={`${testId}-add`}>
          {M.add}
        </button>
      </h3>
      {adding && <EntryForm rule={kind === 'rule'} onSave={(text, appliesTo) => store.addMemory({ text, kind, appliesTo })} onCancel={() => setAdding(false)} testId="memory-add" />}
      {entries.length + shared.length > 0 && (
        <ul className="entries">
          {[...entries, ...shared].map(entry => (
            <MemoryRow key={entry.id} entry={entry} />
          ))}
        </ul>
      )}
    </section>
  )
}

/** The coordinator's notes, editable as one text. */
export function NotesSection(): JSX.Element {
  const state = useAppState()
  const store = useAppStore()
  const [draft, setDraft] = useState<string | undefined>(undefined)
  const notes = state.notes
  return (
    <section className="entry-group" data-testid="memory-notes">
      <h3 className="group-title">
        {M.notesTitle}
        {draft === undefined && (
          <button type="button" className="link small group-action" onClick={() => setDraft(notes?.text ?? '')} data-testid="memory-notes-edit">
            {M.edit}
          </button>
        )}
      </h3>
      {draft !== undefined ? (
        <form
          className="stack memory-form"
          onSubmit={event => {
            event.preventDefault()
            void store.saveNotes(draft).then(ok => {
              if (ok) setDraft(undefined)
            })
          }}
        >
          <textarea rows={8} value={draft} onChange={event => setDraft(event.target.value)} placeholder={M.notesPlaceholder} aria-label={M.notesTitle} data-testid="memory-notes-text" autoFocus />
          <div className="row">
            <button type="submit" className="primary" data-testid="memory-notes-save">
              {M.save}
            </button>
            <button type="button" className="ghost" onClick={() => setDraft(undefined)}>
              {M.cancel}
            </button>
          </div>
        </form>
      ) : notes === undefined || notes.text === '' ? (
        <p className="muted small">{M.notesEmpty}</p>
      ) : (
        <div className="memory-notes">
          <Markdown text={notes.text} />
          {notes.updatedAt !== undefined && <div className="muted small">{M.notesMeta(dayText(notes.updatedAt))}</div>}
        </div>
      )}
    </section>
  )
}

/** Deleted rules and practices, folded, each with a way back. */
export function DeletedEntries(): JSX.Element | null {
  const store = useAppStore()
  const deleted = (useAppState().handbook?.entries ?? []).filter(entry => entry.status === 'retired')
  if (deleted.length === 0) return null
  return (
    <details className="entry-group folded record" data-testid="memory-deleted">
      <summary className="group-title">
        <FoldMarks />
        {M.deletedTitle(deleted.length)}
      </summary>
      <ul className="entries">
        {deleted.map(entry => (
          <li key={entry.id} className="entry" data-testid="memory-deleted-entry" data-entry={entry.id}>
            <span className="dot" aria-hidden="true" />
            <div className="grow">
              <span className="entry-text muted">{entry.text}</span>
            </div>
            {entry.supersededBy === undefined && (
              <button type="button" className="link small" onClick={() => void store.setHandbookStatus(entry.id, 'active')} data-testid="memory-restore">
                {M.restore}
              </button>
            )}
          </li>
        ))}
      </ul>
    </details>
  )
}

// ---------------------------------------------------------------------------
// observations
// ---------------------------------------------------------------------------

/** The observation in one line, from the host's counts. */
export function observationTitle(observation: ObservationView): string {
  const n = observation.evidence.tasks.length
  switch (observation.kind) {
    case 'drift':
      return M.driftTitle(n)
    case 'hotspot':
      return M.hotspotTitle(observation.key, n)
    case 'split':
      return M.splitTitle(n, observation.evidence.of ?? n)
    case 'stuck':
      return M.stuckTitle(observation.evidence.tool ?? observation.key, n)
  }
}

function observationDetail(observation: ObservationView): string {
  const { trouble, problems, code } = observation.evidence
  if (observation.kind === 'hotspot' && trouble !== undefined) return M.hotspotDetail(trouble)
  if (observation.kind === 'split' && problems !== undefined) return M.splitDetail(problems)
  if (observation.kind === 'stuck' && code !== undefined) return code
  return ''
}

/** What keeping it as a rule or practice starts from. */
function keptText(observation: ObservationView): string {
  if (observation.rule !== undefined) return observation.rule
  if (observation.kind === 'drift') return observation.evidence.quotes?.[0] ?? ''
  if (observation.kind === 'stuck') return M.stuckPractice(observation.evidence.tool ?? observation.key)
  return observation.suggestion ?? ''
}

/** One observation: evidence, suggestion, and its one action plus 忽略. */
export function ObservationItem({ observation, compact = false }: { readonly observation: ObservationView; readonly compact?: boolean }): JSX.Element {
  const store = useAppStore()
  const [keeping, setKeeping] = useState(false)
  const detail = observationDetail(observation)
  const open = observation.status === 'open'
  const files = observation.kind === 'hotspot' && (observation.evidence.files?.length ?? 0) > 1 ? observation.evidence.files! : []
  const action = observation.kind === 'drift' ? M.keepRule : observation.kind === 'split' ? M.keepSplit : observation.kind === 'stuck' ? M.keepPractice : M.askSplit
  const tasksTip = M.tasksTip(observation.evidence.tasks.map(task => task.task))
  const show = !compact || keeping
  const tip = compact
    ? [detail, files.join('、'), ...(observation.kind === 'drift' ? (observation.evidence.quotes ?? []).slice(0, 2).map(quote => `“${quote}”`) : []), observation.suggestion ?? '', tasksTip].filter(text => text !== '').join('\n')
    : tasksTip
  return (
    <li className={`observation${compact ? ' compact' : ''}`} data-testid="observation" data-kind={observation.kind} data-status={observation.status}>
      <div className="setting-name observation-title" title={tip}>
        {observationTitle(observation)}
      </div>
      {show && detail !== '' && <div className="muted small">{detail}</div>}
      {show && files.length > 0 && <div className="muted small mono-list">{files.join('、')}</div>}
      {show && observation.kind === 'drift' && (observation.evidence.quotes ?? []).slice(0, 2).map(quote => (
        <div key={quote} className="muted small quote-line">“{quote}”</div>
      ))}
      {show && (observation.missing ?? []).length > 0 && <div className="small warn-text">{M.outdated(observation.missing!)}</div>}
      {show && observation.suggestion !== undefined && <p className="small observation-suggestion" data-testid="observation-suggestion">{observation.suggestion}</p>}
      {keeping ? (
        <EntryForm
          rule={observation.kind === 'drift' || observation.kind === 'split'}
          text={keptText(observation)}
          {...(observation.appliesTo === undefined ? {} : { appliesTo: observation.appliesTo })}
          onSave={(text, appliesTo) => store.resolveObservation(observation.id, 'adopted', { text, appliesTo })}
          onCancel={() => setKeeping(false)}
          testId="observation-keep"
        />
      ) : open ? (
        <div className="row">
          <button
            type="button"
            className="small"
            onClick={() => {
              if (observation.kind !== 'hotspot') return setKeeping(true)
              void store.askCoordinator(M.askSplitText(observation.key, observation.evidence.tasks.length, detail)).then(ok => {
                if (ok) void store.resolveObservation(observation.id, 'adopted')
              })
            }}
            data-testid="observation-act"
          >
            {action}
          </button>
          <button type="button" className="link small" onClick={() => void store.resolveObservation(observation.id, 'dismissed')} data-testid="observation-dismiss">
            {M.ignore}
          </button>
        </div>
      ) : (
        <div className="faint small">{observation.status === 'adopted' ? M.adopted : M.dismissed}</div>
      )}
    </li>
  )
}

/** On the memory page: open observations, and the handled ones folded. */
export function ObservationsSection(): JSX.Element | null {
  const all = useAppState().observations ?? []
  const open = all.filter(item => item.status === 'open')
  const handled = all.filter(item => item.status !== 'open')
  if (all.length === 0) return null
  return (
    <section className="entry-group" data-testid="memory-observations">
      {open.length > 0 && (
        <>
          <h3 className="group-title">
            {M.observationsTitle}
            <span className="faint"> {open.length}</span>
          </h3>
          <ul className="observations">
            {open.map(item => (
              <ObservationItem key={item.id} observation={item} />
            ))}
          </ul>
        </>
      )}
      {handled.length > 0 && (
        <details className="entry-group folded record">
          <summary className="group-title">
            <FoldMarks />
            {M.handledTitle(handled.length)}
          </summary>
          <ul className="observations">
            {handled.map(item => (
              <ObservationItem key={item.id} observation={item} />
            ))}
          </ul>
        </details>
      )}
    </section>
  )
}

/**
 * In the coordinator conversation, above the composer: the open
 * observations (at most three), only while there are any; 收起 hides the card
 * until the observations change.
 */
export function ObservationCard(): JSX.Element | null {
  const state = useAppState()
  const [hidden, setHidden] = useState<string | undefined>(undefined)
  const coordinator = state.sessions.find(session => session.coordinator === true)
  if (coordinator === undefined || state.sessionId !== coordinator.sessionId) return null
  const open = (state.observations ?? []).filter(item => item.status === 'open')
  const signature = open.map(item => `${item.id}:${item.updatedAt}`).join(',')
  if (open.length === 0 || hidden === signature) return null
  return (
    <aside className="observation-card" role="note" data-testid="observation-card">
      <div className="row between">
        <div className="setting-name">{M.observationsTitle}</div>
        <button type="button" className="link small" onClick={() => setHidden(signature)} data-testid="observation-card-close">
          {M.close}
        </button>
      </div>
      <ul className="observations">
        {open.slice(0, 3).map(item => (
          <ObservationItem key={item.id} observation={item} compact />
        ))}
      </ul>
    </aside>
  )
}

// ---------------------------------------------------------------------------
// the card shown with propose_memory
// ---------------------------------------------------------------------------

function proposal(args: string, content: string | undefined): { readonly text: string; readonly quote?: string; readonly appliesTo?: string; readonly entryId?: string; readonly duplicate: boolean } {
  let input: Record<string, unknown> = {}
  try {
    const parsed: unknown = JSON.parse(args)
    if (parsed !== null && typeof parsed === 'object') input = parsed as Record<string, unknown>
  } catch {
    // shown without its text
  }
  const id = /entry ([0-9a-f-]{36})/.exec(content ?? '')?.[1]
  return {
    text: typeof input.text === 'string' ? input.text : '',
    ...(typeof input.quote === 'string' ? { quote: input.quote } : {}),
    ...(typeof input.appliesTo === 'string' && input.appliesTo.trim() !== '' ? { appliesTo: input.appliesTo } : {}),
    ...(id === undefined ? {} : { entryId: id }),
    duplicate: (content ?? '').includes('already has this'),
  }
}

/** 要记住吗: the rule the conversation proposed, until the user keeps, edits or drops it. */
export function ProposalCard({ args, content, readOnly }: { readonly args: string; readonly content?: string | undefined; readonly readOnly: boolean }): JSX.Element | null {
  const state = useAppState()
  const store = useAppStore()
  const [editing, setEditing] = useState(false)
  const item = proposal(args, content)
  const entry = item.entryId === undefined ? undefined : state.handbook?.entries.find(candidate => candidate.id === item.entryId)
  const pending = entry !== undefined && entry.pending === true && entry.status !== 'retired'
  const text = entry?.text ?? item.text
  const appliesTo = entry?.appliesTo ?? item.appliesTo
  const keep = async (next: string, range: string): Promise<boolean> => {
    if (entry === undefined) return false
    if (next.trim() !== entry.text || (range.trim() !== '' && range.trim() !== entry.appliesTo)) {
      if (!(await store.editMemory(entry.id, { text: next, appliesTo: range }))) return false
    }
    return store.setHandbookStatus(entry.id, 'active')
  }
  return (
    <div className="proposal-card" data-testid="proposal-card" data-state={item.duplicate ? 'exists' : pending ? 'pending' : entry === undefined ? 'unknown' : entry.status === 'retired' ? 'dropped' : 'kept'}>
      <div className="small muted">{M.proposalTitle}</div>
      {editing && entry !== undefined ? (
        <EntryForm rule text={text} {...(appliesTo === undefined ? {} : { appliesTo })} onSave={keep} onCancel={() => setEditing(false)} testId="proposal-edit" />
      ) : (
        <>
          <div className="entry-text">{text}</div>
          {appliesTo !== undefined && <div className="muted small">{M.range(appliesTo)}</div>}
          {item.quote !== undefined && <div className="muted small quote-line">{M.quote(item.quote)}</div>}
        </>
      )}
      {item.duplicate ? (
        <div className="faint small">{M.proposalExists}</div>
      ) : pending && !editing && !readOnly ? (
        <div className="row">
          <button type="button" className="primary small" onClick={() => void store.setHandbookStatus(entry.id, 'active')} data-testid="proposal-keep">
            {M.keep}
          </button>
          <button type="button" className="small" onClick={() => setEditing(true)} data-testid="proposal-edit-open">
            {M.editFirst}
          </button>
          <button type="button" className="link small" onClick={() => void store.setHandbookStatus(entry.id, 'retired')} data-testid="proposal-drop">
            {M.noNeed}
          </button>
        </div>
      ) : entry !== undefined && !pending ? (
        <div className="faint small">{entry.status === 'retired' ? M.proposalDropped : M.proposalKept}</div>
      ) : null}
    </div>
  )
}

/** A right chevron while folded, a down one when open. */
export function FoldMarks(): JSX.Element {
  return (
    <>
      <Icon name="chevronRight" className="fold-mark closed" />
      <Icon name="chevronDown" className="fold-mark opened" />
    </>
  )
}
