import { useEffect, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { VoucherKind } from '@shared/domain'
import { todayISO } from '@shared/dates'
import { candidateProducedItem, modeForKind, planVoucherEdit, taxLedgerIdsFrom, type EditPlan } from '@shared/voucherEdit'
import { api } from '../lib/client'
import { useSession, type VoucherDraft } from '../state/stores'
import { isAnyModalOpen, Kbd } from '../components/ui'
import { useFeatures } from '../lib/useFeatures'
import { InvoiceEntry } from './voucher/InvoiceEntry'
import { AccountingEntry } from './voucher/AccountingEntry'
import { ManufactureEntry } from './voucher/ManufactureEntry'
import { PhysicalStockEntry } from './voucher/PhysicalStockEntry'
import { StockLinesEntry } from './voucher/StockLinesEntry'

const FKEYS: Record<string, VoucherKind> = {
  F4: 'contra', F5: 'payment', F6: 'receipt', F7: 'journal', F8: 'sales', F9: 'purchase'
}

export function VoucherEntry({
  voucherId,
  kindHint,
  draft
}: {
  voucherId?: number
  kindHint?: VoucherKind
  draft?: VoucherDraft
}): React.JSX.Element {
  const { data: types } = useQuery({ queryKey: ['voucherTypes'], queryFn: api.voucherTypes.list })
  const { data: existing } = useQuery({
    queryKey: ['voucher', voucherId],
    queryFn: () => api.vouchers.get(voucherId!),
    enabled: !!voucherId
  })
  const features = useFeatures()
  const [typeId, setTypeId] = useState<number | null>(null)
  const [hintDismissed, setHintDismissed] = useState(false)

  // Same queryKey Gateway uses for report:dashboard — a brand-new company (no vouchers yet) gets a
  // first-time hint here; react-query dedupes the request rather than firing a second round-trip.
  const { from, info } = useSession()
  const today = todayISO()
  const { data: dash } = useQuery({ queryKey: ['dashboard', today, from], queryFn: () => api.reports.dashboard(today, from) })
  const showFirstVoucherHint = !voucherId && !hintDismissed && dash?.voucherCount === 0

  // ---------- alteration: which mode can show this voucher faithfully ----------
  // Masters for the decision come from the same query keys the entry modes' pickers use, so the
  // modes mount with them already cached. The plan is computed ONCE per opened voucher — the
  // post-save refetch must not flip the screen into another mode underneath the user.
  const { data: ledgers } = useQuery({ queryKey: ['ledgers'], queryFn: api.ledgers.list, enabled: !!voucherId })
  const { data: items } = useQuery({ queryKey: ['stockItems'], queryFn: api.stockItems.list, enabled: !!voucherId })
  const existingKind = existing && types?.find((t) => t.id === existing.voucherTypeId)?.kind
  const producedId = existing && existingKind === 'stock_journal' ? candidateProducedItem(existing) : null
  const { data: producedBom } = useQuery({
    queryKey: ['bom', producedId],
    queryFn: () => api.bom.get(producedId!),
    enabled: producedId != null
  })
  const [plan, setPlan] = useState<EditPlan | null>(null)

  useEffect(() => {
    if (!voucherId || plan || !existing || !existingKind || !ledgers || !items || !info) return
    if (producedId != null && producedBom === undefined) return
    setPlan(
      planVoucherEdit(existing, existingKind, {
        invoice: {
          companyStateCode: info.stateCode,
          items: new Map(items.map((i) => [i.id, { gstRate: i.gstRate, cessRate: i.cessRate }])),
          ledgers: new Map(ledgers.map((l) => [l.id, { stateCode: l.stateCode, gstRate: l.gstRate }]))
        },
        taxLedgers: taxLedgerIdsFrom(ledgers),
        bomFor: (id) => (id === producedId ? producedBom : undefined),
        itemName: (id) => items.find((i) => i.id === id)?.name ?? ''
      })
    )
  }, [voucherId, plan, existing, existingKind, ledgers, items, info, producedId, producedBom])

  useEffect(() => {
    if (!types || typeId != null) return
    if (voucherId) return
    const wanted = kindHint ?? 'journal'
    const t = types.find((t) => t.kind === wanted) ?? types[0]
    if (t) setTypeId(t.id)
  }, [types, typeId, kindHint, voucherId])

  useEffect(() => {
    if (existing) setTypeId(existing.voucherTypeId)
  }, [existing])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const kind = FKEYS[e.key]
      if (!kind || voucherId || !types) return
      // Never switch voucher type underneath an open dialog (quick-create ledger, confirm…).
      if (isAnyModalOpen()) return
      const withCtrl = e.ctrlKey || e.altKey
      const target = withCtrl && kind === 'sales' ? 'credit_note' : withCtrl && kind === 'purchase' ? 'debit_note' : kind
      const t = types.find((t) => t.kind === target)
      if (t) {
        e.preventDefault()
        setTypeId(t.id)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [types, voucherId])

  if (!types || (voucherId && (!existing || !plan))) return <p className="text-muted">Loading…</p>
  const currentType = (voucherId ? types.find((t) => t.id === existing!.voucherTypeId) : types.find((t) => t.id === typeId)) ?? types[0]!
  const closingEntry = !!existing?.isYearEndClose

  return (
    <div className="mx-auto max-w-4xl">
      {showFirstVoucherHint && (
        <div className="mb-4 flex items-center justify-between gap-4 rounded-md border border-amber/40 bg-amber/10 px-4 py-2.5">
          <p className="text-body-sm text-ink">
            First voucher? Pick a type above (or <Kbd>F8</Kbd> for Sales), fill in the lines, then{' '}
            <Kbd>⌘↵</Kbd> to save.
          </p>
          <button
            onClick={() => setHintDismissed(true)}
            aria-label="Dismiss"
            className="shrink-0 text-small text-muted hover:text-ink"
          >
            Dismiss
          </button>
        </div>
      )}
      <div className="mb-4 flex items-center gap-2">
        <h2 className="mr-3 font-serif text-heading font-semibold tracking-tight">
          {voucherId ? `Alter voucher ${existing?.number}` : 'Voucher entry'}
        </h2>
        {!voucherId &&
          types
            .filter((t) => features.inventory || (t.kind !== 'stock_journal' && t.kind !== 'physical_stock'))
            .map((t) => (
            <button
              key={t.id}
              data-testid={`tab-voucher-entry-${t.kind}`}
              onClick={() => setTypeId(t.id)}
              className={`rounded-md px-2.5 py-1 text-small transition-colors ${
                t.id === currentType.id ? 'bg-amber/20 text-amber' : 'text-muted hover:bg-panel2 hover:text-ink'
              }`}
            >
              {t.name}
            </button>
          ))}
      </div>
      {closingEntry && (
        <div
          data-testid="year-end-close-banner"
          className="mb-4 rounded-md border border-blue/30 bg-blue/10 px-4 py-2.5 text-body-sm text-ink"
        >
          Year-end closing entry — read-only. Move it to the bin to reopen the year, then close again.
        </div>
      )}
      {/* A disabled fieldset disables every input and button inside (Save included) for a
          year-end closing entry; the server refuses the edit regardless. */}
      <fieldset disabled={closingEntry} className="m-0 min-w-0 border-0 p-0">
      <div data-testid="voucher-entry-mode" data-mode={voucherId ? plan!.mode : modeForKind(currentType.kind)}>
        {voucherId && existing && plan ? (
          plan.mode === 'invoice' ? (
            <InvoiceEntry typeId={currentType.id} kind={currentType.kind} voucherId={voucherId} voucher={existing} initial={plan.state} />
          ) : plan.mode === 'manufacture' ? (
            <ManufactureEntry typeId={currentType.id} voucherId={voucherId} voucher={existing} initial={plan.state} />
          ) : plan.mode === 'physical' ? (
            <PhysicalStockEntry typeId={currentType.id} voucherId={voucherId} voucher={existing} initial={plan.state} />
          ) : plan.mode === 'stockLines' ? (
            <StockLinesEntry
              typeId={currentType.id}
              voucherId={voucherId}
              voucher={existing}
              initial={plan.state}
              fallbackReason={plan.fallbackReason}
              formName={currentType.kind === 'physical_stock' ? 'physical-count' : 'manufacture'}
            />
          ) : (
            <AccountingEntry
              key={voucherId}
              typeId={currentType.id}
              kind={currentType.kind}
              voucherId={voucherId}
              voucher={existing}
              initial={plan.state}
              fallbackReason={plan.fallbackReason}
            />
          )
        ) : modeForKind(currentType.kind) === 'invoice' ? (
          <InvoiceEntry key={currentType.id} typeId={currentType.id} kind={currentType.kind} draft={draft} />
        ) : modeForKind(currentType.kind) === 'manufacture' ? (
          <ManufactureEntry key={currentType.id} typeId={currentType.id} />
        ) : modeForKind(currentType.kind) === 'physical' ? (
          <PhysicalStockEntry key={currentType.id} typeId={currentType.id} />
        ) : (
          <AccountingEntry key={currentType.id} typeId={currentType.id} kind={currentType.kind} draft={draft} />
        )}
      </div>
      </fieldset>
      <p className="mt-3 text-hint text-muted">
        <Kbd>F4</Kbd>–<Kbd>F9</Kbd> switch type · <Kbd>⌘↵</Kbd> save · <Kbd>Esc</Kbd> back · dates accept <span className="num">7</span>, <span className="num">7/4</span>, <span className="num">y</span>
      </p>
    </div>
  )
}

// Re-export for renderer unit tests that target the pre-split path (lane T's voucherNumberField.test).
export { useVoucherNumberField } from './voucher/hooks'
