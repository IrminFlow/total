import { useState } from 'react'
import { Button, Modal } from './ui'
import type { ReportColumn } from '../lib/reportConfig'

/** F12-style "configure columns" gear button — opens a checkbox list wired to useReportConfig. */
export function ReportConfigButton({
  columns,
  visible,
  toggle
}: {
  columns: ReportColumn[]
  visible: Record<string, boolean>
  toggle: (key: string) => void
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  return (
    <>
      <button
        className="rounded-md border border-line bg-panel2 px-2 py-1 text-small text-muted hover:border-amber/60 hover:text-ink"
        onClick={() => setOpen(true)}
        title="Configure columns"
        aria-label="Configure columns"
      >
        ⚙ Columns
      </button>
      {open && (
        <Modal title="Columns" onClose={() => setOpen(false)}>
          <div className="flex flex-col gap-2">
            {columns.map((c) => (
              <label key={c.key} className="flex items-center gap-2 text-detail">
                <input type="checkbox" checked={visible[c.key] ?? c.defaultOn} onChange={() => toggle(c.key)} />
                {c.label}
              </label>
            ))}
          </div>
          <div className="mt-4 flex justify-end">
            <Button variant="primary" onClick={() => setOpen(false)}>
              Done
            </Button>
          </div>
        </Modal>
      )}
    </>
  )
}
