/**
 * The getting-started checklist.
 *
 * Every step is DERIVED from the books rather than ticked off by hand. A checklist someone can
 * tick without doing the thing is a checklist that lies, and the one moment it matters is the
 * moment a new user is deciding whether this application is going to work for them.
 *
 * It also means the list is self-healing: delete the only voucher and that step opens again,
 * which is correct — the book really is empty.
 */

export interface ChecklistStep {
  id: string
  label: string
  /** Why this step matters, in one sentence. Shown under the label while the step is open. */
  why: string
  done: boolean
  /** Where to go to do it. Null for a step with nothing to open (learning the shortcuts). */
  screen: string | null
}

export interface ChecklistState {
  steps: ChecklistStep[]
  doneCount: number
  /** True once every step is done — at which point the checklist stops being shown. */
  complete: boolean
}

export interface ChecklistFacts {
  hasCompanyAddress: boolean
  hasGstin: boolean
  /** Registration is deliberately allowed to be 'unregistered' — that is a complete answer. */
  gstAnswered: boolean
  ledgerCount: number
  voucherCount: number
  hasVerifiedBackup: boolean
  hasSeenShortcuts: boolean
}

/**
 * Build the checklist from what the books already show.
 *
 * The ledger threshold is deliberately above the seeded count: a fresh company arrives with Cash
 * and the standard groups, so "has ledgers" would be true before the user had done anything, and
 * a step that is already ticked on arrival teaches nothing.
 */
export const SEEDED_LEDGER_COUNT = 1

export function buildChecklist(facts: ChecklistFacts): ChecklistState {
  const steps: ChecklistStep[] = [
    {
      id: 'company',
      label: 'Fill in your company details',
      why: 'Your name, address and state appear on every invoice and drive the CGST/SGST split.',
      done: facts.hasCompanyAddress && facts.gstAnswered,
      screen: 'company-info'
    },
    {
      id: 'gstin',
      label: 'Add your GSTIN',
      why: 'Without it the GST returns cannot be exported. Skip it if you are not registered.',
      done: facts.hasGstin || !facts.gstAnswered ? facts.hasGstin : true,
      screen: 'company-info'
    },
    {
      id: 'ledgers',
      label: 'Create your ledgers',
      why: 'Customers, suppliers, bank accounts and expense heads — the names your entries land on.',
      done: facts.ledgerCount > SEEDED_LEDGER_COUNT,
      screen: 'masters'
    },
    {
      id: 'voucher',
      label: 'Post your first voucher',
      why: 'Every report in the app is computed from vouchers, so nothing shows until one exists.',
      done: facts.voucherCount > 0,
      screen: 'voucher-entry'
    },
    {
      id: 'shortcuts',
      label: 'Learn the red letters',
      why: 'One letter of every menu item is red. Press it and you are there, from any screen.',
      done: facts.hasSeenShortcuts,
      screen: null
    },
    {
      id: 'backup',
      label: 'Check that your backup restores',
      why: 'Backups happen automatically. Proving one opens and its books balance takes a click.',
      done: facts.hasVerifiedBackup,
      screen: 'settings'
    }
  ]

  const doneCount = steps.filter((s) => s.done).length
  return { steps, doneCount, complete: doneCount === steps.length }
}
