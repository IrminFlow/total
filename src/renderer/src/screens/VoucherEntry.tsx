import { useEffect, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { VOUCHER_KINDS, type VoucherKind } from '@shared/domain'
import { todayISO } from '@shared/dates'
import { api } from '../lib/client'
import { nextDraftId, useNav, useSession, useToasts, type VoucherDraft } from '../state/stores'
import { Kbd, Panel, SectionTitle } from '../components/ui'
import { auditFieldChanges, fieldLabel } from '@shared/auditDiff'
import { formatPaise } from '@shared/money'
import { useFeatures } from '../lib/useFeatures'
import { TRADING_KINDS } from './voucher/hooks'
import { InvoiceEntry } from './voucher/InvoiceEntry'
import { AccountingEntry } from './voucher/AccountingEntry'
import { ManufactureEntry } from './voucher/ManufactureEntry'
import { PhysicalStockEntry } from './voucher/PhysicalStockEntry'
import { useScreenAccels } from '../lib/screenAccels'
import { useStickyTab } from '../lib/useStickyTab'

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
  const [lastKind, setLastKind] = useStickyTab<VoucherKind>('voucher-entry-kind', VOUCHER_KINDS, 'journal')
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
    // An explicit hint (a drill from GSTR-2B, a ⌘D duplicate) wins; failing that, the type this
    // user last entered, because a business enters the same kind of voucher over and over and
    // landing on Journal every time is a tab press paid on every visit.
    const wanted = kindHint ?? lastKind
    const t = types.find((t) => t.kind === wanted) ?? types.find((t) => t.kind === 'journal') ?? types[0]
    if (t) setTypeId(t.id)
  }, [types, typeId, kindHint, voucherId, lastKind])

  // Remember it for next time, but only while creating — the type of a voucher being altered is
  // the voucher's, not a choice the user just made.
  useEffect(() => {
    if (voucherId || !types || typeId == null) return
    const kind = types.find((t) => t.id === typeId)?.kind
    if (kind) setLastKind(kind)
  }, [typeId, types, voucherId, setLastKind])

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
      {/* Crash-safe recovery (roadmap #250) — suppressed while altering an existing voucher, and
          while a draft has just been handed in by a nudge or a duplicate. */}
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
      <SectionTitle
        right={
          <div className="flex items-center gap-1">
            {!voucherId &&
              types
                .filter((t) => features.inventory || (t.kind !== 'stock_journal' && t.kind !== 'physical_stock'))
                .map((t) => (
                  <button
                    key={t.id}
                    data-testid={`tab-voucher-entry-${t.kind}`}
                    onClick={() => setTypeId(t.id)}
                    className={`rounded-md px-2.5 py-1 text-small whitespace-nowrap transition-colors ${
                      t.id === currentType.id ? 'bg-amber/20 text-amber' : 'text-muted hover:bg-panel2 hover:text-ink'
                    }`}
                  >
                    {t.name}
                  </button>
                ))}
            {!voucherId && currentType && <SameAsLast typeId={currentType.id} kind={currentType.kind} />}
          </div>
        }
      >
        {voucherId ? `Alter voucher ${existing?.number}` : 'Voucher entry'}
      </SectionTitle>
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
      {voucherId && <VoucherHistory voucherId={voucherId} />}
      {/* The grid chords live here rather than in the footer strip: the bar is one line wide and
          already carries the ten type keys, and pushing one of those off the edge to make room
          would cost more than it gains. Under `?` too, which now has a search box. */}
      <p className="mt-3 text-hint text-muted">
        <Kbd>⌘↵</Kbd> save · <Kbd>Esc</Kbd> back · dates accept <span className="num">7</span>,{' '}
        <span className="num">7/4</span>, <span className="num">y</span> · the type keys are in the
        bar below and under <Kbd>?</Kbd>
      </p>
      <p className="mt-1 text-hint text-muted">
        In the lines: <Kbd>⌥↑</Kbd> <Kbd>⌥↓</Kbd> move · <Kbd>⌘⌫</Kbd> delete · <Kbd>⌥R</Kbd> repeat
        the last line · <Kbd>⌥O</Kbd> round off · paste a table from a spreadsheet straight in
      </p>
    </div>
  )
}

/**
 * Start this voucher from the last one of the same type.
 *
 * "Same as last time, different amount" is most of the data entry in a small business: the rent
 * cheque, the monthly retainer, the standing purchase from one supplier. Recurring templates
 * cover the ones that repeat on a schedule; this covers the far commoner case of one that repeats
 * whenever it happens to.
 *
 * Hidden rather than disabled when there is no previous voucher of the type — a control that can
 * never do anything on a brand-new book is noise on the screen where noise costs most.
 */
function SameAsLast({ typeId, kind }: { typeId: number; kind: VoucherKind }): React.JSX.Element | null {
  const nav = useNav()
  const toast = useToasts()
  const { data } = useQuery({
    queryKey: ['latestOfType', typeId],
    queryFn: () => api.vouchers.latestOfType(typeId)
  })
  if (!data?.voucherId) return null

  const start = async (): Promise<void> => {
    try {
      const draft = await api.vouchers.draftFrom(data.voucherId!)
      if (!draft) return void toast.push('error', 'That voucher is no longer in the books')
      nav.go({ name: 'voucher-entry', kindHint: kind, draft, draftId: nextDraftId() })
    } catch (err) {
      toast.push('error', (err as Error).message)
    }
  }

  return (
    <button
      data-testid="btn-same-as-last"
      onClick={() => void start()}
      title="Start from the last voucher of this type — everything but its date"
      className="ml-2 rounded-md border border-line px-2.5 py-1 text-small whitespace-nowrap text-muted hover:border-amber/60 hover:text-ink"
    >
      Same as last
    </button>
  )
}

/**
 * This voucher's own audit trail: who touched it, when, and what they changed.
 *
 * The audit log has always held whole before/after snapshots, and Settings could list them — but
 * only across the whole book, so answering "who changed this invoice" meant scrolling a global
 * feed. The trail belongs next to the thing it is about.
 *
 * Collapsed by default. Most alterations are opened to make an edit, not to investigate one, and
 * a panel of history above the save button would be in the way every time.
 */
function VoucherHistory({ voucherId }: { voucherId: number }): React.JSX.Element | null {
  const [open, setOpen] = useState(false)
  const { data } = useQuery({
    queryKey: ['voucherAudit', voucherId],
    queryFn: () => api.audit.list({ entity: 'voucher', entityId: voucherId, page: 0, pageSize: 50 }),
    enabled: open
  })

  return (
    <div className="mt-4">
      <button
        data-testid="btn-voucher-history"
        className="text-small text-muted hover:text-ink"
        onClick={() => setOpen((v) => !v)}
      >
        {open ? '▾' : '▸'} History
      </button>
      {open && (
        <Panel className="mt-2 p-3" data-testid="voucher-history">
          {!data ? (
            <p className="text-hint text-muted">Loading…</p>
          ) : data.rows.length === 0 ? (
            // Possible: audit retention can have trimmed the entries, and a voucher imported from
            // Tally never had a create event of its own.
            <p className="text-hint text-muted">No recorded history for this voucher.</p>
          ) : (
            <ol className="flex flex-col gap-2">
              {data.rows.map((row) => {
                // Field changes only for an edit between two full records. On a create or a
                // delete one side is absent, so every field would list as "— → value" or
                // "value → —" — a wall of noise restating what the action label already said.
                const changes =
                  row.beforeJson && row.afterJson
                    ? auditFieldChanges(
                        JSON.parse(row.beforeJson) as unknown,
                        JSON.parse(row.afterJson) as unknown,
                        (paise) => formatPaise(paise)
                      )
                    : []
                return (
                  <li key={row.id} className="text-body-sm">
                    <span className="font-medium">{ACTION_LABEL[row.action] ?? row.action}</span>{' '}
                    <span className="text-muted">
                      by {row.userName ?? 'someone'} · <span className="num">{row.at}</span>
                    </span>
                    {changes.length > 0 && (
                      <ul className="mt-0.5 ml-4 flex flex-col gap-0.5 text-hint text-muted">
                        {changes.map((c) => (
                          <li key={c.field}>
                            {fieldLabel(c.field)}: <span className="num">{c.before ?? '—'}</span> →{' '}
                            <span className="num text-ink">{c.after ?? '—'}</span>
                          </li>
                        ))}
                      </ul>
                    )}
                  </li>
                )
              })}
            </ol>
          )}
        </Panel>
      )}
    </div>
  )
}

const ACTION_LABEL: Record<string, string> = {
  create: 'Created',
  update: 'Altered',
  delete: 'Deleted',
  import: 'Imported'
}

// Re-export for renderer unit tests that target the pre-split path (lane T's voucherNumberField.test).
export { useVoucherNumberField } from './voucher/hooks'
