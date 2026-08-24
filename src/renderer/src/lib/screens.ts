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
  /** Gateway card subtitle. The card's shortcut badge comes from `accel`. */
  card?: { sub: string }
  /**
   * Bare-key accelerator — the letter rendered red in the sidebar and on the Gateway card, and
   * the key that navigates here from anywhere (the `nav` keyboard layer in App.tsx).
   *
   * Single uppercase A-Z or 0-9, unique across SCREENS, and normally a letter that actually
   * occurs in the rendered label so it can be highlighted in place (Tally's convention:
   * "Ba_l_ance Sheet"). `accel.test.ts` enforces all three, so adding a screen without a letter
   * -- or reusing one -- fails CI rather than silently shadowing an existing shortcut.
   *
   * A screen whose label has no free letter left may use one that is not in the label (only TDS
   * today); it renders as a trailing key badge instead of a highlight, and must be listed in
   * that test's BADGE_ACCELS allowlist.
   */
  accel?: string
  /** Extra command-palette search terms beyond the title. */
  keywords?: string[]
  /**
   * Query-key families to refresh when this screen becomes visible (App.tsx). Each entry must
   * be the FIRST element of a real `useQuery` key somewhere under screens/** — invalidation
   * matches by prefix, so a name no query uses is a silent no-op. When adding a query to a
   * screen (including expandable sub-queries), add its family here too.
   */
  invalidates: string[]
}

export const SCREENS: ScreenDef[] = [
  {
    name: 'gateway',
    title: 'Gateway',
    screen: { name: 'gateway' },
    navSection: 'top',
    accel: 'G',
    invalidates: ['dashboard', 'recurring']
  },
  {
    name: 'voucher-entry',
    title: 'Voucher entry',
    screen: { name: 'voucher-entry' },
    navSection: 'top',
    accel: 'V',
    card: { sub: 'Sales, purchase, payment…' },
    invalidates: ['voucher', 'nextNumber', 'billsOpen', 'ledgers', 'stockItems', 'units', 'currencies', 'voucherTypes']
  },
  {
    name: 'daybook',
    title: 'Day book',
    screen: { name: 'daybook' },
    navSection: 'top',
    accel: 'D',
    card: { sub: 'Every entry, in order' },
    invalidates: ['daybook']
  },
  {
    name: 'masters',
    keywords: ['ledgers', 'items', 'groups', 'units', 'voucher types', 'currencies', 'godowns', 'stock groups'],
    title: 'Masters',
    screen: { name: 'masters' },
    navSection: 'top',
    accel: 'M',
    card: { sub: 'Ledgers, items, groups' },
    invalidates: [
      'ledgers', 'groups', 'groupTree', 'stockItems', 'units', 'voucherTypes', 'currencies', 'bom',
      'godowns', 'stockGroups'
    ]
  },
  {
    name: 'recurring',
    keywords: ['templates', 'scheduled'],
    title: 'Recurring vouchers',
    screen: { name: 'recurring' },
    navSection: 'top',
    accel: 'H',
    invalidates: ['recurring']
  },
  {
    name: 'import-tally',
    title: 'Import from Tally',
    screen: { name: 'import-tally' },
    navSection: 'top',
    accel: 'I',
    invalidates: []
  },

  {
    name: 'trial-balance',
    title: 'Trial balance',
    screen: { name: 'trial-balance' },
    navSection: 'books',
    accel: 'T',
    card: { sub: 'All closing balances' },
    invalidates: ['trialBalance']
  },
  {
    name: 'profit-loss',
    title: 'Profit & Loss',
    screen: { name: 'profit-loss' },
    navSection: 'books',
    accel: 'P',
    card: { sub: 'Trading + P&L account' },
    invalidates: ['pnl']
  },
  {
    name: 'balance-sheet',
    title: 'Balance sheet',
    screen: { name: 'balance-sheet' },
    navSection: 'books',
    accel: 'B',
    card: { sub: 'Assets and liabilities' },
    invalidates: ['balanceSheet']
  },
  {
    name: 'cash-flow',
    keywords: ['cash flow statement'],
    title: 'Cash flow',
    screen: { name: 'cash-flow' },
    navSection: 'books',
    accel: 'F',
    invalidates: ['cashFlow']
  },
  {
    name: 'stock-summary',
    title: 'Stock summary',
    screen: { name: 'stock-summary' },
    navSection: 'books',
    accel: 'S',
    feature: 'inventory',
    card: { sub: 'Quantities and value' },
    invalidates: ['stockSummary', 'stockAgeing', 'stockByGodown', 'stockBatches']
  },
  {
    name: 'year-end',
    title: 'Year-end close',
    screen: { name: 'year-end' },
    navSection: 'books',
    accel: 'A',
    invalidates: ['yearEndPreview']
  },

  {
    name: 'registers',
    keywords: ['sales register', 'purchase register'],
    title: 'Registers',
    screen: { name: 'registers' },
    navSection: 'analysis',
    accel: 'R',
    invalidates: ['register']
  },
  {
    name: 'outstandings',
    keywords: ['ageing', 'receivables', 'payables', 'bills'],
    title: 'Outstandings',
    screen: { name: 'outstandings' },
    navSection: 'analysis',
    accel: 'O',
    invalidates: ['outstandings']
  },
  {
    name: 'consolidated',
    title: 'Consolidated reports',
    screen: { name: 'consolidated' },
    navSection: 'analysis',
    accel: 'L',
    invalidates: ['consolidated', 'company-registry']
  },
  {
    name: 'cost-centres',
    title: 'Cost centres',
    screen: { name: 'cost-centres' },
    navSection: 'analysis',
    accel: 'C',
    feature: 'costCentres',
    invalidates: ['costCentres', 'ccReport', 'ccStatement']
  },
  {
    name: 'budgets',
    title: 'Budgets',
    screen: { name: 'budgets' },
    navSection: 'analysis',
    accel: 'U',
    invalidates: ['budgets', 'budgetVariance']
  },
  {
    name: 'exceptions',
    keywords: ['exception reports', 'negative stock', 'unreconciled'],
    title: 'Exceptions',
    screen: { name: 'exceptions' },
    navSection: 'analysis',
    accel: 'X',
    invalidates: ['exceptions']
  },

  {
    name: 'banking',
    keywords: ['bank reconciliation', 'brs', 'post-dated', 'pdc'],
    title: 'Banking — reconciliation, BRS & post-dated',
    screen: { name: 'banking' },
    navSection: 'banking',
    accel: 'N',
    navLabel: 'Reconciliation',
    invalidates: ['bankLedgers', 'bankRecon', 'bankRules', 'chequeConfig', 'brs', 'pdc']
  },

  {
    name: 'payroll',
    title: 'Payroll — employees & runs',
    screen: { name: 'payroll' },
    navSection: 'payroll',
    accel: 'Y',
    navLabel: 'Payroll',
    feature: 'payroll',
    invalidates: ['employees', 'payrollRuns', 'payrollPreview', 'payHeads', 'employeeHeads', 'ptSummary']
  },

  {
    name: 'gstr1',
    title: 'GSTR-1',
    screen: { name: 'gstr1' },
    navSection: 'gst',
    accel: '1',
    card: { sub: 'Outward supplies return' },
    invalidates: ['gstr1', 'gstValidate']
  },
  {
    name: 'gstr3b',
    title: 'GSTR-3B',
    screen: { name: 'gstr3b' },
    navSection: 'gst',
    accel: '3',
    card: { sub: 'Summary return + ITC' },
    invalidates: ['gstr3b', 'gst3bManual']
  },
  {
    name: 'gstr2b',
    keywords: ['reconciliation', 'itc'],
    title: 'GSTR-2B recon',
    screen: { name: 'gstr2b' },
    navSection: 'gst',
    accel: '2',
    invalidates: ['gstr2b', 'ledgers']
  },
  {
    name: 'edocs',
    keywords: ['e-invoice', 'e-way bill', 'irn', 'ewb'],
    title: 'e-Invoice & e-Way',
    screen: { name: 'edocs' },
    navSection: 'gst',
    accel: 'W',
    invalidates: ['edocList', 'nicStatus', 'nicCreds']
  },
  {
    name: 'filings',
    title: 'Filing register',
    screen: { name: 'filings' },
    navSection: 'gst',
    navLabel: 'Filing register',
    // A badge rather than a highlighted letter: every letter of "Filing register" is already
    // claimed, so Q rides on the end the way TDS's K does. See __tests__/accel.test.ts.
    accel: 'Q',
    keywords: ['filing', 'filed', 'arn', 'late fee', 'interest', 'due', 'overdue', 'calendar'],
    invalidates: ['filings']
  },
  {
    name: 'composition',
    title: 'Composition — CMP-08 & GSTR-4',
    screen: { name: 'composition' },
    navSection: 'gst',
    navLabel: 'CMP-08 & GSTR-4',
    accel: '4',
    keywords: ['composition', 'cmp08', 'cmp-08', 'gstr4', 'gstr-4', 'quarterly', 'scheme'],
    invalidates: ['cmp08', 'gstr4']
  },
  {
    name: 'tds',
    title: 'TDS',
    screen: { name: 'tds' },
    navSection: 'gst',
    accel: 'K',
    feature: 'tds',
    invalidates: ['tdsSummary', 'tdsSections']
  },

  {
    name: 'settings',
    title: 'Settings',
    screen: { name: 'settings' },
    navSection: 'system',
    accel: 'E',
    invalidates: [
      'backups', 'bin', 'users', 'audit', 'nicCreds', 'nicStatus',
      'features', 'invoiceConfig', 'invoicePreview', 'appInfo', 'companyLock', 'agentConfig'
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
