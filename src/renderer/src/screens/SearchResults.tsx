import { useEffect, useMemo, useRef, useState } from 'react'
import { useInfiniteQuery, useQuery } from '@tanstack/react-query'
import { api } from '../lib/client'
import { useSession } from '../state/stores'
import { Button, EmptyState, Kbd, Money, Panel, SectionTitle, SkeletonRows, TextInput, useKeyNav } from '../components/ui'
import { TabBar } from '../components/TabBar'
import {
  Highlight,
  KIND_TITLE,
  QueryChips,
  SYNTAX_HINTS,
  VoucherBadges,
  matchHint,
  recentRecordFor,
  useOpenRecord
} from '../components/SearchParts'
import { rememberQuery } from '../lib/searchRecents'
import { isEmptyQuery, parseSearchQuery, removeToken, type SearchKind } from '@shared/searchQuery'
import type { ItemResult, LedgerResult, SearchResponse, SearchResult, SearchSection, VoucherResult } from '@shared/search'
import { fyOf, todayISO, toDisplayDate } from '@shared/dates'

/** Window event App.tsx fires on ⌘⇧F while this screen is already open — refocus the query box. */
export const FOCUS_SEARCH_EVENT = 'total:focus-search'

/** Rows per "Load more" page on a single-kind tab. */
const PAGE = 50
/** Rows per kind on the All tab (same as the palette). */
const OVERVIEW = 20

type Tab = 'all' | SearchKind
const KINDS: SearchKind[] = ['ledger', 'item', 'voucher']
const SECTION_KEY: Record<SearchKind, 'ledgers' | 'items' | 'vouchers'> = { ledger: 'ledgers', item: 'items', voucher: 'vouchers' }

function useSearchContext(): { today: string; fyStartYear: number } {
  const from = useSession((s) => s.from)
  return useMemo(() => ({ today: todayISO(), fyStartYear: fyOf(from).startYear }), [from])
}

export function SearchResultsScreen({ q = '', kind }: { q?: string; kind?: SearchKind }): React.JSX.Element {
  const ctx = useSearchContext()
  const [input, setInput] = useState(q)
  const [query, setQuery] = useState(q.trim())
  const [tab, setTab] = useState<Tab>(kind ?? 'all')
  const inputRef = useRef<HTMLInputElement>(null)
  const openRecord = useOpenRecord()

  useEffect(() => {
    const t = setTimeout(() => setQuery(input.trim()), 200)
    return () => clearTimeout(t)
  }, [input])

  useEffect(() => {
    const focus = (): void => inputRef.current?.focus()
    window.addEventListener(FOCUS_SEARCH_EVENT, focus)
    return () => window.removeEventListener(FOCUS_SEARCH_EVENT, focus)
  }, [])

  const parsed = useMemo(() => parseSearchQuery(input, ctx), [input, ctx])
  const enabled = !isEmptyQuery(parseSearchQuery(query, ctx))

  const overview = useQuery({
    queryKey: ['searchResults', query, ctx.today, ctx.fyStartYear, 'overview'],
    queryFn: () => api.search.query({ q: query, ...ctx, limitPerKind: OVERVIEW }),
    enabled,
    placeholderData: (prev) => prev
  })

  const paged = useInfiniteQuery({
    queryKey: ['searchResults', query, ctx.today, ctx.fyStartYear, tab],
    queryFn: ({ pageParam }) =>
      api.search.query({ q: query, ...ctx, kind: tab as SearchKind, limitPerKind: PAGE, offset: pageParam }),
    initialPageParam: 0,
    getNextPageParam: (last: SearchResponse, all: SearchResponse[]) => {
      const sec = last[SECTION_KEY[tab as SearchKind]]
      const loaded = all.reduce((n, p) => n + (p[SECTION_KEY[tab as SearchKind]]?.rows.length ?? 0), 0)
      return sec && loaded < sec.total ? loaded : undefined
    },
    enabled: enabled && tab !== 'all'
  })

  const data = enabled ? overview.data : undefined
  const totals: Record<SearchKind, number> = {
    ledger: data?.ledgers?.total ?? 0,
    item: data?.items?.total ?? 0,
    voucher: data?.vouchers?.total ?? 0
  }
  const grand = totals.ledger + totals.item + totals.voucher
  const terms = data?.terms ?? parsed.terms.map((t) => t.text)

  // Flattened, keyboard-navigable rows for the visible tab.
  const rows = useMemo<SearchResult[]>(() => {
    if (!enabled) return []
    if (tab === 'all') {
      if (!data) return []
      return [...(data.ledgers?.rows ?? []), ...(data.items?.rows ?? []), ...(data.vouchers?.rows ?? [])]
    }
    return (paged.data?.pages ?? []).flatMap((p) => (p[SECTION_KEY[tab]]?.rows ?? []) as SearchResult[])
  }, [enabled, tab, data, paged.data])

  const open = (r: SearchResult | undefined): void => {
    if (!r) return
    openRecord(r.kind, recentRecordFor(r), query)
  }
  const { active, setActive } = useKeyNav(rows.length, (i) => open(rows[i]))
  useEffect(() => setActive(0), [tab, query, setActive])

  const tabs = [
    { id: 'all' as Tab, label: enabled && data ? `All · ${grand}` : 'All' },
    ...KINDS.map((k) => ({ id: k as Tab, label: enabled && data ? `${KIND_TITLE[k]} · ${totals[k]}` : KIND_TITLE[k] }))
  ]

  const appendToken = (token: string): void => {
    setInput((v) => (v.trim() ? `${v.trim()} ${token}` : token))
    inputRef.current?.focus()
  }

  let offset = 0
  const sectionStart = (k: SearchKind): number => {
    const start = offset
    offset += data?.[SECTION_KEY[k]]?.rows.length ?? 0
    return start
  }

  return (
    <div className="mx-auto max-w-5xl">
      <SectionTitle right={<span className="text-[12px] text-muted"><Kbd>⌘⇧F</Kbd> from anywhere</span>}>Search</SectionTitle>
      <div className="mb-3 flex flex-col gap-2">
        <TextInput
          ref={inputRef}
          autoFocus={!q}
          data-testid="input-search"
          value={input}
          placeholder="Ledgers, items, vouchers — try amt:>50000, date:apr, gstin:27…, type:sales"
          className="py-2 text-[14px]"
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown' || e.key === 'Enter') {
              // Hand the keyboard to the result list (useKeyNav ignores keys aimed at inputs).
              e.preventDefault()
              setQuery(input.trim())
              if (input.trim().length >= 2) rememberQuery(useSession.getState().slug, input.trim())
              e.currentTarget.blur()
            }
          }}
        />
        <QueryChips chips={parsed.chips} unknown={parsed.unknown} onRemove={(raw) => setInput(removeToken(input, raw))} />
      </div>
      <TabBar screen="search" tabs={tabs} active={tab} onSelect={setTab} className="mb-3" />

      {!enabled ? (
        <SyntaxHelp onPick={appendToken} />
      ) : !data ? (
        <Panel>
          <SkeletonRows rows={6} />
        </Panel>
      ) : tab === 'all' ? (
        grand === 0 ? (
          <Panel>
            <EmptyState title="No matches in the books" hint="Deleted vouchers are in Settings › Bin and are not searched" />
          </Panel>
        ) : (
          <div className="flex flex-col gap-4">
            {KINDS.filter((k) => totals[k] > 0).map((k) => {
              const start = sectionStart(k)
              const sec = data[SECTION_KEY[k]] as SearchSection<SearchResult>
              return (
                <Panel key={k}>
                  <div className="flex items-center justify-between border-b border-line px-4 py-2">
                    <p className="text-[11px] font-semibold tracking-[0.08em] text-muted uppercase">
                      {KIND_TITLE[k]} <span className="num font-normal normal-case tracking-normal">· showing {sec.rows.length} of {sec.total}</span>
                    </p>
                    {sec.total > sec.rows.length && (
                      <button
                        data-testid={`btn-search-show-all-${k}`}
                        className="text-[12px] text-blue hover:underline"
                        onClick={() => setTab(k)}
                      >
                        See all {sec.total}
                      </button>
                    )}
                  </div>
                  <ResultTable kind={k} rows={sec.rows} start={start} active={active} terms={terms} onHover={setActive} onOpen={open} />
                </Panel>
              )
            })}
          </div>
        )
      ) : (
        <KindTab
          kind={tab}
          rows={rows}
          total={totals[tab]}
          loading={paged.isLoading}
          hasMore={!!paged.hasNextPage}
          loadingMore={paged.isFetchingNextPage}
          onMore={() => void paged.fetchNextPage()}
          active={active}
          terms={terms}
          onHover={setActive}
          onOpen={open}
        />
      )}
    </div>
  )
}

function KindTab({
  kind, rows, total, loading, hasMore, loadingMore, onMore, active, terms, onHover, onOpen
}: {
  kind: SearchKind
  rows: SearchResult[]
  total: number
  loading: boolean
  hasMore: boolean
  loadingMore: boolean
  onMore: () => void
  active: number
  terms: string[]
  onHover: (i: number) => void
  onOpen: (r: SearchResult) => void
}): React.JSX.Element {
  if (loading) return <Panel><SkeletonRows rows={8} /></Panel>
  if (rows.length === 0) return <Panel><EmptyState title={`No ${KIND_TITLE[kind].toLowerCase()} match`} /></Panel>
  return (
    <Panel>
      <ResultTable kind={kind} rows={rows} start={0} active={active} terms={terms} onHover={onHover} onOpen={onOpen} />
      <div className="flex items-center justify-between border-t border-line px-4 py-2 text-[12px] text-muted">
        <span className="num">Showing {rows.length} of {total}</span>
        {hasMore && (
          <Button data-testid="btn-search-load-more" onClick={onMore} disabled={loadingMore}>
            {loadingMore ? 'Loading…' : 'Load more'}
          </Button>
        )}
      </div>
    </Panel>
  )
}

function ResultTable({
  kind, rows, start, active, terms, onHover, onOpen
}: {
  kind: SearchKind
  rows: SearchResult[]
  /** Index of rows[0] in the screen's flattened keyboard list. */
  start: number
  active: number
  terms: string[]
  onHover: (i: number) => void
  onOpen: (r: SearchResult) => void
}): React.JSX.Element {
  const rowProps = (r: SearchResult, j: number): React.HTMLAttributes<HTMLTableRowElement> & Record<string, unknown> => ({
    'data-active': start + j === active,
    'data-row-id': r.id,
    className: 'kbar-row cursor-pointer',
    onMouseEnter: () => onHover(start + j),
    onClick: () => onOpen(r)
  })
  if (kind === 'ledger') {
    return (
      <table className="ledger-table">
        <thead>
          <tr><th>Ledger</th><th>Group</th><th>GSTIN</th><th>Matched</th></tr>
        </thead>
        <tbody data-testid="rows-search-ledgers">
          {(rows as LedgerResult[]).map((r, j) => (
            <tr key={r.id} {...rowProps(r, j)}>
              <td><Highlight text={r.name} terms={terms} /></td>
              <td className="text-muted">{r.groupName}</td>
              <td className="num text-muted">{r.gstin ? <Highlight text={r.gstin} terms={terms} /> : ''}</td>
              <td className="max-w-64 truncate text-[12px] text-muted">{matchHint(r) && <Highlight text={matchHint(r)!} terms={terms} />}</td>
            </tr>
          ))}
        </tbody>
      </table>
    )
  }
  if (kind === 'item') {
    return (
      <table className="ledger-table">
        <thead>
          <tr><th>Item</th><th>Stock group</th><th className="w-28">HSN</th><th className="w-36">Barcode</th></tr>
        </thead>
        <tbody data-testid="rows-search-items">
          {(rows as ItemResult[]).map((r, j) => (
            <tr key={r.id} {...rowProps(r, j)}>
              <td><Highlight text={r.name} terms={terms} /></td>
              <td className="text-muted">{r.groupName ?? ''}</td>
              <td className="num text-muted">{r.hsn ? <Highlight text={r.hsn} terms={terms} /> : ''}</td>
              <td className="num text-muted">{r.barcode ? <Highlight text={r.barcode} terms={terms} /> : ''}</td>
            </tr>
          ))}
        </tbody>
      </table>
    )
  }
  return (
    <table className="ledger-table">
      <thead>
        <tr>
          <th className="w-28">Date</th><th className="w-28">Type</th><th className="w-28">No.</th><th>Party</th><th>Narration / matched</th>
          <th className="r w-32">Amount</th>
        </tr>
      </thead>
      <tbody data-testid="rows-search-vouchers">
        {(rows as VoucherResult[]).map((r, j) => {
          const hint = matchHint(r)
          return (
            <tr key={r.id} {...rowProps(r, j)}>
              <td className="num whitespace-nowrap text-muted">{toDisplayDate(r.date)}</td>
              <td className="whitespace-nowrap text-muted">{r.typeName}</td>
              <td className="num whitespace-nowrap"><Highlight text={r.number} terms={terms} /></td>
              <td>
                {r.party ? <Highlight text={r.party} terms={terms} /> : <span className="text-muted">–</span>}
                <VoucherBadges v={r} />
              </td>
              <td className="max-w-72 truncate text-[12.5px] text-muted">
                {hint ? <Highlight text={hint} terms={terms} /> : r.narration ? <Highlight text={r.narration} terms={terms} /> : ''}
              </td>
              <td className="r"><Money paise={r.amount} /></td>
            </tr>
          )
        })}
      </tbody>
    </table>
  )
}

function SyntaxHelp({ onPick }: { onPick: (token: string) => void }): React.JSX.Element {
  return (
    <Panel>
      <div className="px-5 py-4" data-testid="search-help">
        <p className="mb-3 text-[13px] text-ink">
          Type any name, number, GSTIN or amount. Add filters to narrow it down — they combine, and the
          ones you type show up as chips.
        </p>
        <div className="grid grid-cols-3 gap-x-6 gap-y-2">
          {SYNTAX_HINTS.map((h) => (
            <button key={h.token} type="button" className="flex items-center justify-between gap-3 text-left" onClick={() => onPick(h.token)}>
              <code className="font-mono text-[12px] text-ink">{h.token}</code>
              <span className="text-[11.5px] text-muted">{h.label}</span>
            </button>
          ))}
        </div>
        <p className="mt-3 text-[11.5px] text-muted">
          Ranges: <code className="font-mono">amt:1000..5000</code>, <code className="font-mono">date:2026-04-01..2026-04-30</code>.
          Also <code className="font-mono">no:</code> <code className="font-mono">pan:</code> <code className="font-mono">hsn:</code>.
          Optional and post-dated vouchers are included and badged; deleted ones never are.
        </p>
      </div>
    </Panel>
  )
}
