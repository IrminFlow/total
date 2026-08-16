import { useMemo, useState } from 'react'
import { useNav, useSession, useToasts, type Screen } from '../state/stores'
import { api } from '../lib/client'
import { useKeyNav } from './ui'
import { useFeatures } from '../lib/useFeatures'
import type { CompanyFeatures } from '@shared/features'

interface Command {
  label: string
  hint?: string
  /** Hidden (render-only) when this feature is off. */
  feature?: keyof CompanyFeatures
  run: () => void | Promise<void>
}

export function CommandPalette({ onClose }: { onClose: () => void }): React.JSX.Element {
  const nav = useNav()
  const toast = useToasts()
  const { clearCompany } = useSession()
  const features = useFeatures()
  const [query, setQuery] = useState('')

  const commands = useMemo<Command[]>(() => {
    const go = (screen: Screen) => () => nav.go(screen)
    return [
      { label: 'New voucher', hint: 'V', run: go({ name: 'voucher-entry' }) },
      { label: 'New sales invoice', run: go({ name: 'voucher-entry', kindHint: 'sales' }) },
      { label: 'New purchase', run: go({ name: 'voucher-entry', kindHint: 'purchase' }) },
      { label: 'New payment', run: go({ name: 'voucher-entry', kindHint: 'payment' }) },
      { label: 'New receipt', run: go({ name: 'voucher-entry', kindHint: 'receipt' }) },
      { label: 'Gateway', run: () => nav.home() },
      { label: 'Day book', run: go({ name: 'daybook' }) },
      { label: 'Ledgers & masters', run: go({ name: 'masters' }) },
      { label: 'Stock items', feature: 'inventory', run: go({ name: 'masters', tab: 'items' }) },
      { label: 'Trial balance', run: go({ name: 'trial-balance' }) },
      { label: 'Profit & Loss', run: go({ name: 'profit-loss' }) },
      { label: 'Balance sheet', run: go({ name: 'balance-sheet' }) },
      { label: 'Stock summary', feature: 'inventory', run: go({ name: 'stock-summary' }) },
      { label: 'Year-end close', run: go({ name: 'year-end' }) },
      { label: 'GSTR-1', run: go({ name: 'gstr1' }) },
      { label: 'GSTR-3B', run: go({ name: 'gstr3b' }) },
      { label: 'GSTR-2B reconciliation', run: go({ name: 'gstr2b' }) },
      { label: 'e-Invoice & e-Way bill', run: go({ name: 'edocs' }) },
      { label: 'Sales register', run: go({ name: 'registers' }) },
      { label: 'Outstandings & ageing', run: go({ name: 'outstandings' }) },
      { label: 'Recurring vouchers', run: go({ name: 'recurring' }) },
      { label: 'Cost centres', feature: 'costCentres', run: go({ name: 'cost-centres' }) },
      { label: 'Budgets', run: go({ name: 'budgets' }) },
      { label: 'TDS', feature: 'tds', run: go({ name: 'tds' }) },
      { label: 'Bank reconciliation', run: go({ name: 'banking' }) },
      { label: 'Payroll — employees & runs', feature: 'payroll', run: go({ name: 'payroll' }) },
      {
        label: 'New manufacture (stock journal)',
        feature: 'inventory',
        run: go({ name: 'voucher-entry', kindHint: 'stock_journal' })
      },
      { label: 'Company details', run: go({ name: 'company-info' }) },
      { label: 'Settings', run: go({ name: 'settings' }) },
      { label: 'Backups', run: go({ name: 'settings', tab: 'backups' }) },
      { label: 'Bin', run: go({ name: 'settings', tab: 'bin' }) },
      { label: 'Audit trail', run: go({ name: 'settings', tab: 'audit' }) },
      { label: 'Users', run: go({ name: 'settings', tab: 'users' }) },
      { label: 'Features', run: go({ name: 'settings', tab: 'features' }) },
      { label: 'Invoice print', run: go({ name: 'settings', tab: 'invoice' }) },
      {
        label: 'Back up company now',
        run: async () => {
          await api.company.backup()
          toast.push('success', 'Backup saved')
        }
      },
      {
        label: 'Show exports in Finder',
        run: () => api.company.revealExports()
      },
      {
        label: 'Switch company',
        run: async () => {
          await api.company.close()
          clearCompany()
          nav.home()
        }
      }
    ]
  }, [nav, toast, clearCompany])

  const filtered = useMemo(() => {
    const visible = commands.filter((c) => !c.feature || features[c.feature])
    const q = query.trim().toLowerCase()
    if (!q) return visible
    return visible.filter((c) => c.label.toLowerCase().includes(q))
  }, [commands, query, features])

  const { active, setActive } = useKeyNav(filtered.length, () => {}, false)

  const runCommand = (cmd: Command | undefined): void => {
    if (!cmd) return
    onClose()
    void cmd.run()
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
            else if (e.key === 'ArrowDown') { e.preventDefault(); setActive(Math.min(filtered.length - 1, active + 1)) }
            else if (e.key === 'ArrowUp') { e.preventDefault(); setActive(Math.max(0, active - 1)) }
            else if (e.key === 'Enter') runCommand(filtered[active])
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
              onClick={() => runCommand(cmd)}
            >
              <span>{cmd.label}</span>
              {cmd.hint && <span className="text-[11px] text-muted">{cmd.hint}</span>}
            </div>
          ))}
          {filtered.length === 0 && <p className="px-5 py-6 text-center text-[13px] text-muted">No matching command</p>}
        </div>
      </div>
    </div>
  )
}
