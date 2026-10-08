import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api } from '../lib/client'
import { useNav, useSession, useToasts } from '../state/stores'
import { Banner, Button, EmptyState, Money, Page, PageHeader, Panel, ScrollList, SkeletonRows, TabBar } from '../components/ui'
import { OptionsPeriod, OptionsTable } from '../components/ScreenOptions'
import { DataTable, defineColumns, type TableColumn } from '../components/table'
import type { ConsolidatedRow } from '@shared/consolidate'
import { toDisplayDate } from '@shared/dates'
import { LedgerLink } from '../components/links'
import { isRealId, openLedgerStatement } from '../lib/drill'

type Kind = 'tb' | 'pnl'

const signedOrDash = (v: number | null | undefined): React.JSX.Element =>
  v == null ? <span className="text-muted">—</span> : <Money paise={v} signed />

/** Name, group, one signed (dr-positive) column per company, then the row total. The cells are
 *  closing balances, so there is no footer sum. */
/** The open company's own ledger id for a row, or null. `openIndex` is the open company's column
 *  (-1 when it isn't part of the run) — ids of other companies mean nothing in this one's books. */
export function openCompanyLedgerId(r: ConsolidatedRow, openIndex: number): number | null {
  const id = openIndex >= 0 ? (r.ledgerIds?.[openIndex] ?? null) : null
  return isRealId(id) ? id : null
}

export function consolidatedColumns(companies: string[], openIndex = -1): TableColumn<ConsolidatedRow>[] {
  return defineColumns<ConsolidatedRow>([
    {
      id: 'name',
      header: 'Name',
      kind: 'text',
      value: (r) => r.name,
      hideable: false,
      groupable: false,
      minWidth: 180,
      // Links only for ledgers of the company that is open here; other companies' rows stay text.
      cell: (r) => <LedgerLink ledgerId={openCompanyLedgerId(r, openIndex)} name={r.name} />
    },
    { id: 'group', header: 'Group', kind: 'text', value: (r) => r.group, className: 'text-muted', minWidth: 140 },
    ...companies.map((company, i) => ({
      id: `co:${company}`,
      header: company,
      kind: 'money' as const,
      signed: true,
      value: (r: ConsolidatedRow) => r.perCompany[i],
      cell: (r: ConsolidatedRow) => signedOrDash(r.perCompany[i]),
      width: 150
    })),
    { id: 'total', header: 'Total', kind: 'money', signed: true, value: (r) => r.total, width: 160 }
  ])
}

export function ConsolidatedScreen(): React.JSX.Element {
  const { from, to, slug: openSlug } = useSession()
  const toast = useToasts()
  const nav = useNav()
  const { data: registry } = useQuery({ queryKey: ['company-registry'], queryFn: api.company.list })
  const companies = registry?.companies ?? []

  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [kind, setKind] = useState<Kind>('tb')
  const [ranOnce, setRanOnce] = useState(false)

  const slugs = useMemo(() => companies.map((c) => c.slug).filter((s) => selected.has(s)), [companies, selected])

  const { data, error, refetch, isFetching } = useQuery({
    queryKey: ['consolidated', slugs, kind, from, to],
    queryFn: () => api.consolidated.run(slugs, kind, from, to),
    enabled: false
  })

  const toggle = (slug: string): void => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(slug)) next.delete(slug)
      else next.add(slug)
      return next
    })
  }

  const run = async (): Promise<void> => {
    if (slugs.length === 0) {
      toast.push('error', 'Select at least one company')
      return
    }
    setRanOnce(true)
    // refetch() never throws — it resolves with the failure inside the result — so surface
    // the error from the query result (and it stays rendered below via `error`).
    const result = await refetch()
    if (result.error) toast.push('error', result.error.message)
  }

  // The result's columns follow `slugs` order (the query is keyed on it, so `data` always
  // matches the current selection); only the open company's ledger ids drill from here.
  const openIndex = openSlug ? slugs.indexOf(openSlug) : -1
  const columns = useMemo(() => consolidatedColumns(data?.columns ?? [], openIndex), [data, openIndex])

  return (
    <Page>
      <PageHeader
        title="Consolidated reports"
        subtitle="Quick combined view by ledger name — no inter-company eliminations"
        secondary={<Button size="sm" variant="ghost" data-testid="btn-consolidated-groups" onClick={() => nav.go({ name: 'consolidation' })}>Group consolidation</Button>}
        period={`${toDisplayDate(from)} → ${toDisplayDate(to)}`}
        tabs={
          <TabBar
            screen="consolidated"
            label="Report"
            tabs={[
              { id: 'tb', label: 'Trial balance' },
              { id: 'pnl', label: 'Profit & loss' }
            ]}
            active={kind}
            onSelect={setKind}
          />
        }
        options={{
          content: (
            <>
              <OptionsPeriod />
              {data ? (
                <OptionsTable area="consolidated" />
              ) : (
                <p className="text-hint text-muted">Run a consolidation to choose its columns or export it.</p>
              )}
            </>
          )
        }}
      />

      <Panel className="mb-4">
        <div className="p-panel">
          {companies.length === 0 ? (
            <EmptyState title="No companies yet" hint="Create at least one company to consolidate" />
          ) : (
            <ScrollList maxH="40vh" className="flex flex-col gap-1.5">
              {companies.map((c) => (
                <label key={c.slug} className="flex items-center gap-2 text-detail">
                  <input
                    type="checkbox"
                    data-testid={`check-consolidated-${c.slug}`}
                    checked={selected.has(c.slug)}
                    onChange={() => toggle(c.slug)}
                  />
                  {c.name}
                  <span className="num text-caption text-muted">{c.slug}</span>
                </label>
              ))}
            </ScrollList>
          )}
          <div className="mt-4 flex items-center gap-2">
            <Button data-testid="btn-consolidated-run" variant="primary" onClick={() => void run()} loading={isFetching}>
              {isFetching ? 'Running…' : 'Run'}
            </Button>
            <span className="text-hint text-muted">{selected.size} selected</span>
          </div>
        </div>
      </Panel>

      {ranOnce && error && (
        <Banner tone="danger" className="mb-4">
          Couldn&apos;t run the consolidation: {error.message}
        </Banner>
      )}

      {data && data.warnings.length > 0 && (
        <Banner tone="warning" className="mb-4">
          {data.warnings.map((w, i) => (
            <p key={i}>{w}</p>
          ))}
        </Banner>
      )}

      {isFetching && (
        <Panel>
          <SkeletonRows />
        </Panel>
      )}

      {!isFetching && ranOnce && data && (
        <Panel>
          <DataTable
            viewId={`consolidated-${kind}`}
            testId="consolidated"
            ariaLabel={kind === 'tb' ? 'Consolidated trial balance' : 'Consolidated profit and loss'}
            columns={columns}
            rows={data.rows}
            rowKey={(r) => `${r.group}|${r.name}`}
            isRowActivatable={(r) => openCompanyLedgerId(r, openIndex) != null}
            onRowActivate={(r) => openLedgerStatement(openCompanyLedgerId(r, openIndex)!)}
            empty={{ title: 'No balances', hint: 'Nothing to show for the selected companies and period' }}
            exportOptions={{
              title: kind === 'tb' ? 'Consolidated trial balance' : 'Consolidated profit & loss',
              periodLabel: `${toDisplayDate(from)} to ${toDisplayDate(to)}`,
              filename: `consolidated-${kind}`,
              // Signed plain decimals ("-1234.50", dr-positive) so the CSV opens as numbers in a
              // spreadsheet; the PDF keeps the on-screen "1,234.50 Cr".
              csvMoneyFormat: 'plain'
            }}
          />
        </Panel>
      )}
    </Page>
  )
}
