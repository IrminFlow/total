import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../../lib/client'
import { useT } from '../../lib/i18n'
import { useMode } from '../../lib/mode'
import type { MessageKey } from '@shared/i18n'
import { useSession, useToasts } from '../../state/stores'
import { Button, Panel, SectionTitle } from '../../components/ui'
import { DEFAULT_FEATURES, effectiveFeatures, type CompanyFeatures } from '@shared/features'

/** WP 8.3 (plan §4.3): every module is a "Turn on" card with one line on who needs it. New simple
 *  companies start with TDS, TCS, payroll, cost centres, multi-currency, orders and manufacturing
 *  off (written explicitly at setup); a company without `features` meta keeps DEFAULT_FEATURES. */
type Key = keyof CompanyFeatures
const CARDS: { key: Key; label: string; plain: MessageKey; who: MessageKey; hint: string; needsInventory?: boolean }[] = [
  { key: 'inventory', label: 'Inventory', plain: 'simple.features.label.inventory', who: 'simple.features.inventory', hint: 'Stock items, godowns, stock summary' },
  { key: 'manufacturing', label: 'Manufacturing', plain: 'simple.features.label.manufacturing', who: 'simple.features.manufacture', hint: 'Manufacture vouchers (BOM), the manufacturing register and reports', needsInventory: true },
  { key: 'orders', label: 'Orders & challans', plain: 'simple.features.label.orders', who: 'simple.features.orders', hint: 'Delivery challans and goods receipt notes, invoices raised from them, and pending reports', needsInventory: true },
  { key: 'tds', label: 'TDS', plain: 'simple.features.label.tds', who: 'simple.features.tds', hint: 'Tax Deducted at Source suggestions, deduction entries, and the TDS report' },
  { key: 'tcs', label: 'TCS', plain: 'simple.features.label.tcs', who: 'simple.features.tcs', hint: 'Tax Collected at Source on sales — the invoice / receipt banner, 27EQ data and the TCS screen' },
  { key: 'payroll', label: 'Payroll', plain: 'simple.features.label.payroll', who: 'simple.features.payroll', hint: 'Employees, pay runs, and payslips' },
  { key: 'multiCurrency', label: 'Multi-currency', plain: 'simple.features.label.multiCurrency', who: 'simple.features.multiCurrency', hint: 'Foreign-currency invoices with an exchange rate; books stay in ₹' },
  { key: 'costCentres', label: 'Cost centres', plain: 'simple.features.label.costCentres', who: 'simple.features.costCentres', hint: 'Split voucher lines across cost centres for the cost-centre report' },
  { key: 'billWise', label: 'Bill-wise details', plain: 'simple.features.label.billWise', who: 'simple.features.billWise', hint: 'Allocate receipts/payments/notes against specific invoices instead of on-account' }
]

export function FeaturesSection(): React.JSX.Element {
  const t = useT()
  // A simple company reads plain names only; the accountant terms show in the full app.
  const simple = useMode() === 'simple'
  const toast = useToasts()
  const queryClient = useQueryClient()
  const { user } = useSession()
  const { data: existing } = useQuery({ queryKey: ['features'], queryFn: api.config.features.get })
  const [busy, setBusy] = useState<Key | null>(null)
  const stored = existing ?? DEFAULT_FEATURES
  const value = effectiveFeatures(stored)
  // Like the server's owner gate: in a company without users everyone is the owner.
  const canEdit = !user || user.role === 'owner'

  const flip = async (key: Key): Promise<void> => {
    if (!canEdit) return
    const next: CompanyFeatures = { ...stored, [key]: !value[key] }
    // Manufacturing and orders need stock: turning one on turns stock on too.
    if (next[key] && CARDS.find((c) => c.key === key)?.needsInventory) next.inventory = true
    setBusy(key)
    try {
      await api.config.features.set(next)
      await queryClient.invalidateQueries({ queryKey: ['features'] })
      toast.push('success', next[key] ? t('simple.features.turnedOn', { name: t(CARDS.find((c) => c.key === key)!.plain) }) : t('simple.features.turnedOff', { name: t(CARDS.find((c) => c.key === key)!.plain) }))
    } catch (err) {
      toast.push('error', (err as Error).message)
    } finally {
      setBusy(null)
    }
  }

  return (
    <div>
      <SectionTitle>Features</SectionTitle>
      <p className="mb-4 text-body-sm text-muted">{t('simple.features.intro')}</p>
      <div data-testid="features-cards">
      <Panel className="divide-y divide-line">
        {CARDS.map((c) => {
          const on = !!value[c.key]
          return (
            <div key={c.key} className="flex items-start justify-between gap-4 px-5 py-3.5" data-testid={`feature-card-${c.key}`} data-on={on ? 'true' : 'false'}>
              <div className="min-w-0">
                <p className="text-body font-medium">
                  {simple ? t(c.plain) : c.label}{' '}
                  <span className={`ml-1 rounded px-1.5 py-0.5 text-hint ${on ? 'bg-amberbar/20 text-ink' : 'bg-panel2 text-muted'}`}>
                    {on ? t('simple.features.on') : t('simple.features.off')}
                  </span>
                </p>
                <p className="mt-0.5 text-small text-ink">{t(c.who)}</p>
                {!simple && <p className="text-small text-muted">{c.hint}</p>}
              </div>
              {canEdit && (
                <Button
                  variant={on ? 'ghost' : 'primary'}
                  disabled={busy !== null}
                  data-testid={`btn-feature-${c.key}`}
                  onClick={() => void flip(c.key)}
                >
                  {busy === c.key ? t('simple.features.saving') : on ? t('simple.features.turnOff') : t('simple.features.turnOn')}
                </Button>
              )}
            </div>
          )
        })}
      </Panel>
      </div>
      {!canEdit && <p className="mt-4 text-right text-hint text-muted">Only owners can change features</p>}
    </div>
  )
}
