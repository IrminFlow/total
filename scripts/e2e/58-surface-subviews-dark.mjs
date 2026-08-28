import { scenario, assert } from '../lib/harness.mjs'
import { TAB_GROUPS, TEXT_TAB_GROUPS, enableCatalogFeatures, settle, slug } from '../lib/surface-catalog.mjs'

await scenario('58-surface-subviews-dark', async (h) => {
  await h.createDemoCompany()
  await enableCatalogFeatures(h)
  if ((await h.page.evaluate(() => document.documentElement.dataset.theme)) !== 'dark') await h.click('btn-theme')

  for (const [screen, prefix, tabs] of TAB_GROUPS) {
    await h.goto(screen, 20000)
    for (const tab of tabs) {
      const target = h.page.locator(`[data-testid="${prefix}${tab}"]`).first()
      assert((await target.count()) === 1, `${screen} exposes ${tab} subview`)
      if (await target.isVisible()) await target.click()
      else await target.evaluate((element) => element.click())
      await settle(h, screen)
      await h.shot(`dark-${screen}-${slug(tab)}`, { screen, fixture: 'demo-company', state: `subview:${tab}` })
    }
  }

  await h.goto('registers', 20000)
  await h.click('tab-registers-sales')
  await h.click('tab-register-granularity-quarter')
  await settle(h, 'registers')
  await h.shot('dark-registers-sales-quarterly', { screen: 'registers', fixture: 'demo-company', state: 'sales:quarter' })
  await h.click('tab-registers-purchase')
  await settle(h, 'registers')
  await h.shot('dark-registers-purchase-quarterly', { screen: 'registers', fixture: 'demo-company', state: 'purchase:quarter' })

  for (const [screen, labels] of TEXT_TAB_GROUPS) {
    await h.goto(screen, 20000)
    for (const label of labels) {
      const target = h.page.getByRole(screen === 'procurement' ? 'tab' : 'button', { name: label, exact: true }).first()
      assert((await target.count()) === 1, `${screen} exposes ${label} subview`)
      await target.click()
      await settle(h, screen)
      await h.shot(`dark-${screen}-${slug(label)}`, { screen, fixture: 'demo-company', state: `subview:${label}` })
    }
  }

  await h.goto('trial-balance', 20000)
  const row = h.page.locator('[data-testid="rows-trial-balance"] tr.cursor-pointer').first()
  await row.click()
  await settle(h, 'ledger-statement')
  for (const mode of ['detail', 'monthly']) {
    const target = h.page.locator(`[data-testid="tab-ledger-statement-${mode}"]`)
    if ((await target.count()) > 0) {
      await target.click()
      await settle(h, 'ledger-statement')
      await h.shot(`dark-ledger-statement-${mode}`, { screen: 'ledger-statement', fixture: 'demo-company', state: `subview:${mode}` })
    }
  }
})
