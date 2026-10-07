import { useEffect, useMemo, useRef, useState } from 'react'
import { useInfiniteQuery, useQuery } from '@tanstack/react-query'
import { api } from '../lib/client'
import { useSession } from '../state/stores'
import { Button, EmptyState, Kbd, Page, PageHeader, Panel, SkeletonRows, TextInput } from '../components/ui'
import { DataTable, defineColumns, type TableColumn } from '../components/table'
import { TabBar } from '../components/TabBar'
import { Highlight, KIND_TITLE, QueryChips, SYNTAX_HINTS, VoucherBadges, matchHint, recentRecordFor, useOpenRecord } from '../components/SearchParts'
import { rememberQuery } from '../lib/searchRecents'
import { isEmptyQuery, parseSearchQuery, removeToken, type SearchKind } from '@shared/searchQuery'
import type { ItemResult, LedgerResult, SearchResponse, SearchResult, VoucherResult } from '@shared/search'
import { fyOf, todayISO } from '@shared/dates'
import { ItemLink, LedgerLink } from '../components/links'
import { LINKABLE_VOUCHER_KINDS, openLinkedDocs } from '../components/LinkedDocs'
import { useFeatures } from '../lib/useFeatures'

/** Window event App.tsx fires on ⌘⇧F while this screen is already open — refocus the query box. */
export const FOCUS_SEARCH_EVENT = 'total:focus-search'

/** Rows per kind on the All tab (overview; "See all" opens the kind's tab). */
const OVERVIEW = 20
/** Rows per IPC page on a kind tab (the service's max). */
const PAGE = 200
/** Rows a kind tab loads before asking — and the step of each "Load more". */
const LOAD_STEP = 1000

type Tab = 'all' | SearchKind
const KINDS: SearchKind[] = ['ledger', 'item', 'voucher']
const SECTION_KEY: Record<SearchKind, 'ledgers' | 'items' | 'vouchers'> = { ledger: 'ledgers', item: 'items', voucher: 'vouchers' }
const AREA: Record<SearchKind, string> = { ledger: 'search-ledgers', item: 'search-items', voucher: 'search-vouchers' }

/** A result plus its relevance position — the table's input order IS the ranking; the hidden
 *  "Rank" column lets the user sort back to it after sorting by something else. */
type Ranked<T> = T & { rank: number }

// Columns read the free-text terms for highlighting from module state set during render — the
// column arrays must stay module-level (DataTable memoises on their identity).
let highlightTerms: string[] = []
const hl = (text: string | null): React.ReactNode => (text ? <Highlight text={text} terms={highlightTerms} /> : '')

const RANK = { id: 'rank', header: 'Rank', kind: 'number' as const, value: (r: { rank: number }) => r.rank, defaultHidden: true, width: 70, groupable: false }

const LEDGER_COLUMNS = defineColumns<Ranked<LedgerResult>>([
  {
    id: 'name', header: 'Ledger', kind: 'text', value: (r) => r.name, hideable: false,
    // Name → edit window; the rest of the row (or Enter) → statement.
    cell: (r) => <LedgerLink ledgerId={r.id} name={r.name}>{hl(r.name)}</LedgerLink>
  },
  { id: 'group', header: 'Group', kind: 'text', value: (r) => r.groupName, className: 'text-muted' },
  { id: 'gstin', header: 'GSTIN', kind: 'text', value: (r) => r.gstin, cell: (r) => <span className="num text-muted">{hl(r.gstin)}</span>, width: 170 },
  { id: 'pan', header: 'PAN', kind: 'text', value: (r) => r.pan, defaultHidden: true, width: 120 },
  { id: 'matched', header: 'Matched', kind: 'text', value: (r) => matchHint(r), cell: (r) => <span className="text-small text-muted">{hl(matchHint(r))}</span>, groupable: false },
  RANK
])

const ITEM_COLUMNS = defineColumns<Ranked<ItemResult>>([
  { id: 'name', header: 'Item', kind: 'text', value: (r) => r.name, hideable: false, cell: (r) => <ItemLink itemId={r.id} name={r.name}>{hl(r.name)}</ItemLink> },
  { id: 'group', header: 'Stock group', kind: 'text', value: (r) => r.groupName, className: 'text-muted' },
  { id: 'hsn', header: 'HSN', kind: 'text', value: (r) => r.hsn, cell: (r) => <span className="num text-muted">{hl(r.hsn)}</span>, width: 110 },
  { id: 'barcode', header: 'Barcode', kind: 'text', value: (r) => r.barcode, cell: (r) => <span className="num text-muted">{hl(r.barcode)}</span>, width: 150 },
  { id: 'matched', header: 'Matched', kind: 'text', value: (r) => matchHint(r), defaultHidden: true, groupable: false },
  RANK
])

const VOUCHER_COLUMNS = defineColumns<Ranked<VoucherResult>>([
  { id: 'date', header: 'Date', kind: 'date', value: (r) => r.date, className: 'text-muted', width: 110 },
  { id: 'type', header: 'Type', kind: 'text', value: (r) => r.typeName, className: 'text-muted', width: 120 },
  { id: 'number', header: 'No.', kind: 'text', value: (r) => r.number, cell: (r) => <span className="num">{hl(r.number)}</span>, width: 110 },
  {
    id: 'party', header: 'Party', kind: 'text', value: (r) => r.party, hideable: false,
    text: (r) => (r.party ?? '') + (r.isOptional ? ' [Optional]' : '') + (r.postDated ? ' [PDC]' : ''),
    cell: (r) => (
      <>
        {r.party ? <LedgerLink ledgerId={r.partyLedgerId} name={r.party}>{hl(r.party)}</LedgerLink> : <span className="text-muted">–</span>}
        <VoucherBadges v={r} />
      </>
    )
  },
  {
    id: 'narration', header: 'Narration / matched', kind: 'text', value: (r) => matchHint(r) ?? r.narration, groupable: false,
    cell: (r) => <span className="text-body-sm text-muted">{hl(matchHint(r) ?? r.narration)}</span>
  },
  { id: 'amount', header: 'Amount', kind: 'money', value: (r) => r.amount, width: 140 },
  RANK
])

function columnsFor(kind: SearchKind): TableColumn<Ranked<SearchResult>>[] {
  return (kind === 'ledger' ? LEDGER_COLUMNS : kind === 'item' ? ITEM_COLUMNS : VOUCHER_COLUMNS) as unknown as TableColumn<Ranked<SearchResult>>[]
}

const ranked = <T,>(rows: readonly T[], from = 0): Ranked<T>[] => rows.map((r, i) => ({ ...r, rank: from + i + 1 }))

function useSearchContext(): { today: string; fyStartYear: number } {
  const from = useSession((s) => s.from)
  return useMemo(() => ({ today: todayISO(), fyStartYear: fyOf(from).startYear }), [from])
}

/** Give the keyboard to the first results table (DataTable claims it on focus inside its root). */
function focusFirstTable(): void {
  const root = document.querySelector<HTMLElement>('[data-search-results] .data-table-wrap')
  if (!root) return
  root.tabIndex = -1
  root.focus({ preventScroll: true })
}

export function SearchResultsScreen({ q = '', kind }: { q?: string; kind?: SearchKind }): React.JSX.Element {
  const ctx = useSearchContext()
  const [input, setInput] = useState(q)
  const [query, setQuery] = useState(q.trim())
  const [tab, setTab] = useState<Tab>(kind ?? 'all')
  const [cap, setCap] = useState(LOAD_STEP)
  const inputRef = useRef<HTMLInputElement>(null)
  const openRecord = useOpenRecord()

  useEffect(() => {
    const t = setTimeout(() => setQuery(input.trim()), 200)
    return () => clearTimeout(t)
  }, [input])
  useEffect(() => setCap(LOAD_STEP), [query, tab])

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

  const kindKey = tab === 'all' ? null : SECTION_KEY[tab]
  const paged = useInfiniteQuery({
    queryKey: ['searchResults', query, ctx.today, ctx.fyStartYear, tab],
    queryFn: ({ pageParam }) => api.search.query({ q: query, ...ctx, kind: tab as SearchKind, limitPerKind: PAGE, offset: pageParam }),
    initialPageParam: 0,
    getNextPageParam: (last: SearchResponse, all: SearchResponse[]) => {
      const sec = kindKey ? last[kindKey] : null
      const loaded = all.reduce((n, p) => n + (kindKey ? (p[kindKey]?.rows.length ?? 0) : 0), 0)
      return sec && loaded < sec.total ? loaded : undefined
    },
    enabled: enabled && tab !== 'all'
  })

  const kindRows = useMemo(
    () => (kindKey ? ranked((paged.data?.pages ?? []).flatMap((p) => (p[kindKey]?.rows ?? []) as SearchResult[])) : []),
    [paged.data, kindKey]
  )
  // Load pages of 200 in the background up to `cap` rows, so the table sorts and filters a
  // complete result set for any ordinary search; beyond that the user asks for more.
  useEffect(() => {
    if (paged.hasNextPage && !paged.isFetchingNextPage && kindRows.length < cap) void paged.fetchNextPage()
  }, [paged, kindRows.length, cap])

  const data = enabled ? overview.data : undefined
  const totals: Record<SearchKind, number> = {
    ledger: data?.ledgers?.total ?? 0,
    item: data?.items?.total ?? 0,
    voucher: data?.vouchers?.total ?? 0
  }
  const grand = totals.ledger + totals.item + totals.voucher
  highlightTerms = data?.terms ?? parsed.terms.map((t) => t.text)

  const open = (r: SearchResult): void => openRecord(r.kind, recentRecordFor(r), query)
  // WP 2.5d: trade vouchers carry a "Links" action (the linked-documents drawer).
  const ordersOn = useFeatures().orders
  const linksTrailing = (r: SearchResult): React.ReactNode =>
    r.kind === 'voucher' && LINKABLE_VOUCHER_KINDS.has(r.voucherKind) ? (
      <button
        type="button"
        className="text-hint text-blue hover:underline"
        title="Linked documents"
        data-testid="btn-search-links"
        onClick={(e) => {
          e.stopPropagation()
          openLinkedDocs({ voucherId: r.id })
        }}
      >
        Links
      </button>
    ) : null

  const tabs = [
    { id: 'all' as Tab, label: enabled && data ? `All · ${grand}` : 'All' },
    ...KINDS.map((k) => ({ id: k as Tab, label: enabled && data ? `${KIND_TITLE[k]} · ${totals[k]}` : KIND_TITLE[k] }))
  ]

  const appendToken = (token: string): void => {
    setInput((v) => (v.trim() ? `${v.trim()} ${token}` : token))
    inputRef.current?.focus()
  }

  const kindTotal = tab === 'all' ? 0 : totals[tab]
  const loadingMore = paged.isFetching && kindRows.length < Math.min(cap, kindTotal)

  return (
    <Page data-search-results>
      <PageHeader
        title="Search"
        controls={
          <span className="text-small text-muted">
            <Kbd>⌘⇧F</Kbd> from anywhere
          </span>
        }
      />
      <div className="mb-3 flex flex-col gap-2">
        <TextInput
          ref={inputRef}
          autoFocus={!q}
          data-testid="input-search"
          value={input}
          aria-label="Search the books"
          placeholder="Ledgers, items, vouchers — try amt:>50000, date:apr, gstin:27…, type:sales"
          className="py-2 text-lead"
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown' || e.key === 'Enter') {
              // Hand the keyboard to the first results table (tables ignore keys aimed at inputs).
              e.preventDefault()
              setQuery(input.trim())
              if (input.trim().length >= 2) rememberQuery(useSession.getState().slug, input.trim())
              e.currentTarget.blur()
              focusFirstTable()
            }
          }}
        />
        <QueryChips chips={parsed.chips} unknown={parsed.unknown} onRemove={(raw) => setInput(removeToken(input, raw))} />
      </div>
      <TabBar screen="search" label="Result kind" tabs={tabs} active={tab} onSelect={setTab} className="mb-3" />


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
              const sec = data[SECTION_KEY[k]]!
              return (
                <Panel key={k}>
                  <div className="flex items-center justify-between border-b border-line px-4 py-2">
                    <p className="text-caption font-semibold tracking-[0.08em] text-muted uppercase">
                      {KIND_TITLE[k]}{' '}
                      <span className="num font-normal normal-case tracking-normal">· showing {sec.rows.length} of {sec.total}</span>
                    </p>
                    {sec.total > sec.rows.length && (
                      <button data-testid={`btn-search-show-all-${k}`} className="text-small text-blue hover:underline" onClick={() => setTab(k)}>
                        See all {sec.total}
                      </button>
                    )}
                  </div>
                  {/* Overview: relevance order, no toolbar (sorting/export live on the kind tab). */}
                  <DataTable
                    testId={AREA[k]}
                    ariaLabel={KIND_TITLE[k]}
                    columns={columnsFor(k)}
                    rows={ranked(sec.rows as SearchResult[])}
                    rowKey={(r) => r.id}
                    rowAttrs={(r) => ({ 'data-row-id': r.id })}
                    onRowActivate={open}
                    {...(k === 'voucher' && ordersOn ? { trailing: linksTrailing, trailingWidth: 52 } : {})}
                    toolbar={false}
                    maxHeight="none"
                  />
                </Panel>
              )
            })}
          </div>
        )
      ) : (
        <Panel>
          <DataTable
            testId={AREA[tab]}
            ariaLabel={KIND_TITLE[tab]}
            columns={columnsFor(tab)}
            rows={kindRows}
            rowKey={(r) => r.id}
            rowAttrs={(r) => ({ 'data-row-id': r.id })}
            onRowActivate={open}
            {...(tab === 'voucher' && ordersOn ? { trailing: linksTrailing, trailingWidth: 52 } : {})}
            loading={paged.isLoading}
            empty={{ title: `No ${KIND_TITLE[tab].toLowerCase()} match` }}
            exportOptions={{
              title: `Search — ${KIND_TITLE[tab]}`,
              periodLabel: `“${query}”`,
              filename: `search-${SECTION_KEY[tab]}`,
              footNote: kindRows.length < kindTotal ? `First ${kindRows.length} of ${kindTotal} matches, by relevance.` : undefined
            }}
          />
          <div className="flex items-center justify-between border-t border-line px-4 py-2 text-small text-muted">
            <span className="num" data-testid="search-loaded">
              {loadingMore ? `Loading… ${kindRows.length} of ${kindTotal}` : `Loaded ${kindRows.length} of ${kindTotal}`}
              {kindRows.length < kindTotal && !loadingMore && ' · sorting and filters apply to the loaded rows'}
            </span>
            {!loadingMore && kindRows.length < kindTotal && (
              <Button data-testid="btn-search-load-more" onClick={() => setCap((c) => c + LOAD_STEP)}>
                Load {Math.min(LOAD_STEP, kindTotal - kindRows.length).toLocaleString('en-IN')} more
              </Button>
            )}
          </div>
        </Panel>
      )}
    </Page>
  )
}

function SyntaxHelp({ onPick }: { onPick: (token: string) => void }): React.JSX.Element {
  return (
    <Panel>
      <div className="px-5 py-4" data-testid="search-help">
        <p className="mb-3 text-detail text-ink">
          Type any name, number, GSTIN or amount. Add filters to narrow it down — they combine, and the
          ones you type show up as chips.
        </p>
        <div className="grid grid-cols-3 gap-x-6 gap-y-2">
          {SYNTAX_HINTS.map((h) => (
            <button key={h.token} type="button" className="flex items-center justify-between gap-3 text-left" onClick={() => onPick(h.token)}>
              <code className="font-mono text-small text-ink">{h.token}</code>
              <span className="text-hint text-muted">{h.label}</span>
            </button>
          ))}
        </div>
        <p className="mt-3 text-hint text-muted">
          Ranges: <code className="font-mono">amt:1000..5000</code>, <code className="font-mono">date:2026-04-01..2026-04-30</code>.
          Also <code className="font-mono">no:</code> <code className="font-mono">pan:</code> <code className="font-mono">hsn:</code>.
          Optional and post-dated vouchers are included and badged; deleted ones never are.
        </p>
      </div>
    </Panel>
  )
}
