import { useMemo } from 'react'
import { isPeriodDimension, type DimValue, type ReportModel, type ReportResult, type ResultColumnDim, type ResultColumnMeasure } from '@shared/reportBuilder/model'
import { chartSeries, pivotResult, rowKey, variance } from '@shared/reportBuilder/shape'
import { formatPaise, formatPaiseCompact, formatQtyMilli } from '@shared/money'
import { toDisplayDate, toMonthLabel } from '@shared/dates'
import { DataTable, type TableColumn } from '../../components/table'
import { BarChart, LineChart } from '../../components/charts'
import { Banner, Panel } from '../../components/ui'
import { ItemLink, LedgerLink, VoucherLink } from '../../components/links'
import { openLedgerStatement, openVoucher } from '../../lib/drill'
import { useNav } from '../../state/stores'

/** A flat table row: dimension cells + numeric cells by column id. */
interface TableRow {
  key: string
  keys: DimValue[]
  /** Period-dimension key of the row (balance totals take the last bucket). */
  bucket: string | null
  cells: Record<string, number | null>
  others: boolean
}

const numKind = (m: ResultColumnMeasure): 'money' | 'quantity' | 'number' => m.kind

/** Footer total of a closing balance with a date dimension = the last bucket's rows. */
function balanceAware(id: string, isBalance: boolean, hasBucket: boolean): 'sum' | ((rows: TableRow[]) => number) {
  if (!isBalance || !hasBucket) return 'sum'
  return (rows) => {
    const last = rows.reduce<string | null>((m, r) => (r.bucket !== null && (m === null || r.bucket > m) ? r.bucket : m), null)
    return rows.filter((r) => r.bucket === last).reduce((s, r) => s + (r.cells[id] ?? 0), 0)
  }
}

function DimCell({ dim, v }: { dim: ResultColumnDim; v: DimValue }): React.JSX.Element {
  const id = typeof v.id === 'number' ? v.id : null
  if (dim.link === 'ledger' && id) return <LedgerLink ledgerId={id} name={v.label} />
  if (dim.link === 'item' && id) return <ItemLink itemId={id} name={v.label} />
  if (dim.link === 'voucher' && id) return <VoucherLink voucherId={id} label={v.label} />
  return <span className={v.id === null ? 'text-muted' : undefined}>{v.label}</span>
}

function dimColumns(dims: ResultColumnDim[], offset = 0): TableColumn<TableRow>[] {
  return dims.map((d, i) => ({
    id: `d${i + offset}`,
    header: d.label,
    kind: d.key === 'day' ? 'date' : 'text',
    value: (r: TableRow) => (d.key === 'day' ? (typeof r.keys[i]!.id === 'string' ? (r.keys[i]!.id as string) : null) : r.keys[i]!.label),
    text: (r: TableRow) => (d.key === 'day' && typeof r.keys[i]!.id === 'string' ? toDisplayDate(r.keys[i]!.id as string) : r.keys[i]!.label),
    cell: (r: TableRow) => <DimCell dim={d} v={r.keys[i]!} />,
    hideable: i !== 0,
    minWidth: 140,
    // Date buckets sort chronologically by their key, not their label.
    ...(isPeriodDimension(d.key) && d.key !== 'day' ? { groupKey: (r: TableRow) => String(r.keys[i]!.id ?? '') } : {})
  }))
}

/** Builds DataTable columns + rows for a result (pivoted or flat, with comparative columns). */
export function useResultTable(result: ReportResult | undefined, model: ReportModel): { columns: TableColumn<TableRow>[]; rows: TableRow[] } {
  return useMemo(() => {
    if (!result) return { columns: [], rows: [] }
    const pi = result.dims.findIndex((d) => isPeriodDimension(d.key))
    if (model.pivot && result.dims.some((d) => d.key === model.pivot)) {
      const p = pivotResult(result, model.pivot)
      const pivotIsDate = isPeriodDimension(model.pivot)
      const columns: TableColumn<TableRow>[] = [...dimColumns(p.rowDims)]
      p.columns.forEach((c, ci) =>
        p.measures.forEach((m, mi) => {
          const id = `p${ci}_${mi}`
          columns.push({
            id,
            header: p.measures.length > 1 ? `${c.label} · ${m.label}` : c.label,
            kind: numKind(m),
            signed: m.signed,
            value: (r) => r.cells[id] ?? null,
            aggregate: 'sum',
            width: 132
          })
        })
      )
      p.measures.forEach((m, mi) =>
        columns.push({
          id: `t${mi}`,
          header: p.measures.length > 1 ? `Total · ${m.label}` : m.key === 'balance' && pivotIsDate ? 'Closing' : 'Total',
          kind: numKind(m),
          signed: m.signed,
          value: (r) => r.cells[`t${mi}`] ?? null,
          aggregate: 'sum',
          className: 'font-medium',
          width: 140
        })
      )
      const rows: TableRow[] = p.rows.map((r) => {
        const cells: Record<string, number | null> = {}
        r.cells.forEach((c, ci) => c.forEach((v, mi) => { cells[`p${ci}_${mi}`] = v }))
        r.total.forEach((v, mi) => { cells[`t${mi}`] = v })
        return { key: rowKey(r.keys), keys: r.keys, bucket: null, cells, others: false }
      })
      return { columns, rows }
    }

    const columns: TableColumn<TableRow>[] = [...dimColumns(result.dims)]
    const cmp = result.compare
    result.measures.forEach((m, mi) => {
      const isBal = m.key === 'balance'
      columns.push({ id: `m${mi}`, header: m.label, kind: numKind(m), signed: m.signed, value: (r) => r.cells[`m${mi}`] ?? null, aggregate: balanceAware(`m${mi}`, isBal, pi >= 0), width: 150 })
      if (cmp) {
        columns.push({ id: `c${mi}`, header: cmp.kind === 'budget' ? 'Budget' : cmp.label, group: m.label, kind: numKind(m), signed: m.signed, value: (r) => r.cells[`c${mi}`] ?? null, aggregate: balanceAware(`c${mi}`, isBal, pi >= 0), width: 140, className: 'text-muted', defaultHidden: cmp.kind === 'budget' && mi > 0 })
        columns.push({ id: `v${mi}`, header: 'Change', group: m.label, kind: numKind(m), value: (r) => r.cells[`v${mi}`] ?? null, aggregate: balanceAware(`v${mi}`, isBal, pi >= 0), width: 130, defaultHidden: cmp.kind === 'budget' && mi > 0 })
        columns.push({
          id: `x${mi}`, header: 'Change %', group: m.label, kind: 'number',
          value: (r) => r.cells[`x${mi}`] ?? null,
          text: (r) => { const v = r.cells[`x${mi}`]; return v === null || v === undefined ? '' : `${v > 0 ? '+' : ''}${v.toFixed(1)}%` },
          width: 96, defaultHidden: cmp.kind === 'budget' && mi > 0
        })
      }
    })
    const rows: TableRow[] = result.rows.map((r) => {
      const cells: Record<string, number | null> = {}
      r.values.forEach((v, mi) => {
        cells[`m${mi}`] = v
        if (cmp) {
          const c = r.compare?.[mi] ?? null
          const va = variance(v, c)
          cells[`c${mi}`] = c
          cells[`v${mi}`] = va.abs
          cells[`x${mi}`] = va.pct
        }
      })
      return { key: rowKey(r.keys), keys: r.keys, bucket: pi >= 0 ? String(r.keys[pi]!.id ?? '') : null, cells, others: r.keys.every((k) => k.id === null) && /^All others/.test(r.keys[0]?.label ?? '') }
    })
    return { columns, rows }
  }, [result, model.pivot])
}

export function ResultView({
  result,
  model,
  loading,
  title,
  periodLabel
}: {
  result: ReportResult | undefined
  model: ReportModel
  loading: boolean
  title: string
  periodLabel: string
}): React.JSX.Element {
  const pivoted = !!model.pivot && !!result?.dims.some((d) => d.key === model.pivot)
  const { columns, rows } = useResultTable(result, model)
  // Pivoted rows carry only the row dimensions — resolve links against those.
  const rowDims = useMemo(() => (result ? (pivoted ? result.dims.filter((d) => d.key !== model.pivot) : result.dims) : []), [result, pivoted, model.pivot])
  const nav = useNav()
  // What a row opens: its voucher, else its ledger / party, else its item, else its month.
  const activate = useMemo(() => {
    if (!result) return undefined
    return (r: TableRow) => {
      const find = (link: string): DimValue | undefined => {
        const i = rowDims.findIndex((d) => d.link === link)
        return i >= 0 ? r.keys[i] : undefined
      }
      const v = find('voucher')
      if (v && typeof v.id === 'number') return openVoucher(v.id)
      const l = find('ledger')
      if (l && typeof l.id === 'number') return openLedgerStatement(l.id)
      const it = find('item')
      if (it && typeof it.id === 'number') return nav.go({ name: 'stock-movements', itemId: it.id })
      const mo = find('month')
      if (mo && typeof mo.id === 'string') return nav.go({ name: 'daybook', month: mo.id })
    }
  }, [result, rowDims, nav])

  const chart = useMemo(() => (result && model.chart !== 'none' ? chartSeries(result) : null), [result, model.chart])
  const first = result?.measures[0]
  // Money charts use the default rupee formatting; quantities and counts get their own.
  const fmt = first?.kind === 'quantity'
    ? { formatValue: (v: number) => formatQtyMilli(v), formatTick: (v: number) => formatQtyMilli(Math.round(v)) }
    : first?.kind === 'number'
      ? { formatValue: (v: number) => String(v), formatTick: (v: number) => String(Math.round(v)) }
      : { formatValue: (v: number) => formatPaise(v, { symbol: true }), formatTick: formatPaiseCompact }
  const fmtTotal = (vals: number[]): string => fmt.formatValue(vals.reduce((s, v) => s + v, 0))

  return (
    <div className="flex min-w-0 flex-col gap-3">
      {result?.warnings.map((w) => (
        <Banner key={w} tone="warning" testId="rb-warning">{w}</Banner>
      ))}
      {chart && first && chart.categories.length > 1 && (
        <Panel className="p-4" testId="rb-chart-panel">
          {model.chart === 'line' ? (
            <LineChart
              title={`${first.label} by ${result!.dims.find((d) => isPeriodDimension(d.key))?.label ?? result!.dims[0]!.label}`}
              summary={`${first.label}: ${chart.categories.length} points, total ${fmtTotal(chart.values)}`}
              categories={chart.categories.map((c) => ({ key: c.key, label: shortLabel(c), long: c.label }))}
              series={[
                { id: 'current', label: first.label, color: 'blue', values: chart.values },
                ...(chart.compare ? [{ id: 'compare', label: result!.compare!.label, color: 'muted' as const, values: chart.compare }] : [])
              ]}
              testId="rb-chart"
              {...fmt}
            />
          ) : (
            <BarChart
              title={`${first.label} by ${result!.dims.find((d) => isPeriodDimension(d.key))?.label ?? result!.dims[0]!.label}`}
              summary={`${first.label}: ${chart.categories.length} bars, total ${fmtTotal(chart.values)}`}
              categories={chart.categories.map((c) => ({ key: c.key, label: shortLabel(c), long: c.label }))}
              series={[
                { id: 'current', label: first.label, color: 'blue', values: chart.values },
                ...(chart.compare ? [{ id: 'compare', label: result!.compare!.label, color: 'amber' as const, values: chart.compare }] : [])
              ]}
              testId="rb-chart"
              {...fmt}
            />
          )}
        </Panel>
      )}
      <Panel>
        <DataTable
          testId="report-builder"
          ariaLabel={title}
          columns={columns}
          rows={rows}
          rowKey={(r) => r.key}
          loading={loading && !result}
          empty={{ title: 'Nothing to show', hint: 'No entries match this report in the period — widen the period or loosen the filters.' }}
          onRowActivate={activate}
          isRowActivatable={(r) => !r.others && rowDims.some((d, i) => d.link !== null && r.keys[i]?.id !== null)}
          rowAttrs={(r) => ({ 'data-row-key': r.key })}
          exportOptions={{ title, periodLabel, filename: slug(title) }}
          totalsLabel="Total"
          maxHeight="calc(100vh - 300px)"
        />
      </Panel>
    </div>
  )
}

function shortLabel(c: { key: string; label: string }): string {
  if (/^\d{4}-\d{2}$/.test(c.key)) return toMonthLabel(c.key)
  return c.label.length > 12 ? `${c.label.slice(0, 11)}…` : c.label
}

const slug = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'report'
