import { useAppState } from '../hooks.js'
import { L } from '../strings.js'
import { useUi } from '../ui.js'
import { hasPendingRules, LearningCard, learnedLead, organizationLead, PendingRules, useLearningRefresh } from './Learned.js'
import { DeletedEntries, MemoryGroup, NotesSection, ObservationsSection } from './Memory.js'
import { Icon } from './Icon.js'
import { Page } from './Page.js'
import { M, T } from '../strings.js'

/**
 * 项目记忆 (ADR 0028, project memory 2026-11-07): one line on what is in
 * use and its effect, what waits for the user (only when something does),
 * the observations, the rules, the practices and the coordinator's notes,
 * each editable, and what was deleted. The learning spend is in the folded
 * 改进记录.
 */
export function CapabilitiesPage(): JSX.Element {
  const ui = useUi()
  const state = useAppState()
  useLearningRefresh()
  const attention = hasPendingRules(state.handbook?.entries)
  return (
    <Page title={T.capabilitiesTitle} lead={[learnedLead(state.handbook?.entries), organizationLead(state.learning?.organizations)].filter(text => text !== '').join(' ')} onClose={ui.showConversation} testId="capabilities-page">
      <div className="learned" data-testid="learned-panel">
        {attention && (
          <section className="decide" data-testid="capabilities-attention">
            <h3 className="group-title">
              <span className="dot warn" aria-hidden="true" />
              {M.pendingTitle}
            </h3>
            <PendingRules />
          </section>
        )}
        <ObservationsSection />
        <MemoryGroup kind="rule" />
        <MemoryGroup kind="practice" />
        <NotesSection />
        <DeletedEntries />
        <details className="entry-group folded record" data-testid="capabilities-record">
          <summary className="group-title">
            <FoldMarks />
            {L.recordTitle}
          </summary>
          <RecordPart title={L.recordLearning} testId="record-learning">
            {state.learning !== undefined ? <LearningCard learning={state.learning} /> : <p className="muted small record-empty">{L.recordNone}</p>}
          </RecordPart>
        </details>
      </div>
    </Page>
  )
}

/** A right chevron while folded, a down one when open. */
function FoldMarks(): JSX.Element {
  return (
    <>
      <Icon name="chevronRight" className="fold-mark closed" />
      <Icon name="chevronDown" className="fold-mark opened" />
    </>
  )
}

function RecordPart({ title, help, open, testId, children }: { readonly title: string; readonly help?: string; readonly open?: boolean; readonly testId: string; readonly children: JSX.Element | null | false | undefined | readonly (JSX.Element | null | false | undefined)[] }): JSX.Element {
  return (
    <details className="record-part" open={open} data-testid={testId}>
      <summary className="small">
        <FoldMarks />
        {title}
        {help !== undefined && (
          <span className="help-tip" title={help} aria-label={help}>
            ?
          </span>
        )}
      </summary>
      {children}
    </details>
  )
}
