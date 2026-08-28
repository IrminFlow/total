// Scenario 54 — exhaustive light-theme surface catalogue.
//
// This is intentionally broader than the workflow scenarios. It renders every registered
// destination plus each persistent tab/subview at the production desktop viewport and leaves
// a screenshot catalogue for visual review. Dialog-heavy workflows remain covered by their
// dedicated scenarios, where the right fixtures and safety assertions already exist.
import { scenario, assert } from '../lib/harness.mjs'

const TOP_LEVEL = [
  'gateway', 'action-centre', 'task-inbox', 'control-room', 'assist',
  'voucher-entry', 'voucher-drafts', 'sales-documents', 'communications',
  'entry-templates', 'daybook', 'masters', 'recurring', 'import-tally',
  'trial-balance', 'profit-loss', 'balance-sheet', 'cash-flow', 'procurement',
  'stock-summary', 'inventory-control', 'month-close', 'year-end', 'registers',
  'collections', 'outstandings', 'consolidated', 'cost-centres', 'budgets',
  'management-insights', 'exceptions', 'supplier-dues', 'banking', 'payroll',
  'gstr1', 'gstr3b', 'gstr2b', 'edocs', 'tds', 'compliance-centre', 'settings'
]

const FEATURE_SCREENS = {
  procurement: 'inventory',
  'stock-summary': 'inventory',
  'inventory-control': 'inventory',
  'cost-centres': 'costCentres',
  payroll: 'payroll',
  tds: 'tds'
}

const TAB_GROUPS = [
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

const TEXT_TAB_GROUPS = [
  ['procurement', ['Requisitions', 'Purchase orders', 'Goods receipts', 'Supplier intelligence', 'Debit-note claims', 'Reorder', 'Vendors']],
  ['inventory-control', ['Plan', 'Reservations', 'Transfers', 'Cycle counts', 'Production', 'Trace & labels', 'Action log']],
  ['management-insights', ['Overview', 'Variance drivers', 'Scenarios', 'Schedule III', 'Notes & pack']]
]

const slug = (value) => value.toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')

async function settle(h, screen) {
  await h.waitScreen(screen, 20000)
  await h.page.waitForFunction(
    () => ![...document.querySelectorAll('[role="status"]')].some((node) => node.textContent?.includes('Loading settings')),
    null,
    { timeout: 20000 }
  )
  await h.page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))))
}

await scenario('54-surface-catalog-light', async (h) => {
  await h.waitScreen('company-select')
  await h.shot('light-company-select')
  await h.createDemoCompany()

  // A catalogue run must include optional local modules, even when a user's company has chosen
  // to hide them. The change is isolated inside this scenario's temporary TOTAL_DATA_DIR.
  const features = await h.invoke('config:features:get')
  await h.invoke('config:features:set', {
    ...features,
    inventory: true,
    costCentres: true,
    payroll: true,
    tds: true
  })

  for (const name of TOP_LEVEL) {
    const feature = FEATURE_SCREENS[name]
    if (feature && features[feature] === false) {
      // The module has just been enabled; the registry-derived sidebar remounts immediately.
      await h.page.waitForTimeout(50)
    }
    await h.goto(name, 20000)
    await h.shot(`light-page-${name}`)
  }

  // Header-only destination.
  await h.page.getByTitle('Company details').click()
  await settle(h, 'company-info')
  await h.shot('light-page-company-info')

  // Parameterized destination reached through a real ledger row.
  await h.goto('trial-balance', 20000)
  const ledgerRow = h.page.locator('[data-testid="rows-trial-balance"] tr.cursor-pointer').first()
  assert((await ledgerRow.count()) === 1, 'demo company exposes a ledger drill-through')
  await ledgerRow.click()
  await settle(h, 'ledger-statement')
  await h.shot('light-page-ledger-statement')
  for (const mode of ['detail', 'monthly']) {
    const target = h.page.locator(`[data-testid="tab-ledger-statement-${mode}"]`)
    if ((await target.count()) > 0) {
      await target.click()
      await settle(h, 'ledger-statement')
      await h.shot(`light-ledger-statement-${mode}`)
    }
  }

  for (const [screen, prefix, tabs] of TAB_GROUPS) {
    await h.goto(screen, 20000)
    for (const tab of tabs) {
      const target = h.page.locator(`[data-testid="${prefix}${tab}"]`).first()
      assert((await target.count()) === 1, `${screen} exposes ${tab} subview`)
      // Additional voucher kinds live inside a closed <details> menu. Dispatching the control's
      // real click handler is the deterministic equivalent of opening that menu and choosing it;
      // ordinary visible tabs still use Playwright's full pointer actionability checks.
      if (await target.isVisible()) await target.click()
      else await target.evaluate((element) => element.click())
      await settle(h, screen)
      await h.shot(`light-${screen}-${slug(tab)}`)
    }
  }

  // Quarterly grouping is an independently shippable report surface.
  await h.goto('registers', 20000)
  await h.click('tab-registers-sales')
  await h.click('tab-register-granularity-quarter')
  await settle(h, 'registers')
  await h.shot('light-registers-sales-quarterly')
  await h.click('tab-registers-purchase')
  await settle(h, 'registers')
  await h.shot('light-registers-purchase-quarterly')

  for (const [screen, labels] of TEXT_TAB_GROUPS) {
    await h.goto(screen, 20000)
    for (const label of labels) {
      const role = screen === 'procurement' ? 'tab' : 'button'
      const target = h.page.getByRole(role, { name: label, exact: true }).first()
      assert((await target.count()) === 1, `${screen} exposes ${label} subview`)
      await target.click()
      await settle(h, screen)
      await h.shot(`light-${screen}-${slug(label)}`)
    }
  }
})
