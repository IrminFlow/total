import { useQuery } from '@tanstack/react-query'
import { deriveOnboarding, isInvoiceConfigCustomised, type OnboardingChecklist, type OnboardingTarget } from '@shared/onboarding'
import { api } from './client'
import { useSession, type Screen } from '../state/stores'
import { useGroups, useLedgers } from '../components/pickers'

/**
 * The onboarding checklist for the open company, derived from existing data (nothing stored).
 * `voucherCount` comes from the caller's dashboard query (DashboardData.voucherCount) so the
 * Gateway doesn't fetch it twice. Query keys reuse the Settings screen's ('backups',
 * 'invoiceConfig') so caches and invalidation are shared.
 *
 *   const checklist = useOnboardingChecklist(dashboard?.voucherCount)
 *   <Checklist items={checklist.steps} onOpen={(id) => nav.go(onboardingScreen(checklist, id))} />
 */
export function useOnboardingChecklist(voucherCount: number | undefined): OnboardingChecklist {
  const info = useSession((s) => s.info)
  const ledgers = useLedgers()
  const groups = useGroups()
  const { data: backups } = useQuery({ queryKey: ['backups'], queryFn: api.backups.list })
  const { data: invoiceConfig } = useQuery({ queryKey: ['invoiceConfig'], queryFn: api.config.invoice.get })
  return deriveOnboarding({
    company: info,
    ledgers,
    groups,
    voucherCount: voucherCount ?? 0,
    backupCount: backups?.length ?? 0,
    invoiceConfigured: isInvoiceConfigCustomised(invoiceConfig)
  })
}

const TARGETS: Record<OnboardingTarget, Screen> = {
  'company-info': { name: 'company-info' },
  masters: { name: 'masters', tab: 'ledgers' },
  'voucher-entry': { name: 'voucher-entry' },
  'settings-backups': { name: 'settings', tab: 'backups' },
  'settings-invoice': { name: 'settings', tab: 'invoice' }
}

/** Where a checklist step's action navigates. */
export function onboardingScreen(checklist: OnboardingChecklist, stepId: string): Screen {
  const step = checklist.steps.find((s) => s.id === stepId)
  return step ? TARGETS[step.target] : { name: 'gateway' }
}
