import type { ReactNode } from 'react'

/** A status tone: running (coral dot), done, waits for the user, failed, idle. */
export type Tone = 'run' | 'ok' | 'warn' | 'bad' | 'idle'

/** A status as a dot and its words together (a status is never colour alone). */
export function State({ tone, children, testId, title }: {
  readonly tone: Tone
  readonly children: ReactNode
  readonly testId?: string
  readonly title?: string
}): JSX.Element {
  return (
    <span className={`state ${tone}`} {...(testId === undefined ? {} : { 'data-testid': testId })} {...(title === undefined ? {} : { title })}>
      {children}
    </span>
  )
}
