import { useEffect, useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useNav, useSession, useToasts, type Screen } from '../state/stores'
import { api } from '../lib/client'
import { useKeyNav } from './ui'
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

export function CommandPalette({ onClose }: { onClose: () => void }): React.JSX.Element {
  const nav = useNav()
  const toast = useToasts()
  const { clearCompany } = useSession()
  const features = useFeatures()
  const [query, setQuery] = useState('')

  const commands = useMemo<Command[]>(() => {
    const go = (screen: Screen) => () => nav.go(screen)
    // Every navigable screen comes from the single registry; action commands are appended below.
    const screenCommands: Command[] = SCREENS.filter((s) => s.screen != null).map((s) => ({
      label: s.title,
      hint: s.card?.key,
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
    const visible = commands.filter((c) => !c.feature || features[c.feature])
    const q = query.trim().toLowerCase()
    if (!q) return visible
    return visible.filter(
      (c) => c.label.toLowerCase().includes(q) || c.keywords?.some((k) => k.toLowerCase().includes(q))
    )
  }, [commands, query, features])

  // Books search: debounced 150ms, only fires once the query is meaningfully specific (2+ chars).
  const [debounced, setDebounced] = useState('')
  useEffect(() => {
    const t = setTimeout(() => setDebounced(query.trim()), 150)
    return () => clearTimeout(t)
  }, [query])
  const searchEnabled = debounced.length >= 2
  const { data: hits = [] } = useQuery({
    queryKey: ['search', debounced],
    queryFn: () => api.search.global(debounced),
    enabled: searchEnabled
  })

  const navItems = useMemo<NavItem[]>(
    () => [...filtered.map((cmd) => ({ type: 'command' as const, cmd })), ...hits.map((hit) => ({ type: 'hit' as const, hit }))],
    [filtered, hits]
  )

  const { active, setActive } = useKeyNav(navItems.length, () => {}, false)

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
      <div className="w-full max-w-xl overflow-hidden rounded-xl border border-line bg-panel shadow-2xl" onMouseDown={(e) => e.stopPropagation()}>
        <input
          autoFocus
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
          placeholder="Type a command — voucher, report, GST…"
          className="w-full border-b border-line bg-transparent px-5 py-3.5 text-[14px] outline-none placeholder:text-muted/60"
        />
        <div className="max-h-80 overflow-auto py-1">
          {filtered.map((cmd, i) => (
            <div
              key={cmd.label}
              data-active={i === active}
              className="kbar-row flex cursor-pointer items-center justify-between px-5 py-2 text-[13.5px]"
              onMouseEnter={() => setActive(i)}
              onClick={() => runItem(navItems[i])}
            >
              <span>{cmd.label}</span>
              {cmd.hint && <span className="text-[11px] text-muted">{cmd.hint}</span>}
            </div>
          ))}
          {hits.length > 0 && (
            <p className="px-5 pb-1 pt-3 text-[10.5px] font-medium uppercase tracking-wide text-muted">In your books</p>
          )}
          {hits.map((hit, j) => {
            const i = filtered.length + j
            return (
              <div
                key={`${hit.kind}-${hit.id}`}
                data-active={i === active}
                className="kbar-row flex cursor-pointer items-center justify-between gap-3 px-5 py-2 text-[13.5px]"
                onMouseEnter={() => setActive(i)}
                onClick={() => runItem(navItems[i])}
              >
                <div className="flex min-w-0 flex-col">
                  <span className="truncate">{hit.label}</span>
                  <span className="truncate text-[11px] text-muted">{hit.sub}</span>
                </div>
                <span className="shrink-0 text-[11px] text-muted">{HIT_KIND_LABEL[hit.kind]}</span>
              </div>
            )
          })}
          {navItems.length === 0 && <p className="px-5 py-6 text-center text-[13px] text-muted">No commands or matches</p>}
        </div>
      </div>
    </div>
  )
}
