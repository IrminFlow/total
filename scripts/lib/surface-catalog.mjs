export const TOP_LEVEL = [
  'gateway', 'action-centre', 'task-inbox', 'control-room', 'assist', 'voucher-entry',
  'voucher-drafts', 'sales-documents', 'communications', 'entry-templates', 'daybook',
  'masters', 'recurring', 'import-tally', 'trial-balance', 'profit-loss', 'balance-sheet',
  'cash-flow', 'procurement', 'stock-summary', 'inventory-control', 'month-close', 'year-end',
  'registers', 'collections', 'outstandings', 'consolidated', 'cost-centres', 'budgets',
  'management-insights', 'exceptions', 'supplier-dues', 'banking', 'payroll', 'gstr1',
  'gstr3b', 'gstr2b', 'edocs', 'tds', 'compliance-centre', 'settings'
]

export const TAB_GROUPS = [
  ['control-room', 'control-tab-', ['overview', 'review', 'signoff', 'exceptions', 'access', 'evidence']],
  ['assist', 'assist-tab-', ['operator', 'documents', 'ledgers', 'search', 'writing', 'routing']],
  ['voucher-entry', 'tab-voucher-entry-', ['contra', 'payment', 'receipt', 'journal', 'sales', 'purchase', 'credit_note', 'debit_note', 'stock_journal', 'physical_stock']],
  ['sales-documents', 'tab-sales-', ['quotation', 'order', 'challan', 'proforma']],
  ['masters', 'tab-masters-', ['ledgers', 'groups', 'items', 'stock-groups', 'godowns', 'units', 'types', 'currencies']],
  ['registers', 'tab-registers-', ['sales', 'purchase', 'items']],
  ['outstandings', 'tab-outstandings-', ['receivable', 'payable']],
  ['consolidated', 'tab-consolidated-', ['tb', 'pnl']],
  ['banking', 'tab-banking-', ['workspace', 'treasury', 'transfers', 'charges', 'feeds', 'cheques', 'cash', 'recon', 'brs', 'pdc']],
  ['payroll', 'tab-payroll-', ['employees', 'runs', 'attendance', 'workforce', 'claims', 'contractors', 'controls']],
  ['tds', 'tab-tds-q', ['1', '2', '3', '4']],
  ['settings', 'tab-settings-', ['invoice', 'features', 'backups', 'bin', 'health', 'users', 'controls', 'audit', 'ai', 'agents', 'collaboration', 'integrations', 'email', 'nic', 'privacy', 'accessibility', 'community', 'about']]
]

export const TEXT_TAB_GROUPS = [
  ['procurement', ['Requisitions', 'Purchase orders', 'Goods receipts', 'Supplier intelligence', 'Debit-note claims', 'Reorder', 'Vendors']],
  ['inventory-control', ['Plan', 'Reservations', 'Transfers', 'Cycle counts', 'Production', 'Trace & labels', 'Action log']],
  ['management-insights', ['Overview', 'Variance drivers', 'Scenarios', 'Schedule III', 'Notes & pack']]
]

export const slug = (value) => value.toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')

export async function enableCatalogFeatures(h) {
  const features = await h.invoke('config:features:get')
  await h.invoke('config:features:set', { ...features, inventory: true, costCentres: true, payroll: true, tds: true })
}

export async function settle(h, screen) {
  await h.waitScreen(screen, 20000)
  await h.page.waitForFunction(
    () => ![...document.querySelectorAll('[role="status"]')].some((node) => node.textContent?.includes('Loading settings')),
    null,
    { timeout: 20000 }
  )
  await h.waitForScreenshotReady(20000)
}
