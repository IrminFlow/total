import { useRef, useState } from 'react'
import { PRINT_COLUMN_DEFS, type PrintColumn } from '@shared/printTemplates'
import { inputCls } from '../../../components/ui'
import { NumberInput } from './fields'

/** Move item `from` to index `to` (pure — exported for tests). */
export function moveItem<T>(list: readonly T[], from: number, to: number): T[] {
  if (to < 0 || to >= list.length || from === to) return [...list]
  const next = [...list]
  const [it] = next.splice(from, 1)
  next.splice(to, 0, it as T)
  return next
}

/**
 * Line-table columns: show/hide, header text, width (blank = auto), order. Reorder by dragging
 * the handle, the ▲/▼ buttons, or Alt+↑/↓ anywhere in the row (focus follows the moved row).
 */
export function ColumnsEditor({
  columns,
  onChange,
  disabled
}: {
  columns: PrintColumn[]
  onChange: (cols: PrintColumn[]) => void
  disabled?: boolean
}): React.JSX.Element {
  const [dragFrom, setDragFrom] = useState<number | null>(null)
  const rowsRef = useRef<HTMLTableSectionElement>(null)

  const move = (from: number, to: number): void => {
    if (disabled || to < 0 || to >= columns.length) return
    onChange(moveItem(columns, from, to))
    // Keep keyboard focus on the row that moved.
    requestAnimationFrame(() => {
      rowsRef.current?.querySelectorAll<HTMLElement>('[data-col-handle]')[to]?.focus()
    })
  }
  const patch = (i: number, p: Partial<PrintColumn>): void => {
    if (disabled) return
    onChange(columns.map((c, j) => (j === i ? { ...c, ...p } : c)))
  }
  const visibleCount = columns.filter((c) => c.visible).length

  return (
    <div>
      <p className="mb-2 text-hint text-muted">
        Drag ⠿, use ▲/▼, or press Alt+↑/↓ to reorder. Width blank = share the remaining space. Tax
        columns that don&apos;t apply (CGST/SGST on inter-state, IGST on intra-state, empty
        barcode/details/cess) are left out of each printout automatically.
      </p>
      <table className="w-full border-collapse text-body-sm">
        <thead>
          <tr className="text-left text-caption tracking-[0.06em] text-muted uppercase">
            <th className="w-6 py-1" aria-label="Reorder" />
            <th className="w-8 py-1">Show</th>
            <th className="py-1">Column</th>
            <th className="py-1">Header text</th>
            <th className="w-20 py-1">Width px</th>
            <th className="w-14 py-1" aria-label="Move" />
          </tr>
        </thead>
        <tbody ref={rowsRef} data-testid="rows-settings-tpl-columns">
          {columns.map((c, i) => {
            const def = PRINT_COLUMN_DEFS[c.key]
            return (
              <tr
                key={c.key}
                data-col={c.key}
                className={`border-t border-line ${dragFrom === i ? 'opacity-50' : ''} ${c.visible ? '' : 'text-muted'}`}
                onDragOver={(e) => {
                  if (dragFrom !== null) e.preventDefault()
                }}
                onDrop={(e) => {
                  e.preventDefault()
                  if (dragFrom !== null) move(dragFrom, i)
                  setDragFrom(null)
                }}
                onKeyDown={(e) => {
                  if (!e.altKey) return
                  if (e.key === 'ArrowUp') {
                    e.preventDefault()
                    move(i, i - 1)
                  } else if (e.key === 'ArrowDown') {
                    e.preventDefault()
                    move(i, i + 1)
                  }
                }}
              >
                <td className="py-1">
                  <span
                    role="button"
                    tabIndex={0}
                    data-col-handle
                    aria-label={`Reorder ${def.name} (Alt+Up/Down)`}
                    draggable={!disabled}
                    onDragStart={(e) => {
                      setDragFrom(i)
                      e.dataTransfer.effectAllowed = 'move'
                      e.dataTransfer.setData('text/plain', c.key)
                    }}
                    onDragEnd={() => setDragFrom(null)}
                    className="cursor-grab rounded px-1 text-muted hover:text-ink focus-visible:outline focus-visible:outline-amber"
                  >
                    ⠿
                  </span>
                </td>
                <td className="py-1">
                  <input
                    type="checkbox"
                    aria-label={`Show ${def.name}`}
                    data-testid={`input-settings-tpl-col-${c.key}`}
                    checked={c.visible}
                    disabled={disabled || (c.visible && visibleCount === 1)}
                    onChange={(e) => patch(i, { visible: e.target.checked })}
                  />
                </td>
                <td className="py-1 pr-2 whitespace-nowrap">{def.name}</td>
                <td className="py-1 pr-2">
                  <input
                    aria-label={`${def.name} header text`}
                    className={`${inputCls} py-0.5`}
                    value={c.label}
                    maxLength={30}
                    disabled={disabled}
                    onChange={(e) => patch(i, { label: e.target.value })}
                  />
                </td>
                <td className="py-1 pr-2">
                  <NumberInput
                    label={`${def.name} width`}
                    className="py-0.5"
                    value={c.width}
                    min={20}
                    max={400}
                    allowEmpty
                    disabled={disabled}
                    onChange={(w) => patch(i, { width: w === null ? null : Math.round(w) })}
                  />
                </td>
                <td className="py-1 whitespace-nowrap">
                  <button
                    type="button"
                    aria-label={`Move ${def.name} up`}
                    data-testid={`btn-settings-tpl-col-up-${c.key}`}
                    disabled={disabled || i === 0}
                    onClick={() => move(i, i - 1)}
                    className="rounded px-1 text-muted hover:text-ink disabled:opacity-30"
                  >
                    ▲
                  </button>
                  <button
                    type="button"
                    aria-label={`Move ${def.name} down`}
                    data-testid={`btn-settings-tpl-col-down-${c.key}`}
                    disabled={disabled || i === columns.length - 1}
                    onClick={() => move(i, i + 1)}
                    className="rounded px-1 text-muted hover:text-ink disabled:opacity-30"
                  >
                    ▼
                  </button>
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
