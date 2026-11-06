import { useState } from 'react'
import { useAppStore } from '../hooks.js'
import { T } from '../strings.js'
import { Modal } from './Modal.js'

/** Organization redo: the user starts a thread of the coordinator conversation themselves (a title and what it should do). */
export function NewThreadDialog({ onClose }: { readonly onClose: () => void }): JSX.Element {
  const store = useAppStore()
  const [title, setTitle] = useState('')
  const [task, setTask] = useState('')
  const [busy, setBusy] = useState(false)
  const ready = title.trim() !== '' && task.trim() !== '' && !busy
  const start = async (): Promise<void> => {
    if (!ready) return
    setBusy(true)
    const started = await store.startThread(title, task)
    setBusy(false)
    if (started) onClose()
  }
  return (
    <Modal title={T.newThread} onClose={onClose} testId="new-thread-dialog">
      <form
        className="new-thread"
        onSubmit={event => {
          event.preventDefault()
          void start()
        }}
      >
        <input value={title} maxLength={80} placeholder={T.threadTitle} aria-label={T.threadTitle} onChange={e => setTitle(e.target.value)} data-testid="new-thread-title" />
        <textarea rows={5} value={task} placeholder={T.threadTask} aria-label={T.threadTask} onChange={e => setTask(e.target.value)} data-testid="new-thread-task" />
        <div className="row end">
          <button type="button" onClick={onClose}>
            {T.cancel}
          </button>
          <button type="submit" className="primary" disabled={!ready} data-testid="new-thread-start">
            {T.threadStart}
          </button>
        </div>
      </form>
    </Modal>
  )
}
