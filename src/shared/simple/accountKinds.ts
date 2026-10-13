// The plain new-account question (WP 8.4, plan 2026-10-13 §4.1 / §7 WP 8.4): "This is a:
// Customer / Supplier / Expense / Income / Bank / Cash / Loan / Other…". Pure data + rules.
//
// Each kind maps to ONE standard group (DEFAULT_GROUPS) — the only place a simple screen decides a
// group. Expense and Income ask one more plain question (categories.ts `groupForNewCategory` for
// an expense; "from what you sell" vs "other income" for income). "Other…" is the escape hatch:
// the full group list, unchanged. Every kind's class agrees with the WP 5.6 classifier
// (ai/ledgerClass.ts) — unit + db tested — so memory checks and drafting see a quick-created
// account the same way the simple screens do.
import { CATEGORIES, groupForNewCategory, type CategoryKey, type NewCategoryKind } from './categories'

export const ACCOUNT_KINDS = ['customer', 'supplier', 'expense', 'income', 'bank', 'cash', 'loan', 'other'] as const
export type AccountKind = (typeof ACCOUNT_KINDS)[number]

/** What ai/ledgerClass.ts says about an account of the kind (the classifier's own names). */
export type KindClass = 'debtor' | 'creditor' | 'expense' | 'income' | 'bank' | 'cash' | 'other'

export const INCOME_KINDS = ['sales', 'other_income'] as const
export type IncomeKind = (typeof INCOME_KINDS)[number]

export interface AccountKindDef {
  /** Icon id (simple/icons.tsx). */
  icon: string
  /** True for customers / suppliers: the dialog asks phone, WhatsApp and GSTIN. */
  party: boolean
}

export const ACCOUNT_KIND_DEFS: Record<AccountKind, AccountKindDef> = {
  customer: { icon: 'users', party: true },
  supplier: { icon: 'truck', party: true },
  expense: { icon: 'receipt', party: false },
  income: { icon: 'cart', party: false },
  bank: { icon: 'bank', party: false },
  cash: { icon: 'wallet', party: false },
  loan: { icon: 'scale', party: false },
  other: { icon: 'more', party: false }
}

export interface KindAnswer {
  kind: Exclude<AccountKind, 'other'>
  /** Expense only: day-to-day (default) / stock you sell / something you'll use for years. */
  expenseKind?: NewCategoryKind
  /** Income only: from what you sell (default) / other income. */
  incomeKind?: IncomeKind
  /** A manufacturer's stock-you-sell cost is a making cost (Direct Expenses). */
  makingCost?: boolean
}

/** The standard group a plain answer lands in. */
export function groupForKind(a: KindAnswer): string {
  switch (a.kind) {
    case 'customer':
      return 'Sundry Debtors'
    case 'supplier':
      return 'Sundry Creditors'
    case 'bank':
      return 'Bank Accounts'
    case 'cash':
      return 'Cash-in-Hand'
    case 'loan':
      return 'Loans (Liability)'
    case 'income':
      return (a.incomeKind ?? 'sales') === 'sales' ? 'Sales Accounts' : 'Indirect Incomes'
    case 'expense':
      return groupForNewCategory(a.expenseKind ?? 'day_to_day', { makingCost: a.makingCost })
  }
}

/** The class ledgerClass.ts gives an account created from the answer. */
export function classForKind(a: KindAnswer): KindClass {
  switch (a.kind) {
    case 'customer':
      return 'debtor'
    case 'supplier':
      return 'creditor'
    case 'bank':
      return 'bank'
    case 'cash':
      return 'cash'
    case 'loan':
      return 'other'
    case 'income':
      return 'income'
    case 'expense':
      // Something you'll use for years is an asset (Fixed Assets), not a cost of the year.
      return (a.expenseKind ?? 'day_to_day') === 'use_for_years' ? 'other' : 'expense'
  }
}

/** Where the dialog was opened from — the kind it starts on (the user can change it). */
export type AccountContext =
  | { field: 'party'; side: 'sales' | 'purchase' }
  | { field: 'account'; side: 'sales' | 'purchase' }
  | { field: 'line'; voucherKind: string; drCr: 'dr' | 'cr' }
  | { field: 'loan' }
  | { field: 'none' }

/** The pre-picked answer for a context, or null when nothing sensible can be guessed. */
export function kindFromContext(ctx: AccountContext): KindAnswer | null {
  switch (ctx.field) {
    case 'party':
      return { kind: ctx.side === 'sales' ? 'customer' : 'supplier' }
    case 'account':
      return ctx.side === 'sales' ? { kind: 'income', incomeKind: 'sales' } : { kind: 'expense', expenseKind: 'stock_you_sell' }
    case 'loan':
      return { kind: 'loan' }
    case 'none':
      return null
    case 'line': {
      const { voucherKind: k, drCr } = ctx
      if (k === 'contra') return { kind: 'bank' }
      // Money out: what it was spent on is debited, the cash / bank it came from credited.
      if (k === 'payment') return drCr === 'dr' ? { kind: 'expense' } : { kind: 'bank' }
      // Money in: who paid is credited (a customer), where it went debited.
      if (k === 'receipt') return drCr === 'cr' ? { kind: 'customer' } : { kind: 'bank' }
      return null
    }
  }
}

/** The categories a category picker offers for a use, seeded / common ones first. */
export function categoriesFor(use: 'expense' | 'income'): CategoryKey[] {
  const uses = use === 'expense' ? ['expense', 'purchase'] : ['income', 'sale']
  return (Object.keys(CATEGORIES) as CategoryKey[]).filter((k) => (uses as readonly string[]).includes(CATEGORIES[k].use))
}

/** A phone number as people write it: digits with an optional leading +, spaces, dashes and
 *  brackets; 6–15 digits (E.164 allows at most 15). The ledger schema uses the same rule. */
export function isPhoneNumber(s: string): boolean {
  const t = s.trim()
  return /^\+?[0-9 ()-]+$/.test(t) && /^\d{6,15}$/.test(t.replace(/\D/g, ''))
}
