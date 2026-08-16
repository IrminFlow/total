import { useEffect, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { VoucherKind } from '@shared/domain'
import { todayISO } from '@shared/dates'
import { api } from '../lib/client'
import { useSession, type VoucherDraft } from '../state/stores'
import { isAnyModalOpen, Kbd } from '../components/ui'
import { useFeatures } from '../lib/useFeatures'
import { TRADING_KINDS } from './voucher/hooks'
import { InvoiceEntry } from './voucher/InvoiceEntry'
import { AccountingEntry } from './voucher/AccountingEntry'
import { ManufactureEntry } from './voucher/ManufactureEntry'
import { PhysicalStockEntry } from './voucher/PhysicalStockEntry'

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
  const { from } = useSession()
  const today = todayISO()
  const { data: dash } = useQuery({ queryKey: ['dashboard', today, from], queryFn: () => api.reports.dashboard(today, from) })
  const showFirstVoucherHint = !voucherId && !hintDismissed && dash?.voucherCount === 0

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

  if (!types || (voucherId && !existing)) return <p className="text-muted">Loading…</p>
  const currentType = types.find((t) => t.id === typeId) ?? types[0]!
  const invoiceMode = !voucherId && TRADING_KINDS.includes(currentType.kind)
  const manufactureMode = !voucherId && currentType.kind === 'stock_journal'
  const physicalMode = !voucherId && currentType.kind === 'physical_stock'

  return (
    <div className="mx-auto max-w-4xl">
      {showFirstVoucherHint && (
        <div className="mb-4 flex items-center justify-between gap-4 rounded-md border border-amber/40 bg-amber/10 px-4 py-2.5">
          <p className="text-[12.5px] text-ink">
            First voucher? Pick a type above (or <Kbd>F8</Kbd> for Sales), fill in the lines, then{' '}
            <Kbd>⌘↵</Kbd> to save.
          </p>
          <button
            onClick={() => setHintDismissed(true)}
            aria-label="Dismiss"
            className="shrink-0 text-[12px] text-muted hover:text-ink"
          >
            Dismiss
          </button>
        </div>
      )}
      <div className="mb-4 flex items-center gap-2">
        <h2 className="mr-3 font-serif text-[19px] font-semibold tracking-tight">
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
              className={`rounded-md px-2.5 py-1 text-[12px] transition-colors ${
                t.id === currentType.id ? 'bg-amber/20 text-amber' : 'text-muted hover:bg-panel2 hover:text-ink'
              }`}
            >
              {t.name}
            </button>
          ))}
      </div>
      {invoiceMode ? (
        <InvoiceEntry key={currentType.id} typeId={currentType.id} kind={currentType.kind} draft={draft} />
      ) : manufactureMode ? (
        <ManufactureEntry key={currentType.id} typeId={currentType.id} />
      ) : physicalMode ? (
        <PhysicalStockEntry key={currentType.id} typeId={currentType.id} />
      ) : (
        <AccountingEntry
          key={voucherId ?? currentType.id}
          typeId={currentType.id}
          kind={currentType.kind}
          voucherId={voucherId}
          draft={draft}
        />
      )}
      <p className="mt-3 text-[11.5px] text-muted">
        <Kbd>F4</Kbd>–<Kbd>F9</Kbd> switch type · <Kbd>⌘↵</Kbd> save · <Kbd>Esc</Kbd> back · dates accept <span className="num">7</span>, <span className="num">7/4</span>, <span className="num">y</span>
      </p>
    </div>
  )
}
