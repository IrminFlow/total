import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api } from '../lib/client'
import { useNav, useSession } from '../state/stores'
import { DrawerSection, EmptyState, Page, PageHeader, Panel, SkeletonRows } from '../components/ui'
import { OptionToggle, OptionsPeriod, useScreenOptions } from '../components/ScreenOptions'
import { DataTable, defineColumns } from '../components/table'
import { toDisplayDate } from '@shared/dates'
import type { ExceptionRow, ExceptionSection } from '@shared/reports'
import { ItemLink, LedgerLink, VoucherLink } from '../components/links'

/** The row's own record, by kind: a voucher's "Type No." opens the voucher, a ledger's name its
 *  edit window, a stock item's name its editor. */
function LabelCell({ row }: { row: ExceptionRow }): React.JSX.Element {
  if (row.voucherId) return <VoucherLink voucherId={row.voucherId} label={row.label} />
  if (row.ledgerId) return <LedgerLink ledgerId={row.ledgerId} name={row.label} />
  if (row.stockItemId) return <ItemLink itemId={row.stockItemId} name={row.label} />
  return <>{row.label}</>
}

const COLUMNS = defineColumns<ExceptionRow>([
  { id: 'label', header: 'Item', kind: 'text', value: (r) => r.label, hideable: false, cell: (r) => <LabelCell row={r} /> },
  { id: 'detail', header: 'Detail', kind: 'text', value: (r) => r.detail, className: 'text-muted' },
  // Not every check carries an amount — rows without one show a blank cell (and sort last).
  { id: 'amount', header: 'Amount', kind: 'money', value: (r) => r.amount, width: 150 }
])

function SectionPanel({ section, periodLabel, expandAll }: { section: ExceptionSection; periodLabel: string; expandAll: boolean }): React.JSX.Element {
  const nav = useNav()
  const [open, setOpen] = useState(section.count > 0 && (expandAll || section.count <= 8))
  const clean = section.count === 0
  return (
    <Panel className="mb-3">
      <button
        type="button"
        className="flex w-full items-center justify-between px-panel py-2.5 text-left hover:bg-panel2 disabled:hover:bg-transparent"
        data-testid={`exceptions-toggle-${section.key}`}
        aria-expanded={clean ? undefined : open}
        onClick={() => setOpen((v) => !v)}
        disabled={clean}
      >
        <span className="text-body font-medium">
          {!clean && (
            <span aria-hidden="true" className="mr-1.5 inline-block w-3 text-micro text-muted">
              {open ? '▾' : '▸'}
            </span>
          )}
          {section.label}
        </span>
        <span
          className={`num rounded-full px-2.5 py-0.5 text-small ${
            clean ? 'bg-panel2 text-muted' : 'bg-danger-soft font-semibold text-danger'
          }`}
        >
          {section.count === 0 ? 'clean' : section.count}
        </span>
      </button>
      {open && section.rows.length > 0 && (
        <div className="border-t border-line">
          <DataTable
            viewId={`exceptions-${section.key}`}
            testId={`exceptions-${section.key}`}
            tableTestId={`exceptions-rows-${section.key}`}
            ariaLabel={section.label}
            columns={COLUMNS}
            rows={section.rows}
            maxHeight="60vh"
            isRowActivatable={(r) => !!(r.voucherId || r.ledgerId)}
            rowAttrs={(r) => ({ 'data-row-id': r.voucherId ?? r.ledgerId })}
            onRowActivate={(r) => {
              if (r.voucherId) nav.go({ name: 'voucher-entry', voucherId: r.voucherId })
              else if (r.ledgerId) nav.go({ name: 'ledger-statement', ledgerId: r.ledgerId })
            }}
            exportOptions={{ title: `Exceptions — ${section.label}`, periodLabel, filename: `exceptions-${section.key}` }}
          />
        </div>
      )}
      {open && section.count > section.rows.length && (
        <p className="border-t border-line px-panel py-1.5 text-hint text-muted">Showing first {section.rows.length} of {section.count}.</p>
      )}
    </Panel>
  )
}

export function ExceptionsScreen(): React.JSX.Element {
  const { from, to } = useSession()
  const { data, isLoading } = useQuery({ queryKey: ['exceptions', from, to], queryFn: () => api.reports.exceptions(from, to) })
  const total = data?.sections.reduce((s, x) => s + x.count, 0) ?? 0
  const opts = useScreenOptions('exceptions', { hideClean: false, expandAll: false })
  const sections = (data?.sections ?? []).filter((s) => !opts.options.hideClean || s.count > 0)
  const periodLabel = `${toDisplayDate(from)} → ${toDisplayDate(to)}`

  return (
    <Page>
      <PageHeader
        title="Exception reports"
        period={periodLabel}
        subtitle={data ? (total === 0 ? 'all clean' : `${total} to review`) : undefined}
        options={{
          onReset: opts.reset,
          content: (
            <>
              <OptionsPeriod />
              <DrawerSection title="Display">
                <OptionToggle label="Hide checks that came back clean" checked={opts.options.hideClean} onChange={(v) => opts.set('hideClean', v)} testId="input-exceptions-hide-clean" />
                <OptionToggle
                  label="Open every check with findings"
                  hint="Default opens checks with 8 findings or fewer."
                  checked={opts.options.expandAll}
                  onChange={(v) => opts.set('expandAll', v)}
                  testId="input-exceptions-expand-all"
                />
              </DrawerSection>
            </>
          )
        }}
      />
      {isLoading && (
        <Panel>
          <SkeletonRows rows={6} />
        </Panel>
      )}
      {data && total === 0 && (
        <Panel className="mb-3">
          <EmptyState title="No exceptions found" hint="Every check came back clean for this period" />
        </Panel>
      )}
      {sections.map((s) => (
        <SectionPanel key={`${s.key}-${opts.options.expandAll}`} section={s} expandAll={opts.options.expandAll} periodLabel={`${toDisplayDate(from)} to ${toDisplayDate(to)}`} />
      ))}
    </Page>
  )
}
