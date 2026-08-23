import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { Group, Ledger, StockItem } from '@shared/domain'
import { createScanDetector } from '@shared/barcode'
import { api } from '../lib/client'
import { inputCls } from './ui'

export function useLedgers(): Ledger[] {
  const { data } = useQuery({ queryKey: ['ledgers'], queryFn: api.ledgers.list })
  return data ?? []
}

export function useGroups(): Group[] {
  const { data } = useQuery({ queryKey: ['groups'], queryFn: api.groups.list })
  return data ?? []
}

export function useStockItems(): StockItem[] {
  const { data } = useQuery({ queryKey: ['stockItems'], queryFn: api.stockItems.list })
  return data ?? []
}

interface PickerOption {
  id: number
  label: string
  sub?: string
  /** Scannable barcode/SKU — when the typed text matches one exactly, that option ranks first. */
  barcode?: string | null
}

/** Generic type-ahead picker with the amber keyboard bar and an optional inline-create hook. */
function TypeAhead({
  options,
  value,
  onPick,
  placeholder,
  autoFocus,
  onCreate,
  className,
  onScan,
  testId
}: {
  options: PickerOption[]
  value: number | null
  onPick: (id: number | null) => void
  placeholder: string
  autoFocus?: boolean
  onCreate?: (name: string) => void
  className?: string
  /** Fed every keydown for barcode-scan detection; return true to swallow the keystroke. */
  onScan?: (e: React.KeyboardEvent<HTMLInputElement>) => boolean
  /** data-testid for the input (lib/testids.ts — `picker-<what>`). */
  testId?: string
}): React.JSX.Element {
  const selected = options.find((o) => o.id === value) ?? null
  const [text, setText] = useState(selected?.label ?? '')
  const [open, setOpen] = useState(false)
  /** Has the user arrowed within the dropdown? Distinguishes "Enter means pick the highlighted
   *  row" from "Enter on a field I never touched", which must not commit anything. */
  const [movedSelection, setMovedSelection] = useState(false)
  const [active, setActive] = useState(0)
  const wrapRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    setText(selected?.label ?? '')
  }, [selected?.label])

  const filtered = useMemo(() => {
    const q = text.trim().toLowerCase()
    if (!q || q === selected?.label.toLowerCase()) return options.slice(0, 50)
    const matches = options.filter(
      (o) => o.label.toLowerCase().includes(q) || (o.barcode ? o.barcode.toLowerCase().includes(q) : false)
    )
    // Exact barcode match ranks first (scanner input lands here before onScan can even fire).
    matches.sort((a, b) => {
      const aExact = a.barcode && a.barcode.toLowerCase() === q ? 0 : 1
      const bExact = b.barcode && b.barcode.toLowerCase() === q ? 0 : 1
      return aExact - bExact
    })
    return matches.slice(0, 50)
  }, [options, text, selected])

  useEffect(() => {
    const onDoc = (e: MouseEvent): void => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [])

  const pick = (opt: PickerOption | undefined): void => {
    if (!opt) return
    onPick(opt.id)
    setText(opt.label)
    setOpen(false)
  }

  const showCreate = onCreate && text.trim() && !options.some((o) => o.label.toLowerCase() === text.trim().toLowerCase())

  return (
    <div ref={wrapRef} className={`relative ${className ?? ''}`}>
      <input
        className={inputCls}
        data-testid={testId}
        value={text}
        placeholder={placeholder}
        autoFocus={autoFocus}
        onFocus={(e) => {
          e.target.select()
          setOpen(true)
          setActive(0)
          setMovedSelection(false)
        }}
        onChange={(e) => {
          setText(e.target.value)
          setOpen(true)
          setActive(0)
          setMovedSelection(false)
          if (e.target.value.trim() === '') onPick(null)
        }}
        onKeyDown={(e) => {
          if (onScan?.(e)) return
          if (!open && (e.key === 'ArrowDown' || e.key === 'Enter')) {
            setOpen(true)
            return
          }
          if (e.key === 'ArrowDown') {
            e.preventDefault()
            setMovedSelection(true)
            setActive((a) => Math.min(filtered.length - (showCreate ? 0 : 1), a + 1))
          } else if (e.key === 'ArrowUp') {
            e.preventDefault()
            setMovedSelection(true)
            setActive((a) => Math.max(0, a - 1))
          } else if (e.key === 'Enter') {
            // Enter on an untouched, empty field means "nothing goes here" — close and let the
            // key fall through to the form's Enter-chain. Picking `filtered[0]` here would
            // silently commit whichever ledger happens to sort first, and in the voucher line
            // grid that also appends a fresh row, so Enter-chaining could never reach the end
            // of the form.
            if (text.trim() === '' && !movedSelection) {
              setOpen(false)
              return
            }
            e.preventDefault()
            if (showCreate && active === filtered.length) {
              onCreate(text.trim())
              setOpen(false)
            } else {
              pick(filtered[active])
            }
          } else if (e.key === 'Escape') {
            setOpen(false)
            setText(selected?.label ?? '')
          }
        }}
      />
      {open && (filtered.length > 0 || showCreate) && (
        <div className="absolute top-full right-0 left-0 z-30 mt-1 max-h-64 overflow-auto rounded-md border border-line bg-panel2 shadow-xl">
          {filtered.map((o, i) => (
            <div
              key={o.id}
              data-active={i === active}
              className="kbar-row cursor-pointer px-3 py-1.5"
              onMouseEnter={() => setActive(i)}
              onMouseDown={(e) => {
                e.preventDefault()
                pick(o)
              }}
            >
              <span className="text-[13px]">{o.label}</span>
              {o.sub && <span className="ml-2 text-[11px] text-muted">{o.sub}</span>}
            </div>
          ))}
          {showCreate && (
            <div
              data-active={active === filtered.length}
              className="kbar-row cursor-pointer border-t border-line px-3 py-1.5 text-[13px] text-amber"
              onMouseEnter={() => setActive(filtered.length)}
              onMouseDown={(e) => {
                e.preventDefault()
                onCreate(text.trim())
                setOpen(false)
              }}
            >
              Create “{text.trim()}”
            </div>
          )}
        </div>
      )}
    </div>
  )
}

export function LedgerPicker({
  value,
  onPick,
  placeholder = 'Ledger',
  filter,
  autoFocus,
  onCreateRequest,
  className,
  testId = 'picker-ledger'
}: {
  value: number | null
  onPick: (id: number | null) => void
  placeholder?: string
  filter?: (l: Ledger, groups: Map<number, Group>) => boolean
  autoFocus?: boolean
  onCreateRequest?: (name: string) => void
  className?: string
  testId?: string
}): React.JSX.Element {
  const ledgers = useLedgers()
  const groups = useGroups()
  const groupMap = useMemo(() => new Map(groups.map((g) => [g.id, g])), [groups])
  const options = useMemo(
    () =>
      ledgers
        .filter((l) => (filter ? filter(l, groupMap) : true))
        .map((l) => ({ id: l.id, label: l.name, sub: groupMap.get(l.groupId)?.name })),
    [ledgers, filter, groupMap]
  )
  return (
    <TypeAhead
      options={options}
      value={value}
      onPick={onPick}
      placeholder={placeholder}
      autoFocus={autoFocus}
      onCreate={onCreateRequest}
      className={className}
      testId={testId}
    />
  )
}

export function ItemPicker({
  value,
  onPick,
  onCreateRequest,
  className,
  testId = 'picker-item'
}: {
  value: number | null
  onPick: (id: number | null) => void
  onCreateRequest?: (name: string) => void
  className?: string
  testId?: string
}): React.JSX.Element {
  const items = useStockItems()
  const options = useMemo(
    () =>
      items.map((i) => ({
        id: i.id,
        label: i.name,
        sub: i.gstRate != null ? `${i.gstRate}% GST` : undefined,
        barcode: i.barcode
      })),
    [items]
  )

  // A hardware scanner types the barcode's characters in a fast burst terminated by Enter,
  // distinct from a human typing the item name — see @shared/barcode. On a recognized scan,
  // jump straight to that item instead of leaving it to the type-ahead filter.
  const detectorRef = useRef(createScanDetector())
  const onScan = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>): boolean => {
      const ch = e.key === 'Enter' ? '\r' : e.key.length === 1 ? e.key : null
      if (!ch) return false
      const code = detectorRef.current.feed(ch, performance.now())
      if (!code) return false
      const match = items.find((i) => i.barcode && i.barcode === code)
      if (!match) return false
      e.preventDefault()
      onPick(match.id)
      return true
    },
    [items, onPick]
  )

  return (
    <TypeAhead
      options={options}
      value={value}
      onPick={onPick}
      placeholder="Stock item"
      onCreate={onCreateRequest}
      className={className}
      onScan={onScan}
      testId={testId}
    />
  )
}

/** Find-or-create the CGST/SGST/IGST/Cess ledgers (under Duties & Taxes) and Round Off. */
export function useTaxLedgers(): {
  ensure: (taxType: 'cgst' | 'sgst' | 'igst' | 'cess') => Promise<number>
  ensureRoundOff: () => Promise<number>
} {
  const queryClient = useQueryClient()
  const ensure = async (taxType: 'cgst' | 'sgst' | 'igst' | 'cess'): Promise<number> => {
    const ledgers = await api.ledgers.list()
    const existing = ledgers.find((l) => l.taxType === taxType)
    if (existing) return existing.id
    const groups = await api.groups.list()
    const duties = groups.find((g) => g.name === 'Duties & Taxes')
    if (!duties) throw new Error('Duties & Taxes group missing')
    const created = await api.ledgers.create({
      name: taxType.toUpperCase(),
      groupId: duties.id,
      openingBalance: 0,
      gstin: null,
      stateCode: null,
      address: null,
      taxType,
      gstRate: null,
      hsn: null,
      tdsSectionId: null,
      pan: null,
      creditDays: null,
      exportType: null
    })
    await queryClient.invalidateQueries({ queryKey: ['ledgers'] })
    return created.id
  }
  const ensureRoundOff = async (): Promise<number> => {
    const ledgers = await api.ledgers.list()
    const existing = ledgers.find((l) => l.name.toLowerCase() === 'round off')
    if (existing) return existing.id
    const groups = await api.groups.list()
    const indirect = groups.find((g) => g.name === 'Indirect Expenses')
    if (!indirect) throw new Error('Indirect Expenses group missing')
    const created = await api.ledgers.create({
      name: 'Round Off',
      groupId: indirect.id,
      openingBalance: 0,
      gstin: null,
      stateCode: null,
      address: null,
      taxType: null,
      gstRate: null,
      hsn: null,
      tdsSectionId: null,
      pan: null,
      creditDays: null,
      exportType: null
    })
    await queryClient.invalidateQueries({ queryKey: ['ledgers'] })
    return created.id
  }
  return { ensure, ensureRoundOff }
}
