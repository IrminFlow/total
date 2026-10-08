// Shared bits for the Payables screen family (WP 4.3).
import { useMemo } from 'react'
import { todayISO } from '@shared/dates'
import type { Group, Ledger } from '@shared/domain'
import { MSME_CATEGORY_LABELS } from '@shared/payables/msme'
import type { SupplierMsmeFacts } from '@shared/payables/types'
import { Badge } from '../../components/ui'
import { useGroups, useLedgers } from '../../components/pickers'
import { groupAncestryNames } from '../../components/LedgerFormModal'
import { useSession } from '../../state/stores'

export type PayablesTab = 'plan' | 'batch' | 'runs' | 'msme' | 'suppliers'

export const PAYABLES_TABS: { id: PayablesTab; label: string }[] = [
  { id: 'plan', label: 'Plan' },
  { id: 'batch', label: 'Batch payments' },
  { id: 'runs', label: 'Payment runs' },
  { id: 'msme', label: 'MSME' },
  { id: 'suppliers', label: 'Supplier reconciliation' }
]

/** The report date payables default to: today, unless the working period ends earlier. */
export function usePayablesAsOn(): string {
  const to = useSession((s) => s.to)
  const today = todayISO()
  return to < today ? to : today
}

const inGroups = (l: Ledger, groups: Group[], names: string[]): boolean => groupAncestryNames(l.groupId, groups).some((n) => names.includes(n))

/** Cash and bank ledgers (the "pay from" choices), banks first. */
export function useCashBankLedgers(): Ledger[] {
  const ledgers = useLedgers()
  const groups = useGroups()
  return useMemo(() => {
    const banks = ledgers.filter((l) => inGroups(l, groups, ['Bank Accounts', 'Bank OD A/c']))
    const cash = ledgers.filter((l) => inGroups(l, groups, ['Cash-in-Hand']))
    return [...banks, ...cash]
  }, [ledgers, groups])
}

/** Ledger filter for the supplier pickers. */
export function creditorFilter(l: Ledger, groups: Map<number, Group>): boolean {
  let g = groups.get(l.groupId)
  while (g) {
    if (g.name === 'Sundry Creditors') return true
    g = g.parentId ? groups.get(g.parentId) : undefined
  }
  return false
}

export function MsmeBadge({ msme }: { msme: SupplierMsmeFacts | null }): React.JSX.Element | null {
  if (!msme?.category) return msme ? <Badge tone="neutral">MSME</Badge> : null
  const label = MSME_CATEGORY_LABELS[msme.category]
  return (
    <Badge
      tone={msme.covered ? 'warning' : 'neutral'}
      testId="payables-msme-badge"
      title={msme.covered ? 'Micro / small: MSMED Act s.15 deadline applies' : 'Medium enterprise: not a s.2(n) supplier — no s.15 deadline'}
    >
      {label}
    </Badge>
  )
}

/** "2.00 %" from basis points. */
export const pct = (bp: number): string => `${(bp / 100).toFixed(2)} %`
