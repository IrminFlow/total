import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api } from '../lib/client'
import { useNav, useSession } from '../state/stores'
import { EmptyState, Money, Panel, SectionTitle } from '../components/ui'
import { toDisplayDate } from '@shared/dates'
import type { ExceptionSection } from '@shared/reports'

function SectionPanel({ section }: { section: ExceptionSection }): React.JSX.Element {
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
        <span className="text-body font-medium">{section.label}</span>
        <span
          className={`num rounded-full px-2.5 py-0.5 text-small ${
            clean ? 'bg-panel2 text-muted' : 'bg-cr/10 text-cr font-semibold'
          }`}
        >
          {section.count === 0 ? 'clean' : section.count}
        </span>
      </button>
      {open && section.rows.length > 0 && (
        <table className="ledger-table mt-2" data-testid={`exceptions-rows-${section.key}`}>
          <tbody>
            {section.rows.map((r, i) => (
              <tr
                key={i}
                className={r.voucherId || r.ledgerId ? 'kbar-row cursor-pointer' : ''}
                onClick={() => {
                  if (r.voucherId) nav.go({ name: 'voucher-entry', voucherId: r.voucherId })
                  else if (r.ledgerId) nav.go({ name: 'ledger-statement', ledgerId: r.ledgerId })
                }}
              >
                <td>{r.label}</td>
                <td className="text-muted">{r.detail}</td>
                <td className="r">{r.amount !== undefined && <Money paise={r.amount} />}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {open && section.count > section.rows.length && (
        <p className="mt-1 px-1 text-hint text-muted">Showing first {section.rows.length} of {section.count}.</p>
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
        right={<span className="num text-small text-muted">{toDisplayDate(from)} → {toDisplayDate(to)}</span>}
      >
        Exception reports
      </SectionTitle>
      {data && total === 0 && (
        <Panel className="mb-3">
          <EmptyState title="No exceptions found" hint="Every check came back clean for this period" />
        </Panel>
      )}
      {data?.sections.map((s) => <SectionPanel key={s.key} section={s} />)}
    </div>
  )
}
