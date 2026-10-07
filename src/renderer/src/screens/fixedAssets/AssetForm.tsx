// Asset form (WP 3.6): create / edit one register entry, its improvements, and the
// "create from purchase voucher" picker that pre-fills it.
import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { fyFromStartYear, fyOf, toDisplayDate } from '@shared/dates'
import { DEP_METHOD_LABELS, lifeEndDate, type DepMethod } from '@shared/depreciation'
import { formatLife, type AssetGroupRow, type FixedAssetInput, type FixedAssetRow, type PurchaseCandidate } from '@shared/fixedAssets'
import { formatPaise } from '@shared/money'
import { faApi } from '../../lib/fixedAssetsClient'
import { useSession, useToasts } from '../../state/stores'
import { AmountInput, Banner, Button, Checkbox, DateInput, Field, Modal, Money, Select, TextInput } from '../../components/ui'
import { DataTable, defineColumns } from '../../components/table'
import { LedgerPicker } from '../../components/pickers'
import { LedgerLink, VoucherLink } from '../../components/links'
import { bpText, parsePercentBp, useFixedAssetLedgerFilters, useRefreshFixedAssets } from './common'

export interface AssetDraft {
  /** Where a pre-filled draft came from ("Purchase 12 · Laptop World · 01-Apr-26"). */
  sourceLabel?: string
  name: string
  assetGroupId: number | null
  ledgerId: number | null
  purchaseVoucherId: number | null
  purchaseDate: string
  putToUseDate: string
  costPaise: number | null
  residualText: string
  lifeMonthsText: string
  method: DepMethod
  itBlockId: number | null
  itAdditionalEligible: boolean
  location: string
  identifier: string
  accDepLedgerId: number | null
  openingAccDepPaise: number | null
  openingAccDepAsOf: string
  changeEffectiveFrom: string
  notes: string
}

export function blankDraft(date: string, group?: AssetGroupRow): AssetDraft {
  return {
    name: '', assetGroupId: group?.id ?? null, ledgerId: group?.assetLedgerId ?? null, purchaseVoucherId: null,
    purchaseDate: date, putToUseDate: date, costPaise: null, residualText: bpText(group?.residualBp ?? 500),
    lifeMonthsText: String(group?.lifeMonths ?? 60), method: group?.method ?? 'slm', itBlockId: group?.itBlockId ?? null,
    itAdditionalEligible: false, location: '', identifier: '', accDepLedgerId: null, openingAccDepPaise: null,
    openingAccDepAsOf: '', changeEffectiveFrom: '', notes: ''
  }
}

export function draftFromAsset(a: FixedAssetRow): AssetDraft {
  return {
    name: a.name, assetGroupId: a.assetGroupId, ledgerId: a.ledgerId, purchaseVoucherId: a.purchaseVoucherId,
    purchaseDate: a.purchaseDate, putToUseDate: a.putToUseDate, costPaise: a.costPaise, residualText: bpText(a.residualBp),
    lifeMonthsText: String(a.lifeMonths), method: a.method, itBlockId: a.itBlockId, itAdditionalEligible: a.itAdditionalEligible,
    location: a.location ?? '', identifier: a.identifier ?? '', accDepLedgerId: a.accDepLedgerId,
    openingAccDepPaise: a.openingAccDepPaise || null, openingAccDepAsOf: a.openingAccDepAsOf ?? '', changeEffectiveFrom: '',
    notes: a.notes ?? ''
  }
}

/** A draft pre-filled from one fixed-asset line of a purchase voucher. */
export function draftFromCandidate(c: PurchaseCandidate, line: PurchaseCandidate['lines'][number], groups: AssetGroupRow[]): AssetDraft {
  const group = groups.find((g) => g.id === line.suggestedGroupId) ?? groups.find((g) => g.assetLedgerId === line.ledgerId)
  return {
    ...blankDraft(c.date, group),
    sourceLabel: [`${c.voucherTypeName} ${c.number}`, c.partyName, toDisplayDate(c.date)].filter(Boolean).join(' · '),
    name: c.partyName ? `${line.ledgerName} — ${c.partyName}` : line.ledgerName,
    ledgerId: line.ledgerId,
    purchaseVoucherId: c.voucherId,
    costPaise: line.amount
  }
}

/** Client-side checks + the IPC payload (the server re-validates everything). */
export function draftToInput(d: AssetDraft): { input: FixedAssetInput | null; error: string | null } {
  if (!d.name.trim()) return { input: null, error: 'Give the asset a name' }
  if (d.assetGroupId == null) return { input: null, error: 'Pick an asset group' }
  if (d.ledgerId == null) return { input: null, error: 'Pick the asset ledger (under Fixed Assets)' }
  if (!d.costPaise || d.costPaise <= 0) return { input: null, error: 'Enter the cost' }
  if (d.putToUseDate < d.purchaseDate) return { input: null, error: 'Put-to-use date cannot be before the purchase date' }
  const residualBp = parsePercentBp(d.residualText)
  if (residualBp == null) return { input: null, error: 'Residual value must be a percentage between 0 and 100' }
  const lifeMonths = Number(d.lifeMonthsText)
  if (!Number.isInteger(lifeMonths) || lifeMonths < 1 || lifeMonths > 1200) return { input: null, error: 'Useful life must be a whole number of months (1–1200)' }
  if (d.method === 'wdv' && residualBp === 0) return { input: null, error: 'WDV needs a residual value above zero' }
  const opening = d.openingAccDepPaise ?? 0
  if (opening > 0 && !d.openingAccDepAsOf) return { input: null, error: 'Give the date the opening accumulated depreciation runs to' }
  return {
    error: null,
    input: {
      name: d.name.trim(), assetGroupId: d.assetGroupId, ledgerId: d.ledgerId, purchaseVoucherId: d.purchaseVoucherId,
      purchaseDate: d.purchaseDate, putToUseDate: d.putToUseDate, costPaise: d.costPaise, residualBp, lifeMonths,
      method: d.method, itBlockId: d.itBlockId, itAdditionalEligible: d.itAdditionalEligible,
      location: d.location.trim() || null, identifier: d.identifier.trim() || null, accDepLedgerId: d.accDepLedgerId,
      openingAccDepPaise: opening, openingAccDepAsOf: opening > 0 ? d.openingAccDepAsOf : null,
      changeEffectiveFrom: d.changeEffectiveFrom || null, notes: d.notes.trim() || null
    }
  }
}

export function AssetFormModal({
  asset,
  initial,
  onClose,
  onSaved
}: {
  /** Editing an existing asset (null = new). */
  asset: FixedAssetRow | null
  initial: AssetDraft
  onClose: () => void
  onSaved?: (a: FixedAssetRow) => void
}): React.JSX.Element {
  const { workingDate, info } = useSession()
  const toast = useToasts()
  const refresh = useRefreshFixedAssets()
  const filters = useFixedAssetLedgerFilters()
  const { data: groups = [] } = useQuery({ queryKey: ['faGroups'], queryFn: faApi.groups })
  const { data: blocks = [] } = useQuery({ queryKey: ['faBlocks'], queryFn: faApi.blocks })
  const [d, setD] = useState<AssetDraft>(initial)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const set = (patch: Partial<AssetDraft>): void => setD((x) => ({ ...x, ...patch }))
  const dirty = JSON.stringify(d) !== JSON.stringify(initial)
  const booked = !!asset && asset.hasDepreciation
  const defaultChangeFrom = asset?.depreciatedThrough ? fyFromStartYear(fyOf(asset.depreciatedThrough).startYear + 1).from : fyOf(workingDate).from
  const estimateChanged =
    !!asset && (String(asset.lifeMonths) !== d.lifeMonthsText || asset.method !== d.method || bpText(asset.residualBp) !== d.residualText)
  const lifeMonths = Number(d.lifeMonthsText)
  const lifeEnd = Number.isInteger(lifeMonths) && lifeMonths > 0 ? lifeEndDate(d.putToUseDate, lifeMonths) : null

  const pickGroup = (id: number | null): void => {
    const g = groups.find((x) => x.id === id)
    if (!g || asset) return set({ assetGroupId: id })
    set({
      assetGroupId: id, lifeMonthsText: String(g.lifeMonths), residualText: bpText(g.residualBp), method: g.method,
      itBlockId: g.itBlockId, ledgerId: d.ledgerId ?? g.assetLedgerId
    })
  }

  const save = async (): Promise<void> => {
    const { input, error: err } = draftToInput(booked && estimateChanged && !d.changeEffectiveFrom ? { ...d, changeEffectiveFrom: defaultChangeFrom } : d)
    if (!input) return setError(err)
    setError(null)
    setSaving(true)
    try {
      const saved = await faApi.save(input, asset?.id)
      await refresh()
      toast.push('success', asset ? `Saved ${saved.name}` : `${saved.name} added to the register`)
      onSaved?.(saved)
      onClose()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal title={asset ? `Fixed asset — ${asset.name}` : 'New fixed asset'} onClose={onClose} wide dirty={dirty}>
      <div className="flex flex-col gap-4" data-testid="fixed-assets-form">
        {d.purchaseVoucherId != null && (
          <p className="text-body-sm text-muted">
            From <VoucherLink voucherId={d.purchaseVoucherId} label={d.sourceLabel ?? 'the purchase voucher'} />
          </p>
        )}
        {asset?.status === 'disposed' && (
          <Banner tone="info" title="Disposed">
            Disposed on {toDisplayDate(asset.disposalDate!)} — only the name, location, identifier and notes can change.
          </Banner>
        )}
        <div className="grid grid-cols-3 gap-3">
          <Field label="Name" required className="col-span-2">
            <TextInput data-testid="input-fixed-assets-name" value={d.name} autoFocus onChange={(e) => set({ name: e.target.value })} />
          </Field>
          <Field label="Asset group" required>
            <Select data-testid="input-fixed-assets-group" value={d.assetGroupId ?? ''} onChange={(e) => pickGroup(e.target.value ? Number(e.target.value) : null)}>
              <option value="">Pick…</option>
              {groups.map((g) => (
                <option key={g.id} value={g.id}>{g.name}</option>
              ))}
            </Select>
          </Field>
          <Field label="Asset ledger" required hint="A ledger under Fixed Assets">
            <LedgerPicker testId="picker-fixed-assets-ledger" value={d.ledgerId} onPick={(id) => set({ ledgerId: id })} filter={filters.asset} placeholder="Asset ledger" />
          </Field>
          <Field label="Cost" required>
            <AmountInput testId="input-fixed-assets-cost" paise={d.costPaise} onPaise={(p) => set({ costPaise: p })} />
          </Field>
          <Field label="Identifier / serial">
            <TextInput data-testid="input-fixed-assets-identifier" value={d.identifier} onChange={(e) => set({ identifier: e.target.value })} />
          </Field>
          <Field label="Purchase date">
            <DateInput testId="input-fixed-assets-purchase-date" value={d.purchaseDate} context={workingDate} onChange={(v) => set({ purchaseDate: v })} />
          </Field>
          <Field label="Put to use on" hint="Depreciation runs from this day">
            <DateInput testId="input-fixed-assets-put-to-use" value={d.putToUseDate} context={workingDate} onChange={(v) => set({ putToUseDate: v })} />
          </Field>
          <Field label="Location">
            <TextInput data-testid="input-fixed-assets-location" value={d.location} onChange={(e) => set({ location: e.target.value })} />
          </Field>
        </div>

        <fieldset className="rounded-lg border border-line p-3">
          <legend className="px-1 text-small font-medium text-muted">Companies Act depreciation (posted)</legend>
          <div className="grid grid-cols-4 gap-3">
            <Field label="Method">
              <Select data-testid="input-fixed-assets-method" value={d.method} onChange={(e) => set({ method: e.target.value as DepMethod })}>
                {(['slm', 'wdv'] as const).map((m) => (
                  <option key={m} value={m}>{DEP_METHOD_LABELS[m]}</option>
                ))}
              </Select>
            </Field>
            <Field label="Useful life (months)" hint={Number.isInteger(lifeMonths) && lifeMonths > 0 ? formatLife(lifeMonths) : 'e.g. 36'}>
              <TextInput data-testid="input-fixed-assets-life" className="num" value={d.lifeMonthsText} onChange={(e) => set({ lifeMonthsText: e.target.value })} />
            </Field>
            <Field label="Residual value %" hint="Schedule II: normally ≤ 5%">
              <TextInput data-testid="input-fixed-assets-residual" className="num" value={d.residualText} onChange={(e) => set({ residualText: e.target.value })} />
            </Field>
            <Field label="Life ends">
              <p className="num pt-1.5 text-body text-muted" data-testid="fixed-assets-life-end">{lifeEnd ? toDisplayDate(lifeEnd) : '—'}</p>
            </Field>
            <Field label="Accumulated depreciation ledger" hint="Blank = the group's" className="col-span-2">
              <LedgerPicker testId="picker-fixed-assets-accdep" value={d.accDepLedgerId} onPick={(id) => set({ accDepLedgerId: id })} filter={filters.accDep} placeholder="Group default" />
            </Field>
            <Field label="Opening depreciation" hint="For an asset older than the books">
              <AmountInput
                testId="input-fixed-assets-opening-acc"
                paise={d.openingAccDepPaise}
                onPaise={(p) => set({ openingAccDepPaise: p, openingAccDepAsOf: d.openingAccDepAsOf || (info ? `${info.booksFrom}-03-31` : d.purchaseDate) })}
              />
            </Field>
            <Field label="Booked up to" hint={d.openingAccDepPaise ? undefined : 'Only with an opening figure'}>
              {d.openingAccDepPaise ? (
                <DateInput testId="input-fixed-assets-opening-as-of" value={d.openingAccDepAsOf} context={workingDate} onChange={(v) => set({ openingAccDepAsOf: v })} />
              ) : (
                <p className="pt-1.5 text-body text-muted">—</p>
              )}
            </Field>
          </div>
          {booked && estimateChanged && (
            <div className="mt-3">
              <Field label="New estimate applies from (1 April)" hint="Prospective: the carrying amount on this date is spread over the remaining life">
                <DateInput testId="input-fixed-assets-change-from" value={d.changeEffectiveFrom || defaultChangeFrom} context={workingDate} onChange={(v) => set({ changeEffectiveFrom: v })} />
              </Field>
            </div>
          )}
        </fieldset>

        <fieldset className="rounded-lg border border-line p-3">
          <legend className="px-1 text-small font-medium text-muted">Income-tax (computation only)</legend>
          <div className="grid grid-cols-1 gap-3">
            <Field label="Block of assets">
              <Select data-testid="input-fixed-assets-block" value={d.itBlockId ?? ''} onChange={(e) => set({ itBlockId: e.target.value ? Number(e.target.value) : null })}>
                <option value="">Not in an IT block</option>
                {blocks.map((b) => (
                  <option key={b.id} value={b.id}>{b.name}</option>
                ))}
              </Select>
            </Field>
            <div>
              <Checkbox
                testId="input-fixed-assets-additional"
                label="Additional depreciation"
                hint="20% on new plant and machinery of a manufacturer (half if used under 180 days; not for office appliances, vehicles or used machinery)"
                checked={d.itAdditionalEligible}
                onChange={(v) => set({ itAdditionalEligible: v })}
              />
            </div>
          </div>
        </fieldset>

        <Field label="Notes">
          <TextInput value={d.notes} onChange={(e) => set({ notes: e.target.value })} />
        </Field>

        {asset && <AdditionsPanel asset={asset} />}

        {error && <p className="text-body-sm text-danger" role="alert" data-testid="fixed-assets-form-error">{error}</p>}
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" data-testid="btn-fixed-assets-save" loading={saving} onClick={() => void save()}>
            {asset ? 'Save asset' : 'Add to register'}
          </Button>
        </div>
      </div>
    </Modal>
  )
}

function AdditionsPanel({ asset }: { asset: FixedAssetRow }): React.JSX.Element {
  const { workingDate } = useSession()
  const toast = useToasts()
  const refresh = useRefreshFixedAssets()
  const [date, setDate] = useState(workingDate)
  const [amount, setAmount] = useState<number | null>(null)
  const [note, setNote] = useState('')
  const add = async (): Promise<void> => {
    if (!amount) return toast.push('error', 'Enter the amount of the improvement')
    try {
      await faApi.additionSave({ assetId: asset.id, date, amountPaise: amount, kind: 'improvement', note: note.trim() || null })
      await refresh()
      setAmount(null)
      setNote('')
      toast.push('success', 'Improvement added — it depreciates over the remaining life')
    } catch (e) {
      toast.push('error', (e as Error).message)
    }
  }
  return (
    <fieldset className="rounded-lg border border-line p-3">
      <legend className="px-1 text-small font-medium text-muted">Additions and improvements</legend>
      {asset.additions.length > 0 ? (
        <ul className="mb-3 flex flex-col gap-1 text-body-sm" data-testid="fixed-assets-additions">
          {asset.additions.map((x) => (
            <li key={x.id} className="flex items-center justify-between gap-3">
              <span className="num text-muted">{toDisplayDate(x.date)}</span>
              <span className="flex-1 truncate">{x.note ?? (x.kind === 'improvement' ? 'Improvement' : 'Addition')}</span>
              <Money paise={x.amountPaise} />
            </li>
          ))}
        </ul>
      ) : (
        <p className="mb-3 text-hint text-muted">None. An improvement adds to the cost and depreciates over the remaining useful life.</p>
      )}
      {asset.status === 'active' && (
        <div className="grid grid-cols-[9rem_10rem_1fr_auto] items-end gap-2">
          <Field label="Date"><DateInput value={date} context={workingDate} onChange={setDate} testId="input-fixed-assets-addition-date" /></Field>
          <Field label="Amount"><AmountInput paise={amount} onPaise={setAmount} testId="input-fixed-assets-addition-amount" /></Field>
          <Field label="What"><TextInput value={note} onChange={(e) => setNote(e.target.value)} /></Field>
          <Button onClick={() => void add()} data-testid="btn-fixed-assets-add-improvement">Add</Button>
        </div>
      )}
    </fieldset>
  )
}

// ---------- create from a purchase voucher ----------

interface CandidateRow {
  key: string
  candidate: PurchaseCandidate
  line: PurchaseCandidate['lines'][number]
}

const CANDIDATE_COLUMNS = defineColumns<CandidateRow>([
  { id: 'date', header: 'Date', kind: 'date', value: (r) => r.candidate.date, width: 104, className: 'text-muted' },
  {
    id: 'number', header: 'Voucher', kind: 'text', value: (r) => `${r.candidate.voucherTypeName} ${r.candidate.number}`, width: 150,
    cell: (r) => <VoucherLink voucherId={r.candidate.voucherId} label={`${r.candidate.voucherTypeName} ${r.candidate.number}`} />
  },
  {
    id: 'party', header: 'Party', kind: 'text', value: (r) => r.candidate.partyName ?? '', minWidth: 140,
    cell: (r) => (r.candidate.partyLedgerId ? <LedgerLink ledgerId={r.candidate.partyLedgerId} name={r.candidate.partyName ?? ''} /> : <span className="text-muted">—</span>)
  },
  { id: 'ledger', header: 'Asset ledger', kind: 'text', value: (r) => r.line.ledgerName, minWidth: 140, cell: (r) => <LedgerLink ledgerId={r.line.ledgerId} name={r.line.ledgerName} /> },
  { id: 'amount', header: 'Amount', kind: 'money', value: (r) => r.line.amount, width: 140 }
])

export function PurchasePickerModal({
  onPick,
  onClose
}: {
  onPick: (c: PurchaseCandidate, line: PurchaseCandidate['lines'][number]) => void
  onClose: () => void
}): React.JSX.Element {
  const { from, to } = useSession()
  const { data, isLoading } = useQuery({ queryKey: ['faCandidates', from, to], queryFn: () => faApi.purchaseCandidates(from, to) })
  const rows = useMemo<CandidateRow[]>(
    () => (data ?? []).flatMap((c) => c.lines.map((line) => ({ key: `${c.voucherId}:${line.ledgerId}`, candidate: c, line }))),
    [data]
  )
  return (
    <Modal title="Create asset from a purchase" onClose={onClose} wide>
      <p className="mb-3 text-body-sm text-muted">
        Vouchers from {toDisplayDate(from)} to {toDisplayDate(to)} that debit a Fixed Assets ledger not yet on the register. Pick a line
        to pre-fill the asset.
      </p>
      <div className="overflow-hidden rounded-md border border-line">
        <DataTable
          viewId="fixed-assets-candidates"
          testId="fixed-assets-candidates"
          ariaLabel="Purchases with fixed-asset lines"
          columns={CANDIDATE_COLUMNS}
          rows={rows}
          rowKey={(r) => r.key}
          rowAttrs={(r) => ({ 'data-row-id': r.candidate.voucherId })}
          loading={isLoading}
          maxHeight="45vh"
          toolbarFeatures={{ views: false, groupBy: false, density: false, export: false }}
          empty={{ title: 'No unregistered fixed-asset purchases in this period', hint: 'Change the working period, or add the asset by hand' }}
          onRowActivate={(r) => onPick(r.candidate, r.line)}
        />
      </div>
      <p className="mt-2 text-hint text-muted">Amounts are the voucher&apos;s debit to the asset ledger ({formatPaise(rows.reduce((s, r) => s + r.line.amount, 0))} in all).</p>
    </Modal>
  )
}
