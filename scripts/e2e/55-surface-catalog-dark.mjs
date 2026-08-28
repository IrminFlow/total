// Scenario 55 — every registered desktop destination in dark theme.
// Subview detail is catalogued in scenario 54; this pass verifies every page-level composition,
// loading state and contrast treatment after the theme switch.
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

await scenario('55-surface-catalog-dark', async (h) => {
  await h.createDemoCompany()
  const features = await h.invoke('config:features:get')
  await h.invoke('config:features:set', {
    ...features,
    inventory: true,
    costCentres: true,
    payroll: true,
    tds: true
  })
  if ((await h.page.evaluate(() => document.documentElement.dataset.theme)) !== 'dark') {
    await h.click('btn-theme')
  }
  assert((await h.page.evaluate(() => document.documentElement.dataset.theme)) === 'dark', 'dark theme is active')

  for (const name of TOP_LEVEL) {
    await h.goto(name, 20000)
    await h.page.waitForFunction(
      () => ![...document.querySelectorAll('[role="status"]')].some((node) => node.textContent?.includes('Loading settings')),
      null,
      { timeout: 20000 }
    )
    await h.shot(`dark-page-${name}`)
  }

  await h.page.getByTitle('Company details').click()
  await h.waitScreen('company-info', 20000)
  await h.shot('dark-page-company-info')

  await h.goto('trial-balance', 20000)
  const ledgerRow = h.page.locator('[data-testid="rows-trial-balance"] tr.cursor-pointer').first()
  assert((await ledgerRow.count()) === 1, 'demo company exposes a ledger drill-through')
  await ledgerRow.click()
  await h.waitScreen('ledger-statement', 20000)
  await h.shot('dark-page-ledger-statement')
})
