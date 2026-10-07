// Stock-line pickers (WP 2.3): godown, batch (with an expiry badge and inline "new batch" for
// inward lines) and serial numbers. Compact — they live in a voucher line's detail row, never in
// the main keyboard path. All type-ahead pickers reuse pickers.tsx's TypeAhead.
import { useMemo, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { Batch, Godown } from '@shared/domain'
import { parseSmartDate, toDisplayDate } from '@shared/dates'
import { expiryBucketOf } from '@shared/valuation'
import { parseSerialText } from '@shared/serials'
import { api } from '../lib/client'
import { useSession, useToasts } from '../state/stores'
import { TypeAhead } from './pickers'
import { Badge, Button, Chip, inputCls } from './ui'

export function useGodowns(): Godown[] {
  const { data } = useQuery({ queryKey: ['godowns'], queryFn: api.godowns.list })
  return data ?? []
}

/** Every batch (one query, shared by every line's picker), filtered per item by callers. */
export function useAllBatches(): Batch[] {
  const { data } = useQuery({ queryKey: ['batches', 'all'], queryFn: () => api.batches.list() })
  return data ?? []
}

export function GodownPicker({
  value,
  onPick,
  testId = 'picker-godown',
  placeholder = 'Godown',
  className,
  ariaLabel,
  kind
}: {
  value: number | null
  onPick: (id: number | null) => void
  testId?: string
  placeholder?: string
  className?: string
  ariaLabel?: string
  /** WP 2.4: only own godowns, or only job workers' (omitted = all). */
  kind?: Godown['kind']
}): React.JSX.Element {
  const godowns = useGodowns()
  const options = useMemo(
    () => godowns.filter((g) => !kind || g.kind === kind).map((g) => ({ id: g.id, label: g.name })),
    [godowns, kind]
  )
  return (
    <TypeAhead options={options} value={value} onPick={onPick} placeholder={placeholder} testId={testId} className={className} ariaLabel={ariaLabel ?? placeholder} />
  )
}

/** Expiry as a small tone-coded badge: expired (danger), ≤ 30 days (warning), ≤ 90 (info). */
export function ExpiryBadge({ expiry, asOn }: { expiry: string | null; asOn: string }): React.JSX.Element | null {
  if (!expiry) return null
  const bucket = expiryBucketOf(expiry, asOn)
  const tone = bucket === 'expired' ? 'danger' : bucket === 'within30' ? 'warning' : bucket === 'within90' ? 'info' : 'neutral'
  return (
    <Badge tone={tone} testId="badge-expiry" title={`Expires ${toDisplayDate(expiry)}`}>
      {bucket === 'expired' ? 'expired' : 'exp'} {toDisplayDate(expiry)}
    </Badge>
  )
}

export function BatchPicker({
  itemId,
  value,
  onPick,
  allowCreate,
  testId = 'picker-batch',
  className
}: {
  itemId: number
  value: number | null
  onPick: (id: number | null) => void
  /** Inward lines may create a batch on the spot. */
  allowCreate: boolean
  testId?: string
  className?: string
}): React.JSX.Element {
  const { workingDate } = useSession()
  const toast = useToasts()
  const queryClient = useQueryClient()
  const batches = useAllBatches().filter((b) => b.stockItemId === itemId)
  const options = useMemo(
    () => batches.map((b) => ({ id: b.id, label: b.name, sub: b.expiryDate ? `exp ${toDisplayDate(b.expiryDate)}` : undefined })),
    [batches]
  )
  const [draft, setDraft] = useState<{ name: string; expiryText: string } | null>(null)
  const selected = batches.find((b) => b.id === value) ?? null

  const create = async (): Promise<void> => {
    if (!draft || !draft.name.trim()) return
    const expiry = draft.expiryText.trim() ? parseSmartDate(draft.expiryText, workingDate) : null
    if (draft.expiryText.trim() && !expiry) return void toast.push('error', 'Expiry date not recognised — try 31-12-2026')
    try {
      const b = await api.batches.create({ stockItemId: itemId, name: draft.name.trim(), mfgDate: null, expiryDate: expiry })
      await queryClient.invalidateQueries({ queryKey: ['batches'] })
      onPick(b.id)
      setDraft(null)
    } catch (err) {
      toast.push('error', (err as Error).message)
    }
  }

  if (draft) {
    return (
      <span className={`flex items-center gap-1.5 ${className ?? ''}`} data-testid="batch-new">
        <input
          className={`${inputCls} w-28`}
          aria-label="New batch name"
          data-testid="input-batch-new-name"
          value={draft.name}
          autoFocus
          onChange={(e) => setDraft({ ...draft, name: e.target.value })}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void create()
            if (e.key === 'Escape') setDraft(null)
          }}
        />
        <input
          className={`${inputCls} num w-28`}
          aria-label="Expiry date"
          placeholder="Expiry (opt.)"
          data-testid="input-batch-new-expiry"
          value={draft.expiryText}
          onChange={(e) => setDraft({ ...draft, expiryText: e.target.value })}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void create()
            if (e.key === 'Escape') setDraft(null)
          }}
        />
        <Button size="sm" variant="primary" onClick={() => void create()} data-testid="btn-batch-new-save">
          Add
        </Button>
        <Button size="sm" variant="ghost" onClick={() => setDraft(null)}>
          Cancel
        </Button>
      </span>
    )
  }
  return (
    <span className={`flex items-center gap-1.5 ${className ?? ''}`}>
      <TypeAhead
        options={options}
        value={value}
        onPick={onPick}
        placeholder={allowCreate ? 'Batch (type to add)' : 'Batch'}
        testId={testId}
        ariaLabel="Batch"
        className="min-w-0 flex-1"
        onCreate={allowCreate ? (name) => setDraft({ name, expiryText: '' }) : undefined}
      />
      <ExpiryBadge expiry={selected?.expiryDate ?? null} asOn={workingDate} />
    </span>
  )
}

/**
 * Serial numbers for one line: chips of the line's serials and a box to add more (Enter, comma or
 * paste a list). Outward lines also offer the serials in stock (plus, when altering, the ones this
 * voucher took out) as clickable chips. Shows "n of N" against the line's whole-unit quantity.
 */
export function SerialsInput({
  itemId,
  direction,
  qtyMilli,
  value,
  onChange,
  voucherId,
  testId = 'input-serials'
}: {
  itemId: number
  direction: 'in' | 'out'
  qtyMilli: number
  value: readonly string[]
  onChange: (serials: string[]) => void
  voucherId?: number
  testId?: string
}): React.JSX.Element {
  const [text, setText] = useState('')
  const { data: available } = useQuery({
    queryKey: ['serialsAvailable', itemId, voucherId ?? null],
    queryFn: () => api.serials.available(itemId, voucherId),
    enabled: direction === 'out'
  })
  const need = qtyMilli > 0 && qtyMilli % 1000 === 0 ? qtyMilli / 1000 : null
  const add = (raw: string): void => {
    const next = [...value]
    for (const s of parseSerialText(raw)) if (!next.includes(s)) next.push(s)
    onChange(next)
    setText('')
  }
  const offer = (available ?? []).filter((s) => !value.includes(s)).slice(0, 24)
  const countTone = need == null ? 'warning' : value.length === need ? 'success' : 'warning'
  return (
    <div className="flex min-w-0 flex-col gap-1" data-testid="line-serials">
      <div className="flex flex-wrap items-center gap-1">
        {value.map((s) => (
          <Chip key={s} tone="neutral" onRemove={() => onChange(value.filter((x) => x !== s))} removeLabel={`Remove serial ${s}`}>
            <span className="num">{s}</span>
          </Chip>
        ))}
        <input
          className={`${inputCls} num w-40`}
          data-testid={testId}
          aria-label="Add serial numbers"
          placeholder={direction === 'in' ? 'Serial no. ↵' : 'Serial no. or pick ↓'}
          value={text}
          onChange={(e) => {
            const v = e.target.value
            if (/[\n,;]/.test(v)) add(v)
            else setText(v)
          }}
          onPaste={(e) => {
            const pasted = e.clipboardData.getData('text')
            if (/[\n,;]/.test(pasted)) {
              e.preventDefault()
              add(text + pasted)
            }
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && text.trim()) {
              e.preventDefault()
              add(text)
            } else if (e.key === 'Backspace' && text === '' && value.length > 0) {
              onChange(value.slice(0, -1))
            }
          }}
          onBlur={() => text.trim() && add(text)}
        />
        <Badge tone={countTone} testId="badge-serial-count">
          {value.length}
          {need != null ? ` of ${need}` : ''} serial{(need ?? value.length) === 1 ? '' : 's'}
        </Badge>
        {need == null && qtyMilli > 0 && <span className="text-hint text-warning">serial items move whole units</span>}
      </div>
      {direction === 'out' && offer.length > 0 && (
        <div className="flex flex-wrap items-center gap-1" data-testid="serials-available">
          <span className="text-hint text-muted">In stock:</span>
          {offer.map((s) => (
            <Chip key={s} tone="neutral" onClick={() => onChange([...value, s])} testId={`serial-pick-${s}`}>
              <span className="num">{s}</span>
            </Chip>
          ))}
        </div>
      )}
      {direction === 'out' && available && available.length === 0 && value.length === 0 && (
        <span className="text-hint text-muted">No serials of this item are in stock.</span>
      )}
    </div>
  )
}
