// WP 2.6 — Masters › Price lists: the items × levels grid (rates as on a date, edited in place),
// the level tools (new / rename / default / GST-inclusive / bulk % / copy / delete), per-item
// quantity slabs and date ranges, and CSV import / export through the existing CSV paths
// (import:pickCsv, export:csv).
import { useEffect, useMemo, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { PriceLevel } from '@shared/domain'
import { formatPaise, parseRupees } from '@shared/money'
import { toDisplayDate } from '@shared/dates'
import { api } from '../../lib/client'
import { pricingApi, type RateGrid } from '../../lib/pricingClient'
import { useSession, useToasts } from '../../state/stores'
import { AmountInput, Button, Checkbox, DateInput, Field, Modal, PageActions, Panel, Select, TextInput, inputCls } from '../../components/ui'
import { MenuButton } from '../../components/kit'
import { DataTable, defineColumns, type TableColumn } from '../../components/table'
import { ItemLink } from '../../components/links'
import { confirmDialog, promptDialog } from '../../lib/dialogs'

type GridRow = RateGrid['rows'][number]

const BASE_COLUMNS = defineColumns<GridRow>([
  {
    id: 'item', header: 'Item', kind: 'text', value: (r) => r.itemName, hideable: false, groupable: false, minWidth: 180,
    cell: (r) => <ItemLink itemId={r.itemId} name={r.itemName} />
  },
  { id: 'barcode', header: 'Barcode', kind: 'text', value: (r) => r.barcode ?? '', className: 'num text-muted', width: 130, defaultHidden: true, groupable: false },
  { id: 'unit', header: 'Unit', kind: 'text', value: (r) => r.unitSymbol, className: 'text-muted', width: 70 },
  { id: 'gst', header: 'GST %', kind: 'number', value: (r) => r.gstRate, width: 80 },
  { id: 'mrp', header: 'MRP', kind: 'money', value: (r) => r.mrpPaise, width: 110 },
  { id: 'cost', header: 'Std cost', kind: 'money', value: (r) => r.standardCostPaise, width: 110, defaultHidden: true }
])

/** A price cell edited in place: Enter / blur commits, Esc restores, empty clears the row. */
export function RateCell({
  value,
  onCommit,
  testId,
  label
}: {
  value: number | null
  onCommit: (paise: number | null) => Promise<void>
  testId?: string
  label: string
}): React.JSX.Element {
  const shown = value != null ? formatPaise(value) : ''
  const [text, setText] = useState(shown)
  useEffect(() => setText(shown), [shown])
  const invalid = text.trim() !== '' && parseRupees(text) == null
  const commit = async (): Promise<void> => {
    const next = text.trim() === '' ? null : parseRupees(text)
    if (text.trim() !== '' && next == null) return
    if (next === value) return setText(shown)
    await onCommit(next)
  }
  return (
    <input
      className={`${inputCls} num h-control-sm text-right ${invalid ? 'border-danger/70' : ''}`}
      value={text}
      inputMode="decimal"
      placeholder="—"
      aria-label={label}
      data-testid={testId}
      onChange={(e) => setText(e.target.value)}
      onFocus={(e) => e.target.select()}
      onBlur={() => void commit()}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault()
          ;(e.target as HTMLInputElement).blur()
        } else if (e.key === 'Escape') {
          setText(shown)
        }
      }}
    />
  )
}

export function PriceListsTab(): React.JSX.Element {
  const { workingDate } = useSession()
  const toast = useToasts()
  const queryClient = useQueryClient()
  const [date, setDate] = useState(workingDate)
  const { data, isLoading } = useQuery({ queryKey: ['pricingGrid', date], queryFn: () => pricingApi.grid(date) })
  const levels = useMemo(() => data?.levels ?? [], [data])
  const [levelId, setLevelId] = useState<number | null>(null)
  const level = levels.find((l) => l.id === levelId) ?? levels[0] ?? null
  const [editing, setEditing] = useState<PriceLevel | 'new' | null>(null)
  const [slabsFor, setSlabsFor] = useState<{ level: PriceLevel; itemId: number; itemName: string } | null>(null)
  const [bulk, setBulk] = useState<PriceLevel | null>(null)

  const refresh = async (): Promise<void> => {
    await queryClient.invalidateQueries({ queryKey: ['pricingGrid'] })
    await queryClient.invalidateQueries({ queryKey: ['priceLevels'] })
  }
  const run = async (fn: () => Promise<unknown>, ok?: string): Promise<void> => {
    try {
      await fn()
      await refresh()
      if (ok) toast.push('success', ok)
    } catch (err) {
      toast.push('error', (err as Error).message)
    }
  }

  const columns = useMemo(() => {
    const levelCols: TableColumn<GridRow>[] = levels.map((l) => ({
      id: `level-${l.id}`,
      header: `${l.isDefault ? '★ ' : ''}${l.name}${l.inclusiveOfTax ? ' · incl. GST' : ''}`,
      kind: 'money' as const,
      value: (r: GridRow) => r.rates[l.id]?.rate ?? null,
      width: 180,
      groupable: false,
      cell: (r: GridRow) => {
        const cell = r.rates[l.id] ?? null
        return (
          <div className="flex flex-col items-end">
            <RateCell
              value={cell?.rate ?? null}
              label={`${l.name} rate for ${r.itemName}`}
              testId={`input-price-${l.id}-${r.itemId}`}
              onCommit={(rate) => run(() => pricingApi.setGridRate(l.id, r.itemId, date, rate))}
            />
            <button
              type="button"
              className="mt-0.5 text-hint text-blue hover:underline"
              data-testid={`btn-price-slabs-${l.id}-${r.itemId}`}
              onClick={() => setSlabsFor({ level: l, itemId: r.itemId, itemName: r.itemName })}
              title={cell ? `From ${toDisplayDate(cell.effectiveFrom)}${cell.effectiveTo ? ` to ${toDisplayDate(cell.effectiveTo)}` : ''}` : 'Quantity slabs and dates'}
            >
              {cell?.slabs ? `+${cell.slabs} slab${cell.slabs === 1 ? '' : 's'}` : 'slabs / dates'}
            </button>
          </div>
        )
      }
    }))
    return [...BASE_COLUMNS, ...levelCols]
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [levels, date])

  const importCsv = async (): Promise<void> => {
    const picked = await api.importer.pickCsv()
    if (!picked) return
    try {
      const dry = await pricingApi.importCsv(picked.csvText, true)
      if (dry.errors.length > 0) {
        toast.push('error', `${picked.fileName}: ${dry.errors.slice(0, 3).map((e) => `line ${e.line}: ${e.message}`).join('; ')}${dry.errors.length > 3 ? ` (+${dry.errors.length - 3} more)` : ''}`)
        return
      }
      const ok = await confirmDialog({
        title: 'Import price list',
        message: `Import ${dry.rows} rate row${dry.rows === 1 ? '' : 's'} from ${picked.fileName}?${dry.newLevels.length ? ` New levels: ${dry.newLevels.join(', ')}.` : ''} Rows with the same level, item, slab and start date are replaced.`,
        confirmLabel: 'Import'
      })
      if (!ok) return
      await run(() => pricingApi.importCsv(picked.csvText), `${dry.rows} rates imported`)
    } catch (err) {
      toast.push('error', (err as Error).message)
    }
  }
  const exportCsv = async (l?: PriceLevel): Promise<void> => {
    try {
      const { csv } = await pricingApi.exportCsv(l?.id)
      const { path } = await api.exportReport.csv(l ? `price-list-${l.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}` : 'price-lists', csv)
      toast.push('success', `Saved ${path}`)
    } catch (err) {
      toast.push('error', (err as Error).message)
    }
  }

  const levelMenu = level
    ? [
        { label: 'Rename…', testId: 'menu-level-rename', onSelect: async () => {
          const name = await promptDialog({ title: 'Rename price level', initial: level.name, confirmLabel: 'Rename' })
          if (name?.trim()) await run(() => api.priceLevels.update(level.id, { name: name.trim() }))
        } },
        { label: level.isDefault ? 'Not the default level' : 'Make the default level', testId: 'menu-level-default', onSelect: () =>
          void run(() => api.priceLevels.update(level.id, { name: level.name, isDefault: !level.isDefault })) },
        { label: level.inclusiveOfTax ? 'Rates exclude GST' : 'Rates include GST', testId: 'menu-level-inclusive', onSelect: () =>
          void run(() => api.priceLevels.update(level.id, { name: level.name, inclusiveOfTax: !level.inclusiveOfTax })) },
        { label: 'Change by %…', testId: 'menu-level-bulk', onSelect: () => setBulk(level) },
        { label: 'Copy to a new level…', testId: 'menu-level-copy', onSelect: async () => {
          const name = await promptDialog({ title: `Copy ${level.name}`, message: 'Name of the new level (same rates and slabs; change them by % afterwards).', initial: `${level.name} copy`, confirmLabel: 'Copy' })
          if (name?.trim()) await run(() => pricingApi.copyLevel({ fromLevelId: level.id, name: name.trim() }), `Copied to ${name.trim()}`)
        } },
        { label: 'Export this level (CSV)', onSelect: () => void exportCsv(level) },
        { label: 'Delete level…', danger: true, testId: 'menu-level-delete', onSelect: async () => {
          const ok = await confirmDialog({ title: 'Delete price level', message: `Delete ${level.name} and its ${level.rateCount ?? 0} rates?`, confirmLabel: 'Delete', danger: true })
          if (ok) await run(() => api.priceLevels.remove(level.id), 'Price level deleted')
        } }
      ]
    : []

  return (
    <>
      <PageActions>
        <Button variant="primary" data-testid="btn-price-level-new" onClick={() => setEditing('new')}>
          New price level
        </Button>
      </PageActions>
      <Panel>
        <DataTable
          viewId="masters-price-lists"
          testId="masters-price-lists"
          ariaLabel="Price lists"
          columns={columns}
          rows={data?.rows ?? []}
          rowKey={(r) => r.itemId}
          rowAttrs={(r) => ({ 'data-row-id': r.itemId })}
          loading={isLoading}
          empty={{ title: 'No stock items yet', hint: 'Add items in Masters › Stock items, then price them here' }}
          exportOptions={{ title: 'Price lists', periodLabel: `Rates as on ${toDisplayDate(date)}`, filename: 'price-lists' }}
          toolbarStart={
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-caption text-muted">Rates as on</span>
              <DateInput value={date} context={workingDate} onChange={setDate} className="w-32" testId="input-price-date" ariaLabel="Rates as on" />
              {levels.length > 0 && (
                <>
                  <Select value={level?.id ?? ''} onChange={(e) => setLevelId(Number(e.target.value))} className="w-44" aria-label="Price level" data-testid="input-price-level">
                    {levels.map((l) => (
                      <option key={l.id} value={l.id}>
                        {l.name}
                      </option>
                    ))}
                  </Select>
                  <MenuButton label="Level actions" items={levelMenu} testId="btn-price-level-actions" align="left">
                    Level ▾
                  </MenuButton>
                </>
              )}
            </div>
          }
          toolbarEnd={
            <div className="flex items-center gap-2">
              <Button size="sm" variant="ghost" data-testid="btn-price-import" onClick={() => void importCsv()}>
                Import CSV…
              </Button>
              <Button size="sm" variant="ghost" data-testid="btn-price-export" onClick={() => void exportCsv()} disabled={levels.length === 0}>
                Export CSV
              </Button>
            </div>
          }
        />
        {levels.length === 0 && !isLoading && (
          <p className="px-panel pb-3 text-hint text-muted">
            No price levels yet — add one (Retail, Wholesale…) and type rates into its column. Mark one the default; parties pick theirs in the ledger form.
          </p>
        )}
      </Panel>
      {editing && <LevelModal level={editing === 'new' ? null : editing} onClose={() => setEditing(null)} onSaved={refresh} />}
      {bulk && <BulkModal level={bulk} date={date} onClose={() => setBulk(null)} onDone={refresh} />}
      {slabsFor && <SlabsModal {...slabsFor} onClose={() => setSlabsFor(null)} onChanged={refresh} />}
    </>
  )
}

function LevelModal({ level, onClose, onSaved }: { level: PriceLevel | null; onClose: () => void; onSaved: () => Promise<void> }): React.JSX.Element {
  const toast = useToasts()
  const [name, setName] = useState(level?.name ?? '')
  const [inclusive, setInclusive] = useState(level?.inclusiveOfTax ?? false)
  const [isDefault, setIsDefault] = useState(level?.isDefault ?? false)
  const save = async (): Promise<void> => {
    try {
      const data = { name: name.trim(), inclusiveOfTax: inclusive, isDefault }
      if (level) await api.priceLevels.update(level.id, data)
      else await api.priceLevels.create(data)
      await onSaved()
      toast.push('success', `Price level ${data.name} ${level ? 'saved' : 'added'}`)
      onClose()
    } catch (err) {
      toast.push('error', (err as Error).message)
    }
  }
  return (
    <Modal title={level ? `Edit ${level.name}` : 'New price level'} onClose={onClose}>
      <div className="flex flex-col gap-3">
        <Field label="Name">
          <TextInput autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Retail, Wholesale, Dealer…" data-testid="input-price-level-name" />
        </Field>
        <Checkbox
          label="Rates include GST"
          hint="Type the price the customer pays; invoices back out the taxable rate exactly (to the paisa)."
          checked={inclusive}
          onChange={setInclusive}
          testId="input-price-level-inclusive"
        />
        <Checkbox
          label="Default level"
          hint="Prices every party without a level of its own (and walk-in counter sales)."
          checked={isDefault}
          onChange={setIsDefault}
          testId="input-price-level-default"
        />
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={() => void save()} disabled={!name.trim()} data-testid="btn-price-level-save">
            Save level
          </Button>
        </div>
      </div>
    </Modal>
  )
}

function BulkModal({ level, date, onClose, onDone }: { level: PriceLevel; date: string; onClose: () => void; onDone: () => Promise<void> }): React.JSX.Element {
  const toast = useToasts()
  const { workingDate } = useSession()
  const [pct, setPct] = useState('')
  const [round, setRound] = useState('1')
  const [fromDate, setFromDate] = useState(date)
  const [keepHistory, setKeepHistory] = useState(true)
  const changeBp = Math.round(Number(pct) * 100)
  const valid = pct.trim() !== '' && Number.isFinite(changeBp) && changeBp !== 0 && changeBp > -9900
  const apply = async (): Promise<void> => {
    try {
      const r = await pricingApi.bulkUpdate({ priceLevelId: level.id, changeBp, roundToPaise: Number(round), ...(keepHistory ? { effectiveFrom: fromDate } : {}) })
      await onDone()
      toast.push('success', `${r.updated} rate${r.updated === 1 ? '' : 's'} changed by ${pct}%`)
      onClose()
    } catch (err) {
      toast.push('error', (err as Error).message)
    }
  }
  return (
    <Modal title={`Change ${level.name} by %`} onClose={onClose}>
      <div className="flex flex-col gap-3">
        <div className="grid grid-cols-2 gap-3">
          <Field label="Change %" hint="+5 raises, −2.5 lowers">
            <TextInput autoFocus value={pct} onChange={(e) => setPct(e.target.value)} className="num text-right" placeholder="5" data-testid="input-price-bulk-pct" />
          </Field>
          <Field label="Round to">
            <Select value={round} onChange={(e) => setRound(e.target.value)}>
              <option value="1">The paisa</option>
              <option value="100">The rupee</option>
              <option value="500">₹5</option>
              <option value="1000">₹10</option>
            </Select>
          </Field>
        </div>
        <Checkbox
          label="Keep the price history"
          hint="The new rates start on the date below and the current ones end the day before. Off: every row of the level is re-priced in place."
          checked={keepHistory}
          onChange={setKeepHistory}
        />
        {keepHistory && (
          <Field label="New rates from">
            <DateInput value={fromDate} context={workingDate} onChange={setFromDate} />
          </Field>
        )}
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={!valid} onClick={() => void apply()} data-testid="btn-price-bulk-apply">
            Apply
          </Button>
        </div>
      </div>
    </Modal>
  )
}

/** Every row of one item under one level: date ranges, quantity slabs with their discounts, and
 *  foreign-currency rates. */
function SlabsModal({ level, itemId, itemName, onClose, onChanged }: { level: PriceLevel; itemId: number; itemName: string; onClose: () => void; onChanged: () => Promise<void> }): React.JSX.Element {
  const toast = useToasts()
  const { workingDate } = useSession()
  const queryClient = useQueryClient()
  const { data } = useQuery({ queryKey: ['priceRates', level.id], queryFn: () => api.priceLevels.rates(level.id) })
  const rows = (data ?? []).filter((r) => r.stockItemId === itemId)
  const [from, setFrom] = useState(workingDate)
  const [to, setTo] = useState('')
  const [minQty, setMinQty] = useState('')
  const [rate, setRate] = useState<number | null>(null)
  const [disc, setDisc] = useState('')
  const [currency, setCurrency] = useState('INR')
  const { data: currencies } = useQuery({ queryKey: ['currencies'], queryFn: api.currencies.list })
  const refresh = async (): Promise<void> => {
    await queryClient.invalidateQueries({ queryKey: ['priceRates', level.id] })
    await onChanged()
  }
  const add = async (): Promise<void> => {
    if (rate == null) return void toast.push('error', 'Enter the rate')
    try {
      await api.priceLevels.saveRate({
        priceLevelId: level.id, stockItemId: itemId, rate, effectiveFrom: from, effectiveTo: to || null,
        minQtyMilli: minQty.trim() ? Math.round(Number(minQty) * 1000) : 0, discountBp: disc.trim() ? Math.round(Number(disc) * 100) : 0, currency
      })
      setRate(null)
      setMinQty('')
      setDisc('')
      await refresh()
    } catch (err) {
      toast.push('error', (err as Error).message)
    }
  }
  return (
    <Modal title={`${itemName} — ${level.name}`} onClose={onClose} wide>
      <table className="ledger-table" data-testid="table-price-slabs">
        <thead>
          <tr>
            <th>From</th>
            <th>To</th>
            <th className="r">From qty</th>
            <th className="r">Rate{level.inclusiveOfTax ? ' (incl. GST)' : ''}</th>
            <th className="r">Disc. %</th>
            <th>Currency</th>
            <th className="w-16" />
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id}>
              <td className="num">{toDisplayDate(r.effectiveFrom)}</td>
              <td className="num">{r.effectiveTo ? toDisplayDate(r.effectiveTo) : '—'}</td>
              <td className="r num">{(r.minQtyMilli ?? 0) > 0 ? (r.minQtyMilli ?? 0) / 1000 : '—'}</td>
              <td className="r num">{formatPaise(r.rate)}</td>
              <td className="r num">{r.discountBp ? r.discountBp / 100 : '—'}</td>
              <td>{r.currency ?? 'INR'}</td>
              <td className="r">
                <button
                  type="button"
                  className="text-small text-cr hover:underline"
                  onClick={async () => {
                    try {
                      await api.priceLevels.deleteRate(r.id)
                      await refresh()
                    } catch (err) {
                      toast.push('error', (err as Error).message)
                    }
                  }}
                >
                  Remove
                </button>
              </td>
            </tr>
          ))}
          {rows.length === 0 && (
            <tr>
              <td colSpan={7} className="text-hint text-muted">
                No rates yet.
              </td>
            </tr>
          )}
        </tbody>
      </table>
      <div className="mt-4 grid grid-cols-6 items-end gap-2">
        <Field label="From">
          <DateInput value={from} context={workingDate} onChange={setFrom} />
        </Field>
        <Field label="To (optional)">
          <DateInput value={to} context={workingDate} onChange={setTo} allowEmpty placeholder="Open" />
        </Field>
        <Field label="From qty" hint="0 = base rate">
          <TextInput value={minQty} onChange={(e) => setMinQty(e.target.value)} className="num text-right" placeholder="0" data-testid="input-price-slab-qty" />
        </Field>
        <Field label="Rate">
          <AmountInput paise={rate} onPaise={setRate} testId="input-price-slab-rate" />
        </Field>
        <Field label="Disc. %">
          <TextInput value={disc} onChange={(e) => setDisc(e.target.value)} className="num text-right" placeholder="0" data-testid="input-price-slab-disc" />
        </Field>
        <Field label="Currency">
          <Select value={currency} onChange={(e) => setCurrency(e.target.value)}>
            <option value="INR">₹ INR</option>
            {(currencies ?? []).map((c) => (
              <option key={c.id} value={c.code}>
                {c.code}
              </option>
            ))}
          </Select>
        </Field>
      </div>
      <div className="mt-4 flex justify-end gap-2">
        <Button onClick={onClose}>Done</Button>
        <Button variant="primary" onClick={() => void add()} data-testid="btn-price-slab-add">
          Add rate
        </Button>
      </div>
    </Modal>
  )
}
