import { useEffect, useMemo, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useNav, useSession, useToasts, type Screen } from '../state/stores'
import { api } from '../lib/client'
import { Kbd, Money, useKeyNav } from './ui'
import { useFeatures } from '../lib/useFeatures'
import { SCREENS } from '../lib/screens'
import { useSearchRecents, type RecentKind, type RecentRecord } from '../lib/searchRecents'
import { openLedgerEdit } from '../lib/drill'
import {
  Highlight,
  KIND_SINGULAR,
  KIND_TITLE,
  QueryChips,
  SYNTAX_HINTS,
  VoucherBadges,
  matchHint,
  recentRecordFor,
  useOpenRecord
} from './SearchParts'
import type { CompanyFeatures } from '@shared/features'
import type { SearchResult, SearchSection } from '@shared/search'
import { isEmptyQuery, parseSearchQuery, type SearchKind } from '@shared/searchQuery'
import { fyOf, todayISO, toDisplayDate } from '@shared/dates'

interface Command {
  label: string
  hint?: string
  /** Extra search terms (from the screen registry). */
  keywords?: string[]
  /** Hidden (render-only) when this feature is off. */
  feature?: keyof CompanyFeatures
  run: () => void | Promise<void>
}

/** Flattened, keyboard-navigable row. Section headers and the help line aren't part of this list
 *  (they're not navigable), just rendered between groups. */
type NavItem =
  | { type: 'command'; cmd: Command }
  | { type: 'hit'; hit: SearchResult }
  | { type: 'see-all'; kind: SearchKind; total: number }
  | { type: 'recent-query'; q: string }
  | { type: 'recent-record'; kind: RecentKind; rec: RecentRecord }

/** A titled run of NavItems (rendered with a header). */
interface Group {
  key: string
  title: string | null
  count?: number
  items: NavItem[]
}

const KINDS: SearchKind[] = ['ledger', 'item', 'voucher']
const SECTION_KEY: Record<SearchKind, 'ledgers' | 'items' | 'vouchers'> = { ledger: 'ledgers', item: 'items', voucher: 'vouchers' }

/** Rows per kind in the palette — kept short; the "See all N" row opens the results screen.
 *  Counts in the section headers are the true totals from the service. */
const PALETTE_LIMIT = 6

export function CommandPalette({ onClose }: { onClose: () => void }): React.JSX.Element {
  const nav = useNav()
  const toast = useToasts()
  const { clearCompany } = useSession()
  const from = useSession((s) => s.from)
  const features = useFeatures()
  const [query, setQuery] = useState('')
  const { recents, addQuery } = useSearchRecents()
  const openRecord = useOpenRecord()
  const ctx = useMemo(() => ({ today: todayISO(), fyStartYear: fyOf(from).startYear }), [from])

  const commands = useMemo<Command[]>(() => {
    const go = (screen: Screen) => () => nav.go(screen)
    // Every navigable screen comes from the single registry; action commands are appended below.
    const screenCommands: Command[] = SCREENS.filter((s) => s.screen != null).map((s) => ({
      label: s.title,
      hint: s.name === 'search' ? '⌘⇧F' : s.card?.key,
      keywords: s.keywords,
      feature: s.feature,
      run: s.name === 'gateway' ? () => nav.home() : go(s.screen!)
    }))
    return [
      { label: 'New voucher', hint: 'V', run: go({ name: 'voucher-entry' }) },
      { label: 'New sales invoice', run: go({ name: 'voucher-entry', kindHint: 'sales' }) },
      { label: 'New purchase', run: go({ name: 'voucher-entry', kindHint: 'purchase' }) },
      { label: 'New payment', run: go({ name: 'voucher-entry', kindHint: 'payment' }) },
      { label: 'New receipt', run: go({ name: 'voucher-entry', kindHint: 'receipt' }) },
      ...screenCommands,
      { label: 'Stock items', feature: 'inventory', run: go({ name: 'masters', tab: 'items' }) },
      { label: 'Currencies', run: go({ name: 'masters', tab: 'currencies' }) },
      {
        label: 'New manufacture (stock journal)',
        hint: 'Alt F7',
        feature: 'inventory',
        run: go({ name: 'manufacture' })
      },
      {
        label: 'Export CA pack',
        run: async () => {
          try {
            const { from, to } = useSession.getState()
            const r = await api.exporter.caPack(from, to)
            toast.push('success', `Saved to ${r.path}`)
          } catch (err) {
            toast.push('error', (err as Error).message)
          }
        }
      },
      {
        label: 'Export Tally XML',
        run: async () => {
          try {
            const { from, to } = useSession.getState()
            const r = await api.exporter.tallyXml(from, to)
            toast.push('success', `Saved to ${r.path}`)
          } catch (err) {
            toast.push('error', (err as Error).message)
          }
        }
      },
      { label: 'Backups', run: go({ name: 'settings', tab: 'backups' }) },
      { label: 'Bin', run: go({ name: 'settings', tab: 'bin' }) },
      { label: 'Audit trail', run: go({ name: 'settings', tab: 'audit' }) },
      { label: 'Users', run: go({ name: 'settings', tab: 'users' }) },
      { label: 'Features', run: go({ name: 'settings', tab: 'features' }) },
      { label: 'Invoice templates', run: go({ name: 'settings', tab: 'invoice' }) },
      { label: 'Appearance — theme and density', run: go({ name: 'settings', tab: 'appearance' }) },
      {
        label: 'Back up company now',
        run: async () => {
          try {
            await api.company.backup()
            toast.push('success', 'Backup saved')
          } catch (err) {
            toast.push('error', (err as Error).message)
          }
        }
      },
      {
        label: 'Show exports in Finder',
        run: async () => {
          try {
            await api.company.revealExports()
          } catch (err) {
            toast.push('error', (err as Error).message)
          }
        }
      },
      {
        label: 'Switch company',
        run: async () => {
          try {
            await api.company.close()
            clearCompany()
            nav.home()
          } catch (err) {
            toast.push('error', (err as Error).message)
          }
        }
      }
    ]
  }, [nav, toast, clearCompany])

  const filtered = useMemo(() => {
    const visible = commands.filter((c) => !c.feature || features[c.feature])
    const q = query.trim().toLowerCase()
    if (!q) return visible
    return visible.filter(
      (c) => c.label.toLowerCase().includes(q) || c.keywords?.some((k) => k.toLowerCase().includes(q))
    )
  }, [commands, query, features])

  // Chips come from a local parse (instant, no round-trip); the IPC re-parses the same string.
  const parsed = useMemo(() => parseSearchQuery(query, ctx), [query, ctx])

  // Books search: debounced 150ms, only fires once the query is meaningfully specific (2+ chars).
  const [debounced, setDebounced] = useState('')
  useEffect(() => {
    const t = setTimeout(() => setDebounced(query.trim()), 150)
    return () => clearTimeout(t)
  }, [query])
  const searchEnabled = debounced.length >= 2 && !isEmptyQuery(parseSearchQuery(debounced, ctx))
  const { data: results } = useQuery({
    queryKey: ['search', debounced, ctx.today, ctx.fyStartYear],
    queryFn: () => api.search.query({ q: debounced, ...ctx, limitPerKind: PALETTE_LIMIT }),
    enabled: searchEnabled
  })
  const live = searchEnabled ? results : undefined
  const terms = live?.terms ?? []

  const groups = useMemo<Group[]>(() => {
    const out: Group[] = []
    const empty = query.trim() === ''
    const hasRecents = empty && recents.queries.length + recents.vouchers.length + recents.ledgers.length + recents.items.length > 0
    // Commands always come first, so ⌘K then ↵ still runs what it always ran (New voucher);
    // recents sit below them and are never the default selection.
    if (filtered.length) {
      out.push({ key: 'commands', title: hasRecents || live ? 'Commands' : null, items: filtered.map((cmd) => ({ type: 'command', cmd })) })
    }
    if (hasRecents) {
      if (recents.queries.length) {
        out.push({ key: 'recent-q', title: 'Recent searches', items: recents.queries.map((q) => ({ type: 'recent-query', q })) })
      }
      const recentRecords: NavItem[] = [
        ...recents.vouchers.map((rec) => ({ type: 'recent-record' as const, kind: 'voucher' as const, rec })),
        ...recents.ledgers.map((rec) => ({ type: 'recent-record' as const, kind: 'ledger' as const, rec })),
        ...recents.items.map((rec) => ({ type: 'recent-record' as const, kind: 'item' as const, rec }))
      ]
      if (recentRecords.length) out.push({ key: 'recent-r', title: 'Recently opened', items: recentRecords })
    }
    if (live) {
      for (const k of KINDS) {
        const sec = live[SECTION_KEY[k]] as SearchSection<SearchResult> | null
        if (!sec || sec.total === 0) continue
        const items: NavItem[] = sec.rows.map((hit) => ({ type: 'hit', hit }))
        if (sec.total > sec.rows.length) items.push({ type: 'see-all', kind: k, total: sec.total })
        out.push({ key: `kind-${k}`, title: KIND_TITLE[k], count: sec.total, items })
      }
    }
    return out
  }, [query, recents, filtered, live])

  const navItems = useMemo(() => groups.flatMap((g) => g.items), [groups])
  const { active, setActive } = useKeyNav(navItems.length, () => {}, false)
  // A row appearing under a stationary cursor fires mouseenter; only a real mouse move may steal
  // the selection, so ⌘K then ↵ always runs the default (first) row.
  const pointerMoved = useRef(false)

  const openSearchScreen = (kind?: SearchKind): void => {
    const q = query.trim()
    if (q.length >= 2) addQuery(q)
    onClose()
    nav.go({ name: 'search', q, ...(kind ? { kind } : {}) })
  }

  /** The ledger a row stands for (search hit or recently opened), or null. */
  const ledgerOf = (item: NavItem | undefined): number | null =>
    item?.type === 'hit' && item.hit.kind === 'ledger'
      ? item.hit.id
      : item?.type === 'recent-record' && item.kind === 'ledger'
        ? item.rec.id
        : null

  /** ⌘E / the row's Edit action: the ledger's edit window instead of its statement. */
  const editItem = (item: NavItem | undefined): boolean => {
    const id = ledgerOf(item)
    if (id == null) return false
    onClose()
    openLedgerEdit(id)
    return true
  }

  const runItem = (item: NavItem | undefined): void => {
    if (!item) return
    switch (item.type) {
      case 'command':
        onClose()
        void item.cmd.run()
        return
      case 'recent-query':
        setQuery(item.q)
        setActive(0)
        return
      case 'see-all':
        openSearchScreen(item.kind)
        return
      case 'recent-record':
        onClose()
        openRecord(item.kind, item.rec)
        return
      case 'hit':
        onClose()
        openRecord(item.hit.kind, recentRecordFor(item.hit), query.trim())
    }
  }

  let index = 0
  return (
    <div className="fixed inset-0 z-40 flex items-start justify-center bg-scrim pt-[14vh]" onMouseDown={onClose}>
      <div
        className="w-full max-w-2xl overflow-hidden rounded-xl border border-line bg-raised shadow-elev-3"
        data-testid="palette"
        onMouseDown={(e) => e.stopPropagation()}
        onMouseMove={() => {
          if (!pointerMoved.current) pointerMoved.current = true
        }}
      >
        <input
          autoFocus
          data-testid="input-palette"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value)
            setActive(0)
          }}
          onKeyDown={(e) => {
            if (e.key === 'Escape') onClose()
            else if (e.key === 'ArrowDown') { e.preventDefault(); setActive(Math.min(navItems.length - 1, active + 1)) }
            else if (e.key === 'ArrowUp') { e.preventDefault(); setActive(Math.max(0, active - 1)) }
            else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); openSearchScreen() }
            else if (e.key.toLowerCase() === 'e' && (e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey) {
              if (editItem(navItems[active])) e.preventDefault()
            }
            else if (e.key === 'Enter') runItem(navItems[active])
          }}
          placeholder="Type a command, or search the books — name, number, GSTIN, amount…"
          className="w-full border-b border-line bg-transparent px-5 py-3.5 text-lead outline-none placeholder:text-muted"
        />
        {(parsed.chips.length > 0 || parsed.unknown.length > 0) && (
          <div className="border-b border-line px-5 py-2">
            <QueryChips chips={parsed.chips} unknown={parsed.unknown} testId="palette-chips" />
          </div>
        )}
        <div className="max-h-[26rem] overflow-auto py-1">
          {groups.map((g) => (
            <div key={g.key} data-testid={`palette-section-${g.key}`}>
              {g.title && (
                <p className="flex items-baseline justify-between px-5 pb-1 pt-3 text-label font-medium tracking-wide text-muted uppercase">
                  <span>{g.title}</span>
                  {g.count != null && <span className="num normal-case tracking-normal">{g.count}</span>}
                </p>
              )}
              {g.items.map((item) => {
                const i = index++
                return (
                  <PaletteRow
                    key={rowKey(item)}
                    item={item}
                    active={i === active}
                    terms={terms}
                    onHover={() => {
                      if (pointerMoved.current) setActive(i)
                    }}
                    onRun={() => runItem(item)}
                    onEdit={ledgerOf(item) != null ? () => editItem(item) : undefined}
                  />
                )
              })}
            </div>
          ))}
          {navItems.length === 0 && (
            <p className="px-5 py-6 text-center text-detail text-muted">
              {searchEnabled && !live ? 'Searching…' : 'No commands or matches'}
            </p>
          )}
        </div>
        <div data-testid="palette-help" className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-line bg-panel2 px-5 py-2 text-caption text-muted">
          {query.trim() === '' ? (
            <>
              <span>Filters:</span>
              {SYNTAX_HINTS.slice(0, 6).map((h) => (
                <button
                  key={h.token}
                  type="button"
                  className="font-mono text-ink hover:text-ink"
                  title={h.label}
                  onClick={() => setQuery(`${h.token} `)}
                >
                  {h.token}
                </button>
              ))}
            </>
          ) : (
            <span>
              <Kbd>↑↓</Kbd> move · <Kbd>↵</Kbd> open · <Kbd>⌘E</Kbd> edit ledger · <Kbd>⌘↵</Kbd> all results
            </span>
          )}
        </div>
      </div>
    </div>
  )
}

function rowKey(item: NavItem): string {
  switch (item.type) {
    case 'command': return `cmd-${item.cmd.label}`
    case 'hit': return `hit-${item.hit.kind}-${item.hit.id}`
    case 'see-all': return `all-${item.kind}`
    case 'recent-query': return `rq-${item.q}`
    case 'recent-record': return `rr-${item.kind}-${item.rec.id}`
  }
}

function PaletteRow({
  item, active, terms, onHover, onRun, onEdit
}: {
  item: NavItem
  active: boolean
  terms: string[]
  onHover: () => void
  onRun: () => void
  /** Ledger rows: open the edit window (↵ / click opens the statement). */
  onEdit?: () => void
}): React.JSX.Element {
  // Ledger rows: ↵ / click → statement; this action (or ⌘E) → the edit window.
  const editAction = onEdit && (
    <button
      type="button"
      data-testid="palette-edit-ledger"
      title="Edit ledger (⌘E)"
      className="shrink-0 rounded border border-line px-1.5 py-0.5 text-caption text-blue hover:bg-panel2"
      onClick={(e) => {
        e.stopPropagation()
        onEdit()
      }}
    >
      Edit <span className="text-muted">⌘E</span>
    </button>
  )
  const base = 'kbar-row flex cursor-pointer items-center justify-between gap-3 px-5 py-2 text-body'
  const common = { 'data-active': active, onMouseEnter: onHover, onClick: onRun }
  switch (item.type) {
    case 'command':
      return (
        <div {...common} className={base}>
          <span>{item.cmd.label}</span>
          {item.cmd.hint && <span className="text-caption text-muted">{item.cmd.hint}</span>}
        </div>
      )
    case 'recent-query':
      return (
        <div {...common} data-testid="palette-recent-query" className={base}>
          <span className="truncate font-mono text-body-sm">{item.q}</span>
          <span className="shrink-0 text-caption text-muted">Search</span>
        </div>
      )
    case 'recent-record':
      return (
        <div {...common} data-testid={`palette-recent-${item.kind}`} className={base}>
          <div className="flex min-w-0 flex-col">
            <span className="truncate">{item.rec.label}</span>
            {item.rec.sub && <span className="truncate text-caption text-muted">{item.rec.sub}</span>}
          </div>
          <span className="flex shrink-0 items-center gap-2 text-caption text-muted">
            {active && editAction}
            {KIND_SINGULAR[item.kind]}
          </span>
        </div>
      )
    case 'see-all':
      return (
        <div {...common} data-testid={`palette-see-all-${item.kind}`} className={`${base} text-blue`}>
          <span>
            See all {item.total} {KIND_TITLE[item.kind].toLowerCase()}
          </span>
          <span className="text-caption text-muted">⌘↵</span>
        </div>
      )
    case 'hit': {
      const h = item.hit
      const hint = matchHint(h)
      if (h.kind === 'voucher') {
        const sub = [toDisplayDate(h.date), hint ?? h.narration].filter(Boolean).join(' · ')
        return (
          <div {...common} data-testid={`palette-hit-voucher-${h.id}`} className={base}>
            <div className="flex min-w-0 flex-col">
              <span className="truncate">
                <span className="text-muted">{h.typeName}</span> <Highlight text={h.number} terms={terms} />
                {h.party && (
                  <>
                    <span className="text-muted"> · </span>
                    <Highlight text={h.party} terms={terms} />
                  </>
                )}
                <VoucherBadges v={h} />
              </span>
              <span className="truncate text-caption text-muted">
                <Highlight text={sub} terms={terms} />
              </span>
            </div>
            <Money paise={h.amount} className="shrink-0 text-body-sm" />
          </div>
        )
      }
      const sub = h.kind === 'ledger' ? [h.groupName, hint].filter(Boolean).join(' · ') : [h.groupName ?? 'Stock item', hint].filter(Boolean).join(' · ')
      return (
        <div {...common} data-testid={`palette-hit-${h.kind}-${h.id}`} className={base}>
          <div className="flex min-w-0 flex-col">
            <span className="truncate">
              <Highlight text={h.name} terms={terms} />
            </span>
            <span className="truncate text-caption text-muted">
              <Highlight text={sub} terms={terms} />
            </span>
          </div>
          <span className="flex shrink-0 items-center gap-2 text-caption text-muted">
            {active && editAction}
            {KIND_SINGULAR[h.kind]}
          </span>
        </div>
      )
    }
  }
}
