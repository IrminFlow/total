import type { Screen } from '../state/stores'
import type { CompanyFeatures } from '@shared/features'

/**
 * The single screen registry — Shell's sidebar NAV, the Gateway cards, the CommandPalette's
 * navigation commands, ShortcutHelp's Gateway group, and App.tsx's scoped query invalidation
 * all derive from this list. Add a screen once here and every surface picks it up.
 */

export type NavSectionId = 'top' | 'trade' | 'books' | 'analysis' | 'banking' | 'payroll' | 'gst' | 'system'

/** Sidebar section order + titles (null = the untitled block at the top). */
export const NAV_SECTIONS: { id: NavSectionId; title: string | null; feature?: keyof CompanyFeatures }[] = [
  { id: 'top', title: null },
  // WP 2.5b: challans, GRNs and their pending reports (orders join in WP 2.5c).
  { id: 'trade', title: 'Orders & challans', feature: 'orders' },
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
    invalidates: ['dashboard']
  },
  {
    name: 'voucher-entry',
    title: 'Voucher entry',
    screen: { name: 'voucher-entry' },
    navSection: 'top',
    card: { sub: 'Sales, purchase, payment…', key: 'V' },
    invalidates: ['voucher', 'nextNumber', 'billsOpen', 'ledgers', 'stockItems', 'units', 'currencies', 'voucherTypes', 'openSourceLines']
  },
  {
    name: 'manufacture',
    title: 'Manufacture',
    keywords: ['production', 'stock journal', 'bom', 'raw material', 'finished goods'],
    screen: { name: 'manufacture' },
    navSection: 'top',
    feature: 'inventory',
    invalidates: ['manufacturePreview', 'nextNumber', 'stockItems', 'ledgers', 'godowns', 'units', 'bom', 'bomVersions', 'jobWorkSendChallans', 'voucherTypes']
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
    keywords: ['ledgers', 'items', 'groups', 'units', 'voucher types', 'currencies', 'godowns', 'stock groups'],
    title: 'Masters',
    screen: { name: 'masters' },
    navSection: 'top',
    card: { sub: 'Ledgers, items, groups', key: 'M' },
    invalidates: [
      'ledgers', 'groups', 'chartOfAccounts', 'stockItems', 'units', 'voucherTypes', 'currencies', 'bom',
      'godowns', 'stockGroups', 'tradeDocTypes'
    ]
  },

  // WP 2.5c: quotations and orders (non-posting documents) with their pending reports.
  {
    name: 'quotations',
    title: 'Quotations',
    keywords: ['quote', 'estimate', 'proforma', 'offer'],
    screen: { name: 'quotations' },
    navSection: 'trade',
    feature: 'orders',
    invalidates: ['tradeDocs', 'tradeDocTypes']
  },
  {
    name: 'sales-orders',
    title: 'Sales orders',
    keywords: ['so', 'customer order', 'order book'],
    screen: { name: 'sales-orders' },
    navSection: 'trade',
    feature: 'orders',
    invalidates: ['tradeDocs', 'tradeDocTypes']
  },
  {
    name: 'purchase-orders',
    title: 'Purchase orders',
    keywords: ['po', 'supplier order', 'indent'],
    screen: { name: 'purchase-orders' },
    navSection: 'trade',
    feature: 'orders',
    invalidates: ['tradeDocs', 'tradeDocTypes']
  },
  {
    name: 'trade-doc',
    title: 'Quotation / order',
    screen: null,
    navSection: null,
    feature: 'orders',
    invalidates: ['tradeDoc', 'tradeDocs', 'tradeDocTypes', 'tradeDocNextNumber', 'ledgers', 'stockItems', 'units', 'openSourceLines']
  },
  {
    name: 'pending-sales-orders',
    title: 'Pending sales orders',
    navLabel: 'Pending SOs',
    keywords: ['open orders', 'order backlog', 'to deliver', 'undelivered'],
    screen: { name: 'pending-sales-orders' },
    navSection: 'trade',
    feature: 'orders',
    invalidates: ['tradePendingOrders']
  },
  {
    name: 'pending-purchase-orders',
    title: 'Pending purchase orders',
    navLabel: 'Pending POs',
    keywords: ['open purchase orders', 'to receive', 'not received'],
    screen: { name: 'pending-purchase-orders' },
    navSection: 'trade',
    feature: 'orders',
    invalidates: ['tradePendingOrders']
  },
  {
    name: 'quotation-pipeline',
    title: 'Quotation pipeline',
    keywords: ['conversion rate', 'win rate', 'quotes won', 'lost quotations'],
    screen: { name: 'quotation-pipeline' },
    navSection: 'trade',
    feature: 'orders',
    invalidates: ['quotationPipeline']
  },
  {
    name: 'pending-challans',
    title: 'Pending challans',
    keywords: ['delivery challan', 'delivered not invoiced', 'gdni', 'challans not invoiced'],
    screen: { name: 'pending-challans' },
    navSection: 'trade',
    feature: 'orders',
    invalidates: ['tradePending']
  },
  {
    name: 'pending-grns',
    title: 'Pending GRNs',
    keywords: ['goods receipt note', 'received not billed', 'grni', 'grn not billed'],
    screen: { name: 'pending-grns' },
    navSection: 'trade',
    feature: 'orders',
    invalidates: ['tradePending']
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
    invalidates: ['stockSummary', 'stockAgeing', 'stockByGodown', 'stockBatches', 'stockMovements']
  },
  {
    name: 'stock-movements',
    keywords: ['item movement register', 'stock register', 'stock ledger', 'item ledger'],
    title: 'Stock movements',
    screen: { name: 'stock-movements' },
    navSection: 'books',
    feature: 'inventory',
    invalidates: ['stockMovements', 'godowns', 'stockItems']
  },
  {
    name: 'stock-journal',
    keywords: ['godown transfer', 'stock transfer', 'stock adjustment', 'send to job worker', 'job work challan'],
    title: 'Stock journal',
    screen: { name: 'stock-journal' },
    navSection: 'books',
    feature: 'inventory',
    invalidates: ['transferCost', 'stockByGodown', 'godowns', 'batches', 'serialsAvailable', 'nextNumber', 'stockItems', 'voucherTypes', 'jobWorkSendChallans', 'ledgers']
  },
  {
    name: 'fixed-assets',
    title: 'Fixed assets',
    keywords: ['asset register', 'depreciation', 'schedule ii', 'block of assets', 'disposal', 'asset schedule', 'net block'],
    screen: { name: 'fixed-assets' },
    navSection: 'books',
    invalidates: ['faList', 'faGroups', 'faBlocks', 'faClasses', 'faRunPreview', 'faRuns', 'faSchedule', 'faIt', 'faCandidates', 'faDisposal']
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
    invalidates: ['gstr1', 'gstValidate']
  },
  {
    name: 'gstr3b',
    title: 'GSTR-3B',
    screen: { name: 'gstr3b' },
    navSection: 'gst',
    card: { sub: 'Summary return + ITC', key: '3' },
    invalidates: ['gstr3b', 'gst3bManual']
  },
  {
    name: 'gstr9',
    title: 'GSTR-9 annual workings',
    keywords: ['annual return', 'gstr-9', 'gstr9c', 'reconciliation'],
    screen: { name: 'gstr9' },
    navSection: null,
    invalidates: ['gstr9']
  },
  {
    name: 'itc04',
    title: 'ITC-04 · job work',
    keywords: ['job work', 'itc-04', 'challan'],
    screen: { name: 'itc04' },
    navSection: null,
    invalidates: ['itc04']
  },
  {
    name: 'itc-reversal',
    title: 'ITC reversal workings',
    keywords: ['rule 42', 'rule 43', 'rule 37', '17(5)', 'blocked credit', 'reversal'],
    screen: { name: 'itc-reversal' },
    navSection: null,
    invalidates: ['itcReversal', 'gst3bManual']
  },
  {
    name: 'gstr2b',
    keywords: ['reconciliation', 'itc'],
    title: 'GSTR-2B recon',
    screen: { name: 'gstr2b' },
    navSection: 'gst',
    invalidates: ['gstr2b', 'ledgers', 'imsActions', 'recon2bTolerances']
  },
  {
    name: 'edocs',
    keywords: ['e-invoice', 'e-way bill', 'irn', 'ewb'],
    title: 'e-Invoice & e-Way',
    screen: { name: 'edocs' },
    navSection: 'gst',
    invalidates: ['edocList', 'nicStatus', 'nicCreds', 'selfInvoices']
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
    name: 'tcs',
    keywords: ['tax collected at source', '206C', '27EQ', '27D'],
    title: 'TCS',
    screen: { name: 'tcs' },
    navSection: 'gst',
    feature: 'tcs',
    invalidates: ['tcs', 'tcsSections', 'tcsRates']
  },

  {
    name: 'settings',
    title: 'Settings',
    screen: { name: 'settings' },
    navSection: 'system',
    invalidates: [
      'backups', 'bin', 'users', 'audit', 'auditVerify', 'nicCreds', 'nicStatus',
      'features', 'invoiceConfig', 'invoicePreview', 'printTemplates', 'printTemplate', 'printPreview', 'appInfo', 'companyLock', 'agentConfig'
    ]
  },
  {
    name: 'audit-trail',
    title: 'Audit trail (edit log)',
    navLabel: 'Audit trail',
    keywords: ['edit log', 'audit log', 'rule 11(g)', 'mca', 'history', 'who changed', 'tamper', 'hash chain'],
    screen: { name: 'audit-trail' },
    navSection: 'system',
    invalidates: ['audit', 'auditVerify']
  },
  {
    name: 'import-tally',
    title: 'Import from Tally',
    screen: { name: 'import-tally' },
    navSection: 'system',
    invalidates: []
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
    name: 'stock-reports',
    keywords: ['reorder', 'reorder planning', 'stock ageing', 'expiry', 'serial numbers', 'barcode labels', 'labels'],
    title: 'Stock reports — reorder, ageing, expiry, serials, labels',
    screen: { name: 'stock-reports' },
    navSection: null, // reached from Stock summary's header and the palette
    feature: 'inventory',
    invalidates: ['stockReorder', 'stockAgeing', 'stockExpiry', 'serialList', 'priceLevels', 'labelsPreview']
  },
  {
    name: 'ledger-statement',
    title: 'Ledger statement',
    screen: null, // needs a ledgerId — reached from ledger lists/search, never bare navigation
    navSection: null,
    invalidates: ['ledgerStatement']
  },
  {
    name: 'manufacture-register',
    title: 'Manufacture register',
    keywords: ['production register', 'margin', 'manufacturing profit'],
    screen: { name: 'manufacture-register' },
    navSection: null,
    feature: 'inventory',
    invalidates: ['manufactureRegister']
  },
  {
    name: 'manufacture-reports',
    title: 'Manufacturing reports — production, cost sheet, margin, variance, job work',
    keywords: ['production register', 'cost sheet', 'material variance', 'bom variance', 'job work', 'job worker', 'itc-04', 'expected margin'],
    screen: { name: 'manufacture-reports' },
    navSection: null, // reached from the Manufacture register / Manufacture options and the palette
    feature: 'inventory',
    invalidates: ['manufactureProduction', 'manufactureCostSheet', 'manufactureMargin', 'manufactureVariance', 'jobWorkPending', 'stockItems']
  },
  {
    name: 'search',
    title: 'Search the books',
    keywords: ['find', 'search', 'lookup', 'all results'],
    screen: { name: 'search' }, // ⌘⇧F, or "See all" rows in the ⌘K palette (with a query)
    navSection: null,
    invalidates: ['searchResults']
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
