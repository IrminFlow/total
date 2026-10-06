/**
 * DataTable — the shared list/report table. Full guide: ./README.md. Quick start:
 *
 *   const COLUMNS = defineColumns<TbRow>([
 *     { id: 'ledger', header: 'Ledger', kind: 'text', value: (r) => r.ledgerName, hideable: false },
 *     { id: 'group', header: 'Group', kind: 'text', value: (r) => r.groupName, className: 'text-muted' },
 *     { id: 'debit', header: 'Debit', kind: 'money', value: (r) => r.debit, aggregate: 'sum' }
 *   ])
 *
 *   <Panel>
 *     <DataTable
 *       viewId="trial-balance"                // persists sort/filters/columns per company
 *       columns={COLUMNS}
 *       rows={data?.rows ?? []}
 *       rowKey={(r) => r.ledgerId}
 *       loading={isLoading}
 *       onRowActivate={(r) => nav.go({ name: 'ledger-statement', ledgerId: r.ledgerId })}
 *       empty={{ title: 'No balances yet', hint: 'Enter a voucher or set opening balances' }}
 *       exportOptions={{ title: 'Trial balance', periodLabel: `as on ${toDisplayDate(to)}` }}
 *       testId="trial-balance"                // → rows-trial-balance, sort-trial-balance-<col>, …
 *     />
 *   </Panel>
 *
 * Money is integer paise, quantities integer milli, dates ISO — the table formats them with the
 * shared helpers and never does float maths on an amount.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { todayISO } from '@shared/dates'
import {
  aggregateText,
  buildTableExport,
  buildTableModel,
  cellText,
  columnAlign,
  moveColumnTo,
  toggleSort,
  type CellValue,
  type DisplayItem,
  type EnumOption,
  type ViewDefaults
} from '../../lib/table'
import { csvReport, printReport } from '../../lib/reportExport'
import { useSession, useToasts } from '../../state/stores'
import { EmptyState, Money, SkeletonRows, useKeyNav } from '../ui'
import { FilterEditor } from './FilterEditor'
import { Popover } from './Popover'
import { TableToolbar, type ToolbarFeatures } from './TableToolbar'
import type { TableColumn } from './types'
import { useTableView, type TableViewController } from './useTableView'

/** Fixed row heights (px) per density — virtualisation relies on every row being this tall.
 *  Comfortable matches `.ledger-table td` (6px padding + 20px line + 1px rule). */
export const ROW_HEIGHT = { comfortable: 33, compact: 27 } as const
/** Above this many rendered items the body is windowed (with `virtualize="auto"`). */
export const VIRTUALIZE_THRESHOLD = 150
const OVERSCAN = 8
/** Used when the scroller has no layout yet (first paint, jsdom). */
const FALLBACK_VIEWPORT = 640

const DEFAULT_WIDTH: Partial<Record<TableColumn<unknown>['kind'], number>> = {
  money: 150,
  quantity: 130,
  date: 104,
  number: 96,
  enum: 130
}

export interface DataTableExportOptions {
  title: string
  periodLabel: string
  filename?: string
  footNote?: string
  /** Label for the totals row in the export (default 'Total'). */
  totalsLabel?: string
}

export interface DataTableFooterContext<Row> {
  columns: TableColumn<Row>[]
  /** Filtered + sorted rows. */
  rows: Row[]
  totals: Record<string, CellValue>
  /** Number of <td>s a footer row needs (visible columns + action cells). */
  colSpan: number
}

export interface DataTableProps<Row> {
  columns: TableColumn<Row>[]
  rows: readonly Row[]
  /** Stable key per row. Receives the row's index in `rows`. Default: that index. */
  rowKey?: (row: Row, index: number) => string | number
  /** Persist the view (sort, filters, columns, grouping, density, saved views) under this
   *  screen id, scoped to the open company. Omit for an unpersisted table. */
  viewId?: string
  viewDefaults?: ViewDefaults
  /** Migrating a screen off useReportConfig: its reportKey (and key → column id map). */
  legacyReportKey?: string
  legacyIdMap?: Record<string, string | string[]>
  /** An external controller from useTableView (when the screen needs the view itself). */
  controller?: TableViewController

  /** Enter on the active row, and a click (or double-click, see activateOn) on any row. */
  onRowActivate?: (row: Row) => void
  activateOn?: 'click' | 'dblclick'
  /** Rows that do nothing on activate get no pointer cursor. Default: all rows when onRowActivate is set. */
  isRowActivatable?: (row: Row) => boolean
  /** Extra per-row attributes, e.g. (r) => ({ 'data-row-id': r.voucherId }). */
  rowAttrs?: (row: Row) => Record<string, string | number | undefined>
  rowClassName?: (row: Row) => string

  /** Row-level action cells before/after the data columns (clicks inside never activate the row). */
  leading?: (row: Row) => ReactNode
  trailing?: (row: Row) => ReactNode
  leadingWidth?: number
  trailingWidth?: number

  loading?: boolean
  /** Shown when there are no rows at all (before filtering). */
  empty?: { title: string; hint?: string; action?: ReactNode; icon?: ReactNode }

  /** Totals footer: 'auto' (default) shows it when any visible column aggregates. */
  totals?: 'auto' | boolean
  totalsLabel?: ReactNode
  /** Replace the totals footer with your own <tr>s (e.g. a "Closing balance" row). */
  renderFooter?: (ctx: DataTableFooterContext<Row>) => ReactNode

  /** false hides the toolbar entirely. */
  toolbar?: boolean
  toolbarFeatures?: ToolbarFeatures
  /** Extra toolbar content (left of the quick filter / right of the menus). */
  toolbarStart?: ReactNode
  toolbarEnd?: ReactNode
  /** Enables the toolbar's PDF/CSV export of the CURRENT view. */
  exportOptions?: DataTableExportOptions

  /** Keyboard row navigation (↑↓ PgUp PgDn Home End ↵). Default true. */
  keyboard?: boolean
  /** 'auto' windows the body above VIRTUALIZE_THRESHOLD items. */
  virtualize?: 'auto' | boolean
  /** Max height of the table's own scroll area (the header sticks inside it). Default
   *  'calc(100vh - 220px)'. Use 'none' to let the table grow (disables virtualisation). */
  maxHeight?: string
  /** Testid area: tbody `rows-<area>`, headers `sort-<area>-<col>`, toolbar `<area>-table-*`. */
  testId?: string
  /** data-testid on the <table> element itself. */
  tableTestId?: string
  /** Accessible name for the table. */
  ariaLabel?: string
  className?: string
}

const nil = (v: CellValue): boolean => v === null || v === undefined || v === ''

function defaultCell<Row>(col: TableColumn<Row>, row: Row): ReactNode {
  if (col.cell) return col.cell(row)
  const v = col.value(row)
  if (col.kind === 'money') return nil(v) || col.text ? cellText(col, row) : <Money paise={Number(v)} signed={col.signed} />
  const text = cellText(col, row)
  if (col.kind === 'date' || col.kind === 'quantity' || col.kind === 'number') return <span className="num">{text}</span>
  return text
}

function aggregateCell<Row>(col: TableColumn<Row>, v: CellValue): ReactNode {
  if (nil(v)) return ''
  if (col.kind === 'money') return <Money paise={Number(v)} signed={col.signed} />
  return <span className="num">{aggregateText(col, v)}</span>
}

const alignCls = (a: 'left' | 'right' | 'center'): string => (a === 'right' ? 'r' : a === 'center' ? 'text-center' : '')

export function DataTable<Row>(props: DataTableProps<Row>): React.JSX.Element {
  const {
    columns,
    rows,
    rowKey,
    onRowActivate,
    activateOn = 'click',
    isRowActivatable,
    leading,
    trailing,
    leadingWidth = 40,
    trailingWidth = 96,
    loading = false,
    empty,
    totals: totalsMode = 'auto',
    totalsLabel = 'Total',
    renderFooter,
    toolbar = true,
    keyboard = true,
    virtualize = 'auto',
    maxHeight = 'calc(100vh - 220px)',
    exportOptions
  } = props
  const area = props.testId ?? props.viewId ?? 'table'
  const internal = useTableView<Row>(props.controller ? null : (props.viewId ?? null), columns, {
    defaults: props.viewDefaults,
    legacyReportKey: props.legacyReportKey,
    legacyIdMap: props.legacyIdMap
  })
  const controller = props.controller ?? internal
  const { view, setView } = controller
  const toast = useToasts()
  const workingDate = useSession((s) => s.workingDate) || todayISO()

  const [quick, setQuick] = useState('')
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set())
  const [menu, setMenu] = useState<string | null>(null)
  const [liveWidths, setLiveWidths] = useState<Record<string, number>>({})

  const indexOf = useMemo(() => {
    const m = new Map<Row, number>()
    rows.forEach((r, i) => m.set(r, i))
    return m
  }, [rows])
  const keyOf = useCallback(
    (row: Row): string | number => {
      const i = indexOf.get(row) ?? -1
      return rowKey ? rowKey(row, i) : i
    },
    [indexOf, rowKey]
  )

  const model = useMemo(() => buildTableModel(rows, columns, view, { quick, collapsed }), [rows, columns, view, quick, collapsed])
  const visible = model.columns
  const items = model.items
  const hasAggregate = visible.some((c) => c.aggregate)
  const showTotals = !!renderFooter || (totalsMode === 'auto' ? hasAggregate : totalsMode)
  const colSpan = visible.length + (leading ? 1 : 0) + (trailing ? 1 : 0)
  const virtual = maxHeight !== 'none' && (virtualize === true || (virtualize === 'auto' && items.length > VIRTUALIZE_THRESHOLD))

  // ---------- scrolling + windowing ----------
  const scrollRef = useRef<HTMLDivElement>(null)
  const theadRef = useRef<HTMLTableSectionElement>(null)
  const [scrollTop, setScrollTop] = useState(0)
  const [viewportH, setViewportH] = useState(FALLBACK_VIEWPORT)
  const [measuredH, setMeasuredH] = useState<number | null>(null)
  const rowH = measuredH ?? ROW_HEIGHT[view.density]
  useEffect(() => setMeasuredH(null), [view.density])

  useLayoutEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const measure = (): void => setViewportH(el.clientHeight || FALLBACK_VIEWPORT)
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [loading, rows.length === 0])

  const headerH = (): number => theadRef.current?.offsetHeight ?? 0
  let start = 0
  let end = items.length
  if (virtual) {
    const bodyScroll = Math.max(0, scrollTop - headerH())
    start = Math.max(0, Math.floor(bodyScroll / rowH) - OVERSCAN)
    end = Math.min(items.length, Math.ceil((bodyScroll + viewportH) / rowH) + OVERSCAN)
  }

  // Self-correct the assumed row height from a real row (fonts/zoom can shift it a pixel).
  const firstRowRef = useRef<HTMLTableRowElement | null>(null)
  useLayoutEffect(() => {
    if (!virtual) return
    const h = firstRowRef.current?.getBoundingClientRect().height ?? 0
    if (h > 0 && Math.abs(h - rowH) > 0.5) setMeasuredH(h)
  })

  const scrollToIndex = useCallback(
    (i: number) => {
      const el = scrollRef.current
      if (!el || i < 0 || i >= items.length) return
      if (!virtual) {
        const tr = el.querySelector<HTMLElement>(`tr[data-item="${i}"]`)
        if (tr && typeof tr.scrollIntoView === 'function') tr.scrollIntoView({ block: 'nearest' })
        return
      }
      const hh = headerH()
      const vh = el.clientHeight || viewportH
      const top = hh + i * rowH
      const cur = el.scrollTop || scrollTop
      let next = cur
      if (top < cur + hh) next = top - hh
      else if (top + rowH > cur + vh) next = top + rowH - vh
      if (next !== cur) {
        el.scrollTop = next
        setScrollTop(next) // don't wait for the scroll event — render the target row now
      }
    },
    [items.length, virtual, rowH, viewportH, scrollTop]
  )

  // ---------- keyboard ----------
  const toggleGroup = useCallback((key: string) => {
    setCollapsed((s) => {
      const n = new Set(s)
      if (n.has(key)) n.delete(key)
      else n.add(key)
      return n
    })
  }, [])
  const activate = useCallback(
    (item: DisplayItem<Row> | undefined) => {
      if (!item) return
      if (item.type === 'group') toggleGroup(item.key)
      else if (onRowActivate && (!isRowActivatable || isRowActivatable(item.row))) onRowActivate(item.row)
    },
    [onRowActivate, isRowActivatable, toggleGroup]
  )
  const itemsRef = useRef(items)
  itemsRef.current = items
  const { active, setActive } = useKeyNav(items.length, (i) => activate(itemsRef.current[i]), keyboard && !menu && !loading, {
    pageSize: () => Math.max(1, Math.floor(((scrollRef.current?.clientHeight || viewportH) - headerH()) / rowH) - 1),
    scrollTo: scrollToIndex
  })

  // ---------- header interactions ----------
  const dragId = useRef<string | null>(null)
  const resizing = useRef(false)
  const startResize = (e: React.PointerEvent, id: string): void => {
    e.preventDefault()
    e.stopPropagation()
    resizing.current = true
    const th = (e.currentTarget as HTMLElement).closest('th')
    const startX = e.clientX
    const startW = th?.getBoundingClientRect().width || view.widths[id] || 120
    const min = columns.find((c) => c.id === id)?.minWidth ?? 48
    let latest = startW
    const move = (ev: PointerEvent): void => {
      latest = Math.max(min, Math.round(startW + ev.clientX - startX))
      setLiveWidths((w) => ({ ...w, [id]: latest }))
    }
    const up = (): void => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      resizing.current = false
      setLiveWidths({})
      setView((v) => ({ ...v, widths: { ...v.widths, [id]: latest } }))
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }
  const nudgeWidth = (id: string, delta: number, th: HTMLElement | null): void => {
    const cur = view.widths[id] ?? th?.getBoundingClientRect().width ?? 120
    const min = columns.find((c) => c.id === id)?.minWidth ?? 48
    setView((v) => ({ ...v, widths: { ...v.widths, [id]: Math.max(min, Math.round(cur + delta)) } }))
  }

  const widthOf = (c: TableColumn<Row>): number | undefined => liveWidths[c.id] ?? view.widths[c.id] ?? c.width ?? DEFAULT_WIDTH[c.kind]
  const minTableWidth =
    visible.reduce((s, c) => s + (widthOf(c) ?? 160), 0) + (leading ? leadingWidth : 0) + (trailing ? trailingWidth : 0)

  const enumOptions = (c: TableColumn<Row>): EnumOption[] => {
    if (c.options) return c.options
    const seen = new Map<string, string>()
    for (const r of rows) {
      const v = c.value(r)
      if (!nil(v) && !seen.has(String(v))) seen.set(String(v), cellText(c, r))
      if (seen.size > 200) break
    }
    return [...seen.entries()].map(([value, label]) => ({ value, label })).sort((a, b) => a.label.localeCompare(b.label))
  }

  // ---------- export ----------
  const exportModel = (): ReturnType<typeof buildTableExport> =>
    buildTableExport(buildTableModel(rows, columns, view, { quick }), {
      totalsLabel: exportOptions?.totalsLabel ?? (typeof totalsLabel === 'string' ? totalsLabel : 'Total'),
      includeTotals: showTotals
    })
  const exportPdf = exportOptions
    ? (): void => {
        const ex = exportModel()
        void printReport(
          { title: exportOptions.title, periodLabel: exportOptions.periodLabel, columns: ex.columns, rows: ex.rows, footNote: exportOptions.footNote, filename: exportOptions.filename },
          toast
        )
      }
    : undefined
  const exportCsv = exportOptions
    ? (): void => {
        const ex = exportModel()
        void csvReport(ex.header, ex.csvRows, exportOptions.filename ?? exportOptions.title, toast)
      }
    : undefined

  const features: Required<ToolbarFeatures> = {
    quickFilter: true,
    columns: true,
    groupBy: true,
    density: true,
    views: true,
    export: true,
    ...props.toolbarFeatures
  }

  const toolbarEl = toolbar && !loading && rows.length > 0 && (
    <TableToolbar
      area={area}
      columns={columns}
      controller={controller}
      model={model}
      quick={quick}
      setQuick={setQuick}
      features={features}
      menu={menu}
      setMenu={setMenu}
      onExportCsv={exportCsv}
      onExportPdf={exportPdf}
      start={props.toolbarStart}
      end={props.toolbarEnd}
    />
  )

  if (loading) return <SkeletonRows />
  if (rows.length === 0)
    return <EmptyState title={empty?.title ?? 'Nothing to show'} hint={empty?.hint} action={empty?.action} icon={empty?.icon} />

  const firstAgg = visible.findIndex((c) => c.aggregate)
  const labelSpan = (firstAgg < 0 ? visible.length : Math.max(1, firstAgg)) + (leading ? 1 : 0)

  const renderItem = (item: DisplayItem<Row>, i: number): ReactNode => {
    const isActive = i === active
    if (item.type === 'group') {
      return (
        <tr
          key={`g:${item.key}`}
          ref={i === start ? firstRowRef : undefined}
          data-item={i}
          data-active={isActive}
          aria-rowindex={virtual ? i + 2 : undefined}
          className="kbar-row dt-row dt-group cursor-pointer"
          onMouseEnter={() => setActive(i)}
          onClick={() => toggleGroup(item.key)}
        >
          <td colSpan={labelSpan}>
            <button
              type="button"
              className="mr-1.5 inline-block w-3 text-muted"
              aria-expanded={!item.collapsed}
              aria-label={`${item.collapsed ? 'Expand' : 'Collapse'} ${item.label}`}
              onClick={(e) => {
                e.stopPropagation()
                toggleGroup(item.key)
              }}
            >
              {item.collapsed ? '▸' : '▾'}
            </button>
            {item.label}
            <span className="num ml-2 text-small font-normal text-muted">{item.count}</span>
          </td>
          {visible.slice(labelSpan - (leading ? 1 : 0)).map((c) => (
            <td key={c.id} className={alignCls(columnAlign(c))}>
              {c.aggregate ? aggregateCell(c, item.totals[c.id]) : null}
            </td>
          ))}
          {trailing && <td />}
        </tr>
      )
    }
    const row = item.row
    const canActivate = !!onRowActivate && (!isRowActivatable || isRowActivatable(row))
    return (
      <tr
        key={keyOf(row)}
        ref={i === start ? firstRowRef : undefined}
        data-item={i}
        data-active={isActive}
        aria-rowindex={virtual ? i + 2 : undefined}
        {...props.rowAttrs?.(row)}
        className={`kbar-row dt-row ${canActivate ? 'cursor-pointer' : ''} ${props.rowClassName?.(row) ?? ''}`}
        onMouseEnter={() => setActive(i)}
        onClick={activateOn === 'click' && canActivate ? () => onRowActivate!(row) : undefined}
        onDoubleClick={activateOn === 'dblclick' && canActivate ? () => onRowActivate!(row) : undefined}
      >
        {leading && (
          <td onClick={(e) => e.stopPropagation()} onDoubleClick={(e) => e.stopPropagation()}>
            {leading(row)}
          </td>
        )}
        {visible.map((c) => {
          const content = defaultCell(c, row)
          return (
            <td
              key={c.id}
              className={`${alignCls(columnAlign(c))} ${c.className ?? ''}`}
              title={c.kind === 'text' && typeof content === 'string' && content.length > 24 ? content : undefined}
            >
              {content}
            </td>
          )
        })}
        {trailing && (
          <td className="r" onClick={(e) => e.stopPropagation()} onDoubleClick={(e) => e.stopPropagation()}>
            {trailing(row)}
          </td>
        )}
      </tr>
    )
  }

  const topPad = virtual ? start * rowH : 0
  const bottomPad = virtual ? (items.length - end) * rowH : 0

  return (
    <div className={`data-table-wrap ${props.className ?? ''}`} data-testid={`${area}-table`}>
      {toolbarEl}
      <div
        ref={scrollRef}
        className="overflow-auto"
        style={maxHeight !== 'none' ? { maxHeight } : undefined}
        onScroll={(e) => setScrollTop((e.currentTarget as HTMLDivElement).scrollTop)}
      >
        <table
          className="ledger-table data-table"
          data-density={view.density}
          data-virtual={virtual || undefined}
          data-testid={props.tableTestId}
          aria-label={props.ariaLabel}
          aria-rowcount={virtual ? items.length + 1 : undefined}
          style={{ minWidth: minTableWidth }}
        >
          <colgroup>
            {leading && <col style={{ width: leadingWidth }} />}
            {visible.map((c) => {
              const w = widthOf(c)
              return <col key={c.id} style={w ? { width: w } : undefined} />
            })}
            {trailing && <col style={{ width: trailingWidth }} />}
          </colgroup>
          <thead ref={theadRef}>
            <tr aria-rowindex={virtual ? 1 : undefined}>
              {leading && <th aria-label="Row actions" />}
              {visible.map((c) => (
                <HeaderCell
                  key={c.id}
                  col={c}
                  area={area}
                  sortIndex={view.sort.findIndex((k) => k.id === c.id)}
                  sortDir={view.sort.find((k) => k.id === c.id)?.dir}
                  multiSort={view.sort.length > 1}
                  filtered={!!view.filters[c.id]}
                  filterOpen={menu === `filter:${c.id}`}
                  setFilterOpen={(o) => setMenu(o ? `filter:${c.id}` : null)}
                  renderFilter={(close) => (
                    <FilterEditor
                      column={c}
                      filter={view.filters[c.id]}
                      options={c.kind === 'enum' ? enumOptions(c) : []}
                      dateContext={workingDate}
                      testId={`${area}-filter-${c.id}`}
                      close={close}
                      onApply={(f) =>
                        setView((v) => {
                          const filters = { ...v.filters }
                          if (f) filters[c.id] = f
                          else delete filters[c.id]
                          return { ...v, filters }
                        })
                      }
                    />
                  )}
                  onSort={(multi) => setView((v) => ({ ...v, sort: toggleSort(v.sort, c.id, multi) }))}
                  onDragStart={(e) => {
                    if (resizing.current) {
                      e.preventDefault()
                      return
                    }
                    dragId.current = c.id
                    e.dataTransfer.effectAllowed = 'move'
                    e.dataTransfer.setData('text/plain', c.id)
                  }}
                  onDrop={(e) => {
                    const from = dragId.current
                    dragId.current = null
                    if (!from || from === c.id) return
                    e.preventDefault()
                    const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
                    const after = e.clientX > r.left + r.width / 2
                    setView((v) => moveColumnTo(v, from, c.id, after))
                  }}
                  onDragOver={(e) => {
                    if (dragId.current && dragId.current !== c.id) {
                      e.preventDefault()
                      e.dataTransfer.dropEffect = 'move'
                    }
                  }}
                  onResizeStart={(e) => startResize(e, c.id)}
                  onResizeKey={(delta, th) => nudgeWidth(c.id, delta, th)}
                  onResizeReset={() =>
                    setView((v) => {
                      const widths = { ...v.widths }
                      delete widths[c.id]
                      return { ...v, widths }
                    })
                  }
                />
              ))}
              {trailing && <th aria-label="Actions" />}
            </tr>
          </thead>
          <tbody data-testid={`rows-${area}`}>
            {items.length === 0 ? (
              <tr className="dt-empty">
                <td colSpan={colSpan}>
                  <EmptyState
                    title="No rows match"
                    hint={quick ? `Nothing matches “${quick}” with the current filters` : 'Try removing a filter'}
                    action={
                      <button
                        type="button"
                        className="text-small text-blue hover:underline"
                        onClick={() => {
                          setQuick('')
                          setView((v) => ({ ...v, filters: {} }))
                        }}
                        data-testid={`${area}-table-reset-filters`}
                      >
                        Clear filters
                      </button>
                    }
                  />
                </td>
              </tr>
            ) : (
              <>
                {topPad > 0 && (
                  <tr className="dt-spacer" aria-hidden="true" style={{ height: topPad }}>
                    <td colSpan={colSpan} />
                  </tr>
                )}
                {items.slice(start, end).map((item, k) => renderItem(item, start + k))}
                {bottomPad > 0 && (
                  <tr className="dt-spacer" aria-hidden="true" style={{ height: bottomPad }}>
                    <td colSpan={colSpan} />
                  </tr>
                )}
              </>
            )}
          </tbody>
          {showTotals && items.length > 0 && (
            <tfoot>
              {renderFooter ? (
                renderFooter({ columns: visible, rows: model.rows, totals: model.totals, colSpan })
              ) : (
                <tr className="total-row" data-testid={`${area}-table-totals`}>
                  {leading && <td />}
                  {visible.map((c, i) => (
                    <td key={c.id} className={alignCls(columnAlign(c))}>
                      {c.aggregate ? aggregateCell(c, model.totals[c.id]) : i === Math.max(0, visible.findIndex((x) => !x.aggregate)) ? totalsLabel : null}
                    </td>
                  ))}
                  {trailing && <td />}
                </tr>
              )}
            </tfoot>
          )}
        </table>
      </div>
    </div>
  )
}

function HeaderCell<Row>({
  col,
  area,
  sortIndex,
  sortDir,
  multiSort,
  filtered,
  filterOpen,
  setFilterOpen,
  renderFilter,
  onSort,
  onDragStart,
  onDragOver,
  onDrop,
  onResizeStart,
  onResizeKey,
  onResizeReset
}: {
  col: TableColumn<Row>
  area: string
  sortIndex: number
  sortDir: 'asc' | 'desc' | undefined
  multiSort: boolean
  filtered: boolean
  filterOpen: boolean
  setFilterOpen: (o: boolean) => void
  renderFilter: (close: () => void) => ReactNode
  onSort: (multi: boolean) => void
  onDragStart: (e: React.DragEvent) => void
  onDragOver: (e: React.DragEvent) => void
  onDrop: (e: React.DragEvent) => void
  onResizeStart: (e: React.PointerEvent) => void
  onResizeKey: (delta: number, th: HTMLElement | null) => void
  onResizeReset: () => void
}): React.JSX.Element {
  const filterBtn = useRef<HTMLButtonElement>(null)
  const thRef = useRef<HTMLTableCellElement>(null)
  const align = columnAlign(col)
  const sortable = col.sortable !== false
  const filterable = col.filterable !== false
  const ariaSort = sortDir === 'asc' ? 'ascending' : sortDir === 'desc' ? 'descending' : sortable ? 'none' : undefined
  return (
    <th
      ref={thRef}
      scope="col"
      aria-sort={ariaSort}
      className={`dt-th group ${alignCls(align)} ${col.headerClassName ?? ''}`}
      draggable
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDrop={onDrop}
      data-col={col.id}
    >
      <div className={`flex min-w-0 items-center gap-1 ${align === 'right' ? 'justify-end' : align === 'center' ? 'justify-center' : ''}`}>
        {sortable ? (
          <button
            type="button"
            className={`inline-flex min-w-0 items-center gap-1 uppercase hover:text-ink ${sortDir ? 'text-ink' : ''}`}
            onClick={(e) => onSort(e.shiftKey)}
            title={`Sort by ${col.header} (Shift-click to add a secondary sort)`}
            data-testid={`sort-${area}-${col.id}`}
          >
            <span className="truncate">{col.header}</span>
            <span aria-hidden="true" className={sortDir ? 'text-amber' : 'invisible'}>
              {sortDir === 'desc' ? '↓' : '↑'}
              {multiSort && sortIndex >= 0 && <sup className="num ml-px text-[9px]">{sortIndex + 1}</sup>}
            </span>
          </button>
        ) : (
          <span className="truncate">{col.header}</span>
        )}
        {filterable && (
          <>
            <button
              ref={filterBtn}
              type="button"
              aria-label={`Filter ${col.header}`}
              aria-haspopup="dialog"
              aria-expanded={filterOpen}
              title={`Filter ${col.header}`}
              onClick={() => setFilterOpen(!filterOpen)}
              data-testid={`filter-${area}-${col.id}`}
              className={`rounded px-0.5 leading-none transition-opacity ${
                filtered || filterOpen ? 'text-amber opacity-100' : 'text-muted opacity-0 group-hover:opacity-100 focus-visible:opacity-100'
              }`}
            >
              <svg aria-hidden="true" width="10" height="10" viewBox="0 0 10 10" className="block">
                <path d="M0.5 1h9L6 5.2V9L4 8V5.2z" fill="currentColor" />
              </svg>
            </button>
            {filterOpen && (
              <Popover anchor={filterBtn} onClose={() => setFilterOpen(false)} label={`Filter ${col.header}`} align={align === 'right' ? 'right' : 'left'} width={240}>
                {renderFilter(() => {
                  filterBtn.current?.focus()
                  setFilterOpen(false)
                })}
              </Popover>
            )}
          </>
        )}
      </div>
      <span
        role="separator"
        aria-orientation="vertical"
        aria-label={`Resize ${col.header}`}
        tabIndex={0}
        className="dt-resize"
        draggable={false}
        onPointerDown={onResizeStart}
        onDoubleClick={onResizeReset}
        onKeyDown={(e) => {
          if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
            e.preventDefault()
            onResizeKey(e.key === 'ArrowLeft' ? -16 : 16, thRef.current)
          }
        }}
      />
    </th>
  )
}
