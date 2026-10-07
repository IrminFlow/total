// Per-line stock detail (WP 2.3): godown, batch (expiry badge, inline new batch on inward lines)
// and serial numbers, in a detail row under a voucher line. It stays out of the keyboard path:
// the ▸ toggle is not a tab stop (⌥D on the line toggles it), and the "always show" choice is a
// per-company display preference (screen options 'voucher-lines'). A serial-tracked item opens
// its line's detail automatically — its serials are required.
import { useCallback, useState, type ReactNode } from 'react'
import type { StockItem } from '@shared/domain'
import { useScreenOptions, OptionToggle } from '../../components/ScreenOptions'
import { BatchPicker, GodownPicker, SerialsInput, useAllBatches, useGodowns } from '../../components/stockPickers'

export interface LineStockFields {
  godownId: number | null
  batchId: number | null
  serials?: string[]
}

/** The remembered "always show stock details" preference, per company. */
export function useLineDetailPref(): { always: boolean; setAlways: (v: boolean) => void } {
  const opts = useScreenOptions('voucher-lines', { showStockDetail: false })
  return { always: opts.options.showStockDetail, setAlways: (v) => opts.set('showStockDetail', v) }
}

/** The Options-drawer switch for that preference. */
export function LineDetailOption(): React.JSX.Element {
  const pref = useLineDetailPref()
  return (
    <OptionToggle
      label="Show godown, batch and serials on every stock line"
      hint="Off: open a line's details with ▸ or ⌥D. Serial-tracked items always open."
      checked={pref.always}
      onChange={pref.setAlways}
      testId="input-voucher-lines-detail"
    />
  )
}

/**
 * Which lines are expanded. Keys are the caller's stable row keys. `isOpen` folds in the
 * preference and serial-tracked items; `onRowKeyDown` gives ⌥D.
 */
export function useLineDetails(): {
  isOpen: (key: number, item: StockItem | null | undefined) => boolean
  toggle: (key: number) => void
  open: (key: number) => void
  onRowKeyDown: (key: number) => (e: React.KeyboardEvent) => void
} {
  const { always } = useLineDetailPref()
  const [toggled, setToggled] = useState<ReadonlyMap<number, boolean>>(() => new Map())
  const isOpen = useCallback(
    (key: number, item: StockItem | null | undefined): boolean => {
      if (!item) return false
      return toggled.get(key) ?? (always || item.trackSerials)
    },
    [toggled, always]
  )
  const toggle = useCallback(
    (key: number) =>
      setToggled((m) => {
        const next = new Map(m)
        next.set(key, !(m.get(key) ?? always))
        return next
      }),
    [always]
  )
  const open = useCallback((key: number) => setToggled((m) => new Map(m).set(key, true)), [])
  const onRowKeyDown = useCallback(
    (key: number) => (e: React.KeyboardEvent) => {
      if (e.altKey && !e.metaKey && !e.ctrlKey && e.code === 'KeyD') {
        e.preventDefault()
        toggle(key)
      }
    },
    [toggle]
  )
  return { isOpen, toggle, open, onRowKeyDown }
}

/** The ▸ / ▾ button at the end of a line; a dot marks a line that already carries detail. */
export function LineDetailToggle({
  open,
  onToggle,
  fields,
  disabled,
  testId = 'btn-line-detail'
}: {
  open: boolean
  onToggle: () => void
  fields: LineStockFields
  disabled?: boolean
  testId?: string
}): React.JSX.Element {
  const has = fields.godownId != null || fields.batchId != null || (fields.serials?.length ?? 0) > 0
  return (
    <button
      type="button"
      tabIndex={-1}
      disabled={disabled}
      data-testid={testId}
      aria-expanded={open}
      aria-label={open ? 'Hide godown, batch and serials (⌥D)' : 'Godown, batch and serials (⌥D)'}
      title="Godown, batch, serials (⌥D)"
      onClick={onToggle}
      className="relative rounded px-1 text-small text-muted hover:text-ink disabled:opacity-30"
    >
      {open ? '▾' : '▸'}
      {has && !open && <span className="absolute top-0.5 right-0 h-1.5 w-1.5 rounded-full bg-amber" aria-hidden="true" />}
    </button>
  )
}

/** Compact one-line summary of a line's godown / batch / serials (closed lines, read-only lists). */
export function LineStockSummary({ fields }: { fields: LineStockFields }): React.JSX.Element | null {
  const godowns = useGodowns()
  const batches = useAllBatches()
  const parts: string[] = []
  if (fields.godownId != null) parts.push(godowns.find((g) => g.id === fields.godownId)?.name ?? `godown #${fields.godownId}`)
  if (fields.batchId != null) parts.push(`batch ${batches.find((b) => b.id === fields.batchId)?.name ?? `#${fields.batchId}`}`)
  if (fields.serials?.length) parts.push(`${fields.serials.length} serial${fields.serials.length === 1 ? '' : 's'}`)
  if (parts.length === 0) return null
  return <span className="text-hint text-muted" data-testid="line-stock-summary">{parts.join(' · ')}</span>
}

/** The detail row's content: godown · batch · serials. */
export function LineStockDetail({
  item,
  direction,
  qtyMilli,
  fields,
  onChange,
  voucherId,
  extra
}: {
  item: StockItem
  direction: 'in' | 'out'
  qtyMilli: number
  fields: LineStockFields
  onChange: (patch: Partial<LineStockFields>) => void
  /** Altering: lets an outward line re-pick the serials it already took. */
  voucherId?: number
  /** Extra controls at the end (e.g. the stock-journal row's direction). */
  extra?: ReactNode
}): React.JSX.Element {
  return (
    <div className="flex flex-wrap items-start gap-x-4 gap-y-2 py-1 pl-1" data-testid="line-stock-detail">
      <label className="flex items-center gap-1.5">
        <span className="text-caption text-muted">Godown</span>
        <GodownPicker value={fields.godownId} onPick={(id) => onChange({ godownId: id })} className="w-40" testId="picker-line-godown" />
      </label>
      <label className="flex items-center gap-1.5">
        <span className="text-caption text-muted">Batch</span>
        <BatchPicker
          itemId={item.id}
          value={fields.batchId}
          onPick={(id) => onChange({ batchId: id })}
          allowCreate={direction === 'in'}
          className="w-64"
          testId="picker-line-batch"
        />
      </label>
      {item.trackSerials && (
        <div className="flex min-w-0 flex-1 items-start gap-1.5">
          <span className="pt-1.5 text-caption text-muted">Serials</span>
          <SerialsInput
            itemId={item.id}
            direction={direction}
            qtyMilli={qtyMilli}
            value={fields.serials ?? []}
            onChange={(serials) => onChange({ serials })}
            voucherId={voucherId}
          />
        </div>
      )}
      {extra}
    </div>
  )
}
