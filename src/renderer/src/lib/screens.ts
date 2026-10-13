import type { Screen } from '../state/stores'
import type { CompanyFeatures } from '@shared/features'
import type { MessageKey } from '@shared/i18n'
import { SIMPLE_SECTION_IDS, type SimpleSectionId, type UiMode } from '@shared/simple/uiMode'

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

/**
 * WP 8.1 (plan 2026-10-13 §2.2): the simple shell's sidebar — nine sections, in order. Stock
 * shows only with inventory on. Labels are i18n keys (simple.nav.*).
 */
export const SIMPLE_SECTIONS: { id: SimpleSectionId; label: MessageKey; feature?: keyof CompanyFeatures }[] = SIMPLE_SECTION_IDS.map((id) => ({
  id,
  label: `simple.nav.${id}` as MessageKey,
  ...(id === 'stock' ? { feature: 'inventory' as const } : {})
}))

/**
 * A plain-named entry a simple section lists (plan §2.3). For now every entry opens an EXISTING
 * screen (with the "Accountant view / Back to simple" toggle); the simple-native flows replace
 * them in Phase 9.
 */
export interface SimpleEntry {
  /** Stable id — testid `simple-entry-<id>`, and its place in SIMPLE_ENTRY_ORDER. */
  id: string
  /** i18n key of the plain label (common.* / simple.* only — the simple lint's namespaces). */
  label: MessageKey
  /** Section it is listed in (default: the screen's simpleSection). */
  section?: SimpleSectionId
  /** Navigation target (default: the screen's default target). */
  screen?: Screen
  /** A sub-heading inside the section: Reports → "For your CA". */
  group?: 'forYourCa'
  /** Shown only for a regular GST registration (not composition / unregistered) / while the AI
   *  assistant is ready. */
  needs?: 'gstRegular' | 'aiReady'
  /** Hidden when this feature is off (on top of the screen's own feature). */
  feature?: keyof CompanyFeatures
}

export interface ScreenDef {
  name: Screen['name']
  /**
   * WP 8.1: the modes this screen belongs to. 'accountant' = today's sidebar / palette / Gateway
   * (every 0.10 screen); 'simple' = it shows inside the simple shell, drawn by a component under
   * src/renderer/src/simple/ (`simpleView`, so the i18n lints cover it). Until a screen has its
   * Phase 9 simple flow it stays accountant-only: simple entries open it in the full app ("Full
   * app" tag) with a "Back to simple" button.
   */
  modes: readonly UiMode[]
  /** WP 8.1: the simple-mode component (a file under src/renderer/src/simple/, without .tsx);
   *  required with 'simple' (simpleRegistry.test.ts). */
  simpleView?: string
  /** WP 8.1: the simple section this screen belongs to (plan §2.3; required with 'simple'). */
  simpleSection?: SimpleSectionId
  /** WP 8.1: the plain-named entries simple sections list for this screen. */
  simpleEntries?: SimpleEntry[]
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
  /** WP 8.0: hidden from the sidebar / palette / Gateway when the company is unregistered (no GST
   *  returns or e-documents to file). The screen still opens by link and says so. */
  requiresGstRegistration?: boolean
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
    // Simple view = simple/SimpleHome (WP 8.6 grows it); accountant view = the Gateway dashboard.
    modes: ['accountant', 'simple'],
    simpleView: 'SimpleHome',
    simpleSection: 'home',
    title: 'Gateway',
    screen: { name: 'gateway' },
    navSection: 'top',
    invalidates: ['dashboard']
  },
  {
    name: 'voucher-entry',
    modes: ['accountant'],
    simpleSection: 'sell',
    simpleEntries: [
      { id: 'make-bill', label: 'simple.entries.makeBill', screen: { name: 'voucher-entry', kindHint: 'sales' } },
      { id: 'sale-returns', label: 'simple.entries.saleReturns', screen: { name: 'voucher-entry', kindHint: 'credit_note' } },
      { id: 'record-purchase', label: 'simple.entries.recordPurchase', section: 'buy', screen: { name: 'voucher-entry', kindHint: 'purchase' } },
      { id: 'purchase-returns', label: 'simple.entries.purchaseReturns', section: 'buy', screen: { name: 'voucher-entry', kindHint: 'debit_note' } },
      { id: 'money-in', label: 'simple.home.moneyIn', section: 'money', screen: { name: 'voucher-entry', kindHint: 'receipt' } },
      { id: 'money-out', label: 'simple.home.moneyOut', section: 'money', screen: { name: 'voucher-entry', kindHint: 'payment' } },
      { id: 'move-money', label: 'simple.entries.moveMoney', section: 'money', screen: { name: 'voucher-entry', kindHint: 'contra' } }
    ],
    title: 'Voucher entry',
    screen: { name: 'voucher-entry' },
    navSection: 'top',
    card: { sub: 'Sales, purchase, payment…', key: 'V' },
    invalidates: ['voucher', 'nextNumber', 'billsOpen', 'ledgers', 'stockItems', 'units', 'currencies', 'voucherTypes', 'openSourceLines', 'pricingConfig']
  },
  {
    name: 'manufacture',
    modes: ['accountant'],
    simpleSection: 'stock',
    simpleEntries: [
      { id: 'made-goods', label: 'simple.stock.madeGoods' }
    ],
    title: 'Manufacture',
    keywords: ['production', 'stock journal', 'bom', 'raw material', 'finished goods'],
    screen: { name: 'manufacture' },
    navSection: 'top',
    feature: 'inventory',
    invalidates: ['manufacturePreview', 'nextNumber', 'stockItems', 'ledgers', 'godowns', 'units', 'bom', 'bomVersions', 'jobWorkSendChallans', 'voucherTypes']
  },
  // WP 2.6: POS-style counter sales (a normal sales invoice + its receipt).
  {
    name: 'counter-billing',
    modes: ['accountant'],
    simpleSection: 'sell',
    simpleEntries: [
      { id: 'quick-bill', label: 'simple.entries.quickBill' }
    ],
    title: 'Counter billing',
    navLabel: 'Counter',
    keywords: ['pos', 'point of sale', 'retail', 'barcode', 'scan', 'cash sale', 'billing', 'till', 'receipt'],
    screen: { name: 'counter-billing' },
    navSection: 'top',
    feature: 'inventory',
    invalidates: ['counterConfig', 'counterHeld', 'counterDayEnd', 'nextNumber', 'stockItems', 'ledgers', 'groups', 'units', 'pricingConfig', 'printTemplates']
  },
  {
    name: 'daybook',
    modes: ['accountant'],
    simpleSection: 'money',
    simpleEntries: [
      { id: 'all-entries', label: 'simple.entries.allEntries' }
    ],
    title: 'Day book',
    screen: { name: 'daybook' },
    navSection: 'top',
    card: { sub: 'Every entry, in order', key: 'D' },
    invalidates: ['daybook']
  },
  {
    name: 'masters',
    modes: ['accountant'],
    simpleSection: 'people',
    simpleEntries: [
      { id: 'customers-suppliers', label: 'simple.entries.customersSuppliers', screen: { name: 'masters', tab: 'ledgers', parties: true } },
      { id: 'product-list', label: 'simple.entries.productList', section: 'stock', screen: { name: 'masters', tab: 'items' }, feature: 'inventory' }
    ],
    keywords: ['ledgers', 'items', 'groups', 'units', 'voucher types', 'currencies', 'godowns', 'stock groups'],
    title: 'Masters',
    screen: { name: 'masters' },
    navSection: 'top',
    card: { sub: 'Ledgers, items, groups', key: 'M' },
    invalidates: [
      'ledgers', 'groups', 'chartOfAccounts', 'stockItems', 'units', 'voucherTypes', 'currencies', 'bom',
      'godowns', 'stockGroups', 'tradeDocTypes',
      // WP 2.6 pricing tabs
      'pricingGrid', 'priceLevels', 'priceRates', 'partyRates', 'discountSchemes'
    ]
  },

  // WP 2.5c: quotations and orders (non-posting documents) with their pending reports.
  {
    name: 'quotations',
    modes: ['accountant'],
    simpleSection: 'sell',
    simpleEntries: [
      { id: 'quotations', label: 'simple.entries.quotations' }
    ],
    title: 'Quotations',
    keywords: ['quote', 'estimate', 'proforma', 'offer'],
    screen: { name: 'quotations' },
    navSection: 'trade',
    feature: 'orders',
    invalidates: ['tradeDocs', 'tradeDocTypes']
  },
  {
    name: 'sales-orders',
    modes: ['accountant'],
    simpleSection: 'sell',
    simpleEntries: [
      { id: 'customer-orders', label: 'simple.entries.customerOrders' }
    ],
    title: 'Sales orders',
    keywords: ['so', 'customer order', 'order book'],
    screen: { name: 'sales-orders' },
    navSection: 'trade',
    feature: 'orders',
    invalidates: ['tradeDocs', 'tradeDocTypes']
  },
  {
    name: 'purchase-orders',
    modes: ['accountant'],
    simpleSection: 'buy',
    simpleEntries: [
      { id: 'supplier-orders', label: 'simple.entries.supplierOrders' }
    ],
    title: 'Purchase orders',
    keywords: ['po', 'supplier order', 'indent'],
    screen: { name: 'purchase-orders' },
    navSection: 'trade',
    feature: 'orders',
    invalidates: ['tradeDocs', 'tradeDocTypes']
  },
  {
    name: 'trade-doc',
    modes: ['accountant'],
    simpleSection: 'sell',
    title: 'Quotation / order',
    screen: null,
    navSection: null,
    feature: 'orders',
    invalidates: ['tradeDoc', 'tradeDocs', 'tradeDocTypes', 'tradeDocNextNumber', 'ledgers', 'stockItems', 'units', 'openSourceLines']
  },
  {
    name: 'pending-sales-orders',
    modes: ['accountant'],
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
    modes: ['accountant'],
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
    modes: ['accountant'],
    title: 'Quotation pipeline',
    keywords: ['conversion rate', 'win rate', 'quotes won', 'lost quotations'],
    screen: { name: 'quotation-pipeline' },
    navSection: 'trade',
    feature: 'orders',
    invalidates: ['quotationPipeline']
  },
  {
    name: 'pending-challans',
    modes: ['accountant'],
    title: 'Pending challans',
    keywords: ['delivery challan', 'delivered not invoiced', 'gdni', 'challans not invoiced'],
    screen: { name: 'pending-challans' },
    navSection: 'trade',
    feature: 'orders',
    invalidates: ['tradePending']
  },
  {
    name: 'pending-grns',
    modes: ['accountant'],
    title: 'Pending GRNs',
    keywords: ['goods receipt note', 'received not billed', 'grni', 'grn not billed'],
    screen: { name: 'pending-grns' },
    navSection: 'trade',
    feature: 'orders',
    invalidates: ['tradePending']
  },

  // WP 2.5d: trade-cycle reports — match, demand, order book / lead time, returns, GRNI / GDNI, stale.
  {
    name: 'three-way-match',
    modes: ['accountant'],
    title: 'Three-way match',
    keywords: ['po grn bill', 'rate variance', 'purchase match', 'bill mismatch', '3-way'],
    screen: { name: 'three-way-match' },
    navSection: 'trade',
    feature: 'orders',
    invalidates: ['tradeMatch']
  },
  {
    name: 'item-demand',
    modes: ['accountant'],
    title: 'Demand vs stock',
    navLabel: 'Demand vs stock',
    keywords: ['pending orders by item', 'shortage', 'on order', 'to order', 'open so', 'open po'],
    screen: { name: 'item-demand' },
    navSection: 'trade',
    feature: 'orders',
    invalidates: ['tradeItemDemand']
  },
  {
    name: 'order-book',
    modes: ['accountant'],
    title: 'Order book',
    keywords: ['orders by party', 'orders by month', 'lead time', 'fulfilment', 'delivery days'],
    screen: { name: 'order-book' },
    navSection: 'trade',
    feature: 'orders',
    invalidates: ['tradeOrderBook', 'tradeLeadTime']
  },
  {
    name: 'trade-returns',
    modes: ['accountant'],
    title: 'Returns',
    keywords: ['returns register', 'sales returns', 'purchase returns', 'credit notes', 'debit notes', 'rejections', 'return rate'],
    screen: { name: 'trade-returns' },
    navSection: 'trade',
    feature: 'orders',
    invalidates: ['tradeReturns', 'tradeReturnsRate']
  },
  {
    name: 'unbilled-goods',
    modes: ['accountant'],
    title: 'Goods not invoiced',
    navLabel: 'GRNI / GDNI',
    keywords: ['grni', 'gdni', 'received not invoiced', 'delivered not invoiced', 'unbilled', 'provision'],
    screen: { name: 'unbilled-goods' },
    navSection: 'trade',
    feature: 'orders',
    invalidates: ['tradeUnbilled']
  },
  {
    name: 'stale-documents',
    modes: ['accountant'],
    title: 'Stale documents',
    keywords: ['expired quotations', 'overdue orders', 'old challans', 'close quotations', 'short-close'],
    screen: { name: 'stale-documents' },
    navSection: 'trade',
    feature: 'orders',
    invalidates: ['tradeStale']
  },

  {
    name: 'trial-balance',
    modes: ['accountant'],
    simpleSection: 'reports',
    simpleEntries: [
      { id: 'trial-balance', label: 'simple.entries.trialBalance', group: 'forYourCa' }
    ],
    title: 'Trial balance',
    screen: { name: 'trial-balance' },
    navSection: 'books',
    card: { sub: 'All closing balances', key: 'T' },
    invalidates: ['trialBalance']
  },
  {
    name: 'profit-loss',
    modes: ['accountant'],
    simpleSection: 'reports',
    simpleEntries: [
      { id: 'how-am-i-doing', label: 'simple.reports.howAmIDoing' }
    ],
    title: 'Profit & Loss',
    screen: { name: 'profit-loss' },
    navSection: 'books',
    card: { sub: 'Trading + P&L account', key: 'P' },
    invalidates: ['pnl', 'pnlComparative', 'budgets', 'budgetAmounts']
  },
  {
    name: 'balance-sheet',
    modes: ['accountant'],
    simpleSection: 'reports',
    simpleEntries: [
      { id: 'balance-sheet', label: 'simple.entries.balanceSheet', group: 'forYourCa' }
    ],
    title: 'Balance sheet',
    screen: { name: 'balance-sheet' },
    navSection: 'books',
    card: { sub: 'Assets and liabilities', key: 'B' },
    invalidates: ['balanceSheet', 'bsComparative']
  },
  {
    name: 'cash-flow',
    modes: ['accountant'],
    simpleSection: 'reports',
    simpleEntries: [
      { id: 'cash-flow', label: 'simple.entries.cashFlow', group: 'forYourCa' }
    ],
    keywords: ['cash flow statement'],
    title: 'Cash flow',
    screen: { name: 'cash-flow' },
    navSection: 'books',
    invalidates: ['cashFlow']
  },
  {
    name: 'stock-summary',
    modes: ['accountant'],
    simpleSection: 'stock',
    simpleEntries: [
      { id: 'products', label: 'simple.entries.products' }
    ],
    title: 'Stock summary',
    screen: { name: 'stock-summary' },
    navSection: 'books',
    feature: 'inventory',
    card: { sub: 'Quantities and value', key: 'S' },
    invalidates: ['stockSummary', 'stockAgeing', 'stockByGodown', 'stockBatches', 'stockMovements']
  },
  {
    name: 'stock-movements',
    modes: ['accountant'],
    simpleSection: 'stock',
    simpleEntries: [
      { id: 'stock-history', label: 'simple.entries.stockHistory' }
    ],
    keywords: ['item movement register', 'stock register', 'stock ledger', 'item ledger'],
    title: 'Stock movements',
    screen: { name: 'stock-movements' },
    navSection: 'books',
    feature: 'inventory',
    invalidates: ['stockMovements', 'godowns', 'stockItems']
  },
  {
    name: 'stock-journal',
    modes: ['accountant'],
    keywords: ['godown transfer', 'stock transfer', 'stock adjustment', 'send to job worker', 'job work challan'],
    title: 'Stock journal',
    screen: { name: 'stock-journal' },
    navSection: 'books',
    feature: 'inventory',
    invalidates: ['transferCost', 'stockByGodown', 'godowns', 'batches', 'serialsAvailable', 'nextNumber', 'stockItems', 'voucherTypes', 'jobWorkSendChallans', 'ledgers']
  },
  {
    name: 'fixed-assets',
    modes: ['accountant'],
    title: 'Fixed assets',
    keywords: ['asset register', 'depreciation', 'schedule ii', 'block of assets', 'disposal', 'asset schedule', 'net block'],
    screen: { name: 'fixed-assets' },
    navSection: 'books',
    invalidates: ['faList', 'faGroups', 'faBlocks', 'faClasses', 'faRunPreview', 'faRuns', 'faSchedule', 'faIt', 'faCandidates', 'faDisposal']
  },
  {
    name: 'year-end',
    modes: ['accountant'],
    simpleSection: 'home',
    title: 'Year-end close',
    screen: { name: 'year-end' },
    navSection: 'books',
    invalidates: ['yearEndPreview']
  },

  {
    name: 'registers',
    modes: ['accountant'],
    simpleSection: 'sell',
    simpleEntries: [
      { id: 'sales-list', label: 'simple.entries.salesList', screen: { name: 'registers', tab: 'sales' } },
      { id: 'purchase-list', label: 'simple.entries.purchaseList', section: 'buy', screen: { name: 'registers', tab: 'purchase' } },
      { id: 'by-month', label: 'simple.reports.byMonth', section: 'reports', screen: { name: 'registers', tab: 'sales' } }
    ],
    keywords: ['sales register', 'purchase register'],
    title: 'Registers',
    screen: { name: 'registers' },
    navSection: 'analysis',
    invalidates: ['register']
  },
  {
    name: 'outstandings',
    modes: ['accountant'],
    simpleSection: 'people',
    simpleEntries: [
      { id: 'who-owes', label: 'simple.entries.whoOwes' },
      { id: 'who-owes-me', label: 'simple.reports.whoOwesMe', section: 'reports' }
    ],
    keywords: ['ageing', 'receivables', 'payables', 'bills'],
    title: 'Outstandings',
    screen: { name: 'outstandings' },
    navSection: 'analysis',
    invalidates: ['outstandings', 'followups', 'statement', 'receivablesConfig']
  },
  // WP 4.2: receivables — credit control, reminder letters, interest, collection reports.
  {
    name: 'receivables',
    modes: ['accountant'],
    simpleSection: 'people',
    simpleEntries: [
      { id: 'reminders', label: 'simple.entries.reminders' }
    ],
    title: 'Credit control',
    keywords: ['receivables', 'reminders', 'dunning', 'interest on overdue', 'credit hold', 'dso', 'collections', 'promised payments', 'follow-up'],
    screen: { name: 'receivables' },
    navSection: 'analysis',
    invalidates: ['creditControl', 'promisedWeek', 'reminderCandidates', 'reminderLog', 'interestPreview', 'interestCharges', 'collections', 'topOverdue', 'receivablesConfig']
  },
  {
    name: 'payables',
    modes: ['accountant'],
    simpleSection: 'people',
    simpleEntries: [
      { id: 'bills-to-pay', label: 'simple.people.billsToPay' }
    ],
    keywords: ['payment planning', 'msme', 'udyam', '43b', 'msme form 1', 'batch payments', 'payment run', 'supplier reconciliation', 'supplier statement'],
    title: 'Payables',
    screen: { name: 'payables' },
    navSection: 'analysis',
    invalidates: ['payablesPlan', 'payablesRuns', 'msmeReport', 'msmeBankRates', 'supplierStatement', 'billsOpen']
  },
  // WP 6.5: group consolidation with inter-company eliminations; the quick combined view of any
  // companies (by ledger name, no eliminations) stays as "Consolidated reports".
  {
    name: 'consolidation',
    modes: ['accountant'],
    title: 'Group consolidation',
    keywords: ['consolidated financial statements', 'group', 'subsidiary', 'inter-company', 'elimination', 'minority interest', 'goodwill', 'as 21', 'holding company'],
    screen: { name: 'consolidation' },
    navSection: 'analysis',
    invalidates: ['consolGroups', 'consolRun', 'consolCharts', 'company-registry']
  },
  {
    name: 'consolidated',
    modes: ['accountant'],
    title: 'Consolidated reports',
    navLabel: 'Combined view',
    keywords: ['quick combined view', 'multi-company'],
    screen: { name: 'consolidated' },
    navSection: 'analysis',
    invalidates: ['consolidated', 'company-registry']
  },
  {
    name: 'cost-centres',
    modes: ['accountant'],
    title: 'Cost centres',
    screen: { name: 'cost-centres' },
    navSection: 'analysis',
    feature: 'costCentres',
    invalidates: ['costCentres', 'ccReport', 'ccStatement']
  },
  {
    name: 'budgets',
    modes: ['accountant'],
    title: 'Budgets',
    screen: { name: 'budgets' },
    navSection: 'analysis',
    invalidates: ['budgets', 'budgetMonthly', 'budgetRevisions', 'budgetDrill', 'costCentres']
  },
  // WP 4.4: cash and finance.
  {
    name: 'cash-forecast',
    modes: ['accountant'],
    simpleSection: 'reports',
    simpleEntries: [
      { id: 'cash-next-30', label: 'simple.reports.cashNext30' }
    ],
    title: 'Cash-flow forecast',
    navLabel: 'Cash forecast',
    keywords: ['forecast', 'cash flow projection', 'liquidity', 'shortfall', 'runway', 'scenario'],
    screen: { name: 'cash-forecast' },
    navSection: 'analysis',
    invalidates: ['forecastBase', 'forecastItems']
  },
  {
    name: 'loans',
    modes: ['accountant'],
    title: 'Loans and EMIs',
    navLabel: 'Loans',
    keywords: ['emi', 'loan schedule', 'term loan', 'interest', 'amortisation', 'prepayment', 'moratorium'],
    screen: { name: 'loans' },
    navSection: 'analysis',
    invalidates: ['loans', 'loan', 'ledgers']
  },
  {
    name: 'forex',
    modes: ['accountant'],
    title: 'Forex — exposures and revaluation',
    navLabel: 'Forex',
    keywords: ['foreign currency', 'exchange rate', 'revaluation', 'unrealised', 'realised gain', 'usd', 'export receivable'],
    screen: { name: 'forex' },
    navSection: 'analysis',
    invalidates: ['fxPreview', 'fxRates', 'fxRevaluations', 'fxLedgerCurrencies', 'fxOpenBills', 'currencies']
  },
  // WP 6.1: report builder (pinned saved reports join the Analysis section as dynamic entries —
  // lib/dynamicNav.ts); WP 6.2: ratio analysis.
  {
    name: 'report-builder',
    modes: ['accountant'],
    title: 'Report builder',
    keywords: ['custom report', 'pivot', 'analysis', 'dimensions', 'measures', 'saved reports', 'sales by party', 'comparative'],
    screen: { name: 'report-builder' },
    navSection: 'analysis',
    invalidates: ['rbRun', 'savedReports', 'savedReport', 'rbUsers', 'budgets']
  },
  {
    name: 'ratios',
    modes: ['accountant'],
    title: 'Ratio analysis',
    navLabel: 'Ratios',
    keywords: ['current ratio', 'quick ratio', 'debt equity', 'margin', 'return on equity', 'debtor days', 'creditor days', 'inventory turnover', 'working capital', 'cash conversion'],
    screen: { name: 'ratios' },
    navSection: 'analysis',
    invalidates: ['ratios']
  },
  // WP 5.5: the assistants — month-end close checklist, GSTR-2B mismatches, anomalies and
  // duplicates, report from a question. Deterministic (they work with AI off); "Run with AI"
  // hands a result to the assistant panel.
  {
    name: 'assistants',
    modes: ['accountant'],
    simpleSection: 'home',
    title: 'Assistants',
    keywords: ['month end', 'close checklist', 'closing', 'gstr-2b mismatch', '2b', 'itc', 'anomalies', 'duplicates', 'unusual entries', 'fraud', 'report from a question', 'natural language report'],
    screen: { name: 'assistants' },
    navSection: 'analysis',
    invalidates: ['assistClose', 'assistAnomalies', 'assistGst2b', 'assistSettings', 'aiSettings']
  },
  {
    name: 'exceptions',
    modes: ['accountant'],
    simpleSection: 'home',
    keywords: ['exception reports', 'negative stock', 'unreconciled'],
    title: 'Exceptions',
    screen: { name: 'exceptions' },
    navSection: 'analysis',
    invalidates: ['exceptions']
  },

  {
    name: 'banking',
    modes: ['accountant'],
    simpleSection: 'money',
    simpleEntries: [
      { id: 'bank', label: 'simple.entries.bank', screen: { name: 'banking', tab: 'import' } }
    ],
    keywords: ['bank reconciliation', 'brs', 'post-dated', 'pdc', 'bank statement import', 'mt940', 'camt', 'cheque printing', 'cheque register', 'bulk payments', 'neft', 'rtgs'],
    title: 'Banking — reconciliation, statements, cheques & PDC',
    screen: { name: 'banking' },
    navSection: 'banking',
    navLabel: 'Reconciliation',
    invalidates: [
      'bankLedgers', 'bankRecon', 'bankRules', 'chequeConfig', 'brs', 'pdc', 'bankWorkspace', 'bankLearned', 'chequeBooks', 'chequeRegister',
      'bulkTemplates', 'bulkCandidates', 'bulkBeneficiaries', 'bulkBatches'
    ]
  },

  // WP 5.4: bills → purchase drafts, the capture queue and inbox folder.
  {
    name: 'capture',
    modes: ['accountant'],
    simpleSection: 'buy',
    simpleEntries: [
      { id: 'snap-bill', label: 'simple.entries.snapBill', needs: 'aiReady' }
    ],
    keywords: ['document capture', 'scan bill', 'bill photo', 'purchase bill', 'ocr', 'pdf bill', 'inbox', 'upload bills', 'receipts'],
    title: 'Document capture — bills to purchase drafts',
    screen: { name: 'capture' },
    navSection: 'banking',
    navLabel: 'Document capture',
    invalidates: ['captureQueue']
  },

  {
    name: 'payroll',
    modes: ['accountant'],
    simpleSection: 'money',
    simpleEntries: [
      { id: 'salaries', label: 'simple.entries.salaries' }
    ],
    title: 'Payroll — employees & runs',
    screen: { name: 'payroll' },
    navSection: 'payroll',
    navLabel: 'Employees & runs',
    feature: 'payroll',
    invalidates: ['employees', 'payrollRuns', 'payrollPreview', 'payHeads', 'employeeHeads', 'ptSummary']
  },

  {
    name: 'gstr1',
    requiresGstRegistration: true,
    modes: ['accountant'],
    simpleSection: 'taxes',
    simpleEntries: [
      { id: 'gst-sales', label: 'simple.entries.gstSales', needs: 'gstRegular' }
    ],
    title: 'GSTR-1',
    screen: { name: 'gstr1' },
    navSection: 'gst',
    card: { sub: 'Outward supplies return', key: '1' },
    invalidates: ['gstr1', 'gstValidate']
  },
  {
    name: 'gstr3b',
    requiresGstRegistration: true,
    modes: ['accountant'],
    simpleSection: 'taxes',
    simpleEntries: [
      { id: 'gst-summary', label: 'simple.entries.gstToPay', needs: 'gstRegular' },
      { id: 'gst-summary-report', label: 'simple.reports.gstSummary', section: 'reports', needs: 'gstRegular' }
    ],
    title: 'GSTR-3B',
    screen: { name: 'gstr3b' },
    navSection: 'gst',
    card: { sub: 'Summary return + ITC', key: '3' },
    invalidates: ['gstr3b', 'gst3bManual']
  },
  {
    name: 'gstr9',
    requiresGstRegistration: true,
    modes: ['accountant'],
    title: 'GSTR-9 annual workings',
    keywords: ['annual return', 'gstr-9', 'gstr9c', 'reconciliation'],
    screen: { name: 'gstr9' },
    navSection: null,
    invalidates: ['gstr9']
  },
  {
    name: 'itc04',
    requiresGstRegistration: true,
    modes: ['accountant'],
    title: 'ITC-04 · job work',
    keywords: ['job work', 'itc-04', 'challan'],
    screen: { name: 'itc04' },
    navSection: null,
    invalidates: ['itc04']
  },
  {
    name: 'itc-reversal',
    requiresGstRegistration: true,
    modes: ['accountant'],
    title: 'ITC reversal workings',
    keywords: ['rule 42', 'rule 43', 'rule 37', '17(5)', 'blocked credit', 'reversal'],
    screen: { name: 'itc-reversal' },
    navSection: null,
    invalidates: ['itcReversal', 'gst3bManual']
  },
  {
    name: 'gstr2b',
    requiresGstRegistration: true,
    modes: ['accountant'],
    simpleSection: 'taxes',
    simpleEntries: [
      { id: 'check-supplier-bills', label: 'simple.taxes.gst.step2', needs: 'gstRegular' }
    ],
    keywords: ['reconciliation', 'itc'],
    title: 'GSTR-2B recon',
    screen: { name: 'gstr2b' },
    navSection: 'gst',
    invalidates: ['gstr2b', 'ledgers', 'imsActions', 'recon2bTolerances']
  },
  {
    name: 'edocs',
    requiresGstRegistration: true,
    modes: ['accountant'],
    simpleSection: 'sell',
    keywords: ['e-invoice', 'e-way bill', 'irn', 'ewb'],
    title: 'e-Invoice & e-Way',
    screen: { name: 'edocs' },
    navSection: 'gst',
    invalidates: ['edocList', 'nicStatus', 'nicCreds', 'selfInvoices']
  },
  {
    name: 'tds',
    modes: ['accountant'],
    simpleSection: 'taxes',
    simpleEntries: [
      { id: 'tds', label: 'simple.taxes.tds.what' }
    ],
    title: 'TDS',
    screen: { name: 'tds' },
    navSection: 'gst',
    feature: 'tds',
    invalidates: ['tdsSummary', 'tdsSections']
  },
  {
    name: 'tcs',
    modes: ['accountant'],
    simpleSection: 'taxes',
    simpleEntries: [
      { id: 'tcs', label: 'simple.taxes.tcs.what' }
    ],
    keywords: ['tax collected at source', '206C', '27EQ', '27D'],
    title: 'TCS',
    screen: { name: 'tcs' },
    navSection: 'gst',
    feature: 'tcs',
    invalidates: ['tcs', 'tcsSections', 'tcsRates']
  },

  {
    name: 'settings',
    modes: ['accountant'],
    simpleSection: 'settings',
    simpleEntries: [
      { id: 'bills-printing', label: 'simple.settings.billsPrinting', screen: { name: 'settings', tab: 'invoice' } },
      { id: 'backups', label: 'simple.settings.backups', screen: { name: 'settings', tab: 'backups' } },
      { id: 'people-roles', label: 'simple.settings.peopleRoles', screen: { name: 'settings', tab: 'users' } },
      { id: 'features', label: 'simple.settings.features', screen: { name: 'settings', tab: 'features' } },
      { id: 'advanced', label: 'simple.settings.advanced' }
    ],
    title: 'Settings',
    screen: { name: 'settings' },
    navSection: 'system',
    invalidates: [
      'backups', 'bin', 'users', 'audit', 'nicCreds', 'nicStatus',
      'features', 'invoiceConfig', 'invoicePreview', 'printTemplates', 'printTemplate', 'printPreview', 'appInfo', 'companyLock', 'agentConfig',
      // WP 6.2 scheduled packs
      'reportPacks', 'reportPackRuns', 'savedReports',
      'aiSettings', 'aiUsage', 'aiOutbound'
    ]
  },
  {
    name: 'audit-trail',
    modes: ['accountant'],
    simpleSection: 'settings',
    title: 'Audit trail (edit log)',
    navLabel: 'Audit trail',
    keywords: ['edit log', 'audit log', 'rule 11(g)', 'mca', 'history', 'who changed', 'tamper', 'hash chain'],
    screen: { name: 'audit-trail' },
    navSection: 'system',
    invalidates: ['audit']
  },
  // WP 6.3 — kept before "Import from Tally", which stays last in System.
  {
    name: 'data-import',
    modes: ['accountant'],
    simpleSection: 'settings',
    title: 'Import from Excel, CSV, Busy or Zoho Books',
    navLabel: 'Import',
    keywords: ['excel', 'xlsx', 'csv', 'busy', 'zoho', 'opening balances', 'migrate', 'bulk import', 'undo import'],
    screen: { name: 'data-import' },
    navSection: 'system',
    invalidates: ['importBatches', 'importTemplates']
  },
  {
    name: 'data-export',
    modes: ['accountant'],
    simpleSection: 'settings',
    simpleEntries: [
      { id: 'ca-export', label: 'simple.entries.caExport', section: 'reports', group: 'forYourCa' }
    ],
    title: 'Export books to Excel',
    navLabel: 'Export',
    keywords: ['excel', 'xlsx', 'workbook', 'backup to excel', 'download data'],
    screen: { name: 'data-export' },
    navSection: 'system',
    invalidates: []
  },
  {
    name: 'import-tally',
    modes: ['accountant'],
    simpleSection: 'settings',
    title: 'Import from Tally',
    screen: { name: 'import-tally' },
    navSection: 'system',
    invalidates: []
  },

  // Not in the sidebar — reached from the header / other screens — but the palette and the
  // invalidation map still need them.
  {
    name: 'company-info',
    modes: ['accountant'],
    simpleSection: 'settings',
    simpleEntries: [
      { id: 'business', label: 'simple.settings.business' }
    ],
    keywords: ['company details', 'gstin', 'pan'],
    title: 'Company details',
    screen: { name: 'company-info' },
    navSection: null,
    invalidates: []
  },
  {
    name: 'stock-reports',
    modes: ['accountant'],
    simpleSection: 'stock',
    simpleEntries: [
      { id: 'low-stock', label: 'simple.entries.lowStock', screen: { name: 'stock-reports', tab: 'reorder' } }
    ],
    keywords: ['reorder', 'reorder planning', 'stock ageing', 'expiry', 'serial numbers', 'barcode labels', 'labels'],
    title: 'Stock reports — reorder, ageing, expiry, serials, labels',
    screen: { name: 'stock-reports' },
    navSection: null, // reached from Stock summary's header and the palette
    feature: 'inventory',
    invalidates: ['stockReorder', 'stockAgeing', 'stockExpiry', 'serialList', 'priceLevels', 'labelsPreview']
  },
  {
    name: 'ledger-statement',
    modes: ['accountant'],
    simpleSection: 'people',
    title: 'Ledger statement',
    screen: null, // needs a ledgerId — reached from ledger lists/search, never bare navigation
    navSection: null,
    invalidates: ['ledgerStatement']
  },
  {
    name: 'manufacture-register',
    modes: ['accountant'],
    title: 'Manufacture register',
    keywords: ['production register', 'margin', 'manufacturing profit'],
    screen: { name: 'manufacture-register' },
    navSection: null,
    feature: 'inventory',
    invalidates: ['manufactureRegister']
  },
  {
    name: 'manufacture-reports',
    modes: ['accountant'],
    title: 'Manufacturing reports — production, cost sheet, margin, variance, job work',
    keywords: ['production register', 'cost sheet', 'material variance', 'bom variance', 'job work', 'job worker', 'itc-04', 'expected margin'],
    screen: { name: 'manufacture-reports' },
    navSection: null, // reached from the Manufacture register / Manufacture options and the palette
    feature: 'inventory',
    invalidates: ['manufactureProduction', 'manufactureCostSheet', 'manufactureMargin', 'manufactureVariance', 'jobWorkPending', 'stockItems']
  },
  // WP 8.1: a simple section's page (Sell, Buy, Money …) — the simple shell's sidebar targets.
  {
    name: 'simple-section',
    modes: ['simple'],
    simpleView: 'SimpleSection',
    title: 'Simple section',
    screen: null, // needs its section
    navSection: null,
    invalidates: []
  },
  // WP 8.1: Settings → How Total looks in the simple shell (mode, theme, density, language).
  {
    name: 'simple-looks',
    modes: ['simple'],
    simpleView: 'SimpleLooks',
    simpleSection: 'settings',
    simpleEntries: [{ id: 'looks', label: 'simple.settings.looks', screen: { name: 'simple-looks' } }],
    title: 'How Total looks',
    screen: null, // simple shell only (its accountant home is Settings → How Total looks)
    navSection: null,
    invalidates: []
  },
  {
    name: 'search',
    modes: ['accountant'],
    simpleSection: 'home',
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

/**
 * The accountant sidebar (Shell): registry sections in order, each with its accountant-mode
 * screens that have a default target — exactly the 0.10 sidebar (accountantSidebar.test.tsx).
 */
export const ACCOUNTANT_NAV = NAV_SECTIONS.map((section) => ({
  ...section,
  items: SCREENS.filter((s) => s.navSection === section.id && s.screen != null && s.modes.includes('accountant')).map((s) => ({
    label: s.navLabel ?? s.title,
    screen: s.screen!,
    feature: s.feature,
    requiresGstRegistration: s.requiresGstRegistration
  }))
}))

/**
 * Order of the simple entries inside their sections (and groups). Every entry id appears once
 * (registry test).
 */
export const SIMPLE_ENTRY_ORDER: readonly string[] = [
  // Sell
  'make-bill', 'quick-bill', 'sales-list', 'sale-returns', 'quotations', 'customer-orders',
  // Buy
  'record-purchase', 'purchase-list', 'purchase-returns', 'snap-bill', 'supplier-orders',
  // Money
  'money-in', 'money-out', 'move-money', 'bank', 'all-entries', 'salaries',
  // Stock
  'products', 'product-list', 'low-stock', 'stock-history', 'made-goods',
  // People
  'customers-suppliers', 'who-owes', 'reminders', 'bills-to-pay',
  // Reports (then For your CA)
  'how-am-i-doing', 'cash-next-30', 'who-owes-me', 'by-month', 'gst-summary-report',
  'trial-balance', 'balance-sheet', 'cash-flow', 'ca-export',
  // Taxes
  'gst-summary', 'gst-sales', 'check-supplier-bills', 'tds', 'tcs',
  // Settings (then Advanced)
  'business', 'bills-printing', 'backups', 'people-roles', 'features', 'looks', 'advanced'
]

export interface ResolvedSimpleEntry {
  id: string
  label: MessageKey
  section: SimpleSectionId
  screen: Screen
  group: SimpleEntry['group'] | null
  needs: SimpleEntry['needs'] | null
  /** The screen's feature and the entry's own (both must be on). */
  features: (keyof CompanyFeatures)[]
  /** The screen it opens (its registry name). */
  screenName: Screen['name']
}

/** Every simple entry with its defaults filled in, in SIMPLE_ENTRY_ORDER. */
export const SIMPLE_ENTRIES: ResolvedSimpleEntry[] = SCREENS.flatMap((def) =>
  (def.simpleEntries ?? []).map((e) => {
    const screen = e.screen ?? def.screen
    if (!screen) throw new Error(`simple entry ${e.id} needs a screen`)
    const section = e.section ?? def.simpleSection
    if (!section) throw new Error(`simple entry ${e.id} needs a section`)
    return {
      id: e.id,
      label: e.label,
      section,
      screen,
      group: e.group ?? null,
      needs: e.needs ?? null,
      features: [def.feature, e.feature].filter((f): f is keyof CompanyFeatures => !!f),
      screenName: def.name
    }
  })
).sort((a, b) => SIMPLE_ENTRY_ORDER.indexOf(a.id) - SIMPLE_ENTRY_ORDER.indexOf(b.id))

/** The entries a simple section lists. */
export function simpleEntriesOf(section: SimpleSectionId): ResolvedSimpleEntry[] {
  return SIMPLE_ENTRIES.filter((e) => e.section === section)
}

/**
 * Which shell shows `name`: the company's mode, unless the screen is accountant-only (always the
 * accountant view) or the user picked "Accountant view" for it (`override`).
 */
export function screenView(companyMode: UiMode, name: Screen['name'], override: boolean): UiMode {
  if (companyMode === 'accountant') return 'accountant'
  const def = byName.get(name)
  if (!def || !def.modes.includes('simple')) return 'accountant'
  return override ? 'accountant' : 'simple'
}

/** The simple section a screen highlights in the simple sidebar. */
export function simpleSectionOf(screen: Screen): SimpleSectionId | null {
  if (screen.name === 'simple-section') return screen.section
  return byName.get(screen.name)?.simpleSection ?? null
}

/** Query-key families to refresh when `name` becomes the visible screen. */
export function invalidationFamilies(name: Screen['name']): string[] {
  return byName.get(name)?.invalidates ?? []
}

/** WP 8.0: is a registry entry shown for this company? */
export const screenApplies = (s: { requiresGstRegistration?: boolean }, gstRegistrationType: string | undefined): boolean =>
  !s.requiresGstRegistration || gstRegistrationType !== 'unregistered'
