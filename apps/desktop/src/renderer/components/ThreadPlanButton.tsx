import { useEffect, useRef, useState } from 'react'
import type { ThreadPlan } from '@nexgent/kernel'
import { useAppStore } from '../hooks.js'
import { T } from '../strings.js'
import { Icon } from './Icon.js'

/** Most threads one message can name (`MAX_PLANNED_THREADS`). */
const MAX_ROWS = 8

interface Row {
  readonly title: string
  readonly task: string
}

/** The rows with a title, as the plan `turns.send` carries (a row's one sentence only when written). */
export function planOfRows(rows: readonly Row[], exact: boolean): ThreadPlan {
  return {
    threads: rows.flatMap(row => (row.title.trim() === '' ? [] : [{ title: row.title.trim(), ...(row.task.trim() === '' ? {} : { task: row.task.trim() }) }])),
    exact,
  }
}

/**
 * The button beside the composer that opens the panel where the user names
 * the threads they want for the message: one title (and an optional
 * sentence) per row, and whether only these are started. The plan goes with
 * the next message (`onChange`).
 */
export function ThreadPlanButton({ plan, onChange, disabled }: { readonly plan: ThreadPlan; readonly onChange: (plan: ThreadPlan) => void; readonly disabled: boolean }): JSX.Element {
  const store = useAppStore()
  const [open, setOpen] = useState(false)
  const [rows, setRows] = useState<readonly Row[]>([{ title: '', task: '' }])
  const [exact, setExact] = useState(true)
  const root = useRef<HTMLSpanElement>(null)
  // A sent (or cleared) plan empties the panel: only when the plan goes from some threads to none.
  const had = useRef(plan.threads.length > 0)
  useEffect(() => {
    if (had.current && plan.threads.length === 0) {
      setRows([{ title: '', task: '' }])
      setExact(true)
    }
    had.current = plan.threads.length > 0
  }, [plan])

  // Opening shows the plan the task already has (it outlives the message that named it).
  const toggle = (): void => {
    if (open) {
      setOpen(false)
      return
    }
    setOpen(true)
    if (plan.threads.length === 0) {
      void store.threadPlan().then(saved => {
        if (saved === null || saved.threads.length === 0) return
        setRows(saved.threads.map(t => ({ title: t.title, task: t.task ?? '' })))
        setExact(saved.exact)
      })
    }
  }
  useEffect(() => {
    if (!open) return undefined
    const close = (event: MouseEvent): void => {
      if (root.current !== null && !root.current.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [open])

  const update = (next: readonly Row[], nextExact: boolean): void => {
    setRows(next)
    setExact(nextExact)
    onChange(planOfRows(next, nextExact))
  }
  const count = plan.threads.length
  return (
    <span className="plan-anchor" ref={root}>
      <button
        type="button"
        className={count > 0 ? 'chip-button active' : 'chip-button'}
        aria-expanded={open}
        title={T.planThreadsHelp}
        onMouseDown={event => event.preventDefault()}
        onClick={toggle}
        disabled={disabled}
        data-testid="plan-threads"
      >
        <Icon name="users" />
        {count > 0 ? `${T.planThreads} · ${count}` : T.planThreads}
      </button>
      {open && (
        <div className="plan-popover" role="dialog" aria-label={T.planThreads} data-testid="plan-panel">
          {rows.map((row, index) => (
            <div className="plan-row" key={index}>
              <input value={row.title} maxLength={80} placeholder={T.planRowTitle} aria-label={T.planRowTitle} onChange={e => update(rows.map((r, i) => (i === index ? { ...r, title: e.target.value } : r)), exact)} data-testid="plan-title" />
              <input value={row.task} placeholder={T.planTask} aria-label={T.planTask} onChange={e => update(rows.map((r, i) => (i === index ? { ...r, task: e.target.value } : r)), exact)} data-testid="plan-task" />
              {rows.length > 1 && (
                <button type="button" className="ghost icon-button" aria-label={T.planRemove} title={T.planRemove} onClick={() => update(rows.filter((_, i) => i !== index), exact)}>
                  <Icon name="close" />
                </button>
              )}
            </div>
          ))}
          <div className="plan-foot">
            <span className="row">
              {rows.length < MAX_ROWS && (
                <button type="button" className="ghost small" onClick={() => setRows([...rows, { title: '', task: '' }])} data-testid="plan-add">
                  <Icon name="plus" />
                  {T.planAdd}
                </button>
              )}
              <button type="button" className="ghost small" onClick={() => update([{ title: '', task: '' }], exact)} data-testid="plan-clear">
                {T.planClear}
              </button>
            </span>
            <label className="row small" title={T.planExactHelp}>
              <input type="checkbox" checked={exact} onChange={e => update(rows, e.target.checked)} data-testid="plan-exact" />
              {T.planExact}
            </label>
          </div>
        </div>
      )}
    </span>
  )
}
