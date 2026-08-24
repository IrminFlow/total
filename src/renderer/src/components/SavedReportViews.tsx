import { BookmarkSimple, FloppyDisk, Trash } from '@phosphor-icons/react'
import { useState } from 'react'
import type { SavedReportView } from '../lib/reportConfig'
import { Button, EmptyState, Modal, TextInput } from './ui'

export function SavedReportViews<T>({
  views,
  current,
  onSave,
  onApply,
  onRemove
}: {
  views: SavedReportView<T>[]
  current: T
  onSave: (name: string, value: T) => void
  onApply: (value: T) => void
  onRemove: (name: string) => void
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')
  const save = (): void => {
    if (!name.trim()) return
    onSave(name, current)
    setName('')
  }
  return <>
    <Button variant="ghost" data-testid="btn-report-views" onClick={() => setOpen(true)} title="Saved report views">
      <BookmarkSimple size={15} weight="bold" /> Views
    </Button>
    {open && <Modal title="Saved report views" onClose={() => setOpen(false)}>
      <p className="mb-3 text-[12px] text-muted">Keep this report’s dates and comparisons as a reusable company view.</p>
      <div className="flex gap-2">
        <TextInput data-testid="input-report-view-name" value={name} onChange={(event) => setName(event.target.value)} maxLength={48} placeholder="For example: Monthly owner review" onKeyDown={(event) => event.key === 'Enter' && save()} />
        <Button data-testid="btn-report-view-save" variant="primary" disabled={!name.trim()} onClick={save}><FloppyDisk size={15} /> Save</Button>
      </div>
      <div className="mt-4 overflow-hidden rounded-md border border-line">
        {views.length === 0 ? <EmptyState title="No saved views" hint="Save the current report setup to return to it in one click." /> : views.map((view) => <div key={view.name} className="flex items-center justify-between gap-3 border-b border-line px-3 py-2 last:border-b-0">
          <button className="min-w-0 flex-1 text-left" onClick={() => { onApply(view.value); setOpen(false) }}>
            <span className="block truncate text-[12.5px] font-medium text-ink">{view.name}</span>
            <span className="block text-[10.5px] text-muted">Saved {new Date(view.createdAt).toLocaleDateString('en-IN')}</span>
          </button>
          <button aria-label={`Delete ${view.name}`} className="rounded p-1.5 text-muted hover:bg-cr/10 hover:text-cr" onClick={() => onRemove(view.name)}><Trash size={15} /></button>
        </div>)}
      </div>
    </Modal>}
  </>
}
