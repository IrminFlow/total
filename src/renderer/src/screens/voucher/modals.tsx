import { useEffect, useMemo, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { CostCentre, Ledger } from '@shared/domain'
import type { VoucherInputParsed } from '@shared/schemas'
import { formatPaise } from '@shared/money'
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

  const setRow = (i: number, patch: Partial<{ costCentreId: number | null; amount: number | null }>): void => {
    setRows((rs) => {
      const next = rs.map((r, j) => (j === i ? { ...r, ...patch } : r))
      const last = next[next.length - 1]!
      if (last.costCentreId != null) next.push({ costCentreId: null, amount: null })
      return next
    })
  }
  const removeRow = (i: number): void => setRows((rs) => rs.filter((_, j) => j !== i))

  const allocated = rows.reduce((s, r) => s + (r.amount ?? 0), 0)
  const remaining = lineAmount - allocated

  return (
    <Modal title="Cost centre allocation" onClose={onClose}>
      <div className="flex flex-col gap-2">
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
            <AmountInput paise={r.amount} onPaise={(p) => setRow(i, { amount: p })} className="w-32" />
            {i < rows.length - 1 && (
              <button className="text-small text-cr" onClick={() => removeRow(i)}>
                ×
              </button>
            )}
          </div>
        ))}
        <p className={`text-small ${remaining === 0 ? 'text-muted' : remaining < 0 ? 'text-cr' : 'text-amber'}`}>
          Allocated {formatPaise(allocated)} of {formatPaise(lineAmount)}
          {remaining !== 0 ? ` — ${formatPaise(Math.abs(remaining))} ${remaining > 0 ? 'remaining' : 'over'}` : ''}
        </p>
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            onClick={() => {
              onSave(
                rows
                  .filter((r): r is { costCentreId: number; amount: number } => r.costCentreId != null && (r.amount ?? 0) > 0)
                  .map((r) => ({ costCentreId: r.costCentreId, amount: r.amount! }))
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
