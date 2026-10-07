/**
 * Onboarding checklist (WP 1.10a) — pure derivation of "what's left to set up" from data the app
 * already has. Nothing is stored: every step is recomputed from the company's facts, so a step
 * ticks itself the moment the user does the thing anywhere in the app.
 *
 * Consumed by the Gateway (WP 1.10b) through the renderer hook `useOnboardingChecklist`
 * (renderer/src/lib/onboarding.ts) and the kit `Checklist` component.
 */
import type { CompanyInfo } from './domain'
import { DEFAULT_INVOICE_CONFIG, type InvoiceConfig } from './invoiceConfig'

export type OnboardingStepId = 'company' | 'gstin' | 'ledger' | 'voucher' | 'bank' | 'backup' | 'invoice'

/** Where a step's action takes the user (the renderer maps it to a Screen). */
export type OnboardingTarget = 'company-info' | 'masters' | 'voucher-entry' | 'settings-backups' | 'settings-invoice'

export interface OnboardingStep {
  id: OnboardingStepId
  label: string
  hint: string
  done: boolean
  /** Not applicable to this company (e.g. GSTIN for an unregistered business) — counts as done. */
  skipped?: boolean
  target: OnboardingTarget
}

export interface OnboardingChecklist {
  steps: OnboardingStep[]
  doneCount: number
  total: number
  complete: boolean
}

export interface OnboardingFacts {
  company: Pick<CompanyInfo, 'name' | 'address' | 'stateCode' | 'gstin' | 'gstRegistrationType' | 'email' | 'phone'> | null
  /** All ledgers (seeded system ledgers carry isSystem). */
  ledgers: readonly { isSystem: boolean; groupId: number }[]
  /** All account groups, for finding ledgers under Bank Accounts / Bank OD A/c (any depth). */
  groups: readonly { id: number; name: string; parentId: number | null }[]
  /** Vouchers in the books (DashboardData.voucherCount). */
  voucherCount: number
  /** Backups on disk (api.backups.list().length). */
  backupCount: number
  /** The invoice print setup differs from the defaults — see isInvoiceConfigCustomised. */
  invoiceConfigured: boolean
}

const BANK_GROUPS = ['Bank Accounts', 'Bank OD A/c']

const filled = (s: string | null | undefined): boolean => !!s && s.trim() !== ''

/** True when the invoice print setup has been touched (any field differs from the defaults). */
export function isInvoiceConfigCustomised(config: InvoiceConfig | null | undefined, defaults: InvoiceConfig = DEFAULT_INVOICE_CONFIG): boolean {
  if (!config) return false
  return (Object.keys(defaults) as (keyof InvoiceConfig)[]).some((k) => JSON.stringify(config[k]) !== JSON.stringify(defaults[k]))
}

/** Group ids at or under the bank groups (Bank Accounts, Bank OD A/c and their sub-groups). */
function bankGroupIds(groups: OnboardingFacts['groups']): Set<number> {
  const byId = new Map(groups.map((g) => [g.id, g]))
  const ids = new Set<number>()
  for (const g of groups) {
    let cur: (typeof groups)[number] | undefined = g
    for (let depth = 0; cur && depth < 32; depth++) {
      if (BANK_GROUPS.includes(cur.name)) {
        ids.add(g.id)
        break
      }
      cur = cur.parentId == null ? undefined : byId.get(cur.parentId)
    }
  }
  return ids
}

export function deriveOnboarding(facts: OnboardingFacts): OnboardingChecklist {
  const c = facts.company
  const companyDone = !!c && filled(c.name) && filled(c.address) && filled(c.stateCode) && (filled(c.email) || filled(c.phone))
  const unregistered = c?.gstRegistrationType === 'unregistered'
  const banks = bankGroupIds(facts.groups)

  const steps: OnboardingStep[] = [
    {
      id: 'company',
      label: 'Fill in company details',
      hint: 'Address, state and a phone or email — they print on every invoice.',
      done: companyDone,
      target: 'company-info'
    },
    {
      id: 'gstin',
      label: 'Add your GSTIN',
      hint: unregistered ? 'Not needed — the company is unregistered for GST.' : 'Needed for GST returns and tax invoices.',
      done: unregistered || filled(c?.gstin),
      skipped: unregistered || undefined,
      target: 'company-info'
    },
    {
      id: 'ledger',
      label: 'Create your first ledger',
      hint: 'A customer, supplier or expense account of your own.',
      done: facts.ledgers.some((l) => !l.isSystem),
      target: 'masters'
    },
    {
      id: 'bank',
      label: 'Add a bank account',
      hint: 'A ledger under Bank Accounts, for payments and reconciliation.',
      done: facts.ledgers.some((l) => banks.has(l.groupId)),
      target: 'masters'
    },
    {
      id: 'voucher',
      label: 'Enter your first voucher',
      hint: 'A sale, purchase, payment or receipt.',
      done: facts.voucherCount > 0,
      target: 'voucher-entry'
    },
    {
      id: 'invoice',
      label: 'Set up your invoice',
      hint: 'Logo, bank details, terms and signatory.',
      done: facts.invoiceConfigured,
      target: 'settings-invoice'
    },
    {
      id: 'backup',
      label: 'Take a backup',
      hint: 'Everything stays on this Mac — keep a copy somewhere safe.',
      done: facts.backupCount > 0,
      target: 'settings-backups'
    }
  ]
  const doneCount = steps.filter((s) => s.done).length
  return { steps, doneCount, total: steps.length, complete: doneCount === steps.length }
}
