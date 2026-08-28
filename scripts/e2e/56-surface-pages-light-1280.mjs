import { scenario, assert } from '../lib/harness.mjs'
import { TOP_LEVEL, enableCatalogFeatures, settle } from '../lib/surface-catalog.mjs'

await scenario('56-surface-pages-light-1280', async (h) => {
  await h.page.setViewportSize({ width: 1280, height: 800 })
  await h.waitScreen('company-select')
  await h.shot('light-page-company-select', { fixture: 'empty-company-list' })
  await h.createDemoCompany()
  await enableCatalogFeatures(h)
  for (const screen of TOP_LEVEL) {
    await h.goto(screen, 20000)
    await h.shot(`light-page-${screen}`, { screen, fixture: 'demo-company' })
  }
  await h.page.getByTitle('Company details').click()
  await settle(h, 'company-info')
  await h.shot('light-page-company-info', { screen: 'company-info', fixture: 'demo-company' })
  await h.goto('trial-balance', 20000)
  const row = h.page.locator('[data-testid="rows-trial-balance"] tr.cursor-pointer').first()
  assert((await row.count()) === 1, 'demo company exposes a ledger drill-through')
  await row.click()
  await settle(h, 'ledger-statement')
  await h.shot('light-page-ledger-statement', { screen: 'ledger-statement', fixture: 'demo-company' })
})
