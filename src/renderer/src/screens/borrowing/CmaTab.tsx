import { useEffect, useMemo, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { api, type CmaFacility, type CmaPackRow, type CmaPackView } from '../../lib/client'
import { useToasts } from '../../state/stores'
import {
  AmountInput,
  Button,
  EmptyState,
  Field,
  Modal,
  Money,
  Panel,
  Select,
  SkeletonRows,
  TextInput
} from '../../components/ui'
import { formatPaise } from '@shared/money'
import { fyOf, todayISO } from '@shared/dates'
import type { CmaCell, CmaCellSource, CmaColumn, CmaColumnKey, CmaForm, CmaLine } from '@shared/cma'
import { CMA_FORM_TITLES } from '@shared/cma'
import { confirmDialog } from '../../lib/dialogs'

/**
 * CMA data for a working-capital application (roadmap #371).
 *
 * The screen has one job beyond showing the numbers, and it is the reason this is not just a
 * report: it has to make the boundary between what the BOOKS say and what the BORROWER claims
 * impossible to miss. A banker reading a projection needs to know it is a projection, and the
 * borrower signing the pack needs to know which figures they are personally asserting.
 *
 * So the three cell states never look alike:
 *
 *   from the books — plain, right-aligned, not editable, on the panel's own background
 *   typed          — an input box, tinted, with a caret in it
 *   derived        — a subtotal, rendered in the muted ink of something the app worked out
 *
 * and the column headers say it again in words, because a colour alone is a convention nobody
 * was taught. It lives on the Borrowing screen next to the stock statement and drawing power on
 * purpose: same borrower, same bank, one set of figures.
 */

const COLUMN_NOTE: Record<CmaColumn['source'], string> = {
  audited: 'Audited — from your books',
  estimate: 'Estimate — your figures',
  projection: 'Projection — your figures'
}

const FORM_ORDER: CmaForm['id'][] = ['II', 'III', 'V', 'DS']

export function CmaTab(): React.JSX.Element {
  const [packId, setPackId] = useState<number | null>(null)
  const [creating, setCreating] = useState(false)
  const { data: packs, isLoading } = useQuery({ queryKey: ['cmaPacks'], queryFn: api.cma.packs })

  // Open the newest pack by default rather than making the first click a choice between one item.
  useEffect(() => {
    if (packId === null && packs && packs.length > 0) setPackId(packs[0]!.id)
  }, [packs, packId])

  if (isLoading) return <Panel><SkeletonRows rows={6} /></Panel>
  const rows = packs ?? []

  return (
    <>
      <div className="mb-3 flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          {rows.length > 0 && (
            <Select
              data-testid="select-cma-pack"
              value={packId ?? ''}
              onChange={(e) => setPackId(e.target.value === '' ? null : Number(e.target.value))}
              className="w-72"
            >
              {rows.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name} — FY {p.estimateFyStartYear}-{String((p.estimateFyStartYear + 1) % 100).padStart(2, '0')}
                </option>
              ))}
            </Select>
          )}
        </div>
        <Button variant="primary" data-testid="btn-cma-new" onClick={() => setCreating(true)}>
          New CMA pack
        </Button>
      </div>

      {rows.length === 0 ? (
        <EmptyState
          title="No CMA pack yet"
          hint="The format a bank wants before it sanctions or renews a cash-credit limit. The audited years come out of your books; the estimate and the projections are yours to state."
        />
      ) : packId !== null ? (
        <PackView packId={packId} onDeleted={() => setPackId(null)} />
      ) : null}

      {creating && <PackModal pack={null} onClose={() => setCreating(false)} onSaved={setPackId} />}
    </>
  )
}

// ---------- the pack ----------

function PackView({ packId, onDeleted }: { packId: number; onDeleted: () => void }): React.JSX.Element {
  const queryClient = useQueryClient()
  const toast = useToasts()
  const [editing, setEditing] = useState<CmaPackRow | null>(null)
  const { data, isLoading } = useQuery({ queryKey: ['cmaPack', packId], queryFn: () => api.cma.pack(packId) })

  const refresh = async (): Promise<void> => {
    await queryClient.invalidateQueries({ queryKey: ['cmaPack', packId] })
  }

  if (isLoading || !data) return <Panel><SkeletonRows rows={10} /></Panel>

  const remove = async (): Promise<void> => {
    if (!(await confirmDialog(`Delete "${data.pack.name}"? The figures you typed into it go with it.`))) return
    await api.cma.deletePack(packId)
    await queryClient.invalidateQueries({ queryKey: ['cmaPacks'] })
    onDeleted()
    toast.push('success', 'CMA pack deleted')
  }

  return (
    <div className="flex flex-col gap-4">
      {data.warnings.length > 0 && (
        <div className="rounded-md border border-line bg-panel2 px-3 py-2" data-testid="cma-warnings">
          <p className="text-small font-medium text-ink">Before this goes to a bank</p>
          <ul className="mt-1 list-disc pl-4 text-hint text-muted">
            {data.warnings.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
        </div>
      )}

      <Legend />

      <FormOne view={data} packId={packId} onChanged={refresh} />

      {FORM_ORDER.map((id) => {
        const form = data.forms.find((f) => f.id === id)
        return form ? (
          <FormTable key={id} form={form} columns={data.columns} packId={packId} onChanged={refresh} />
        ) : null
      })}

      <FormFour view={data} />
      <FundFlow view={data} />
      <Ratios view={data} />

      <div className="flex items-center justify-between">
        <div className="flex gap-2">
          <Button variant="ghost" data-testid="btn-cma-edit" onClick={() => setEditing(data.pack)}>
            Rename
          </Button>
          <Button variant="ghost" data-testid="btn-cma-delete" onClick={remove}>
            Delete pack
          </Button>
        </div>
        <PrefillControls view={data} packId={packId} onChanged={refresh} />
      </div>

      {editing && <PackModal pack={editing} onClose={() => setEditing(null)} onSaved={refresh} />}
    </div>
  )
}

function Legend(): React.JSX.Element {
  return (
    <div className="flex flex-wrap items-center gap-4 text-hint text-muted" data-testid="cma-legend">
      <span className="flex items-center gap-1.5">
        <span className="inline-block h-3 w-6 rounded-sm border border-line bg-panel" />
        From your books — computed, not editable
      </span>
      <span className="flex items-center gap-1.5">
        <span className="inline-block h-3 w-6 rounded-sm border border-accentbar/60 bg-accentbar/15" />
        Your figure — typed, and asserted by you
      </span>
      <span className="flex items-center gap-1.5">
        <span className="inline-block h-3 w-6 rounded-sm border border-line bg-panel2" />
        A subtotal this screen worked out
      </span>
    </div>
  )
}

// ---------- the table that does the real work ----------

/**
 * A cell's rendering is decided by its source and nothing else.
 *
 * `books` never becomes an input, whatever column it sits in — the way to change an audited
 * figure is to fix the voucher that produced it, and offering a box here would invite somebody
 * to type over the books and send a bank a figure the ledgers do not support.
 */
function Cell({
  cell,
  line,
  column,
  packId,
  onChanged
}: {
  cell: CmaCell
  line: CmaLine
  column: CmaColumn
  packId: number
  onChanged: () => void
}): React.JSX.Element {
  const toast = useToasts()
  if (cell.source === 'books') {
    return (
      <td className="r num" data-cell-source="books" title="From your books">
        {formatPaise(cell.value ?? 0, { zeroDash: true })}
      </td>
    )
  }
  if (cell.source === 'derived') {
    return (
      <td className="r num bg-panel2 text-muted" data-cell-source="derived" title="A subtotal">
        {cell.value === null ? '' : formatPaise(cell.value, { zeroDash: true })}
      </td>
    )
  }
  return (
    <td className="r p-0.5" data-cell-source="typed">
      <AmountInput
        testId={`cma-${column.key}-${line.key}`}
        paise={cell.value}
        className="bg-accentbar/10"
        onPaise={(paise) => {
          void api.cma
            .setInput(packId, column.key, line.key, paise)
            .then(onChanged)
            .catch((err: Error) => toast.push('error', err.message))
        }}
      />
    </td>
  )
}

function ColumnHeaders({ columns }: { columns: CmaColumn[] }): React.JSX.Element {
  return (
    <tr>
      <th scope="col">Particulars</th>
      {columns.map((c) => (
        <th key={c.key} scope="col" className="r w-40" data-testid={`cma-col-${c.key}`}>
          <span className="block">{c.label}</span>
          <span
            className={`block text-hint font-normal ${c.source === 'audited' && c.booksCover ? 'text-muted' : 'text-accent'}`}
          >
            {c.source === 'audited' && !c.booksCover ? 'Audited — books do not reach it' : COLUMN_NOTE[c.source]}
          </span>
        </th>
      ))}
    </tr>
  )
}

function FormTable({
  form,
  columns,
  packId,
  onChanged
}: {
  form: CmaForm
  columns: CmaColumn[]
  packId: number
  onChanged: () => void
}): React.JSX.Element {
  return (
    <Panel data-testid={`panel-cma-form-${form.id}`}>
      <p className="mb-2 text-small font-medium text-ink">{form.title}</p>
      <table className="ledger-table">
        <thead>
          <ColumnHeaders columns={columns} />
        </thead>
        <tbody data-testid={`rows-cma-${form.id}`}>
          {form.lines.map((line) => (
            <LineRow key={line.key} line={line} columns={columns} packId={packId} onChanged={onChanged} />
          ))}
        </tbody>
      </table>
    </Panel>
  )
}

function LineRow({
  line,
  columns,
  packId,
  onChanged
}: {
  line: CmaLine
  columns: CmaColumn[]
  packId: number
  onChanged: () => void
}): React.JSX.Element {
  return (
    <>
      {line.heading && (
        <tr>
          <td colSpan={columns.length + 1} className="pt-3 text-hint font-medium uppercase tracking-wide text-muted">
            {line.heading}
          </td>
        </tr>
      )}
      <tr data-testid={`cma-line-${line.key}`}>
        <td className={line.emphasis ? 'font-medium' : ''} style={{ paddingLeft: `${line.indent * 14 + 8}px` }}>
          {line.label}
        </td>
        {columns.map((c, i) => (
          <Cell key={c.key} cell={line.cells[i]!} line={line} column={c} packId={packId} onChanged={onChanged} />
        ))}
      </tr>
    </>
  )
}

// ---------- Form I ----------

function FormOne({
  view,
  packId,
  onChanged
}: {
  view: CmaPackView
  packId: number
  onChanged: () => void
}): React.JSX.Element {
  const [editing, setEditing] = useState<CmaFacility | 'new' | null>(null)
  const queryClient = useQueryClient()

  const remove = async (id: number): Promise<void> => {
    await api.cma.deleteFacility(id)
    await queryClient.invalidateQueries({ queryKey: ['cmaPack', packId] })
    onChanged()
  }

  return (
    <Panel data-testid="panel-cma-form-I">
      <div className="mb-2 flex items-center justify-between">
        <p className="text-small font-medium text-ink">{CMA_FORM_TITLES.I}</p>
        <Button variant="ghost" data-testid="btn-cma-facility-add" onClick={() => setEditing('new')}>
          Add facility
        </Button>
      </div>
      {view.facilities.length === 0 ? (
        <EmptyState title="No facilities listed" hint="What the bank already gives you, and what you are asking for." />
      ) : (
        <table className="ledger-table">
          <thead>
            <tr>
              <th scope="col">Facility</th>
              <th scope="col" className="r w-36">Existing limit</th>
              <th scope="col" className="r w-36">Outstanding</th>
              <th scope="col" className="r w-36">Proposed limit</th>
              <th scope="col">Security</th>
              <th scope="col" className="w-28" />
            </tr>
          </thead>
          <tbody data-testid="rows-cma-facilities">
            {view.facilities.map((f) => (
              <tr key={f.id}>
                <td>{f.facility}</td>
                <td className="r"><Money paise={f.existingLimitPaise} /></td>
                <td className="r" data-cell-source={f.outstandingFromBooks ? 'books' : 'typed'}>
                  {f.outstandingPaise === null ? (
                    <span className="text-muted">—</span>
                  ) : (
                    <>
                      <Money paise={f.outstandingPaise} />
                      {f.outstandingFromBooks && (
                        <span className="ml-1 text-hint text-muted" title={`From ${f.ledgerName}`}>
                          books
                        </span>
                      )}
                    </>
                  )}
                </td>
                <td className="r"><Money paise={f.proposedLimitPaise} /></td>
                <td className="text-muted">{f.security ?? '—'}</td>
                <td className="r whitespace-nowrap">
                  <Button variant="ghost" onClick={() => setEditing(f)}>Edit</Button>
                  <Button variant="ghost" onClick={() => remove(f.id)}>Remove</Button>
                </td>
              </tr>
            ))}
            <tr>
              <td className="font-medium">Total</td>
              <td className="r"><Money paise={view.facilityTotals.existingLimitPaise} /></td>
              <td className="r"><Money paise={view.facilityTotals.outstandingPaise} /></td>
              <td className="r"><Money paise={view.facilityTotals.proposedLimitPaise} /></td>
              <td colSpan={2} />
            </tr>
          </tbody>
        </table>
      )}
      {editing && (
        <FacilityModal
          packId={packId}
          facility={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={onChanged}
        />
      )}
    </Panel>
  )
}

function FacilityModal({
  packId,
  facility,
  onClose,
  onSaved
}: {
  packId: number
  facility: CmaFacility | null
  onClose: () => void
  onSaved: () => void
}): React.JSX.Element {
  const toast = useToasts()
  const { data: ledgers } = useQuery({ queryKey: ['ledgers'], queryFn: api.ledgers.list })
  const [name, setName] = useState(facility?.facility ?? 'Cash credit')
  const [existing, setExisting] = useState<number | null>(facility?.existingLimitPaise ?? null)
  const [proposed, setProposed] = useState<number | null>(facility?.proposedLimitPaise ?? null)
  const [outstanding, setOutstanding] = useState<number | null>(facility?.outstandingPaise ?? null)
  const [ledgerId, setLedgerId] = useState<number | ''>(facility?.ledgerId ?? '')
  const [security, setSecurity] = useState(facility?.security ?? '')

  const submit = async (): Promise<void> => {
    try {
      await api.cma.saveFacility(
        packId,
        {
          facility: name.trim(),
          existingLimitPaise: existing ?? 0,
          proposedLimitPaise: proposed ?? 0,
          outstandingPaise: outstanding,
          ledgerId: ledgerId === '' ? null : ledgerId,
          security: security.trim() || null,
          notes: null,
          seq: facility?.seq ?? 0
        },
        facility?.id
      )
      onSaved()
      onClose()
    } catch (err) {
      toast.push('error', (err as Error).message)
    }
  }

  return (
    <Modal title={facility ? `Edit ${facility.facility}` : 'Add facility'} onClose={onClose} wide>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Facility">
          <TextInput data-testid="input-facility-name" value={name} autoFocus onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="Security offered">
          <TextInput value={security} onChange={(e) => setSecurity(e.target.value)} />
        </Field>
        <Field label="Existing limit">
          <AmountInput testId="input-facility-existing" paise={existing} onPaise={setExisting} />
        </Field>
        <Field label="Proposed limit">
          <AmountInput testId="input-facility-proposed" paise={proposed} onPaise={setProposed} />
        </Field>
        <Field
          label="Ledger"
          hint="Point it at the account and the outstanding is read from your books instead of typed."
        >
          <Select value={ledgerId} onChange={(e) => setLedgerId(e.target.value === '' ? '' : Number(e.target.value))}>
            <option value="">Not linked</option>
            {(ledgers ?? []).map((l) => (
              <option key={l.id} value={l.id}>{l.name}</option>
            ))}
          </Select>
        </Field>
        <Field label="Outstanding">
          {ledgerId === '' ? (
            <AmountInput testId="input-facility-outstanding" paise={outstanding} onPaise={setOutstanding} />
          ) : (
            <p className="pt-2 text-small text-muted">Read from the linked ledger.</p>
          )}
        </Field>
      </div>
      <div className="mt-4 flex justify-end gap-2">
        <Button variant="ghost" onClick={onClose}>Cancel</Button>
        <Button variant="primary" data-testid="btn-facility-save" onClick={submit}>Save</Button>
      </div>
    </Modal>
  )
}

// ---------- Form IV, VI and the ratios ----------

function FormFour({ view }: { view: CmaPackView }): React.JSX.Element {
  const section = (title: string, rows: CmaPackView['formIV']['assets']): React.JSX.Element => (
    <>
      <tr>
        <td colSpan={view.columns.length * 2 + 1} className="pt-3 text-hint font-medium uppercase tracking-wide text-muted">
          {title}
        </td>
      </tr>
      {rows.map((r) => (
        <tr key={r.key} data-testid={`cma-iv-${r.key}`}>
          <td className={r.emphasis ? 'font-medium' : 'pl-3'}>{r.label}</td>
          {r.cells.map((cell, i) => (
            <CellReadOnly key={`v${i}`} cell={cell} />
          ))}
          {r.holdingDays.map((d, i) => (
            <td key={`d${i}`} className="r num text-muted">
              {d === null ? '' : `${d} d`}
            </td>
          ))}
        </tr>
      ))}
    </>
  )

  return (
    <Panel data-testid="panel-cma-form-IV">
      <p className="mb-2 text-small font-medium text-ink">{CMA_FORM_TITLES.IV}</p>
      <table className="ledger-table">
        <thead>
          <tr>
            <th scope="col">Particulars</th>
            {view.columns.map((c) => (
              <th key={c.key} scope="col" className="r w-36">{c.label}</th>
            ))}
            {view.columns.map((c) => (
              <th key={`h${c.key}`} scope="col" className="r w-24 text-muted">Held {c.label.slice(3)}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {section('Current assets', view.formIV.assets)}
          {section('Current liabilities', view.formIV.liabilities)}
        </tbody>
      </table>
      <p className="mt-2 text-hint text-muted">
        Holding levels are inventory against cost of sales, receivables against sales and creditors
        against purchases. A blank means the flow it is measured against is nil — a business with no
        sales does not hold its debtors forever, the question simply has no answer.
      </p>
    </Panel>
  )
}

function CellReadOnly({ cell }: { cell: CmaCell }): React.JSX.Element {
  const tone: Record<CmaCellSource, string> = {
    books: '',
    typed: 'bg-accentbar/10',
    derived: 'bg-panel2 text-muted'
  }
  return (
    <td className={`r num ${tone[cell.source]}`} data-cell-source={cell.source}>
      {cell.value === null ? '' : formatPaise(cell.value, { zeroDash: true })}
    </td>
  )
}

function FundFlow({ view }: { view: CmaPackView }): React.JSX.Element {
  const { fundFlow } = view
  const block = (title: string, lines: typeof fundFlow.sources): React.JSX.Element => (
    <>
      <tr>
        <td colSpan={fundFlow.columns.length + 1} className="pt-3 text-hint font-medium uppercase tracking-wide text-muted">
          {title}
        </td>
      </tr>
      {lines.map((l) => (
        <tr key={l.key} data-testid={`cma-vi-${l.key}`}>
          <td className={l.emphasis ? 'font-medium' : 'pl-3'}>{l.label}</td>
          {l.values.map((v, i) => (
            <td key={i} className="r num">
              {v === null ? <span className="text-muted">—</span> : formatPaise(v, { zeroDash: true })}
            </td>
          ))}
        </tr>
      ))}
    </>
  )

  return (
    <Panel data-testid="panel-cma-form-VI">
      <p className="mb-2 text-small font-medium text-ink">{CMA_FORM_TITLES.VI}</p>
      <table className="ledger-table">
        <thead>
          <tr>
            <th scope="col">Particulars</th>
            {fundFlow.columns.map((c) => (
              <th key={c.label} scope="col" className="r w-44">
                {c.label}
                {!c.available && <span className="block text-hint font-normal text-muted">no movement to show</span>}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {block('Sources', fundFlow.sources)}
          {block('Uses', fundFlow.uses)}
          {block('Summary', fundFlow.summary)}
        </tbody>
      </table>
    </Panel>
  )
}

function Ratios({ view }: { view: CmaPackView }): React.JSX.Element {
  const fmt = (v: number | null, unit: 'x' | 'days' | '%'): string =>
    v === null ? '—' : unit === 'x' ? `${v.toFixed(2)}` : unit === 'days' ? `${Math.round(v)} d` : `${v.toFixed(2)}%`

  return (
    <Panel data-testid="panel-cma-ratios">
      <p className="mb-2 text-small font-medium text-ink">The ratios a credit officer reads</p>
      <table className="ledger-table">
        <thead>
          <tr>
            <th scope="col">Ratio</th>
            {view.columns.map((c) => (
              <th key={c.key} scope="col" className="r w-32">{c.label}</th>
            ))}
          </tr>
        </thead>
        <tbody data-testid="rows-cma-ratios">
          {view.ratios.map((r) => (
            <tr key={r.key} data-testid={`cma-ratio-${r.key}`}>
              <td>
                {r.label}
                <span className="block text-hint text-muted">{r.note}</span>
              </td>
              {r.values.map((v, i) => (
                <td key={i} className="r num">
                  {fmt(v, r.unit)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </Panel>
  )
}

// ---------- prefill ----------

function PrefillControls({
  view,
  packId,
  onChanged
}: {
  view: CmaPackView
  packId: number
  onChanged: () => void
}): React.JSX.Element {
  const toast = useToasts()
  const filled = useMemo(() => view.columns.filter((c) => c.state !== 'empty'), [view.columns])
  const typeable = useMemo(() => view.columns.filter((c) => c.state !== 'books'), [view.columns])
  const [from, setFrom] = useState<CmaColumnKey | ''>(filled[filled.length - 1]?.key ?? '')
  const [to, setTo] = useState<CmaColumnKey | ''>(typeable[0]?.key ?? '')

  const run = async (): Promise<void> => {
    if (from === '' || to === '') return
    try {
      const copied = await api.cma.prefill(packId, from, to)
      onChanged()
      toast.push('success', `${copied} figures copied. They are yours now — go through them.`)
    } catch (err) {
      toast.push('error', (err as Error).message)
    }
  }

  return (
    <div className="flex items-center gap-2 text-small text-muted">
      <span>Start</span>
      <Select value={to} data-testid="select-prefill-to" onChange={(e) => setTo(e.target.value as CmaColumnKey)} className="w-32">
        {typeable.map((c) => (
          <option key={c.key} value={c.key}>{c.label}</option>
        ))}
      </Select>
      <span>from</span>
      <Select value={from} data-testid="select-prefill-from" onChange={(e) => setFrom(e.target.value as CmaColumnKey)} className="w-32">
        {filled.map((c) => (
          <option key={c.key} value={c.key}>{c.label}</option>
        ))}
      </Select>
      <Button variant="ghost" data-testid="btn-cma-prefill" onClick={run}>Copy</Button>
    </div>
  )
}

// ---------- new / rename ----------

function PackModal({
  pack,
  onClose,
  onSaved
}: {
  pack: CmaPackRow | null
  onClose: () => void
  onSaved: (id: number) => void
}): React.JSX.Element {
  const toast = useToasts()
  const queryClient = useQueryClient()
  const thisFy = fyOf(todayISO()).startYear
  const [name, setName] = useState(pack?.name ?? `Working capital ${thisFy}-${String((thisFy + 1) % 100).padStart(2, '0')}`)
  const [year, setYear] = useState(String(pack?.estimateFyStartYear ?? thisFy))
  const [notes, setNotes] = useState(pack?.notes ?? '')

  const submit = async (): Promise<void> => {
    try {
      const saved = await api.cma.savePack(
        { name: name.trim(), estimateFyStartYear: Number(year), notes: notes.trim() || null },
        pack?.id
      )
      await queryClient.invalidateQueries({ queryKey: ['cmaPacks'] })
      await queryClient.invalidateQueries({ queryKey: ['cmaPack', saved.id] })
      onSaved(saved.id)
      onClose()
    } catch (err) {
      toast.push('error', (err as Error).message)
    }
  }

  return (
    <Modal title={pack ? 'Rename CMA pack' : 'New CMA pack'} onClose={onClose}>
      <div className="grid gap-3">
        <Field label="Name">
          <TextInput data-testid="input-cma-name" value={name} autoFocus onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field
          label="Current year (the estimate column)"
          hint="Two audited years count back from it and two projections count forward."
        >
          <TextInput data-testid="input-cma-year" value={year} inputMode="numeric" onChange={(e) => setYear(e.target.value)} />
        </Field>
        <Field label="Notes">
          <TextInput value={notes} onChange={(e) => setNotes(e.target.value)} />
        </Field>
      </div>
      <div className="mt-4 flex justify-end gap-2">
        <Button variant="ghost" onClick={onClose}>Cancel</Button>
        <Button variant="primary" data-testid="btn-cma-save" onClick={submit}>Save</Button>
      </div>
    </Modal>
  )
}
