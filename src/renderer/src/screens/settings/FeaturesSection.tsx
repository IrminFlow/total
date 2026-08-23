import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../../lib/client'
import { useSession, useToasts } from '../../state/stores'
import { Button, Panel, SectionTitle } from '../../components/ui'
import { DEFAULT_FEATURES, type CompanyFeatures } from '@shared/features'

const TOGGLES: { key: keyof CompanyFeatures; label: string; hint: string }[] = [
  { key: 'inventory', label: 'Inventory', hint: 'Stock items, godowns, stock summary, and manufacturing (BOM) vouchers' },
  { key: 'billWise', label: 'Bill-wise details', hint: 'Allocate receipts/payments/notes against specific invoices instead of on-account' },
  { key: 'costCentres', label: 'Cost centres', hint: 'Split voucher lines across cost centres for the cost-centre report' },
  { key: 'tds', label: 'TDS', hint: 'Tax Deducted at Source suggestions, deduction entries, and the TDS report' },
  { key: 'multiCurrency', label: 'Multi-currency', hint: 'Foreign-currency invoices with an exchange rate; books stay in ₹' },
  { key: 'payroll', label: 'Payroll', hint: 'Employees, pay runs, and payslips' },
  {
    key: 'ai',
    label: 'AI assistant',
    hint: 'Off by default. Ask questions about these books using your own API key — the only part of Total that uses the internet. Set it up in Settings → AI assistant.'
  }
]

export function FeaturesSection(): React.JSX.Element {
  const toast = useToasts()
  const queryClient = useQueryClient()
  const { user } = useSession()
  const { data: existing } = useQuery({ queryKey: ['features'], queryFn: api.config.features.get })
  const [draft, setDraft] = useState<CompanyFeatures | null>(null)
  const [busy, setBusy] = useState(false)
  const value = draft ?? existing ?? DEFAULT_FEATURES
  const canEdit = user?.role === 'owner'

  const toggle = (key: keyof CompanyFeatures): void => {
    if (!canEdit) return
    setDraft({ ...value, [key]: !value[key] })
  }

  const save = async (): Promise<void> => {
    setBusy(true)
    try {
      await api.config.features.set(value)
      await queryClient.invalidateQueries({ queryKey: ['features'] })
      setDraft(null)
      toast.push('success', 'Features saved')
    } catch (err) {
      toast.push('error', (err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div>
      <SectionTitle>Features</SectionTitle>
      <p className="mb-4 text-[12.5px] text-muted">
        Turning a feature off only hides it — existing entries stay in your books and reports.
      </p>
      <Panel className="divide-y divide-line">
        {TOGGLES.map((t) => (
          <label
            key={t.key}
            className={`flex items-start gap-3 px-5 py-3.5 ${canEdit ? 'cursor-pointer' : 'cursor-default opacity-80'}`}
          >
            <input
              type="checkbox"
              checked={value[t.key]}
              disabled={!canEdit}
              onChange={() => toggle(t.key)}
              className="mt-0.5"
            />
            <div>
              <p className="text-[13.5px] font-medium">{t.label}</p>
              <p className="text-[12px] text-muted">{t.hint}</p>
            </div>
          </label>
        ))}
      </Panel>
      <div className="mt-4 flex items-center justify-end gap-3">
        {!canEdit && <span className="text-[11.5px] text-muted">Only owners can change features</span>}
        {canEdit && (
          <Button variant="primary" disabled={busy || !draft} onClick={() => void save()}>
            {busy ? 'Saving…' : 'Save features'}
          </Button>
        )}
      </div>
    </div>
  )
}
