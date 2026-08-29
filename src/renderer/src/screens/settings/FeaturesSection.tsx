import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../../lib/client'
import { useSession, useToasts } from '../../state/stores'
import { Button, Panel, SectionTitle } from '../../components/ui'
import { DEFAULT_FEATURES, type CompanyFeatures } from '@shared/features'
import {
  PRODUCT_FLAGS,
  setProductFlag,
  type ProductFlagId,
} from '../../lib/productFlags'
import { readCommercialState, writeCommercialState } from '../../lib/commercialOps'
import { DEFAULT_DEVICE_SAFETY_CONTROLS, type DeviceSafetyControls } from '@shared/deviceSafety'

const TOGGLES: { key: keyof CompanyFeatures; label: string; hint: string }[] = [
  { key: 'inventory', label: 'Inventory', hint: 'Stock items, godowns, stock summary, and manufacturing (BOM) vouchers' },
  { key: 'billWise', label: 'Bill-wise details', hint: 'Allocate receipts/payments/notes against specific invoices instead of on-account' },
  { key: 'costCentres', label: 'Cost centres', hint: 'Split voucher lines across cost centres for the cost-centre report' },
  { key: 'tds', label: 'TDS', hint: 'Tax Deducted at Source suggestions, deduction entries, and the TDS report' },
  { key: 'multiCurrency', label: 'Multi-currency', hint: 'Foreign-currency invoices with an exchange rate; books stay in ₹' },
  { key: 'payroll', label: 'Payroll', hint: 'Employees, pay runs, and payslips' }
]

export function FeaturesSection(): React.JSX.Element {
  const toast = useToasts()
  const queryClient = useQueryClient()
  const { user } = useSession()
  const { data: existing } = useQuery({ queryKey: ['features'], queryFn: api.config.features.get })
  const [draft, setDraft] = useState<CompanyFeatures | null>(null)
  const [busy, setBusy] = useState(false)
  const value = draft ?? existing ?? DEFAULT_FEATURES
  const { data: deviceSafety = DEFAULT_DEVICE_SAFETY_CONTROLS } = useQuery({
    queryKey: ['deviceSafety'],
    queryFn: api.deviceSafety.get,
  })
  const canEdit = user?.role === 'owner'
  const safetyFlagIds = new Set<ProductFlagId>(['aiCopilot', 'mcpAccess', 'supportUploads', 'telemetry'])
  const safetyFlags = PRODUCT_FLAGS.filter((flag) => safetyFlagIds.has(flag.id))

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

  const toggleSafetyFlag = async (key: keyof DeviceSafetyControls): Promise<void> => {
    if (!canEdit) return
    const enabled = !deviceSafety[key]
    try {
      await api.deviceSafety.set({ ...deviceSafety, [key]: enabled })
      await queryClient.invalidateQueries({ queryKey: ['deviceSafety'] })
    } catch (err) {
      toast.push('error', (err as Error).message)
      return
    }
    setProductFlag(localStorage, key as ProductFlagId, enabled)
    if (key === 'telemetry') {
      const commercial = readCommercialState(localStorage)
      commercial.analytics.enabled = enabled
      writeCommercialState(localStorage, commercial)
    }
    if (key === 'mcpAccess' && !enabled) {
      try {
        await api.agent.setConfig(false)
        await queryClient.invalidateQueries({ queryKey: ['agentConfig'] })
      } catch (err) {
        toast.push('error', `MCP access is off on this device, but the company agent setting could not be updated: ${(err as Error).message}`)
      }
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
      <div className="mt-8"><SectionTitle>Device safety controls</SectionTitle></div>
      <p className="mb-4 text-[12.5px] leading-5 text-muted">
        These switches are independent of company modules. They default off on each device and can stop optional network or agent features immediately.
      </p>
      <Panel className="divide-y divide-line">
        {safetyFlags.map((flag) => (
          <label key={flag.id} className={`flex items-start gap-3 px-5 py-3.5 ${canEdit ? 'cursor-pointer' : 'cursor-default opacity-80'}`}>
            <input
              type="checkbox"
              checked={deviceSafety[flag.id as keyof DeviceSafetyControls]}
              disabled={!canEdit}
              onChange={() => void toggleSafetyFlag(flag.id as keyof DeviceSafetyControls)}
              className="mt-0.5"
            />
            <div>
              <p className="text-[13.5px] font-medium">{flag.label}</p>
              <p className="text-[12px] text-muted">When off: {flag.safeFallback}</p>
            </div>
          </label>
        ))}
      </Panel>
    </div>
  )
}
