import { useEffect, useMemo, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { CostCentre, Ledger } from '@shared/domain'
import type { VoucherInputParsed } from '@shared/schemas'
import { formatPaise } from '@shared/money'
import {
  allocationComplete, bpsOfAmount, formatBps, FULL_BPS, parsePercent, splitByPercent, totalBps
} from '@shared/costSplit'
import { todayISO } from '@shared/dates'
import { nextDueAfter } from '@shared/recurring'
import { api } from '../../lib/client'
import { useToasts } from '../../state/stores'
import { AmountInput, Button, DateInput, Field, Modal, Select, TextInput } from '../../components/ui'
import { useGroups } from '../../components/pickers'
import { groupAncestryNames, PARTY_GROUPS, TRADING_GROUPS } from '../../components/LedgerFormModal'

// ---------- "Save as recurring…" modal (AccountingEntry + InvoiceEntry) ----------

const RECURRING_WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

/** Serializes the CURRENT form state (via `buildPayload`, the same helper the Save button uses)
 *  into a recurring template. Does NOT save the voucher itself. */
export function SaveAsRecurringModal({
  buildPayload,
  onClose
}: {
  buildPayload: () => VoucherInputParsed | null | Promise<VoucherInputParsed | null>
  onClose: () => void
}): React.JSX.Element {
  const toast = useToasts()
  const queryClient = useQueryClient()
  const today = todayISO()
  const todayDay = Number(today.slice(8, 10))
  const todayWeekday = new Date(today + 'T00:00:00Z').getUTCDay()
  const [name, setName] = useState('')
  const [cadence, setCadence] = useState<'monthly' | 'weekly'>('monthly')
  const [dayOfMonth, setDayOfMonth] = useState(todayDay)
  const [weekday, setWeekday] = useState(todayWeekday)
  const [nextDue, setNextDue] = useState(() => nextDueAfter('monthly', { dayOfMonth: todayDay }, today))
  const [saving, setSaving] = useState(false)

  const changeCadence = (next: 'monthly' | 'weekly'): void => {
    setCadence(next)
    setNextDue(
      next === 'monthly'
        ? nextDueAfter('monthly', { dayOfMonth }, today)
        : nextDueAfter('weekly', { weekday }, today)
    )
  }

  const save = async (): Promise<void> => {
    if (!name.trim()) return void toast.push('error', 'Name is required')
    setSaving(true)
    try {
      const payload = await buildPayload()
      if (!payload) {
        toast.push('error', 'Finish the voucher (balanced lines / party & items) before saving it as recurring')
        return
      }
      await api.recurring.save({
        name: name.trim(),
        voucherJson: JSON.stringify(payload),
        cadence,
        dayOfMonth: cadence === 'monthly' ? dayOfMonth : undefined,
        weekday: cadence === 'weekly' ? weekday : undefined,
        nextDue,
        active: true
      })
      await queryClient.invalidateQueries()
      toast.push('success', `Recurring template "${name.trim()}" saved`)
      onClose()
    } catch (err) {
      toast.push('error', (err as Error).message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal title="Save as recurring…" onClose={onClose}>
      <div className="flex flex-col gap-3">
        <Field label="Name" hint="e.g. “Monthly office rent”">
          <TextInput autoFocus value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Cadence">
            <Select value={cadence} onChange={(e) => changeCadence(e.target.value as 'monthly' | 'weekly')}>
              <option value="monthly">Monthly</option>
              <option value="weekly">Weekly</option>
            </Select>
          </Field>
          {cadence === 'monthly' ? (
            <Field label="Day of month" hint="Clamped to shorter months">
              <TextInput
                type="number"
                min={1}
                max={31}
                value={dayOfMonth}
                onChange={(e) => {
                  const d = Math.max(1, Math.min(31, Number(e.target.value) || 1))
                  setDayOfMonth(d)
                  setNextDue(nextDueAfter('monthly', { dayOfMonth: d }, today))
                }}
                className="num"
              />
            </Field>
          ) : (
            <Field label="Weekday">
              <Select
                value={weekday}
                onChange={(e) => {
                  const w = Number(e.target.value)
                  setWeekday(w)
                  setNextDue(nextDueAfter('weekly', { weekday: w }, today))
                }}
              >
                {RECURRING_WEEKDAYS.map((w, i) => (
                  <option key={w} value={i}>
                    {w}
                  </option>
                ))}
              </Select>
            </Field>
          )}
        </div>
        <Field label="First due">
          <DateInput value={nextDue} context={nextDue} onChange={setNextDue} />
        </Field>
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={saving} onClick={() => void save()}>
            Save template
          </Button>
        </div>
      </div>
    </Modal>
  )
}

// ---------- named voucher templates (#27) ----------

/**
 * "Save as template…" — the same shape, without a schedule.
 *
 * Sits beside "Save as recurring…" and shares its serialiser (`buildPayload`, the helper the
 * Save button itself uses), so a template can only ever hold a voucher the entry screen would
 * have accepted. The difference from recurring is the whole point: this one never posts. It waits
 * until somebody reaches for it.
 */
export function SaveAsTemplateModal({
  voucherTypeId,
  buildPayload,
  onClose
}: {
  voucherTypeId: number
  buildPayload: () => VoucherInputParsed | null | Promise<VoucherInputParsed | null>
  onClose: () => void
}): React.JSX.Element {
  const toast = useToasts()
  const queryClient = useQueryClient()
  const [name, setName] = useState('')
  const [saving, setSaving] = useState(false)

  const save = async (): Promise<void> => {
    if (!name.trim()) return void toast.push('error', 'Name is required')
    setSaving(true)
    try {
      const payload = await buildPayload()
      if (!payload) {
        toast.push('error', 'Finish the voucher (balanced lines / party & items) before saving it as a template')
        return
      }
      await api.vtemplates.save({ name: name.trim(), voucherTypeId, voucherJson: JSON.stringify(payload) })
      await queryClient.invalidateQueries({ queryKey: ['vtemplates'] })
      toast.push('success', `Template "${name.trim()}" saved`)
      onClose()
    } catch (err) {
      toast.push('error', (err as Error).message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal title="Save as template…" onClose={onClose}>
      <div className="flex flex-col gap-3">
        <Field label="Name" hint="e.g. “Branch expense journal”">
          <TextInput autoFocus value={name} data-testid="input-template-name" onChange={(e) => setName(e.target.value)} />
        </Field>
        <p className="text-small text-muted">
          The lines, party and narration are kept. The date and the voucher number are not — both are
          decided when you actually post it.
        </p>
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={saving} data-testid="btn-save-template" onClick={() => void save()}>
            Save template
          </Button>
        </div>
      </div>
    </Modal>
  )
}

/**
 * Pick a template to load into the form.
 *
 * Ordered most-used first by the service, which is the ordering that matters for something typed
 * daily. A template broken by a later deletion still lists, greyed and unusable, with the reason
 * on the row — hiding it would leave the user with no way to delete it, and no idea why the one
 * they remember has gone.
 */
export function TemplatePickerModal({
  voucherTypeId,
  date,
  onClose,
  onPick
}: {
  voucherTypeId: number
  /** The date the loaded voucher should carry — the form's current date, not today. */
  date: string
  onClose: () => void
  onPick: (shape: VoucherInputParsed) => void
}): React.JSX.Element {
  const toast = useToasts()
  const queryClient = useQueryClient()
  const { data: templates, isLoading } = useQuery({
    queryKey: ['vtemplates', voucherTypeId],
    queryFn: () => api.vtemplates.list(voucherTypeId)
  })

  const apply = async (id: number): Promise<void> => {
    try {
      const { shape } = await api.vtemplates.use(id, date)
      await queryClient.invalidateQueries({ queryKey: ['vtemplates'] })
      onPick(shape)
      onClose()
    } catch (err) {
      toast.push('error', (err as Error).message)
    }
  }

  const remove = async (id: number, name: string): Promise<void> => {
    try {
      await api.vtemplates.remove(id)
      await queryClient.invalidateQueries({ queryKey: ['vtemplates'] })
      toast.push('success', `Template "${name}" deleted`)
    } catch (err) {
      toast.push('error', (err as Error).message)
    }
  }

  return (
    <Modal title="Templates" onClose={onClose}>
      <div className="flex flex-col gap-2" data-testid="template-list">
        {isLoading ? (
          <p className="text-small text-muted">Loading…</p>
        ) : (templates ?? []).length === 0 ? (
          <p className="text-small text-muted">
            No templates for this voucher type yet. Fill a voucher in and use “Save as template…”.
          </p>
        ) : (
          (templates ?? []).map((t) => (
            <div key={t.id} className="flex items-center gap-2 rounded-md border border-hair px-3 py-2">
              <div className="min-w-0 flex-1">
                <div className="truncate text-body-sm">{t.name}</div>
                <div className="text-caption text-muted">
                  {t.lineCount} line{t.lineCount === 1 ? '' : 's'} · {formatPaise(t.total)}
                  {t.usedCount > 0 ? ` · used ${t.usedCount}×` : ''}
                </div>
                {t.problem && (
                  <div className="text-caption text-cr" data-testid="template-problem">
                    Cannot be used: {t.problem}
                  </div>
                )}
              </div>
              <Button
                variant="primary"
                disabled={t.problem != null}
                data-testid="btn-use-template"
                onClick={() => void apply(t.id)}
              >
                Use
              </Button>
              <button
                className="text-small text-cr"
                aria-label={`Delete template ${t.name}`}
                onClick={() => void remove(t.id, t.name)}
              >
                ×
              </button>
            </div>
          ))
        )}
        <div className="flex justify-end">
          <Button onClick={onClose}>Close</Button>
        </div>
      </div>
    </Modal>
  )
}

// ---------- per-line cost-centre allocation modal ----------

export function CostAllocModal({
  lineAmount,
  centres,
  initial,
  onClose,
  onSave
}: {
  lineAmount: number
  centres: CostCentre[]
  initial: { costCentreId: number; amount: number }[]
  onClose: () => void
  onSave: (allocations: { costCentreId: number; amount: number }[]) => void
}): React.JSX.Element {
  const [rows, setRows] = useState<{ costCentreId: number | null; amount: number | null }[]>(
    initial.length ? initial.map((a) => ({ costCentreId: a.costCentreId, amount: a.amount })) : [{ costCentreId: null, amount: null }]
  )

  /**
   * Percentage mode (#41). "Rent is 40% Mumbai, 35% Pune" is how the split is decided; the
   * amounts are derived from it every time the rent changes, and deriving them by hand is where
   * a paisa goes missing and the voucher stops saving.
   *
   * The two modes hold DIFFERENT state rather than one being computed from the other on every
   * keystroke: percentages that had to survive a round trip through amounts could not express
   * 33.33% of an odd line at all, and would drift each time the modal was reopened.
   */
  const [mode, setMode] = useState<'amount' | 'percent'>('amount')
  const [pctText, setPctText] = useState<string[]>([])

  const setRow = (i: number, patch: Partial<{ costCentreId: number | null; amount: number | null }>): void => {
    setRows((rs) => {
      const next = rs.map((r, j) => (j === i ? { ...r, ...patch } : r))
      const last = next[next.length - 1]!
      if (last.costCentreId != null) next.push({ costCentreId: null, amount: null })
      return next
    })
  }
  const removeRow = (i: number): void => {
    setRows((rs) => rs.filter((_, j) => j !== i))
    setPctText((ps) => ps.filter((_, j) => j !== i))
  }

  const setPct = (i: number, text: string): void => {
    setPctText((ps) => {
      const next = [...ps]
      next[i] = text
      return next
    })
    // Keep the trailing blank row appearing as rows fill up, exactly as amount mode does.
    setRows((rs) => {
      const last = rs[rs.length - 1]!
      return last.costCentreId != null ? [...rs, { costCentreId: null, amount: null }] : rs
    })
  }

  // Basis points per row, 0 for a row that is blank or unparseable — an unreadable cell is worth
  // nothing rather than silently keeping its last good value.
  const bps = rows.map((_, i) => parsePercent(pctText[i] ?? '') ?? 0)
  // Split ONCE over the whole line by largest remainder, so the parts sum to the line exactly.
  const pctAmounts = splitByPercent(lineAmount, bps)

  const effective = rows.map((r, i) => ({
    costCentreId: r.costCentreId,
    amount: mode === 'percent' ? (pctAmounts[i] ?? 0) : (r.amount ?? 0)
  }))
  const allocated = effective.reduce((s, r) => s + r.amount, 0)
  const remaining = lineAmount - allocated
  const pctTotal = totalBps(bps)

  /** Switching modes carries the allocation across rather than clearing it. */
  const switchMode = (next: 'amount' | 'percent'): void => {
    if (next === mode) return
    if (next === 'percent') {
      setPctText(rows.map((r) => (r.amount ? formatBps(bpsOfAmount(r.amount, lineAmount)).replace('%', '') : '')))
    } else {
      setRows((rs) => rs.map((r, i) => ({ ...r, amount: pctAmounts[i] ?? r.amount })))
    }
    setMode(next)
  }

  const tabCls = (active: boolean): string =>
    `rounded px-2 py-0.5 text-caption ${active ? 'bg-accent text-onaccent' : 'text-muted hover:text-body'}`

  return (
    <Modal title="Cost centre allocation" onClose={onClose}>
      <div className="flex flex-col gap-2">
        <div className="flex items-center gap-1" role="group" aria-label="Allocate by">
          <span className="mr-1 text-caption text-muted">Allocate by</span>
          <button type="button" className={tabCls(mode === 'amount')} data-testid="btn-alloc-amount"
            aria-pressed={mode === 'amount'} onClick={() => switchMode('amount')}>
            Amount
          </button>
          <button type="button" className={tabCls(mode === 'percent')} data-testid="btn-alloc-percent"
            aria-pressed={mode === 'percent'} onClick={() => switchMode('percent')}>
            Percentage
          </button>
        </div>
        {rows.map((r, i) => (
          <div key={i} className="flex items-center gap-2">
            <Select
              value={r.costCentreId ?? ''}
              onChange={(e) => setRow(i, { costCentreId: e.target.value ? Number(e.target.value) : null })}
              className="flex-1"
            >
              <option value="">— cost centre —</option>
              {centres.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </Select>
            {mode === 'amount' ? (
              <AmountInput paise={r.amount} onPaise={(p) => setRow(i, { amount: p })} className="w-32" />
            ) : (
              <span className="flex w-32 items-center gap-1">
                <TextInput
                  value={pctText[i] ?? ''}
                  onChange={(e) => setPct(i, e.target.value)}
                  placeholder="0"
                  inputMode="decimal"
                  aria-label="Share of the line, per cent"
                  data-testid="input-alloc-percent"
                  className="num text-right"
                />
                <span className="text-caption text-muted">%</span>
              </span>
            )}
            {mode === 'percent' && (
              // What the percentage is worth, stated rather than left to be worked out — the
              // whole reason to allocate by percentage is not having to do this arithmetic.
              <span className="num w-28 shrink-0 text-right text-caption text-muted" data-testid="alloc-percent-amount">
                {r.costCentreId != null ? formatPaise(pctAmounts[i] ?? 0) : ''}
              </span>
            )}
            {i < rows.length - 1 && (
              <button className="text-small text-cr" onClick={() => removeRow(i)} aria-label="Remove allocation">
                ×
              </button>
            )}
          </div>
        ))}
        <p className={`text-small ${remaining === 0 ? 'text-muted' : remaining < 0 ? 'text-cr' : 'text-accent'}`}>
          Allocated {formatPaise(allocated)} of {formatPaise(lineAmount)}
          {remaining !== 0 ? ` — ${formatPaise(Math.abs(remaining))} ${remaining > 0 ? 'remaining' : 'over'}` : ''}
          {mode === 'percent' && pctTotal !== FULL_BPS ? ` (${formatBps(pctTotal)} of 100%)` : ''}
        </p>
        {mode === 'percent' && allocationComplete(bps) && (
          <p className="text-caption text-muted">
            The shares add to the line exactly — the odd paise go to whichever share came closest to earning them.
          </p>
        )}
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            onClick={() => {
              onSave(
                effective
                  .filter((r): r is { costCentreId: number; amount: number } => r.costCentreId != null && r.amount > 0)
                  .map((r) => ({ costCentreId: r.costCentreId, amount: r.amount }))
              )
              onClose()
            }}
          >
            Save allocation
          </Button>
        </div>
      </div>
    </Modal>
  )
}

// ---------- quick-create modals ----------

export function QuickLedgerModal({
  name,
  suggestParty,
  suggestAccount,
  onClose,
  onCreated
}: {
  name: string
  /** true → Sundry Debtors, false → Sundry Creditors, null → no preselect */
  suggestParty: boolean | null
  suggestAccount: boolean | null
  onClose: () => void
  onCreated: (ledger: Ledger) => void
}): React.JSX.Element {
  const groups = useGroups()
  const toast = useToasts()
  const queryClient = useQueryClient()
  const defaultGroup =
    suggestParty != null
      ? groups.find((g) => g.name === (suggestParty ? 'Sundry Debtors' : 'Sundry Creditors'))
      : suggestAccount != null
        ? groups.find((g) => g.name === (suggestAccount ? 'Sales Accounts' : 'Purchase Accounts'))
        : null
  const [ledgerName, setLedgerName] = useState(name)
  const [groupId, setGroupId] = useState<number | null>(defaultGroup?.id ?? null)
  useEffect(() => {
    if (groupId == null && defaultGroup) setGroupId(defaultGroup.id)
  }, [defaultGroup, groupId])
  const [gstin, setGstin] = useState('')
  const [gstRate, setGstRate] = useState('')

  const ancestry = useMemo(() => (groupId != null ? groupAncestryNames(groupId, groups) : []), [groupId, groups])
  const isParty = ancestry.some((n) => PARTY_GROUPS.includes(n))
  const isTradingLedger = !isParty && ancestry.some((n) => TRADING_GROUPS.includes(n))

  const create = async (): Promise<void> => {
    try {
      if (!groupId) return void toast.push('error', 'Pick a group')
      const l = await api.ledgers.create({
        name: ledgerName.trim(),
        groupId,
        openingBalance: 0,
        gstin: isParty && gstin.trim() ? gstin.trim().toUpperCase() : null,
        stateCode: isParty && gstin.trim().length >= 2 ? gstin.trim().slice(0, 2) : null,
        address: null,
        taxType: null,
        gstRate: isTradingLedger && gstRate.trim() ? Number(gstRate) : null,
        hsn: null,
        tdsSectionId: null,
        pan: null,
        creditDays: null,
        exportType: null
      })
      await queryClient.invalidateQueries({ queryKey: ['ledgers'] })
      toast.push('success', `Ledger “${l.name}” created`)
      onCreated(l)
    } catch (err) {
      toast.push('error', (err as Error).message)
    }
  }

  return (
    <Modal title="New ledger" onClose={onClose}>
      <div className="flex flex-col gap-3">
        <Field label="Name">
          <TextInput autoFocus value={ledgerName} onChange={(e) => setLedgerName(e.target.value)} />
        </Field>
        <Field label="Under group">
          <Select value={groupId ?? ''} onChange={(e) => setGroupId(Number(e.target.value))}>
            <option value="" disabled>
              Choose…
            </option>
            {groups.map((g) => (
              <option key={g.id} value={g.id}>
                {g.name}
              </option>
            ))}
          </Select>
        </Field>
        {(isParty || isTradingLedger) && (
          <div className="grid grid-cols-2 gap-3">
            {isParty && (
              <Field label="GSTIN">
                <TextInput value={gstin} onChange={(e) => setGstin(e.target.value.toUpperCase())} className="num" placeholder="Optional" />
              </Field>
            )}
            {isTradingLedger && (
              <Field label="GST rate %">
                <TextInput value={gstRate} onChange={(e) => setGstRate(e.target.value)} className="num" placeholder="Optional" />
              </Field>
            )}
          </div>
        )}
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={() => void create()}>
            Create ledger
          </Button>
        </div>
      </div>
    </Modal>
  )
}

export function QuickItemModal({
  name,
  onClose,
  onCreated
}: {
  name: string
  onClose: () => void
  onCreated: (id: number) => void
}): React.JSX.Element {
  const { data: units } = useQuery({ queryKey: ['units'], queryFn: api.units.list })
  const toast = useToasts()
  const queryClient = useQueryClient()
  const [itemName, setItemName] = useState(name)
  const [unitId, setUnitId] = useState<number | null>(null)
  const [hsn, setHsn] = useState('')
  const [rate, setRate] = useState('18')

  useEffect(() => {
    if (unitId == null && units?.length) setUnitId(units[0]!.id)
  }, [units, unitId])

  const create = async (): Promise<void> => {
    try {
      if (!unitId) return void toast.push('error', 'Pick a unit')
      const item = await api.stockItems.create({
        name: itemName.trim(),
        groupId: null,
        unitId,
        hsn: hsn.trim() || null,
        gstRate: rate.trim() ? Number(rate) : null,
        cessRate: null,
        openingQtyMilli: 0,
        openingValue: 0,
        barcode: null,
        reorderLevelMilli: null
      })
      await queryClient.invalidateQueries({ queryKey: ['stockItems'] })
      toast.push('success', `Item “${item.name}” created`)
      onCreated(item.id)
    } catch (err) {
      toast.push('error', (err as Error).message)
    }
  }

  return (
    <Modal title="New stock item" onClose={onClose}>
      <div className="flex flex-col gap-3">
        <Field label="Name">
          <TextInput autoFocus value={itemName} onChange={(e) => setItemName(e.target.value)} />
        </Field>
        <div className="grid grid-cols-3 gap-3">
          <Field label="Unit">
            <Select value={unitId ?? ''} onChange={(e) => setUnitId(Number(e.target.value))}>
              {(units ?? []).map((u) => (
                <option key={u.id} value={u.id}>
                  {u.symbol}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="HSN">
            <TextInput value={hsn} onChange={(e) => setHsn(e.target.value)} className="num" placeholder="8471" />
          </Field>
          <Field label="GST %">
            <TextInput value={rate} onChange={(e) => setRate(e.target.value)} className="num" />
          </Field>
        </div>
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={() => void create()}>
            Create item
          </Button>
        </div>
      </div>
    </Modal>
  )
}
