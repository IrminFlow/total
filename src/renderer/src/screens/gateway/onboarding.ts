import type { DashSetup } from '@shared/dashboard'
import type { Screen } from '../../state/stores'

// TODO(WP 1.10a): replace with the shared onboarding-checklist function from the design-system
// work package once it lands — this local version only derives step state from the dashboard's
// `setup` section so the Gateway card can swap to it with a one-line change.

export interface OnboardingStep {
  id: 'company' | 'gstin' | 'ledgers' | 'bank' | 'voucher' | 'backup'
  label: string
  hint: string
  done: boolean
  target: Screen
}

export function onboardingSteps(s: DashSetup): OnboardingStep[] {
  const steps: OnboardingStep[] = [
    { id: 'company', label: 'Complete company details', hint: 'Address, phone or email, and PAN', done: s.companyInfoComplete, target: { name: 'company-info' } },
    { id: 'gstin', label: 'Add your GSTIN', hint: 'Company info → GST registration', done: s.gstinSet, target: { name: 'company-info' } },
    { id: 'ledgers', label: 'Add parties and accounts', hint: 'Masters → Ledgers, or import from Tally', done: s.userLedgers > 0, target: { name: 'masters', tab: 'ledgers' } },
    { id: 'bank', label: 'Add a bank account', hint: 'A ledger under Bank Accounts', done: s.bankLedgers > 0, target: { name: 'masters', tab: 'ledgers' } },
    { id: 'voucher', label: 'Post your first voucher', hint: 'Voucher entry — F8 for Sales', done: s.voucherCount > 0, target: { name: 'voucher-entry', kindHint: 'sales' } },
    { id: 'backup', label: 'Take a backup', hint: 'Settings → Backups (the automatic on-open copy does not count)', done: s.userBackups > 0, target: { name: 'settings', tab: 'backups' } }
  ]
  // Unregistered businesses have no GSTIN to add.
  return s.gstRegistered ? steps : steps.filter((st) => st.id !== 'gstin')
}
