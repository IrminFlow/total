// Banking → Cheques (WP 4.1): cheque books (leaf ranges), the cheque register (issued / cleared
// / cancelled / stop payment — cleared comes from the bank date), and the per-bank layout
// designer with a live mm preview and the calibration test print.
import { useEffect, useMemo, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { CHEQUE_STATUS_LABELS, type ChequeStatus } from '@shared/chequeRegister'
import { chequeFields } from '@shared/cheque'
import { DEFAULT_CHEQUE_CONFIG, type ChequeConfig } from '@shared/schemas'
import { toDisplayDate, todayISO } from '@shared/dates'
import { api } from '../../lib/client'
import { bankingApi, type ChequeBook, type ChequeRegisterRow } from '../../lib/bankingClient'
import { DataTable, defineColumns } from '../../components/table'
import { Badge, Button, Checkbox, DateInput, Field, Modal, Panel, Spinner, StatGrid, StatTile, TextInput } from '../../components/ui'
import { MenuButton } from '../../components/kit'
import { VoucherLink } from '../../components/links'
import { useToasts } from '../../state/stores'
import { confirmDialog, promptDialog } from '../../lib/dialogs'
import { useUnsavedGuard } from '../../lib/useUnsavedGuard'

const STATUS_TONE: Record<ChequeStatus, 'neutral' | 'info' | 'success' | 'warning' | 'danger'> = {
  available: 'neutral', issued: 'info', cleared: 'success', cancelled: 'warning', stopped: 'danger'
}

const REGISTER_COLUMNS = defineColumns<ChequeRegisterRow>([
  { id: 'number', header: 'Cheque no.', kind: 'text', value: (r) => r.number, hideable: false, width: 120, className: 'num' },
  {
    id: 'status',
    header: 'Status',
    kind: 'enum',
    value: (r) => r.status,
    options: (Object.keys(CHEQUE_STATUS_LABELS) as ChequeStatus[]).map((k) => ({ value: k, label: CHEQUE_STATUS_LABELS[k] })),
    width: 130,
    cell: (r) => <Badge tone={STATUS_TONE[r.status]}>{CHEQUE_STATUS_LABELS[r.status]}</Badge>
  },
  { id: 'date', header: 'Cheque date', kind: 'date', value: (r) => r.chequeDate, width: 120, className: 'text-muted' },
  { id: 'payee', header: 'Payee', kind: 'text', value: (r) => r.payee, minWidth: 160 },
  { id: 'amount', header: 'Amount', kind: 'money', value: (r) => r.amount, aggregate: 'sum', width: 130 },
  {
    id: 'voucher',
    header: 'Voucher',
    kind: 'text',
    value: (r) => r.voucherNumber,
    width: 110,
    cell: (r) => (r.voucherId ? <VoucherLink voucherId={r.voucherId} label={r.voucherNumber ?? '—'} /> : null)
  },
  { id: 'bankDate', header: 'Cleared on', kind: 'date', value: (r) => r.bankDate, width: 120, className: 'text-muted' },
  { id: 'book', header: 'Book', kind: 'text', value: (r) => r.bookName, width: 110, defaultHidden: true },
  { id: 'printed', header: 'Printed', kind: 'number', value: (r) => r.printedCount, width: 90, defaultHidden: true },
  { id: 'note', header: 'Note', kind: 'text', value: (r) => r.note, width: 160, defaultHidden: true }
])

export function ChequesTab({ bankLedgerId, bankName }: { bankLedgerId: number; bankName: string }): React.JSX.Element {
  const toast = useToasts()
  const queryClient = useQueryClient()
  const [showAvailable, setShowAvailable] = useState(false)
  const { data: books } = useQuery({ queryKey: ['chequeBooks', bankLedgerId], queryFn: () => bankingApi.cheques.books(bankLedgerId) })
  const { data: register, isLoading } = useQuery({
    queryKey: ['chequeRegister', bankLedgerId, showAvailable],
    queryFn: () => bankingApi.cheques.register(bankLedgerId, showAvailable)
  })
  const [bookEdit, setBookEdit] = useState<ChequeBook | 'new' | null>(null)
  const [layoutOpen, setLayoutOpen] = useState(false)

  const invalidate = (): Promise<unknown> =>
    Promise.all([queryClient.invalidateQueries({ queryKey: ['chequeBooks'] }), queryClient.invalidateQueries({ queryKey: ['chequeRegister'] })])

  const setStatus = async (r: ChequeRegisterRow, status: 'cancelled' | 'stopped' | 'issued'): Promise<void> => {
    let note: string | null = null
    if (status !== 'issued') {
      note = await promptDialog({
        title: status === 'stopped' ? `Stop payment — cheque ${r.number}` : `Cancel cheque ${r.number}`,
        message: status === 'stopped' ? 'Record the stop-payment instruction given to the bank.' : 'A cancelled leaf is never used again.',
        placeholder: 'Note (optional)',
        confirmLabel: status === 'stopped' ? 'Stop payment' : 'Cancel cheque'
      })
      if (note === null) return
    }
    try {
      await bankingApi.cheques.setStatus({ bankLedgerId, chequeId: r.chequeId, number: r.number, status, note: note || null })
      await invalidate()
    } catch (err) {
      toast.push('error', (err as Error).message)
    }
  }

  const reprint = async (r: ChequeRegisterRow): Promise<void> => {
    if (!r.voucherId) return
    try {
      const res = await bankingApi.cheques.print(r.voucherId, bankLedgerId, r.number)
      toast.push('success', `Cheque ${res.cheque.number}: ${res.path}`)
      await invalidate()
    } catch (err) {
      toast.push('error', (err as Error).message)
    }
  }

  const rows = register ?? []
  const count = (s: ChequeStatus): number => rows.filter((r) => r.status === s).length
  const leavesLeft = (books ?? []).filter((b) => b.active).reduce((s, b) => s + b.leaves - b.used, 0)

  return (
    <>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <Button variant="primary" data-testid="btn-banking-add-chequebook" onClick={() => setBookEdit('new')}>
          Add cheque book…
        </Button>
        <Button data-testid="btn-banking-cheque-setup" onClick={() => setLayoutOpen(true)}>
          Cheque layout &amp; calibration…
        </Button>
        <span className="text-hint text-muted">Print a cheque from a saved payment voucher (Print cheque) — the next leaf is used and recorded here.</span>
      </div>
      <StatGrid className="mb-3">
        <StatTile label="Leaves left" value={String(leavesLeft)} hint={`${books?.filter((b) => b.active).length ?? 0} active ${books?.filter((b) => b.active).length === 1 ? 'book' : 'books'}`} />
        <StatTile label="Issued, not cleared" value={String(count('issued'))} />
        <StatTile label="Cleared" value={String(count('cleared'))} />
        <StatTile label="Cancelled / stopped" value={String(count('cancelled') + count('stopped'))} />
      </StatGrid>

      {(books ?? []).length > 0 && (
        <Panel className="mb-3">
          <div className="flex flex-wrap gap-2 p-3" data-testid="banking-chequebooks">
            {(books ?? []).map((b) => (
              <button
                key={b.id}
                type="button"
                className={`rounded-md border border-line px-3 py-2 text-left hover:border-blue ${b.active ? '' : 'opacity-60'}`}
                onClick={() => setBookEdit(b)}
              >
                <span className="block text-detail font-medium text-ink">{b.name || 'Cheque book'}</span>
                <span className="num block text-caption text-muted">
                  {String(b.fromNo).padStart(b.width, '0')} – {String(b.toNo).padStart(b.width, '0')} · {b.leaves - b.used} of {b.leaves} left{b.active ? '' : ' · inactive'}
                </span>
              </button>
            ))}
          </div>
        </Panel>
      )}

      <Panel>
        <DataTable
          viewId="banking-cheques"
          testId="banking-cheques"
          ariaLabel="Cheque register"
          columns={REGISTER_COLUMNS}
          rows={rows}
          rowKey={(r) => r.key}
          rowAttrs={(r) => ({ 'data-row-id': r.key, 'data-status': r.status })}
          rowClassName={(r) => (r.status === 'available' ? 'text-muted' : '')}
          loading={isLoading}
          maxHeight="52vh"
          empty={{ title: 'No cheques yet', hint: 'Add a cheque book, then use Print cheque on a payment voucher' }}
          toolbarStart={
            <label className="flex items-center gap-2 text-small text-muted">
              <input type="checkbox" checked={showAvailable} onChange={(e) => setShowAvailable(e.target.checked)} data-testid="input-banking-cheques-available" />
              Show unused leaves
            </label>
          }
          trailingWidth={52}
          trailing={(r) => {
            const items =
              r.status === 'available'
                ? [
                    { label: 'Cancel leaf…', onSelect: () => void setStatus(r, 'cancelled'), testId: 'banking-cheque-cancel' },
                    { label: 'Stop payment…', onSelect: () => void setStatus(r, 'stopped') }
                  ]
                : r.status === 'issued' || r.status === 'cleared'
                  ? [
                      ...(r.status === 'issued' ? [{ label: 'Print again', onSelect: () => void reprint(r), testId: 'banking-cheque-reprint' }] : []),
                      { label: 'Stop payment…', onSelect: () => void setStatus(r, 'stopped') },
                      { label: 'Cancel cheque…', onSelect: () => void setStatus(r, 'cancelled'), danger: true }
                    ]
                  : r.voucherId
                    ? [{ label: 'Back to issued', onSelect: () => void setStatus(r, 'issued') }]
                    : []
            return items.length ? (
              <MenuButton label={`Actions for cheque ${r.number}`} testId={`banking-cheque-actions-${r.key}`} className="px-1.5 text-muted hover:text-ink" items={items}>
                ⋯
              </MenuButton>
            ) : null
          }}
          exportOptions={{ title: `Cheque register — ${bankName}`, periodLabel: `as on ${toDisplayDate(todayISO())}`, filename: 'cheque-register' }}
        />
      </Panel>

      {bookEdit && (
        <ChequeBookModal
          bankLedgerId={bankLedgerId}
          book={bookEdit === 'new' ? null : bookEdit}
          onClose={() => setBookEdit(null)}
          onSaved={() => {
            setBookEdit(null)
            void invalidate()
          }}
        />
      )}
      {layoutOpen && <ChequeLayoutModal bankLedgerId={bankLedgerId} bankLedgerName={bankName} onClose={() => setLayoutOpen(false)} />}
    </>
  )
}

function ChequeBookModal({ bankLedgerId, book, onClose, onSaved }: { bankLedgerId: number; book: ChequeBook | null; onClose: () => void; onSaved: () => void }): React.JSX.Element {
  const toast = useToasts()
  const [name, setName] = useState(book?.name ?? '')
  const [fromNo, setFromNo] = useState(book ? String(book.fromNo).padStart(book.width, '0') : '')
  const [toNo, setToNo] = useState(book ? String(book.toNo).padStart(book.width, '0') : '')
  const [receivedOn, setReceivedOn] = useState<string>(book?.receivedOn ?? todayISO())
  const [active, setActive] = useState(book?.active ?? true)
  const save = async (): Promise<void> => {
    if (!/^\d+$/.test(fromNo) || !/^\d+$/.test(toNo)) return void toast.push('error', 'Leaf numbers are digits, e.g. 000451 to 000500')
    try {
      await bankingApi.cheques.saveBook(
        { bankLedgerId, name, fromNo: Number(fromNo), toNo: Number(toNo), width: Math.max(fromNo.length, toNo.length, 1), receivedOn, active },
        book?.id
      )
      toast.push('success', 'Cheque book saved')
      onSaved()
    } catch (err) {
      toast.push('error', (err as Error).message)
    }
  }
  const remove = async (): Promise<void> => {
    if (!book) return
    const ok = await confirmDialog({ title: 'Delete cheque book', message: 'Delete this cheque book? Only possible while none of its leaves is in the register.', confirmLabel: 'Delete', danger: true })
    if (!ok) return
    try {
      await bankingApi.cheques.deleteBook(book.id)
      onSaved()
    } catch (err) {
      toast.push('error', (err as Error).message)
    }
  }
  return (
    <Modal title={book ? 'Cheque book' : 'Add cheque book'} onClose={onClose}>
      <div className="flex flex-col gap-3">
        <div className="grid grid-cols-2 gap-3">
          <Field label="Name">
            <TextInput value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Book 12" data-testid="input-banking-chequebook-name" />
          </Field>
          <Field label="Received on">
            <DateInput value={receivedOn} context={todayISO()} onChange={setReceivedOn} className="w-40" />
          </Field>
          <Field label="First leaf" hint="As printed, leading zeros kept">
            <TextInput value={fromNo} onChange={(e) => setFromNo(e.target.value.trim())} className="num" data-testid="input-banking-chequebook-from" />
          </Field>
          <Field label="Last leaf">
            <TextInput value={toNo} onChange={(e) => setToNo(e.target.value.trim())} className="num" data-testid="input-banking-chequebook-to" />
          </Field>
        </div>
        <Checkbox label="Active (leaves are handed out from it)" checked={active} onChange={setActive} />
        <div className="flex justify-between gap-2">
          <span>{book && <Button variant="danger" onClick={() => void remove()}>Delete</Button>}</span>
          <span className="flex gap-2">
            <Button onClick={onClose}>Cancel</Button>
            <Button variant="primary" data-testid="btn-banking-chequebook-save" onClick={() => void save()}>
              Save
            </Button>
          </span>
        </div>
      </div>
    </Modal>
  )
}

// ---------- layout designer ----------

function MmField({ label, value, onChange, testId, min }: { label: string; value: number; onChange: (n: number) => void; testId?: string; min?: number }): React.JSX.Element {
  return (
    <Field label={label}>
      <TextInput
        type="number"
        step="0.5"
        min={min}
        className="num text-right"
        value={value}
        data-testid={testId}
        onChange={(e) => onChange(Number(e.target.value) || 0)}
      />
    </Field>
  )
}

const PRESETS: { label: string; apply: (c: ChequeConfig) => ChequeConfig }[] = [
  { label: 'CTS-2010 leaf fed directly (202 × 92 mm)', apply: (c) => ({ ...c, widthMm: 202, heightMm: 92, pageWidthMm: 0, pageHeightMm: 0, offsetXMm: 0, offsetYMm: 0 }) },
  { label: 'Leaf on an A4 carrier, top-left', apply: (c) => ({ ...c, widthMm: 202, heightMm: 92, pageWidthMm: 210, pageHeightMm: 297, offsetXMm: 4, offsetYMm: 10 }) },
  { label: 'Reset field positions to defaults', apply: (c) => ({ ...DEFAULT_CHEQUE_CONFIG, widthMm: c.widthMm, heightMm: c.heightMm, pageWidthMm: c.pageWidthMm, pageHeightMm: c.pageHeightMm, offsetXMm: c.offsetXMm, offsetYMm: c.offsetYMm }) }
]

/** Monospace text wrapped to a width in mm (a monospace glyph is ~0.6 em wide). */
function wrapMono(text: string, widthMm: number, sizeMm: number): string[] {
  const perLine = Math.max(8, Math.floor(widthMm / (0.6 * sizeMm)))
  const lines: string[] = []
  let cur = ''
  for (const word of text.split(' ')) {
    if (cur && `${cur} ${word}`.length > perLine) {
      lines.push(cur)
      cur = word
    } else cur = cur ? `${cur} ${word}` : word
  }
  if (cur) lines.push(cur)
  return lines
}

/** SVG text at (x, y) mm, `size` mm tall — sized by scaling (see .cheque-preview in app.css). */
function MmText({ x, y, size, children, anchor, bold }: { x: number; y: number; size: number; children: string; anchor?: 'middle'; bold?: boolean }): React.JSX.Element {
  return (
    <text transform={`translate(${x} ${y}) scale(${size})`} textAnchor={anchor} fontWeight={bold ? 700 : undefined} className="fill-ink">
      {children}
    </text>
  )
}

/** Live, to-scale preview of the leaf (mm grid, every field with sample text). */
export function ChequePreview({ config }: { config: ChequeConfig }): React.JSX.Element {
  const f = chequeFields({ date: todayISO(), payee: 'Shree Packaging Pvt Ltd', amount: 1234550 })
  const w = config.widthMm
  const h = config.heightMm
  const grid: React.JSX.Element[] = []
  for (let x = 10; x < w; x += 10) grid.push(<line key={`x${x}`} x1={x} y1={0} x2={x} y2={h} className={x % 50 === 0 ? 'stroke-line' : 'stroke-line/50'} strokeWidth={0.15} />)
  for (let y = 10; y < h; y += 10) grid.push(<line key={`y${y}`} x1={0} y1={y} x2={w} y2={y} className={y % 50 === 0 ? 'stroke-line' : 'stroke-line/50'} strokeWidth={0.15} />)
  const fs = (config.fontPt * 25.4) / 72 // pt → mm
  const words = wrapMono(f.words, config.words.wMm, fs)
  return (
    <svg
      viewBox={`-6 -6 ${w + 12} ${h + 12}`}
      className="cheque-preview w-full rounded-md border border-line bg-panel2"
      data-testid="banking-cheque-preview"
      role="img"
      aria-label="Cheque layout preview"
    >
      <rect x={0} y={0} width={w} height={h} className="fill-panel stroke-muted" strokeWidth={0.4} />
      {grid}
      {[0, 50, 100, 150, 200]
        .filter((x) => x <= w)
        .map((x) => (
          <MmText key={x} x={x} y={-1.5} size={2.6} anchor="middle">
            {String(x)}
          </MmText>
        ))}
      {config.acPayee && (
        <g transform={`translate(${config.acPayeePos.xMm} ${config.acPayeePos.yMm}) rotate(-12)`}>
          <line x1={0} y1={0} x2={44} y2={0} className="stroke-ink" strokeWidth={0.4} />
          <MmText x={22} y={4} size={3} anchor="middle" bold>
            A/C PAYEE ONLY
          </MmText>
          <line x1={0} y1={6} x2={44} y2={6} className="stroke-ink" strokeWidth={0.4} />
        </g>
      )}
      {f.dateBoxes.split('').map((d, i) => (
        <MmText key={i} x={config.date.xMm + i * config.date.charGapMm} y={config.date.yMm + fs} size={fs}>
          {d}
        </MmText>
      ))}
      <MmText x={config.payee.xMm} y={config.payee.yMm + fs} size={fs}>
        {f.payee}
      </MmText>
      {words.map((line, i) => (
        <MmText key={i} x={config.words.xMm} y={config.words.yMm + fs * (i + 1) * 1.2} size={fs}>
          {line}
        </MmText>
      ))}
      <rect
        x={config.words.xMm}
        y={config.words.yMm}
        width={config.words.wMm}
        height={fs * 1.2 * Math.max(2, words.length) + fs * 0.4}
        className="fill-none stroke-blue/40"
        strokeWidth={0.2}
        strokeDasharray="1 1"
      />
      <MmText x={config.figures.xMm} y={config.figures.yMm + fs} size={fs}>
        {f.figures}
      </MmText>
    </svg>
  )
}

export function ChequeLayoutModal({ bankLedgerId, bankLedgerName, onClose }: { bankLedgerId: number; bankLedgerName: string; onClose: () => void }): React.JSX.Element {
  const toast = useToasts()
  const { data: saved, error: loadError, refetch } = useQuery({ queryKey: ['chequeConfig', bankLedgerId], queryFn: () => api.cheque.config.get(bankLedgerId) })
  const [form, setForm] = useState<ChequeConfig | null>(null)
  const [snapshot, setSnapshot] = useState<ChequeConfig | null>(null)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    if (saved && !form) {
      setForm(saved)
      setSnapshot(saved)
    }
  }, [saved, form])
  const dirty = form != null && snapshot != null && JSON.stringify(form) !== JSON.stringify(snapshot)
  useUnsavedGuard(dirty)
  const pageNote = useMemo(() => (form ? (form.pageWidthMm > 0 ? `${form.pageWidthMm} × ${form.pageHeightMm} mm paper` : 'paper = the leaf') : ''), [form])

  const save = async (): Promise<boolean> => {
    if (!form) return false
    setBusy(true)
    try {
      await api.cheque.config.set(bankLedgerId, form)
      setSnapshot(form)
      return true
    } catch (err) {
      toast.push('error', (err as Error).message)
      return false
    } finally {
      setBusy(false)
    }
  }
  const printGrid = async (): Promise<void> => {
    if (!(await save())) return
    try {
      const r = await api.cheque.testGrid(bankLedgerId)
      toast.push('success', `Test grid: ${r.path}`)
    } catch (err) {
      toast.push('error', (err as Error).message)
    }
  }

  if (!form) {
    return (
      <Modal title={`Cheque layout — ${bankLedgerName}`} onClose={onClose} wide>
        {loadError ? (
          <div className="flex flex-col items-start gap-3">
            <p className="text-detail text-cr">Couldn’t load the cheque layout: {(loadError as Error).message}</p>
            <Button data-testid="btn-banking-cheque-retry" onClick={() => void refetch()}>
              Try again
            </Button>
          </div>
        ) : (
          <div className="flex items-center gap-2 py-4 text-detail text-muted">
            <Spinner /> Loading cheque layout…
          </div>
        )}
      </Modal>
    )
  }
  const pos = (key: 'payee' | 'figures' | 'acPayeePos', axis: 'xMm' | 'yMm', n: number): void => setForm({ ...form, [key]: { ...form[key], [axis]: n } })
  return (
    <Modal title={`Cheque layout — ${bankLedgerName}`} onClose={onClose} wide dirty={dirty}>
      <div className="flex flex-col gap-4">
        <ChequePreview config={form} />
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-caption text-muted">Start from:</span>
          {PRESETS.map((p) => (
            <Button key={p.label} size="sm" variant="ghost" onClick={() => setForm(p.apply(form))}>
              {p.label}
            </Button>
          ))}
        </div>
        <div className="grid grid-cols-6 gap-3">
          <MmField label="Leaf width" value={form.widthMm} onChange={(n) => setForm({ ...form, widthMm: n })} testId="input-cheque-width" />
          <MmField label="Leaf height" value={form.heightMm} onChange={(n) => setForm({ ...form, heightMm: n })} />
          <MmField label="Paper width (0 = leaf)" value={form.pageWidthMm} min={0} onChange={(n) => setForm({ ...form, pageWidthMm: n })} />
          <MmField label="Paper height" value={form.pageHeightMm} min={0} onChange={(n) => setForm({ ...form, pageHeightMm: n })} />
          <MmField label="Leaf offset X" value={form.offsetXMm} onChange={(n) => setForm({ ...form, offsetXMm: n })} testId="input-cheque-offset-x" />
          <MmField label="Leaf offset Y" value={form.offsetYMm} onChange={(n) => setForm({ ...form, offsetYMm: n })} />
        </div>
        <div className="grid grid-cols-6 gap-3">
          <MmField label="Date X" value={form.date.xMm} onChange={(n) => setForm({ ...form, date: { ...form.date, xMm: n } })} />
          <MmField label="Date Y" value={form.date.yMm} onChange={(n) => setForm({ ...form, date: { ...form.date, yMm: n } })} />
          <MmField label="Date box gap" value={form.date.charGapMm} onChange={(n) => setForm({ ...form, date: { ...form.date, charGapMm: n } })} />
          <MmField label="Payee X" value={form.payee.xMm} onChange={(n) => pos('payee', 'xMm', n)} />
          <MmField label="Payee Y" value={form.payee.yMm} onChange={(n) => pos('payee', 'yMm', n)} />
          <MmField label="Font (pt)" value={form.fontPt} onChange={(n) => setForm({ ...form, fontPt: n })} />
          <MmField label="Words X" value={form.words.xMm} onChange={(n) => setForm({ ...form, words: { ...form.words, xMm: n } })} />
          <MmField label="Words Y" value={form.words.yMm} onChange={(n) => setForm({ ...form, words: { ...form.words, yMm: n } })} />
          <MmField label="Words width" value={form.words.wMm} onChange={(n) => setForm({ ...form, words: { ...form.words, wMm: n } })} />
          <MmField label="Figures X" value={form.figures.xMm} onChange={(n) => pos('figures', 'xMm', n)} />
          <MmField label="Figures Y" value={form.figures.yMm} onChange={(n) => pos('figures', 'yMm', n)} />
          <div />
          <div className="col-span-2 flex items-end pb-1.5">
            <Checkbox label="A/C payee crossing" checked={form.acPayee} onChange={(v) => setForm({ ...form, acPayee: v })} />
          </div>
          <MmField label="Crossing X" value={form.acPayeePos.xMm} onChange={(n) => pos('acPayeePos', 'xMm', n)} />
          <MmField label="Crossing Y" value={form.acPayeePos.yMm} onChange={(n) => pos('acPayeePos', 'yMm', n)} />
        </div>
        <p className="text-hint text-muted">
          All positions are millimetres from the leaf’s top-left corner ({pageNote}). Print the test grid on plain paper, hold it over a blank leaf against the light, and adjust the offsets until the crosses sit on the printed boxes.
        </p>
        <div className="flex justify-end gap-2 border-t border-line pt-4">
          <Button disabled={busy} data-testid="btn-banking-cheque-test-grid" onClick={() => void printGrid()}>
            Print test grid
          </Button>
          <Button
            variant="primary"
            disabled={busy || !dirty}
            data-testid="btn-banking-cheque-save"
            onClick={() => void save().then((ok) => ok && toast.push('success', 'Cheque layout saved'))}
          >
            Save
          </Button>
        </div>
      </div>
    </Modal>
  )
}
