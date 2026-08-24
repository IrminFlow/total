import { useEffect, useMemo, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useNav, useSession, useToasts, type Screen } from '../state/stores'
import { api } from '../lib/client'
import { isAnyModalOpen, useFocusTrap, useKeyNav } from './ui'
import { useFeatures } from '../lib/useFeatures'
import { SCREENS } from '../lib/screens'
import type { CompanyFeatures } from '@shared/features'
import type { SearchHit } from '@shared/search'

interface Command {
  label: string
  hint?: string
  /** Extra search terms (from the screen registry). */
  keywords?: string[]
  /** Hidden (render-only) when this feature is off. */
  feature?: keyof CompanyFeatures
  run: () => void | Promise<void>
}

/** Flattened, keyboard-navigable row — either a static command or a books search hit. Dividers
 *  aren't part of this list (they're not navigable), just spliced in at render time. */
type NavItem = { type: 'command'; cmd: Command } | { type: 'hit'; hit: SearchHit }

const HIT_KIND_LABEL: Record<SearchHit['kind'], string> = { ledger: 'Ledger', item: 'Item', voucher: 'Voucher' }

const HIT_KIND_PLURAL: Record<SearchHit['kind'], string> = { ledger: 'ledgers', item: 'items', voucher: 'vouchers' }

/**
 * What "search this screen" means, per screen (⌘⇧F).
 *
 * ⌘K searches everything and lists every command, which is right when you do not know where you
 * are going. It is the wrong tool when you are already on the Day Book and want one voucher: the
 * answer arrives behind forty navigation commands nobody asked for.
 *
 * So ⌘⇧F opens the same palette with the commands dropped and the results narrowed to the kind
 * of thing THIS screen is about. A screen not listed here is one where "the current screen"
 * narrows nothing — the key then behaves like ⌘K rather than pretending to a scope it has not got.
 */
export const SCREEN_SEARCH_SCOPE: Partial<Record<Screen['name'], SearchHit['kind'][]>> = {
  daybook: ['voucher'],
  'voucher-entry': ['voucher'],
  registers: ['voucher'],
  exceptions: ['voucher'],
  'ledger-statement': ['ledger'],
  'trial-balance': ['ledger'],
  'profit-loss': ['ledger'],
  'balance-sheet': ['ledger'],
  outstandings: ['ledger'],
  khata: ['ledger'],
  collections: ['ledger'],
  masters: ['ledger', 'item'],
  'stock-summary': ['item']
}

export function CommandPalette({
  onClose,
  scope
}: {
  onClose: () => void
  /** Result kinds to keep; the command list is hidden entirely while a scope is in force. */
  scope?: SearchHit['kind'][]
}): React.JSX.Element {
  const nav = useNav()
  const toast = useToasts()
  const { clearCompany } = useSession()
  const features = useFeatures()
  const [query, setQuery] = useState('')
  const dialogRef = useRef<HTMLDivElement>(null)

  const commands = useMemo<Command[]>(() => {
    const go = (screen: Screen) => () => nav.go(screen)
    // Every navigable screen comes from the single registry; action commands are appended below.
    const screenCommands: Command[] = SCREENS.filter((s) => s.screen != null).map((s) => ({
      label: s.title,
      hint: s.accel,
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
        feature: 'inventory',
        run: go({ name: 'voucher-entry', kindHint: 'stock_journal' })
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
      // Named for what people search for, not for the tab: someone whose eyes hurt types
      // "contrast" or "text size", never "appearance".
      {
        label: 'Appearance — theme, text size, motion',
        keywords: ['contrast', 'high contrast', 'text size', 'font size', 'dark', 'motion', 'accessibility'],
        run: go({ name: 'settings', tab: 'appearance' })
      },
      { label: 'Backups', run: go({ name: 'settings', tab: 'backups' }) },
      { label: 'Bin', run: go({ name: 'settings', tab: 'bin' }) },
      { label: 'Audit trail', run: go({ name: 'settings', tab: 'audit' }) },
      { label: 'Users', run: go({ name: 'settings', tab: 'users' }) },
      { label: 'Features', run: go({ name: 'settings', tab: 'features' }) },
      { label: 'Invoice print', run: go({ name: 'settings', tab: 'invoice' }) },
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
    // A scoped search is a search, not a menu — the commands would bury the hits it was opened for.
    if (scope) return []
    const visible = commands.filter((c) => !c.feature || features[c.feature])
    const q = query.trim().toLowerCase()
    if (!q) return visible
    return visible.filter(
      (c) => c.label.toLowerCase().includes(q) || c.keywords?.some((k) => k.toLowerCase().includes(q))
    )
  }, [commands, query, features, scope])

  // Books search: debounced 150ms, only fires once the query is meaningfully specific (2+ chars).
  const [debounced, setDebounced] = useState('')
  useEffect(() => {
    const t = setTimeout(() => setDebounced(query.trim()), 150)
    return () => clearTimeout(t)
  }, [query])
  const searchEnabled = debounced.length >= 2
  const { data: allHits = [] } = useQuery({
    queryKey: ['search', debounced],
    queryFn: () => api.search.global(debounced),
    enabled: searchEnabled
  })
  // Filtered here rather than at the IPC boundary so the same cached result serves both the
  // scoped and the unscoped palette — the query key stays the query, which is what it is about.
  const hits = useMemo(() => (scope ? allHits.filter((h) => scope.includes(h.kind)) : allHits), [allHits, scope])

  const navItems = useMemo<NavItem[]>(
    () => [...filtered.map((cmd) => ({ type: 'command' as const, cmd })), ...hits.map((hit) => ({ type: 'hit' as const, hit }))],
    [filtered, hits]
  )

  const { active, setActive } = useKeyNav(navItems.length, () => {}, false)

  // The input keeps its own `autoFocus` (it must be focused, not merely first in the trap), so
  // the hook only has to wrap Tab and hand focus back to whatever was focused when ⌘K was hit.
  // It yields to any modal opened over the palette — the modal's own trap wins.
  useFocusTrap(dialogRef, { autoFocus: false, isTop: () => !isAnyModalOpen() })

  const runItem = (item: NavItem | undefined): void => {
    if (!item) return
    onClose()
    if (item.type === 'command') {
      void item.cmd.run()
      return
    }
    const { hit } = item
    if (hit.kind === 'ledger') nav.go({ name: 'ledger-statement', ledgerId: hit.id })
    else if (hit.kind === 'item') nav.go({ name: 'masters', tab: 'items' })
    else nav.go({ name: 'voucher-entry', voucherId: hit.id })
  }

  return (
    <div className="fixed inset-0 z-40 flex items-start justify-center bg-black/50 pt-[14vh]" onMouseDown={onClose}>
      {/* A dialog in every way that matters to the user, so it says so to the reader too: named,
          modal, and trapped. Before this it was an unlabelled <div> whose only a11y behaviour was
          `autoFocus` on the input — Tab walked straight out into the sidebar behind the dimmer. */}
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        data-testid="command-palette"
        className="w-full max-w-xl overflow-hidden rounded-lg border border-line bg-panel shadow-2xl"
        onMouseDown={(e) => e.stopPropagation()}
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
            else if (e.key === 'Enter') runItem(navItems[active])
          }}
          placeholder={
            scope
              ? `Search ${scope.map((k) => HIT_KIND_PLURAL[k]).join(' and ')} on this screen…`
              : 'Type a command — voucher, report, GST…'
          }
          className="w-full border-b border-line bg-transparent px-5 py-3.5 text-lead outline-none placeholder:text-muted/60"
        />
        <div className="max-h-80 overflow-auto py-1">
          {filtered.map((cmd, i) => (
            <div
              key={cmd.label}
              data-active={i === active}
              className="kbar-row flex cursor-pointer items-center justify-between px-5 py-2 text-body"
              onMouseEnter={() => setActive(i)}
              onClick={() => runItem(navItems[i])}
            >
              <span>{cmd.label}</span>
              {cmd.hint && <span className="text-caption text-muted">{cmd.hint}</span>}
            </div>
          ))}
          {hits.length > 0 && (
            <p className="px-5 pb-1 pt-3 text-label font-medium uppercase tracking-wide text-muted">In your books</p>
          )}
          {hits.map((hit, j) => {
            const i = filtered.length + j
            return (
              <div
                key={`${hit.kind}-${hit.id}`}
                data-active={i === active}
                className="kbar-row flex cursor-pointer items-center justify-between gap-3 px-5 py-2 text-body"
                onMouseEnter={() => setActive(i)}
                onClick={() => runItem(navItems[i])}
              >
                <div className="flex min-w-0 flex-col">
                  <span className="truncate">{hit.label}</span>
                  <span className="truncate text-caption text-muted">{hit.sub}</span>
                </div>
                <span className="shrink-0 text-caption text-muted">{HIT_KIND_LABEL[hit.kind]}</span>
              </div>
            )
          })}
          {navItems.length === 0 && <p className="px-5 py-6 text-center text-detail text-muted">No commands or matches</p>}
        </div>
      </div>
    </div>
  )
}
