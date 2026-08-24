import { useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { api, type ImportKind, type ImportPreview } from '../lib/client'
import { useToasts } from '../state/stores'
import { Button, Panel, Select } from '../components/ui'

/**
 * Masters and opening balances from a spreadsheet (roadmap O #291).
 *
 * The parsing, the matching and the diff have existed in the engine for a while with no way to
 * reach them; this is the screen. It is deliberately the same three steps as the Tally wizard —
 * choose, look at what would change, then apply — because it is the same act.
 *
 * **CSV, not .xlsx.** Excel writes CSV with one menu command, and the alternative is a
 * spreadsheet-format parser (zip container, shared-string table, styles, dates as serial numbers)
 * carried in an offline app to read a file the user can convert in two seconds. The honest trade
 * is to say so on the screen rather than to half-support a binary format.
 */
const KINDS: { id: ImportKind; label: string; blurb: string }[] = [
  { id: 'ledgers', label: 'Ledgers', blurb: 'Name, group, opening balance, GSTIN, state, PAN, credit days.' },
  { id: 'items', label: 'Stock items', blurb: 'Name, unit, group, HSN, GST rate, opening quantity and value.' },
  { id: 'openings', label: 'Opening balances', blurb: 'Ledger name and its opening balance. Nothing else is touched.' }
]

export function CsvImport(): React.JSX.Element {
  const toast = useToasts()
  const qc = useQueryClient()
  const [kind, setKind] = useState<ImportKind>('ledgers')
  const [file, setFile] = useState<{ csvText: string; fileName: string } | null>(null)
  const [preview, setPreview] = useState<ImportPreview | null>(null)
  const [busy, setBusy] = useState(false)

  const chosen = KINDS.find((k) => k.id === kind)!

  const pick = async (): Promise<void> => {
    setBusy(true)
    try {
      const picked = await api.importer.pickCsv()
      if (!picked) return
      setFile(picked)
      setPreview(await api.importer.preview(kind, picked.csvText))
    } catch (err) {
      toast.push('error', (err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const apply = async (): Promise<void> => {
    if (!file) return
    setBusy(true)
    try {
      const result = await api.importer.apply(kind, file.csvText)
      void qc.invalidateQueries()
      toast.push(
        'success',
        `${result.created} created, ${result.updated} updated` +
          (result.errors.length ? ` — ${result.errors.length} row(s) could not be read` : '')
      )
      setFile(null)
      setPreview(null)
    } catch (err) {
      toast.push('error', (err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const template = async (): Promise<void> => {
    try {
      const { path } = await api.importer.template(kind)
      toast.push('success', `Template written to ${path}`)
    } catch (err) {
      toast.push('error', (err as Error).message)
    }
  }

  return (
    <Panel className="p-6" data-testid="csv-import">
      <div className="flex flex-wrap items-end gap-3">
        <div>
          <span className="mb-1 block text-caption font-semibold tracking-[0.08em] text-muted uppercase">What</span>
          <Select
            data-testid="select-csv-kind"
            value={kind}
            onChange={(e) => {
              setKind(e.target.value as ImportKind)
              setFile(null)
              setPreview(null)
            }}
          >
            {KINDS.map((k) => (
              <option key={k.id} value={k.id}>
                {k.label}
              </option>
            ))}
          </Select>
        </div>
        <Button variant="ghost" data-testid="btn-csv-template" onClick={() => void template()}>
          Save a template
        </Button>
        <Button variant="primary" data-testid="btn-csv-pick" disabled={busy} onClick={() => void pick()}>
          {busy ? 'Reading…' : 'Choose a CSV…'}
        </Button>
      </div>
      <p className="mt-3 max-w-prose text-body-sm text-muted">
        {chosen.blurb} Save your spreadsheet as CSV first — in Excel, File → Save As → CSV. Nothing is written
        until you have seen what would change.
      </p>

      {preview && (
        <div className="mt-5" data-testid="csv-preview">
          <p className="text-detail font-medium">
            {file?.fileName} — <span className="num">{preview.total}</span> row{preview.total === 1 ? '' : 's'}
          </p>
          <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Count label="New" value={preview.willCreate} testId="csv-will-create" />
            <Count label="Changed" value={preview.willUpdate} testId="csv-will-update" />
            {/* The count that decides whether somebody presses the button. "480 unchanged, 3
                changed" reads very differently from "483 will be updated". */}
            <Count label="Unchanged" value={preview.unchanged} testId="csv-unchanged" muted />
            <Count label="Unreadable" value={preview.errors.length} testId="csv-errors" bad={preview.errors.length > 0} />
          </div>

          {preview.errors.length > 0 && (
            <div className="mt-4 max-h-48 overflow-auto rounded-md border border-cr/40 bg-cr/10 px-3 py-2">
              {preview.errors.slice(0, 20).map((e, i) => (
                <p key={i} className="py-0.5 text-body-sm text-ink">
                  Line <span className="num">{e.line}</span>: {e.message}
                </p>
              ))}
              {preview.errors.length > 20 && (
                <p className="py-0.5 text-body-sm text-muted">…and {preview.errors.length - 20} more</p>
              )}
            </div>
          )}

          <div className="mt-4 flex justify-end gap-2">
            <Button
              variant="ghost"
              disabled={busy}
              onClick={() => {
                setFile(null)
                setPreview(null)
              }}
            >
              Choose a different file
            </Button>
            <Button
              variant="primary"
              data-testid="btn-csv-apply"
              disabled={busy || preview.willCreate + preview.willUpdate === 0}
              onClick={() => void apply()}
            >
              {busy ? 'Importing…' : 'Import now'}
            </Button>
          </div>
          {preview.willCreate + preview.willUpdate === 0 && (
            <p className="mt-2 text-right text-body-sm text-muted">
              Nothing in this file would change anything.
            </p>
          )}
        </div>
      )}
    </Panel>
  )
}

function Count({
  label,
  value,
  testId,
  muted,
  bad
}: {
  label: string
  value: number
  testId: string
  muted?: boolean
  bad?: boolean
}): React.JSX.Element {
  return (
    <div className="rounded-md border border-line bg-panel2 px-3 py-2.5 text-center">
      <div data-testid={testId} className={`num text-heading font-semibold ${bad ? 'text-cr' : muted ? 'text-muted' : ''}`}>
        {value}
      </div>
      <div className="text-caption text-muted uppercase tracking-[0.06em]">{label}</div>
    </div>
  )
}
