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
import { Fragment, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { todayISO } from '@shared/dates'
import {
  aggregateText,
  buildRowLayout,
  buildTableExport,
  buildTableModel,
  buildTableXlsx,
  capExportForPdf,
  cellText,
  columnAlign,
  columnDropTarget,
  columnLabel,
  columnWidthSpecs,
  headerBands,
  itemAt,
  layoutColumnWidths,
  moveColumnTo,
  scrollTopFor,
  toggleSort,
  visibleRange,
  type CellValue,
  type DisplayItem,
  type EnumOption,
  type MoneyExportFormat,
  type ViewDefaults
} from '../../lib/table'
import { csvReport, PDF_ROW_LIMIT, printReport, xlsxReport } from '../../lib/reportExport'
import { useDensity, useSession, useToasts } from '../../state/stores'
import { EmptyState, Money, SkeletonRows, useKeyNav } from '../ui'
import { FilterEditor } from './FilterEditor'
import { Popover } from './Popover'
import { TableToolbar, type ToolbarFeatures } from './TableToolbar'
import type { TableColumn } from './types'
import { useTableView, type TableViewController } from './useTableView'
import { registerTableActions } from './tableActions'

/** Fixed row heights (px) per density — virtualisation relies on every DATA row being this tall
 *  (detail rows are measured). Comfortable matches `.ledger-table td` (6px + 20px line + 6px + 1px). */
export const ROW_HEIGHT = { comfortable: 33, compact: 27 } as const
/** Above this many rendered items the body is windowed (with `virtualize="auto"`). */
export const VIRTUALIZE_THRESHOLD = 150
const OVERSCAN = 8
/** Used when the scroller has no layout yet (first paint, jsdom). */
const FALLBACK_VIEWPORT = 640
const EXPANDER_WIDTH = 32

export type RowKey = string | number

export interface DataTableExportOptions {
  title: string
  periodLabel: string
  filename?: string
  footNote?: string
  /** Label for the totals row in the export (default: `totalsLabel` when it is a string, else 'Total'). */
  totalsLabel?: string
  /** Money cells in the toolbar's CSV: 'display' (default, "1,234.00 Dr") or 'plain' signed
   *  decimals ("-1234.00") for spreadsheets. See buildTableExport's `moneyFormat`. */
  csvMoneyFormat?: MoneyExportFormat
  /** Money cells in the toolbar's PDF (default 'display'). */
  pdfMoneyFormat?: MoneyExportFormat
}

export interface DataTableFooterContext<Row> {
  /** Visible columns in view order. */
  columns: TableColumn<Row>[]
  /** The rows in view: filtered + sorted (every row of a collapsed group included). */
  rows: Row[]
  totals: Record<string, CellValue>
  /** Number of <td>s a footer row needs (visible columns + expander + action cells). */
  colSpan: number
  /** `rows.length` — rows left after the column filters and the quick filter. */
  filteredCount: number
  /** Rows passed to the table, before any filter. */
  totalCount: number
  /** True when a filter or the quick filter hides some rows. */
  isFiltered: boolean
}

export interface DataTableProps<Row> {
  columns: TableColumn<Row>[]
  rows: readonly Row[]
  /** Stable key per row. Receives the row's index in `rows`. Default: that index. */
  rowKey?: (row: Row, index: number) => RowKey
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
  /** Rows that do nothing on activate: no pointer cursor, Enter is a no-op (the keyboard bar
   *  still shows). Default: all rows are activatable when onRowActivate is set. */
  isRowActivatable?: (row: Row) => boolean
  /** Extra per-row attributes, e.g. (r) => ({ 'data-row-id': r.voucherId }). */
  rowAttrs?: (row: Row) => Record<string, string | number | undefined>
  rowClassName?: (row: Row) => string

  /** Expandable detail: content rendered in a full-width row under an expanded row. Its height
   *  may vary (it is measured). Adds a chevron column; → / ← expand and collapse the active row. */
  renderDetail?: (row: Row) => ReactNode
  /** Which rows can expand (default: all, when renderDetail is set). */
  isRowExpandable?: (row: Row) => boolean
  /** Controlled expanded row keys. Omit for uncontrolled (see defaultExpanded). */
  expanded?: ReadonlySet<RowKey>
  onExpandedChange?: (next: Set<RowKey>) => void
  defaultExpanded?: Iterable<RowKey>
  /** Assumed height of a detail row before it has been measured (px). Default 120. */
  detailHeightEstimate?: number

  /** Row-level action cells before/after the data columns (clicks inside never activate the row). */
  leading?: (row: Row) => ReactNode
  trailing?: (row: Row) => ReactNode
  leadingWidth?: number
  trailingWidth?: number

  loading?: boolean
  /** Shown in the body when there are no rows at all (before filtering). The toolbar and the
   *  header stay, so screen controls in `toolbarStart` remain usable. When rows exist but the
   *  table's filters hide them all, a "No rows match" state with Clear filters shows instead. */
  empty?: { title: string; hint?: string; action?: ReactNode; icon?: ReactNode }

  /** Totals footer: 'auto' (default) shows it when any visible column aggregates. */
  totals?: 'auto' | boolean
  /** The totals row's label, or a function of the footer context (rows in view, counts), e.g.
   *  `(ctx) => \`Total · ${ctx.filteredCount} vouchers\``. */
  totalsLabel?: ReactNode | ((ctx: DataTableFooterContext<Row>) => ReactNode)
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

  /** Keyboard row navigation (↑↓ PgUp PgDn Home End ↵ ← →). Default true. */
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

/** A detail row that reports its rendered height (on mount and whenever it resizes). */
function DetailRow({
  id,
  rowKey,
  colSpan,
  ariaRowIndex,
  onHeight,
  children
}: {
  id: string
  rowKey: RowKey
  colSpan: number
  ariaRowIndex?: number
  onHeight: (key: RowKey, h: number) => void
  children: ReactNode
}): React.JSX.Element {
  const ref = useRef<HTMLTableRowElement>(null)
  const onHeightRef = useRef(onHeight)
  onHeightRef.current = onHeight
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const report = (): void => {
      const h = el.getBoundingClientRect().height
      if (h > 0) onHeightRef.current(rowKey, h)
    }
    report()
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(report)
    ro.observe(el)
    return () => ro.disconnect()
  }, [rowKey])
  return (
    <tr ref={ref} id={id} className="dt-detail" data-detail-for={String(rowKey)} aria-rowindex={ariaRowIndex}>
      <td colSpan={colSpan}>{children}</td>
    </tr>
  )
}

export function DataTable<Row>(props: DataTableProps<Row>): React.JSX.Element {
  const {
    columns,
    rows,
    rowKey,
    onRowActivate,
    activateOn = 'click',
    isRowActivatable,
    renderDetail,
    isRowExpandable,
    detailHeightEstimate = 120,
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
  const uid = useId()
  const internal = useTableView<Row>(props.controller ? null : (props.viewId ?? null), columns, {
    defaults: props.viewDefaults,
    legacyReportKey: props.legacyReportKey,
    legacyIdMap: props.legacyIdMap
  })
  const controller = props.controller ?? internal
  const { view, setView } = controller
  const toast = useToasts()
  const workingDate = useSession((s) => s.workingDate) || todayISO()
  const companyName = useSession((s) => s.info?.name) ?? ''

  const [quick, setQuick] = useState('')
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set())
  const [menu, setMenu] = useState<string | null>(null)
  const [liveWidths, setLiveWidths] = useState<Record<string, number>>({})
  const [drag, setDrag] = useState<{ id: string; target: { id: string; after: boolean } | null } | null>(null)

  const indexOf = useMemo(() => {
    const m = new Map<Row, number>()
    rows.forEach((r, i) => m.set(r, i))
    return m
  }, [rows])
  const keyOf = useCallback(
    (row: Row): RowKey => {
      const i = indexOf.get(row) ?? -1
      return rowKey ? rowKey(row, i) : i
    },
    [indexOf, rowKey]
  )
  const canActivate = useCallback(
    (row: Row): boolean => !!onRowActivate && (!isRowActivatable || isRowActivatable(row)),
    [onRowActivate, isRowActivatable]
  )

  // ---------- expanded detail rows (controlled or uncontrolled) ----------
  const [internalExpanded, setInternalExpanded] = useState<ReadonlySet<RowKey>>(() => new Set(props.defaultExpanded ?? []))
  const expandedSet = props.expanded ?? internalExpanded
  const expandedRef = useRef(expandedSet)
  expandedRef.current = expandedSet
  const onExpandedChangeRef = useRef(props.onExpandedChange)
  onExpandedChangeRef.current = props.onExpandedChange
  const controlledExpanded = props.expanded !== undefined
  const setRowExpanded = useCallback(
    (key: RowKey, open: boolean) => {
      const cur = expandedRef.current
      if (cur.has(key) === open) return
      const next = new Set(cur)
      if (open) next.add(key)
      else next.delete(key)
      if (!controlledExpanded) setInternalExpanded(next)
      onExpandedChangeRef.current?.(next)
    },
    [controlledExpanded]
  )
  const expandable = useCallback(
    (row: Row): boolean => !!renderDetail && (!isRowExpandable || isRowExpandable(row)),
    [renderDetail, isRowExpandable]
  )
  // Measured detail heights by row key. A ref + version counter, so a measurement doesn't copy a map.
  const detailHeights = useRef(new Map<RowKey, number>())
  const [heightsVersion, setHeightsVersion] = useState(0)
  const onDetailHeight = useCallback((key: RowKey, h: number) => {
    const prev = detailHeights.current.get(key)
    if (prev !== undefined && Math.abs(prev - h) < 0.5) return
    detailHeights.current.set(key, h)
    setHeightsVersion((v) => v + 1)
  }, [])

  const model = useMemo(() => buildTableModel(rows, columns, view, { quick, collapsed }), [rows, columns, view, quick, collapsed])
  const visible = model.columns
  const items = model.items
  const hasAggregate = visible.some((c) => c.aggregate)
  const showTotals = !!renderFooter || (totalsMode === 'auto' ? hasAggregate : totalsMode)
  const hasExpander = !!renderDetail
  const prefixCols = (hasExpander ? 1 : 0) + (leading ? 1 : 0)
  const colSpan = visible.length + prefixCols + (trailing ? 1 : 0)
  const virtual = maxHeight !== 'none' && (virtualize === true || (virtualize === 'auto' && items.length > VIRTUALIZE_THRESHOLD))

  const isExpanded = useCallback(
    (item: DisplayItem<Row> | undefined): boolean =>
      !!item && item.type === 'row' && expandable(item.row) && expandedSet.has(keyOf(item.row)),
    [expandable, expandedSet, keyOf]
  )

  // ---------- scrolling + windowing ----------
  const rootRef = useRef<HTMLDivElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const theadRef = useRef<HTMLTableSectionElement>(null)
  const [scrollTop, setScrollTop] = useState(0)
  const [viewportH, setViewportH] = useState(FALLBACK_VIEWPORT)
  /** The scroll area's inner width (excludes its scrollbar); 0 until measured (and in jsdom). */
  const [availableW, setAvailableW] = useState(0)
  const [measuredH, setMeasuredH] = useState<number | null>(null)
  // The view's own density, else the app-wide setting (Settings → Appearance).
  const appDensity = useDensity()
  const density = view.density ?? appDensity
  const rowH = measuredH ?? ROW_HEIGHT[density]
  useEffect(() => setMeasuredH(null), [density])

  useLayoutEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const measure = (): void => {
      setViewportH(el.clientHeight || FALLBACK_VIEWPORT)
      setAvailableW(el.clientWidth)
    }
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [loading])

  // Offset index: prefix sums of (row height + measured/estimated detail height) per item.
  const layout = useMemo(
    () =>
      buildRowLayout(items.length, rowH, (i) => {
        const it = items[i]
        if (!isExpanded(it) || it?.type !== 'row') return 0
        return detailHeights.current.get(keyOf(it.row)) ?? detailHeightEstimate
      }),
    // heightsVersion: re-sum when a detail row reports a new height
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [items, rowH, isExpanded, keyOf, detailHeightEstimate, heightsVersion]
  )
  const layoutRef = useRef(layout)
  layoutRef.current = layout

  const headerH = (): number => theadRef.current?.offsetHeight ?? 0
  let start = 0
  let end = items.length
  if (virtual) [start, end] = visibleRange(layout, scrollTop - headerH(), viewportH, OVERSCAN)

  // Self-correct the assumed row height from a real data row (fonts/zoom can shift it a pixel).
  const firstRowRef = useRef<HTMLTableRowElement | null>(null)
  useLayoutEffect(() => {
    if (!virtual) return
    const h = firstRowRef.current?.getBoundingClientRect().height ?? 0
    if (h > 0 && Math.abs(h - rowH) > 0.5) setMeasuredH(h)
  })

  // The row the keyboard last scrolled to. Detail rows rendered for the first time can turn out
  // taller/shorter than estimated, which moves that row — so it is re-scrolled whenever the
  // layout changes, until the user scrolls by hand.
  const scrollTarget = useRef<number | null>(null)
  const scrollToIndex = useCallback(
    (i: number) => {
      const el = scrollRef.current
      if (!el || i < 0 || i >= items.length) return
      if (!virtual) {
        const tr = el.querySelector<HTMLElement>(`tr[data-item="${i}"]`)
        if (tr && typeof tr.scrollIntoView === 'function') tr.scrollIntoView({ block: 'nearest' })
        return
      }
      scrollTarget.current = i
      const cur = el.scrollTop || scrollTop
      const next = scrollTopFor(layoutRef.current, i, rowH, cur, el.clientHeight || viewportH, headerH())
      if (next !== cur) {
        el.scrollTop = next
        setScrollTop(next) // don't wait for the scroll event — render the target row now
      }
    },
    [items.length, virtual, rowH, viewportH, scrollTop]
  )
  useLayoutEffect(() => {
    if (virtual && scrollTarget.current !== null && scrollTarget.current < items.length) scrollToIndex(scrollTarget.current)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layout])
  const onScroll = (e: React.UIEvent<HTMLDivElement>): void => setScrollTop(e.currentTarget.scrollTop)
  // Hand scrolling (wheel, touch, scrollbar drag) releases the keyboard target. Scroll events
  // alone can't tell: Chromium's scroll anchoring also fires them.
  const releaseScrollTarget = (): void => {
    scrollTarget.current = null
  }

  // ---------- keyboard ----------
  const toggleGroup = useCallback((key: string, open?: boolean) => {
    setCollapsed((s) => {
      const isOpen = !s.has(key)
      if (open !== undefined && open === isOpen) return s
      const n = new Set(s)
      if (isOpen) n.add(key)
      else n.delete(key)
      return n
    })
  }, [])
  const activate = useCallback(
    (item: DisplayItem<Row> | undefined) => {
      if (!item) return
      if (item.type === 'group') toggleGroup(item.key)
      else if (canActivate(item.row)) onRowActivate!(item.row)
    },
    [canActivate, onRowActivate, toggleGroup]
  )
  const itemsRef = useRef(items)
  itemsRef.current = items
  const activeRef = useRef(0)
  const { active, setActive } = useKeyNav(items.length, (i) => activate(itemsRef.current[i]), keyboard && !menu && !loading, {
    // A page = the items that fit in one viewport above/below the active one (detail rows count
    // by their height, so a page over expanded rows moves fewer items).
    pageSize: (dir) => {
      const vh = Math.max(rowH, (scrollRef.current?.clientHeight || viewportH) - headerH() - rowH)
      const L = layoutRef.current
      const a = Math.min(activeRef.current, itemsRef.current.length - 1)
      if (a < 0) return 1
      return dir > 0 ? itemAt(L, L.offsets[a]! + vh) - a : a - itemAt(L, L.offsets[a]! - vh + rowH - 1)
    },
    scrollTo: scrollToIndex,
    claim: () => rootRef.current,
    onKey: (e, i) => {
      if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return false
      const item = itemsRef.current[i]
      if (!item) return false
      const open = e.key === 'ArrowRight'
      if (item.type === 'group') {
        toggleGroup(item.key, open)
        return true
      }
      if (!expandable(item.row)) return false
      setRowExpanded(keyOf(item.row), open)
      return true
    }
  })
  activeRef.current = active

  // ---------- header interactions ----------
  const resizing = useRef(false)
  const startResize = (e: React.PointerEvent, id: string): void => {
    if (e.button !== 0) return
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
      if (latest !== startW) setView((v) => ({ ...v, widths: { ...v.widths, [id]: latest } }))
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }
  const nudgeWidth = (id: string, delta: number, th: HTMLElement | null): void => {
    const cur = view.widths[id] ?? th?.getBoundingClientRect().width ?? 120
    const min = columns.find((c) => c.id === id)?.minWidth ?? 48
    setView((v) => ({ ...v, widths: { ...v.widths, [id]: Math.max(min, Math.round(cur + delta)) } }))
  }

  /** Pointer-driven reorder (HTML5 drag-and-drop is avoided: it fires a stray click — a sort — on
   *  drop and gives no control over the drop indicator). Movement under 5px stays a click. */
  const startReorder = (e: React.PointerEvent, id: string): void => {
    if (e.button !== 0 || resizing.current) return
    if ((e.target as HTMLElement).closest('.dt-resize, [data-no-drag]')) return
    const startX = e.clientX
    let dragging = false
    const rects = (): { id: string; left: number; right: number }[] =>
      Array.from(theadRef.current?.querySelectorAll<HTMLElement>('th[data-col]') ?? []).map((th) => {
        const r = th.getBoundingClientRect()
        return { id: th.dataset.col!, left: r.left, right: r.right }
      })
    const move = (ev: PointerEvent): void => {
      if (!dragging && Math.abs(ev.clientX - startX) < 5) return
      dragging = true
      setDrag({ id, target: columnDropTarget(rects(), id, ev.clientX) })
    }
    const up = (ev: PointerEvent): void => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      if (!dragging) return
      const t = columnDropTarget(rects(), id, ev.clientX)
      setDrag(null)
      if (t) setView((v) => moveColumnTo(v, id, t.id, t.after))
      // Swallow the click that follows the pointerup, so a drag never also sorts.
      const swallow = (ce: MouseEvent): void => {
        ce.stopPropagation()
        ce.preventDefault()
      }
      window.addEventListener('click', swallow, { capture: true, once: true })
      setTimeout(() => window.removeEventListener('click', swallow, { capture: true }), 0)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  // ---------- column widths (lib/table/layout.ts) ----------
  // Integer px for every column, summing exactly to the table width: spare space goes to the
  // flexible columns (or the last text column), so the browser never splits pixels itself.
  const fixedW = (hasExpander ? EXPANDER_WIDTH : 0) + (leading ? leadingWidth : 0) + (trailing ? trailingWidth : 0)
  const widthSpecs = columnWidthSpecs(visible, { ...view.widths, ...liveWidths })
  const measuredLayout = availableW > 0
  const { widths: colWidths, total: tableWidth } = layoutColumnWidths(widthSpecs, availableW, fixedW)
  // Before the first measurement (and in jsdom) flexible columns stay auto, as before.
  const colWidth = (i: number): number | undefined => (measuredLayout || !widthSpecs[i]!.flex ? colWidths[i] : undefined)
  const bands = headerBands(visible)
  const headerRows = bands.length > 0 ? 2 : 1

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

  // ---------- footer context ----------
  const footerCtx: DataTableFooterContext<Row> = {
    columns: visible,
    rows: model.rows,
    totals: model.totals,
    colSpan,
    filteredCount: model.rows.length,
    totalCount: model.totalCount,
    isFiltered: model.rows.length !== model.totalCount
  }
  const totalsLabelNode: ReactNode = typeof totalsLabel === 'function' ? totalsLabel(footerCtx) : totalsLabel

  // ---------- export ----------
  const exportModel = (moneyFormat?: MoneyExportFormat): ReturnType<typeof buildTableExport> =>
    buildTableExport(buildTableModel(rows, columns, view, { quick }), {
      totalsLabel: exportOptions?.totalsLabel ?? (typeof totalsLabelNode === 'string' ? totalsLabelNode : 'Total'),
      includeTotals: showTotals,
      moneyFormat
    })
  const exportPdf = exportOptions
    ? (): void => {
        const capped = capExportForPdf(exportModel(exportOptions.pdfMoneyFormat), PDF_ROW_LIMIT)
        if (capped.note) toast.push('warning', capped.note)
        // report:pdf caps footNote at 500 chars — keep the truncation note, trim the screen's own note.
        const footNote = capped.note
          ? [exportOptions.footNote?.slice(0, 500 - capped.note.length - 3), capped.note].filter(Boolean).join(' · ')
          : exportOptions.footNote
        void printReport(
          {
            title: exportOptions.title,
            periodLabel: exportOptions.periodLabel,
            columns: capped.export.columns,
            rows: capped.export.rows,
            footNote,
            filename: exportOptions.filename
          },
          toast
        )
      }
    : undefined
  const exportCsv = exportOptions
    ? (): void => {
        const ex = exportModel(exportOptions.csvMoneyFormat)
        void csvReport(ex.header, ex.csvRows, exportOptions.filename ?? exportOptions.title, toast)
      }
    : undefined
  // WP 6.3: the same view as a typed workbook — money as ₹ numbers, dates as dates.
  const exportXlsx = exportOptions
    ? (): void => {
        const sheet = buildTableXlsx(buildTableModel(rows, columns, view, { quick }), {
          name: exportOptions.title,
          preamble: [companyName, exportOptions.title, exportOptions.periodLabel, exportOptions.footNote ?? ''].filter(Boolean),
          totalsLabel: exportOptions.totalsLabel ?? (typeof totalsLabelNode === 'string' ? totalsLabelNode : 'Total'),
          includeTotals: showTotals
        })
        void xlsxReport(sheet, exportOptions.filename ?? exportOptions.title, toast)
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

  // The toolbar stays whenever the table is mounted with columns — while loading and with zero
  // rows too — so screen controls in toolbarStart never vanish and an over-filtered table can
  // always be un-filtered.
  // Expose columns + export to the screen's Options drawer (tableActions.ts), by testId area.
  const actionsRef = useRef({ exportPdf, exportCsv, exportXlsx, hasRows: rows.length > 0, columns: features.columns && toolbar })
  actionsRef.current = { exportPdf, exportCsv, exportXlsx, hasRows: rows.length > 0, columns: features.columns && toolbar }
  useEffect(
    () =>
      registerTableActions(area, {
        openColumns: () => {
          if (actionsRef.current.columns) setMenu('columns')
        },
        exportPdf: () => (actionsRef.current.hasRows ? actionsRef.current.exportPdf?.() : undefined),
        exportCsv: () => (actionsRef.current.hasRows ? actionsRef.current.exportCsv?.() : undefined),
        exportXlsx: () => (actionsRef.current.hasRows ? actionsRef.current.exportXlsx?.() : undefined)
      }),
    [area]
  )

  const toolbarEl = toolbar && columns.length > 0 && (
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
      appDensity={appDensity}
      onExportCsv={rows.length > 0 ? exportCsv : undefined}
      onExportPdf={rows.length > 0 ? exportPdf : undefined}
      onExportXlsx={rows.length > 0 ? exportXlsx : undefined}
      start={props.toolbarStart}
      end={props.toolbarEnd}
      loading={loading}
    />
  )

  if (loading) {
    if (!toolbarEl) return <SkeletonRows />
    return (
      <div ref={rootRef} className={`data-table-wrap ${props.className ?? ''}`} data-testid={`${area}-table`}>
        {toolbarEl}
        <SkeletonRows />
      </div>
    )
  }

  const clearAllFilters = (): void => {
    setQuick('')
    setView((v) => ({ ...v, filters: {} }))
  }
  const hasTableFilters = quick.trim() !== '' || Object.keys(view.filters).length > 0

  const firstAgg = visible.findIndex((c) => c.aggregate)
  const labelSpan = (firstAgg < 0 ? visible.length : Math.max(1, firstAgg)) + prefixCols
  const ariaRow = (i: number): number | undefined => (virtual ? layout.rowIndex[i]! + headerRows + 1 : undefined)

  const renderItem = (item: DisplayItem<Row>, i: number): ReactNode => {
    const isActive = i === active
    if (item.type === 'group') {
      return (
        <tr
          key={`g:${item.key}`}
          ref={i === start ? firstRowRef : undefined}
          data-item={i}
          data-active={isActive}
          aria-rowindex={ariaRow(i)}
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
          {visible.slice(labelSpan - prefixCols).map((c) => (
            <td key={c.id} className={alignCls(columnAlign(c))}>
              {c.aggregate ? aggregateCell(c, item.totals[c.id]) : null}
            </td>
          ))}
          {trailing && <td />}
        </tr>
      )
    }
    const row = item.row
    const key = keyOf(row)
    const clickable = canActivate(row)
    const canExpand = expandable(row)
    const open = canExpand && expandedSet.has(key)
    const detailId = `${uid}-detail-${String(key)}`
    const tr = (
      <tr
        ref={i === start ? firstRowRef : undefined}
        data-item={i}
        data-active={isActive}
        aria-rowindex={ariaRow(i)}
        {...props.rowAttrs?.(row)}
        className={`kbar-row dt-row ${clickable ? 'cursor-pointer' : 'dt-inert'} ${props.rowClassName?.(row) ?? ''}`}
        onMouseEnter={() => setActive(i)}
        onClick={activateOn === 'click' && clickable ? () => onRowActivate!(row) : undefined}
        onDoubleClick={activateOn === 'dblclick' && clickable ? () => onRowActivate!(row) : undefined}
      >
        {hasExpander && (
          <td className="dt-expander" onClick={(e) => e.stopPropagation()} onDoubleClick={(e) => e.stopPropagation()}>
            {canExpand && (
              <button
                type="button"
                className="w-4 text-muted hover:text-ink"
                aria-expanded={open}
                aria-controls={open ? detailId : undefined}
                aria-label={`${open ? 'Hide' : 'Show'} details${visible[0] ? ` for ${cellText(visible[0], row)}` : ''}`}
                onClick={() => setRowExpanded(key, !open)}
                data-testid={`${area}-expand-${String(key)}`}
              >
                {open ? '▾' : '▸'}
              </button>
            )}
          </td>
        )}
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
    // One keyed Fragment whether or not the detail shows, so expanding never remounts the row
    // (which would drop focus from the chevron).
    return (
      <Fragment key={key}>
        {tr}
        {open && (
          <DetailRow
            id={detailId}
            rowKey={key}
            colSpan={colSpan}
            ariaRowIndex={virtual ? ariaRow(i)! + 1 : undefined}
            onHeight={onDetailHeight}
          >
            {renderDetail!(row)}
          </DetailRow>
        )}
      </Fragment>
    )
  }

  const topPad = virtual ? layout.offsets[start]! : 0
  const bottomPad = virtual ? layout.total - layout.offsets[end]! : 0

  return (
    <div ref={rootRef} className={`data-table-wrap ${props.className ?? ''}`} data-testid={`${area}-table`}>
      {toolbarEl}
      <div
        ref={scrollRef}
        className="overflow-auto"
        style={maxHeight !== 'none' ? { maxHeight } : undefined}
        onScroll={onScroll}
        onWheel={releaseScrollTarget}
        onTouchMove={releaseScrollTarget}
        onPointerDown={(e) => {
          if (e.target === e.currentTarget) releaseScrollTarget() // the scrollbar itself
        }}
      >
        <table
          className="ledger-table data-table"
          data-density={density}
          data-virtual={virtual || undefined}
          data-testid={props.tableTestId}
          aria-label={props.ariaLabel}
          aria-rowcount={virtual ? layout.rowIndex[items.length]! + headerRows : undefined}
          style={measuredLayout ? { width: tableWidth } : { minWidth: tableWidth }}
        >
          {bands.length === 0 ? (
            <colgroup>
              {hasExpander && <col style={{ width: EXPANDER_WIDTH }} />}
              {leading && <col style={{ width: leadingWidth }} />}
              {visible.map((c, i) => {
                const w = colWidth(i)
                return <col key={c.id} style={w ? { width: w } : undefined} />
              })}
              {trailing && <col style={{ width: trailingWidth }} />}
            </colgroup>
          ) : (
            // One <colgroup> per header band, so each band's <th scope="colgroup"> names its columns.
            <>
              {prefixCols > 0 && (
                <colgroup>
                  {hasExpander && <col style={{ width: EXPANDER_WIDTH }} />}
                  {leading && <col style={{ width: leadingWidth }} />}
                </colgroup>
              )}
              {bands.map((b) => (
                <colgroup key={`${b.start}:${b.group ?? ''}`} data-band={b.group ?? undefined}>
                  {visible.slice(b.start, b.start + b.span).map((c, k) => {
                    const w = colWidth(b.start + k)
                    return <col key={c.id} style={w ? { width: w } : undefined} />
                  })}
                </colgroup>
              ))}
              {trailing && (
                <colgroup>
                  <col style={{ width: trailingWidth }} />
                </colgroup>
              )}
            </>
          )}
          <thead ref={theadRef}>
            {bands.length > 0 && (
              <tr className="dt-bands" aria-rowindex={virtual ? 1 : undefined} data-testid={`${area}-table-bands`}>
                {prefixCols > 0 && <td colSpan={prefixCols} />}
                {bands.map((b) =>
                  b.group ? (
                    <th
                      key={`${b.start}:${b.group}`}
                      scope="colgroup"
                      colSpan={b.span}
                      className="dt-band"
                      data-band={b.group}
                      data-testid={`${area}-band-${b.ids[0]}`}
                    >
                      {/* Out of flow: a spanning cell's text must not nudge the fixed column
                          widths (Chromium otherwise adds a sub-pixel to one of them). */}
                      <span className="dt-band-label">{b.group}</span>
                    </th>
                  ) : (
                    <td key={`${b.start}:`} colSpan={b.span} />
                  )
                )}
                {trailing && <td />}
              </tr>
            )}
            <tr aria-rowindex={virtual ? headerRows : undefined}>
              {hasExpander && (
                <th>
                  <span className="sr-only">Details</span>
                </th>
              )}
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
                  dragState={
                    drag?.id === c.id ? 'dragging' : drag?.target?.id === c.id ? (drag.target.after ? 'drop-after' : 'drop-before') : null
                  }
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
                  onReorderStart={(e) => startReorder(e, c.id)}
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
            {rows.length === 0 ? (
              // No data at all: the screen's own empty state, under the (still usable) toolbar.
              <tr className="dt-empty" data-empty="no-data">
                <td colSpan={colSpan}>
                  <EmptyState title={empty?.title ?? 'Nothing to show'} hint={empty?.hint} action={empty?.action} icon={empty?.icon} />
                </td>
              </tr>
            ) : items.length === 0 ? (
              // Rows exist, the table's own filters hide them all.
              <tr className="dt-empty" data-empty="filtered">
                <td colSpan={colSpan}>
                  <EmptyState
                    title="No rows match"
                    hint={
                      quick
                        ? `Nothing matches “${quick}” with the current filters`
                        : `None of the ${model.totalCount.toLocaleString('en-IN')} ${model.totalCount === 1 ? 'row matches' : 'rows match'} your filters`
                    }
                    action={
                      hasTableFilters ? (
                        <button
                          type="button"
                          className="text-small text-blue hover:underline"
                          onClick={clearAllFilters}
                          data-testid={`${area}-table-reset-filters`}
                        >
                          Clear filters
                        </button>
                      ) : undefined
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
                renderFooter(footerCtx)
              ) : firstAgg > 0 ? (
                // The label spans every column before the first aggregate (like a group header),
                // so "Closing balance" isn't clipped to a narrow leading Date column.
                <tr className="total-row" data-testid={`${area}-table-totals`}>
                  <td colSpan={labelSpan}>{totalsLabelNode}</td>
                  {visible.slice(firstAgg).map((c) => (
                    <td key={c.id} className={alignCls(columnAlign(c))}>
                      {c.aggregate ? aggregateCell(c, model.totals[c.id]) : null}
                    </td>
                  ))}
                  {trailing && <td />}
                </tr>
              ) : (
                <tr className="total-row" data-testid={`${area}-table-totals`}>
                  {hasExpander && <td />}
                  {leading && <td />}
                  {visible.map((c, i) => (
                    <td key={c.id} className={alignCls(columnAlign(c))}>
                      {c.aggregate
                        ? aggregateCell(c, model.totals[c.id])
                        : i === Math.max(0, visible.findIndex((x) => !x.aggregate))
                          ? totalsLabelNode
                          : null}
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
  dragState,
  renderFilter,
  onSort,
  onReorderStart,
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
  dragState: 'dragging' | 'drop-before' | 'drop-after' | null
  renderFilter: (close: () => void) => ReactNode
  onSort: (multi: boolean) => void
  onReorderStart: (e: React.PointerEvent) => void
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
  const label = columnLabel(col)
  // The funnel overlays the header's padding/label edge instead of reserving width: it shows on
  // hover, on keyboard focus anywhere in the header, and always while a filter is set or open.
  // Only an ACTIVE filter reserves room, so its amber funnel never covers the label.
  const filterSide = align === 'right' ? 'left' : 'right'
  const filterActive = filtered || filterOpen
  return (
    <th
      ref={thRef}
      scope="col"
      aria-sort={ariaSort}
      className={`dt-th group ${alignCls(align)} ${dragState ? `dt-${dragState}` : ''} ${col.headerClassName ?? ''}`}
      onPointerDown={onReorderStart}
      data-col={col.id}
    >
      <div
        className={`flex min-w-0 items-center ${align === 'right' ? 'justify-end' : align === 'center' ? 'justify-center' : ''} ${
          filterable && filtered ? (filterSide === 'left' ? 'pl-3.5' : 'pr-3.5') : ''
        }`}
      >
        {sortable ? (
          <button
            type="button"
            className={`inline-flex min-w-0 items-center gap-1 uppercase hover:text-ink ${sortDir ? 'text-ink' : ''}`}
            onClick={(e) => onSort(e.shiftKey)}
            title={`Sort by ${label} (Shift-click to add a secondary sort; drag to reorder)`}
            data-testid={`sort-${area}-${col.id}`}
          >
            <span className="truncate">{col.header}</span>
            {sortDir && (
              <span aria-hidden="true" className="shrink-0 text-amber">
                {sortDir === 'desc' ? '↓' : '↑'}
                {multiSort && sortIndex >= 0 && <sup className="num ml-px text-micro">{sortIndex + 1}</sup>}
              </span>
            )}
          </button>
        ) : (
          <span className="truncate" title={label}>
            {col.header}
          </span>
        )}
      </div>
      {filterable && (
        <>
          <button
            ref={filterBtn}
            type="button"
            aria-label={`Filter ${label}${filtered ? ' (filtered)' : ''}`}
            aria-haspopup="dialog"
            aria-expanded={filterOpen}
            title={`Filter ${label}`}
            onClick={() => setFilterOpen(!filterOpen)}
            data-testid={`filter-${area}-${col.id}`}
            data-no-drag=""
            data-active={filterActive || undefined}
            className={`dt-filter ${filterSide === 'left' ? 'dt-filter-left' : 'dt-filter-right'} ${
              filterActive ? 'text-amber' : 'text-muted hover:text-ink'
            }`}
          >
            <svg aria-hidden="true" width="10" height="10" viewBox="0 0 10 10" className="block">
              <path d="M0.5 1h9L6 5.2V9L4 8V5.2z" fill="currentColor" />
            </svg>
          </button>
          {filterOpen && (
            <Popover anchor={filterBtn} onClose={() => setFilterOpen(false)} label={`Filter ${label}`} align={align === 'right' ? 'right' : 'left'} width={240}>
              {renderFilter(() => {
                filterBtn.current?.focus()
                setFilterOpen(false)
              })}
            </Popover>
          )}
        </>
      )}
      <span
        role="separator"
        aria-orientation="vertical"
        aria-label={`Resize ${label}`}
        tabIndex={0}
        className="dt-resize"
        data-testid={`resize-${area}-${col.id}`}
        onPointerDown={onResizeStart}
        onDoubleClick={onResizeReset}
        onKeyDown={(e) => {
          if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
            e.preventDefault()
            e.stopPropagation() // not a table ←/→ (expand/collapse)
            onResizeKey(e.key === 'ArrowLeft' ? -16 : 16, thRef.current)
          }
        }}
      />
    </th>
  )
}
