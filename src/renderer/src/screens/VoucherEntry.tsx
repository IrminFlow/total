import { useEffect, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { VoucherKind } from '@shared/domain'
import { todayISO } from '@shared/dates'
import { api } from '../lib/client'
import { useSession, type VoucherDraft } from '../state/stores'
import { Kbd } from '../components/ui'
import { useFeatures } from '../lib/useFeatures'
import { TRADING_KINDS } from './voucher/hooks'
import { InvoiceEntry } from './voucher/InvoiceEntry'
import { AccountingEntry } from './voucher/AccountingEntry'
import { ManufactureEntry } from './voucher/ManufactureEntry'
import { PhysicalStockEntry } from './voucher/PhysicalStockEntry'
import { useScreenAccels } from '../lib/screenAccels'

/**
 * Voucher types reachable by keyboard, each with BOTH a Tally function key and a bare letter.
 *
 * The F-keys are twenty years of muscle memory and are the primary path here, because they fire
 * even with the cursor in a field — which is where it almost always is on this screen. The
 * letters are the "just arrived, or just pressed Esc" path, and they are what makes the screen
 * consistent with every menu in the app. Both are advertised in the footer and in `?`.
 *
 * Letters that collide with a navigation accelerator (C = cost centres, P = P&L, R = registers,
 * S = stock summary, U = budgets, J is free) win while this screen is open, because the screen
 * layer sits above the nav layer. The sidebar greys those letters out so the shadowing is
 * visible rather than surprising.
 */
const TYPE_KEYS: { kind: VoucherKind; fkey?: string; key?: string; label: string; ctrlOrAlt?: boolean }[] = [
  { kind: 'contra', fkey: 'F4', key: 'c', label: 'Contra' },
  { kind: 'payment', fkey: 'F5', key: 'p', label: 'Payment' },
  { kind: 'receipt', fkey: 'F6', key: 'r', label: 'Receipt' },
  { kind: 'journal', fkey: 'F7', key: 'j', label: 'Journal' },
  { kind: 'sales', fkey: 'F8', key: 's', label: 'Sales' },
  { kind: 'purchase', fkey: 'F9', key: 'u', label: 'Purchase' },
  // Credit/debit note keep ONLY their Tally modifier keys. A bare letter for them would have to
  // be D and E, which are Day book and Settings — shadowing the two most-used destinations in
  // the app for two rarely-used voucher types is a bad trade. Ctrl/Alt+F8/F9 is what a Tally
  // user reaches for anyway, and the type pills and Cmd-K still work.
  { kind: 'credit_note', fkey: 'F8', label: 'Credit note', ctrlOrAlt: true },
  { kind: 'debit_note', fkey: 'F9', label: 'Debit note', ctrlOrAlt: true },
  // No Tally F-key exists for these two; before now they had no keyboard path at all.
  { kind: 'stock_journal', key: 'k', label: 'Stock journal' },
  { kind: 'physical_stock', key: 'y', label: 'Physical stock' }
]

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

  // Switching type only makes sense while creating; altering an existing voucher keeps its type.
  // A dialog on top pushes an opaque layer, so nothing here needs to check for one any more.
  const canSwitchType = !voucherId && !!types
  useScreenAccels(
    'voucher-entry',
    TYPE_KEYS.map((t) => ({
      key: t.key,
      fkey: t.fkey,
      ctrlOrAlt: t.ctrlOrAlt,
      label: t.label,
      when: () => canSwitchType && types!.some((v) => v.kind === t.kind),
      run: () => {
        const target = types?.find((v) => v.kind === t.kind)
        if (target) setTypeId(target.id)
      }
    }))
  )

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
        <Kbd>⌘↵</Kbd> save · <Kbd>Esc</Kbd> back · dates accept <span className="num">7</span>,{' '}
        <span className="num">7/4</span>, <span className="num">y</span> · the type keys are in the
        bar below and under <Kbd>?</Kbd>
      </p>
    </div>
  )
}

// Re-export for renderer unit tests that target the pre-split path (lane T's voucherNumberField.test).
export { useVoucherNumberField } from './voucher/hooks'
