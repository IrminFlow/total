/**
 * The month-end close checklist.
 *
 * Closing a month is a sequence a bookkeeper holds in their head, and the parts people forget
 * are the boring ones: the bank not reconciled, the suspense balance nobody chased, the backup
 * not taken before the period was locked. None of that needs a language model — every item here
 * is a number Total already computes, compared against a rule.
 *
 * The assistant's role is narrow and deliberate: it reads this list and talks about it. It does
 * not decide what "ready to close" means, because that decision has to be reproducible, and a
 * checklist that says something different on Tuesday is not a checklist.
 *
 * Read-only throughout. Nothing here closes anything; the Year End screen does that, with a
 * human pressing the button.
 */

export type CheckStatus = 'ok' | 'attention' | 'blocked' | 'skipped'

export interface CheckItem {
  id: string
  label: string
  status: CheckStatus
  /** The figure behind the status, already formatted. */
  detail: string
  /** Why it matters, for someone closing their first month. */
  why: string
  /** Screen name to open, where there is one. */
  screen?: string
}

/**
 * Everything the checklist needs, computed by the caller.
 *
 * A flat bag of primitives rather than a database handle, so the rules are testable without a
 * database and the same rules serve the screen, the tool and the test.
 */
export interface CloseInputs {
  /** The month being closed, as its first and last day. */
  from: string
  to: string
  unbalancedVouchers: number
  negativeStockItems: number
  /** Bank lines in the period with no bank date against them. */
  unreconciledBankLines: number
  bankLedgers: number
  gstBlockingIssues: number
  gstWarnings: number
  /** Vouchers waiting on an approver. */
  pendingApprovals: number
  /** Recurring templates that were due in the period and never posted. */
  recurringDue: number
  /** Balance sitting in Suspense at the end of the month, in paise. */
  suspensePaise: number
  /** Days since the last backup, or null when there has never been one. */
  lastBackupDaysAgo: number | null
  /** Date the books are locked up to, or null. */
  lockedUpTo: string | null
  /** Receivables older than 90 days, in paise. */
  overdue90Paise: number
  /** Null when the feature is off — the item is then skipped rather than failed. */
  payrollPosted: boolean | null
  /** Formatter injected so this module keeps no dependency on money formatting rules. */
  money: (paise: number) => string
}

export interface CloseChecklist {
  from: string
  to: string
  items: CheckItem[]
  blocked: number
  attention: number
  /** True when nothing is blocked — the month can be locked. */
  readyToLock: boolean
}

export function closeChecklist(input: CloseInputs): CloseChecklist {
  const money = input.money
  const items: CheckItem[] = [
    {
      id: 'unbalanced',
      label: 'Every voucher balances',
      status: input.unbalancedVouchers > 0 ? 'blocked' : 'ok',
      detail: input.unbalancedVouchers > 0 ? `${input.unbalancedVouchers} unbalanced` : 'All balanced',
      why: 'An unbalanced voucher makes the trial balance wrong, and every report is computed from those lines.',
      screen: 'exceptions'
    },
    {
      id: 'suspense',
      label: 'Suspense is empty',
      status: input.suspensePaise !== 0 ? 'attention' : 'ok',
      detail: input.suspensePaise !== 0 ? `${money(input.suspensePaise)} sitting in Suspense` : 'Nothing in Suspense',
      why: 'Suspense is where an entry goes when nobody knew the account. Left there, it becomes last year\'s mystery.',
      screen: 'trial-balance'
    },
    {
      id: 'bank',
      label: 'Bank reconciled',
      status: input.bankLedgers === 0 ? 'skipped' : input.unreconciledBankLines > 0 ? 'attention' : 'ok',
      detail:
        input.bankLedgers === 0
          ? 'No bank ledgers'
          : input.unreconciledBankLines > 0
            ? `${input.unreconciledBankLines} entries with no bank date`
            : 'Every entry matched',
      why: 'The bank statement is the one figure in the books that an outside party also holds. It is the cheapest check there is.',
      screen: 'banking'
    },
    {
      id: 'gst',
      label: 'GST return clean',
      status: input.gstBlockingIssues > 0 ? 'blocked' : input.gstWarnings > 0 ? 'attention' : 'ok',
      detail:
        input.gstBlockingIssues > 0
          ? `${input.gstBlockingIssues} blocking, ${input.gstWarnings} warnings`
          : input.gstWarnings > 0
            ? `${input.gstWarnings} warnings`
            : 'Nothing blocking',
      why: 'A blocking issue stops the export, and the return is due whether or not the books are ready.',
      screen: 'gstr1'
    },
    {
      id: 'stock',
      label: 'No negative stock',
      status: input.negativeStockItems > 0 ? 'attention' : 'ok',
      detail: input.negativeStockItems > 0 ? `${input.negativeStockItems} items below zero` : 'No item below zero',
      why: 'Negative stock means a sale was entered before its purchase. The valuation is wrong until the order is fixed.',
      screen: 'stock-summary'
    },
    {
      id: 'approvals',
      label: 'Nothing waiting on an approver',
      status: input.pendingApprovals > 0 ? 'attention' : 'ok',
      detail: input.pendingApprovals > 0 ? `${input.pendingApprovals} pending` : 'Nothing pending',
      why: 'A voucher waiting for approval is in the books but not agreed. Closing over it means agreeing by default.',
      screen: 'daybook'
    },
    {
      id: 'recurring',
      label: 'Recurring entries posted',
      status: input.recurringDue > 0 ? 'attention' : 'ok',
      detail: input.recurringDue > 0 ? `${input.recurringDue} due and unposted` : 'None outstanding',
      why: 'Rent, EMI and subscriptions do not stop because nobody typed them. A missed one understates the month.',
      screen: 'recurring'
    },
    {
      id: 'payroll',
      label: 'Payroll posted',
      status: input.payrollPosted === null ? 'skipped' : input.payrollPosted ? 'ok' : 'attention',
      detail: input.payrollPosted === null ? 'Payroll is off' : input.payrollPosted ? 'Posted' : 'Not posted for this month',
      why: 'Salaries are usually the largest single expense in the month, and the one most often posted late.',
      screen: 'payroll'
    },
    {
      id: 'overdue',
      label: 'Old receivables chased',
      status: input.overdue90Paise > 0 ? 'attention' : 'ok',
      detail: input.overdue90Paise > 0 ? `${money(input.overdue90Paise)} older than 90 days` : 'Nothing over 90 days',
      why: 'Debt gets harder to collect the longer it sits. Month end is when anyone actually looks.',
      screen: 'collections'
    },
    {
      id: 'backup',
      label: 'Recent backup',
      status: input.lastBackupDaysAgo === null ? 'blocked' : input.lastBackupDaysAgo > 7 ? 'attention' : 'ok',
      detail:
        input.lastBackupDaysAgo === null
          ? 'Never backed up'
          : input.lastBackupDaysAgo === 0
            ? 'Backed up today'
            : `${input.lastBackupDaysAgo} days ago`,
      why: 'Locking a period is the moment to have a copy. Everything here lives on one machine.',
      screen: 'settings'
    },
    {
      id: 'lock',
      label: 'Period locked',
      status: input.lockedUpTo != null && input.lockedUpTo >= input.to ? 'ok' : 'attention',
      detail: input.lockedUpTo ? `Locked up to ${input.lockedUpTo}` : 'Not locked',
      why: 'Locking is what makes a closed month stay closed — an unlocked period silently accepts a backdated entry.',
      screen: 'year-end'
    }
  ]

  const blocked = items.filter((i) => i.status === 'blocked').length
  const attention = items.filter((i) => i.status === 'attention').length
  return { from: input.from, to: input.to, items, blocked, attention, readyToLock: blocked === 0 }
}
