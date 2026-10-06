import { useId, useState } from 'react'
import { columnLabel, filterTypeFor, formatRaw, parseFilterValue, type ColumnFilter, type DateOp, type EnumOption, type RangeOp, type TextOp } from '../../lib/table'
import { toPortalDate } from '@shared/dates'
import { Button, inputCls } from '../ui'
import type { TableColumn } from './types'

const TEXT_OPS: { value: TextOp; label: string }[] = [
  { value: 'contains', label: 'Contains' },
  { value: 'startsWith', label: 'Starts with' },
  { value: 'equals', label: 'Equals' },
  { value: 'empty', label: 'Is empty' }
]
const RANGE_OPS: { value: RangeOp; label: string }[] = [
  { value: 'eq', label: '=' },
  { value: 'gte', label: '≥' },
  { value: 'lte', label: '≤' },
  { value: 'between', label: 'Between' }
]
const DATE_OPS: { value: DateOp; label: string }[] = [
  { value: 'on', label: 'On' },
  { value: 'before', label: 'Before' },
  { value: 'after', label: 'After' },
  { value: 'between', label: 'Between' }
]

const small = `${inputCls} !py-1 !text-detail`

/**
 * The per-column filter form inside a header's filter popover. Operands are typed as the user
 * sees them (rupees, quantities, DD-MM-YY / Tally smart dates) and parsed with the shared
 * parsers into raw values (paise, milli, ISO) — the filter itself never holds a float amount.
 */
export function FilterEditor<Row>({
  column,
  filter,
  options,
  dateContext,
  onApply,
  close,
  testId
}: {
  column: TableColumn<Row>
  filter: ColumnFilter | undefined
  /** Enum choices (column.options, or distinct values derived from the rows). */
  options: EnumOption[]
  dateContext: string
  onApply: (f: ColumnFilter | null) => void
  close: () => void
  testId: string
}): React.JSX.Element {
  const type = filterTypeFor(column.kind)
  const uid = useId()
  // Prefill in a form the parsers read back: rupees with grouping, plain quantities, and
  // DD-MM-YYYY dates (parseSmartDate does not read the DD-MMM-YY display form).
  const fmt = (v: string | number | undefined): string => {
    if (v === undefined) return ''
    if (column.kind === 'date') return toPortalDate(String(v))
    if (column.kind === 'money' || column.kind === 'quantity') return formatRaw(column.kind, v, { decimals: 3, plainZero: true })
    return String(v)
  }

  const [op, setOp] = useState<string>(() => {
    if (filter && filter.type !== 'enum') return filter.op
    return type === 'text' ? 'contains' : type === 'range' ? 'gte' : 'on'
  })
  const [a, setA] = useState(() =>
    filter?.type === 'text' ? filter.value : filter?.type === 'range' || filter?.type === 'date' ? fmt(filter.a) : ''
  )
  const [b, setB] = useState(() => (filter?.type === 'range' || filter?.type === 'date' ? fmt(filter.b) : ''))
  const [picked, setPicked] = useState<string[]>(() => (filter?.type === 'enum' ? filter.values : []))
  const [error, setError] = useState<string | null>(null)

  const apply = (): void => {
    setError(null)
    if (type === 'enum') {
      onApply(picked.length ? { type: 'enum', values: picked } : null)
      close()
      return
    }
    if (type === 'text') {
      if (op !== 'empty' && a.trim() === '') onApply(null)
      else onApply({ type: 'text', op: op as TextOp, value: op === 'empty' ? '' : a })
      close()
      return
    }
    const pa = parseFilterValue(column.kind, a, dateContext)
    const needB = op === 'between'
    const pb = needB ? parseFilterValue(column.kind, b, dateContext) : null
    const what = type === 'date' ? 'a date (7, 7/4, 15-08-2026)' : column.kind === 'money' ? 'an amount' : 'a number'
    if (pa === null || (needB && pb === null)) {
      setError(`Enter ${what}`)
      return
    }
    if (type === 'range')
      onApply(needB ? { type: 'range', op: 'between', a: pa as number, b: pb as number } : { type: 'range', op: op as RangeOp, a: pa as number })
    else onApply(needB ? { type: 'date', op: 'between', a: pa as string, b: pb as string } : { type: 'date', op: op as DateOp, a: pa as string })
    close()
  }

  const onKey = (e: React.KeyboardEvent): void => {
    if (e.key === 'Enter') {
      e.preventDefault()
      apply()
    }
  }

  return (
    <div className="flex flex-col gap-2" data-testid={testId}>
      <p className="text-caption font-semibold tracking-[0.08em] text-muted uppercase">Filter · {columnLabel(column)}</p>
      {type === 'enum' ? (
        <fieldset className="flex max-h-56 flex-col gap-1 overflow-y-auto">
          <legend className="sr-only">Show only</legend>
          {options.length === 0 && <span className="text-muted">No values</span>}
          {options.map((o) => (
            <label key={o.value} className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={picked.includes(o.value)}
                onChange={(e) => setPicked((p) => (e.target.checked ? [...p, o.value] : p.filter((x) => x !== o.value)))}
                onKeyDown={onKey}
              />
              {o.label}
            </label>
          ))}
        </fieldset>
      ) : (
        <>
          <label className="sr-only" htmlFor={`${uid}-op`}>
            Condition
          </label>
          <select id={`${uid}-op`} className={small} value={op} onChange={(e) => setOp(e.target.value)} data-testid={`${testId}-op`}>
            {(type === 'text' ? TEXT_OPS : type === 'range' ? RANGE_OPS : DATE_OPS).map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
          {!(type === 'text' && op === 'empty') && (
            <input
              className={`${small} ${type !== 'text' ? 'num' : ''}`}
              aria-label={op === 'between' ? 'From' : 'Value'}
              placeholder={type === 'date' ? 'e.g. 1/4 or 01-04-2026' : type === 'range' ? '0.00' : ''}
              inputMode={type === 'range' ? 'decimal' : undefined}
              value={a}
              onChange={(e) => setA(e.target.value)}
              onKeyDown={onKey}
              data-testid={`${testId}-a`}
              aria-invalid={error ? true : undefined}
            />
          )}
          {op === 'between' && (
            <input
              className={`${small} num`}
              aria-label="To"
              value={b}
              onChange={(e) => setB(e.target.value)}
              onKeyDown={onKey}
              data-testid={`${testId}-b`}
              aria-invalid={error ? true : undefined}
            />
          )}
        </>
      )}
      {error && (
        <span role="alert" className="text-hint text-cr">
          {error}
        </span>
      )}
      <div className="mt-1 flex justify-between gap-2">
        <Button
          variant="ghost"
          className="!px-2 !py-1"
          onClick={() => {
            onApply(null)
            close()
          }}
          data-testid={`${testId}-clear`}
        >
          Clear
        </Button>
        <Button variant="primary" className="!px-2 !py-1" onClick={apply} data-testid={`${testId}-apply`}>
          Apply
        </Button>
      </div>
    </div>
  )
}
