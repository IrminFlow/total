// Scenario 01 — onboarding: first launch lands on company-select; creating a company through
// the UI opens straight into the Gateway with seeded masters ready.
import { scenario, assert } from '../lib/harness.mjs'

await scenario('01-onboarding', async (h) => {
  await h.waitScreen('company-select')
  await h.shot('01-company-select')

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
})
