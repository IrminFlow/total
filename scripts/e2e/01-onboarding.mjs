// Scenario 01 — onboarding: first launch lands on company-select; creating a company through
// the UI opens straight into the Gateway with seeded masters ready.
import { scenario, assert } from '../lib/harness.mjs'

await scenario('01-onboarding', async (h) => {
  await h.waitScreen('company-select')
  await h.shot('01-company-select')
  // Sidebar section prefs live in localStorage, which sits in Electron's userData rather than
  // TOTAL_DATA_DIR — drop any left over from an earlier run so the defaults are what we test.
  await h.page.evaluate(() => {
    for (const k of Object.keys(localStorage)) if (k.startsWith('total-navsections-')) localStorage.removeItem(k)
  })

  await h.createCompanyUI('E2E Traders')
  await h.shot('02-gateway')

  // The sidebar (registry-derived nav testids) is up.
  await h.page.waitForSelector('[data-testid="nav-daybook"]', { timeout: 10000 })

  // Seeded masters exist for a brand-new company.
  const groups = await h.invoke('master:groups:list')
  assert(Array.isArray(groups) && groups.some((g) => g.name === 'Sales Accounts'), 'seeded groups include Sales Accounts')
  const ledgers = await h.invoke('master:ledgers:list')
  assert(ledgers.some((l) => l.name === 'Cash'), "seeded ledgers include 'Cash'")
  const types = await h.invoke('master:voucherTypes:list')
  assert(types.some((t) => t.kind === 'sales') && types.some((t) => t.kind === 'receipt'), 'seeded voucher types cover sales + receipt')

  // Round-trip a couple of screens to prove navigation works right after onboarding.
  await h.goto('masters')
  await h.goto('gateway')

  // Collapsible sidebar: only the top block and Books start open; a heading reveals its items,
  // and the choice survives a restart.
  const visible = (id) => h.page.isVisible(`[data-testid="nav-${id}"]`)
  assert(await visible('daybook'), 'top block is open')
  assert(await visible('trial-balance'), 'Books starts open')
  for (const id of ['registers', 'banking', 'gstr1', 'settings', 'import-tally']) {
    assert(!(await visible(id)), `${id} starts hidden in a collapsed section`)
  }
  const expanded = () => h.page.getAttribute('[data-testid="nav-section-gst"]', 'aria-expanded')
  assert((await expanded()) === 'false', 'GST heading reports aria-expanded=false')
  await h.click('nav-section-gst')
  assert(await visible('gstr1'), 'clicking GST reveals its items')
  assert((await expanded()) === 'true', 'GST heading reports aria-expanded=true')
  await h.shot('03-gst-expanded')

  await h.relaunch()
  await h.openCompany('E2E Traders')
  assert(await visible('gstr1'), 'GST stays open after a restart')
  assert(!(await visible('registers')), 'Analysis stays collapsed after a restart')
})
