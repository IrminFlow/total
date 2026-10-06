import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api } from '../lib/client'
import { useNav, useSession } from '../state/stores'
import { EmptyState, Panel, SectionTitle } from '../components/ui'
import { DataTable, defineColumns } from '../components/table'
import { toDisplayDate } from '@shared/dates'
import type { ExceptionRow, ExceptionSection } from '@shared/reports'

const COLUMNS = defineColumns<ExceptionRow>([
  { id: 'label', header: 'Item', kind: 'text', value: (r) => r.label, hideable: false },
  { id: 'detail', header: 'Detail', kind: 'text', value: (r) => r.detail, className: 'text-muted' },
  // Not every check carries an amount — rows without one show a blank cell (and sort last).
  { id: 'amount', header: 'Amount', kind: 'money', value: (r) => r.amount, width: 150 }
])

function SectionPanel({ section, periodLabel }: { section: ExceptionSection; periodLabel: string }): React.JSX.Element {
  const nav = useNav()
  const [open, setOpen] = useState(section.count > 0 && section.count <= 8)
  const clean = section.count === 0
  return (
    <Panel className="mb-3">
      <button
        className="flex w-full items-center justify-between px-1 py-0.5 text-left"
        data-testid={`exceptions-toggle-${section.key}`}
        onClick={() => setOpen((v) => !v)}
        disabled={clean}
      >
        <span className="text-[13.5px] font-medium">{section.label}</span>
        <span
          className={`num rounded-full px-2.5 py-0.5 text-[12px] ${
            clean ? 'bg-panel2 text-muted' : 'bg-cr/10 text-cr font-semibold'
          }`}
        >
          {section.count === 0 ? 'clean' : section.count}
        </span>
      </button>
      {open && section.rows.length > 0 && (
        <div className="mt-2">
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
        <p className="mt-1 px-1 text-[11.5px] text-muted">Showing first {section.rows.length} of {section.count}.</p>
      )}
    </Panel>
  )
}

export function ExceptionsScreen(): React.JSX.Element {
  const { from, to } = useSession()
  const { data } = useQuery({ queryKey: ['exceptions', from, to], queryFn: () => api.reports.exceptions(from, to) })
  const total = data?.sections.reduce((s, x) => s + x.count, 0) ?? 0

  return (
    <div className="mx-auto max-w-4xl">
      <SectionTitle
        right={<span className="num text-[12px] text-muted">{toDisplayDate(from)} → {toDisplayDate(to)}</span>}
      >
        Exception reports
      </SectionTitle>
      {data && total === 0 && (
        <Panel className="mb-3">
          <EmptyState title="No exceptions found" hint="Every check came back clean for this period" />
        </Panel>
      )}
      {data?.sections.map((s) => (
        <SectionPanel key={s.key} section={s} periodLabel={`${toDisplayDate(from)} to ${toDisplayDate(to)}`} />
      ))}
    </div>
  )
}
