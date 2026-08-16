import type { Screen } from '../state/stores'
import type { CompanyFeatures } from '@shared/features'

/**
 * The single screen registry — Shell's sidebar NAV, the Gateway cards, the CommandPalette's
 * navigation commands, ShortcutHelp's Gateway group, and App.tsx's scoped query invalidation
 * all derive from this list. Add a screen once here and every surface picks it up.
 */

export type NavSectionId = 'top' | 'books' | 'analysis' | 'banking' | 'payroll' | 'gst' | 'system'

/** Sidebar section order + titles (null = the untitled block at the top). */
export const NAV_SECTIONS: { id: NavSectionId; title: string | null; feature?: keyof CompanyFeatures }[] = [
  { id: 'top', title: null },
  { id: 'books', title: 'Books' },
  { id: 'analysis', title: 'Analysis' },
  { id: 'banking', title: 'Banking' },
  { id: 'payroll', title: 'Payroll', feature: 'payroll' },
  { id: 'gst', title: 'GST' },
  { id: 'system', title: 'System' }
]

export interface ScreenDef {
  name: Screen['name']
  /** Canonical name — used by the command palette (and the sidebar unless navLabel differs). */
  title: string
  /** Default navigation target (screens with required params aren't navigable from here). */
  screen: Screen | null
  /** Sidebar placement; null = not in the sidebar. */
  navSection: NavSectionId | null
  /** Sidebar label when shorter than the palette title. */
  navLabel?: string
  /** Hidden everywhere (render-only) when this feature is off. */
  feature?: keyof CompanyFeatures
  /** Gateway card: subtitle + single-letter shortcut (also ShortcutHelp's Gateway group). */
  card?: { sub: string; key: string }
  /** Extra command-palette search terms beyond the title. */
  keywords?: string[]
  /** Query-key families to refresh when this screen becomes visible (App.tsx). */
  invalidates: string[]
}

export const SCREENS: ScreenDef[] = [
  {
    name: 'gateway',
    title: 'Gateway',
    screen: { name: 'gateway' },
    navSection: 'top',
    invalidates: ['dashboard', 'recurring']
  },
  {
    name: 'voucher-entry',
    title: 'Voucher entry',
    screen: { name: 'voucher-entry' },
    navSection: 'top',
    card: { sub: 'Sales, purchase, payment…', key: 'V' },
    invalidates: ['voucher', 'nextNumber', 'billsOpen', 'ledgers', 'stockItems', 'units', 'currencies', 'voucherTypes']
  },
  {
    name: 'daybook',
    title: 'Day book',
    screen: { name: 'daybook' },
    navSection: 'top',
    card: { sub: 'Every entry, in order', key: 'D' },
    invalidates: ['daybook']
  },
  {
    name: 'masters',
    keywords: ['ledgers', 'items', 'groups', 'units', 'voucher types', 'currencies'],
    title: 'Masters',
    screen: { name: 'masters' },
    navSection: 'top',
    card: { sub: 'Ledgers, items, groups', key: 'M' },
    invalidates: ['ledgers', 'groups', 'groupTree', 'stockItems', 'units', 'voucherTypes', 'currencies', 'bom']
  },
  {
    name: 'recurring',
    keywords: ['templates', 'scheduled'],
    title: 'Recurring vouchers',
    screen: { name: 'recurring' },
    navSection: 'top',
    invalidates: ['recurring']
  },
  {
    name: 'import-tally',
    title: 'Import from Tally',
    screen: { name: 'import-tally' },
    navSection: 'top',
    invalidates: []
  },

  {
    name: 'trial-balance',
    title: 'Trial balance',
    screen: { name: 'trial-balance' },
    navSection: 'books',
    card: { sub: 'All closing balances', key: 'T' },
    invalidates: ['trialBalance']
  },
  {
    name: 'profit-loss',
    title: 'Profit & Loss',
    screen: { name: 'profit-loss' },
    navSection: 'books',
    card: { sub: 'Trading + P&L account', key: 'P' },
    invalidates: ['pnl']
  },
  {
    name: 'balance-sheet',
    title: 'Balance sheet',
    screen: { name: 'balance-sheet' },
    navSection: 'books',
    card: { sub: 'Assets and liabilities', key: 'B' },
    invalidates: ['balanceSheet']
  },
  {
    name: 'cash-flow',
    keywords: ['cash flow statement'],
    title: 'Cash flow',
    screen: { name: 'cash-flow' },
    navSection: 'books',
    invalidates: ['cashFlow']
  },
  {
    name: 'stock-summary',
    title: 'Stock summary',
    screen: { name: 'stock-summary' },
    navSection: 'books',
    feature: 'inventory',
    card: { sub: 'Quantities and value', key: 'S' },
    invalidates: ['stockSummary', 'stockAgeing']
  },
  {
    name: 'year-end',
    title: 'Year-end close',
    screen: { name: 'year-end' },
    navSection: 'books',
    invalidates: ['yearEndPreview']
  },

  {
    name: 'registers',
    keywords: ['sales register', 'purchase register'],
    title: 'Registers',
    screen: { name: 'registers' },
    navSection: 'analysis',
    invalidates: ['register']
  },
  {
    name: 'outstandings',
    keywords: ['ageing', 'receivables', 'payables', 'bills'],
    title: 'Outstandings',
    screen: { name: 'outstandings' },
    navSection: 'analysis',
    invalidates: ['outstandings']
  },
  {
    name: 'consolidated',
    title: 'Consolidated reports',
    screen: { name: 'consolidated' },
    navSection: 'analysis',
    invalidates: ['consolidated', 'company-registry']
  },
  {
    name: 'cost-centres',
    title: 'Cost centres',
    screen: { name: 'cost-centres' },
    navSection: 'analysis',
    feature: 'costCentres',
    invalidates: ['costCentres', 'ccReport', 'ccStatement']
  },
  {
    name: 'budgets',
    title: 'Budgets',
    screen: { name: 'budgets' },
    navSection: 'analysis',
    invalidates: ['budgets', 'budgetVariance']
  },
  {
    name: 'exceptions',
    keywords: ['exception reports', 'negative stock', 'unreconciled'],
    title: 'Exceptions',
    screen: { name: 'exceptions' },
    navSection: 'analysis',
    invalidates: ['exceptions']
  },

  {
    name: 'banking',
    keywords: ['bank reconciliation', 'brs', 'post-dated', 'pdc'],
    title: 'Banking — reconciliation, BRS & post-dated',
    screen: { name: 'banking' },
    navSection: 'banking',
    navLabel: 'Reconciliation',
    invalidates: ['bankLedgers', 'bankRecon', 'bankRules', 'chequeConfig', 'brs', 'pdc']
  },

  {
    name: 'payroll',
    title: 'Payroll — employees & runs',
    screen: { name: 'payroll' },
    navSection: 'payroll',
    navLabel: 'Employees & runs',
    feature: 'payroll',
    invalidates: ['employees', 'payrollRuns', 'payrollPreview', 'payHeads', 'employeeHeads', 'ptSummary']
  },

  {
    name: 'gstr1',
    title: 'GSTR-1',
    screen: { name: 'gstr1' },
    navSection: 'gst',
    card: { sub: 'Outward supplies return', key: '1' },
    invalidates: ['gstr1']
  },
  {
    name: 'gstr3b',
    title: 'GSTR-3B',
    screen: { name: 'gstr3b' },
    navSection: 'gst',
    card: { sub: 'Summary return + ITC', key: '3' },
    invalidates: ['gstr3b']
  },
  {
    name: 'gstr2b',
    keywords: ['reconciliation', 'itc'],
    title: 'GSTR-2B recon',
    screen: { name: 'gstr2b' },
    navSection: 'gst',
    invalidates: ['gstr2b', 'ledgers']
  },
  {
    name: 'edocs',
    keywords: ['e-invoice', 'e-way bill', 'irn', 'ewb'],
    title: 'e-Invoice & e-Way',
    screen: { name: 'edocs' },
    navSection: 'gst',
    invalidates: ['edocList', 'nicStatus', 'nicCreds']
  },
  {
    name: 'tds',
    title: 'TDS',
    screen: { name: 'tds' },
    navSection: 'gst',
    feature: 'tds',
    invalidates: ['tdsSummary', 'tdsSections']
  },

  {
    name: 'settings',
    title: 'Settings',
    screen: { name: 'settings' },
    navSection: 'system',
    invalidates: [
      'backups', 'bin', 'users', 'audit', 'nicCreds', 'nicStatus',
      'features', 'invoiceConfig', 'invoicePreview', 'appInfo', 'companyLock'
    ]
  },

  // Not in the sidebar — reached from the header / other screens — but the palette and the
  // invalidation map still need them.
  {
    name: 'company-info',
    keywords: ['company details', 'gstin', 'pan'],
    title: 'Company details',
    screen: { name: 'company-info' },
    navSection: null,
    invalidates: []
  },
  {
    name: 'ledger-statement',
    title: 'Ledger statement',
    screen: null, // needs a ledgerId — reached from ledger lists/search, never bare navigation
    navSection: null,
    invalidates: ['ledgerStatement']
  }
]

const byName = new Map(SCREENS.map((s) => [s.name, s]))

export function screenDef(name: Screen['name']): ScreenDef | undefined {
  return byName.get(name)
}

/** Gateway cards, in registry order. */
export const CARD_SCREENS: (ScreenDef & { card: NonNullable<ScreenDef['card']>; screen: Screen })[] = SCREENS.filter(
  (s): s is ScreenDef & { card: NonNullable<ScreenDef['card']>; screen: Screen } => !!s.card && !!s.screen
)

/** Query-key families to refresh when `name` becomes the visible screen. */
export function invalidationFamilies(name: Screen['name']): string[] {
  return byName.get(name)?.invalidates ?? []
}
