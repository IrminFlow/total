// Scenario 01 — onboarding: first launch lands on company-select; creating a company through
// the UI opens straight into the Gateway with seeded masters ready.
import { scenario, assert } from '../lib/harness.mjs'

await scenario('01-onboarding', async (h) => {
  await h.waitScreen('company-select')
  await h.shot('01-company-select')

  await h.click('btn-company-create')
  await h.page.getByText('Credentials', { exact: false }).waitFor()
  await h.page.getByText('Business type', { exact: true }).waitFor()
  await h.shot('02-readiness-and-guided-setup')
  await h.page.getByTestId('modal-close').click()

  await h.createCompanyUI('E2E Traders')
  await h.shot('03-gateway')

  // The sidebar (registry-derived nav testids) is up.
  await h.page.waitForSelector('[data-testid="nav-daybook"]', { timeout: 10000 })

  // Seeded masters exist for a brand-new company.
  const groups = await h.invoke('master:groups:list')
  assert(Array.isArray(groups) && groups.some((g) => g.name === 'Sales Accounts'), 'seeded groups include Sales Accounts')
  const ledgers = await h.invoke('master:ledgers:list')
  assert(ledgers.some((l) => l.name === 'Cash'), "seeded ledgers include 'Cash'")
  assert(ledgers.some((l) => l.name === 'Service Revenue'), 'business template creates editable service ledgers')
  const types = await h.invoke('master:voucherTypes:list')
  assert(types.some((t) => t.kind === 'sales') && types.some((t) => t.kind === 'receipt'), 'seeded voucher types cover sales + receipt')

  // Round-trip a couple of screens to prove navigation works right after onboarding.
  await h.goto('masters')
  await h.goto('gateway')
  await h.page.getByTitle('Company details').click()
  await h.waitScreen('company-info')
  await h.page.getByTestId('setup-progress').waitFor()
  const setup = await h.invoke('onboarding:status')
  assert(setup.score > 40 && setup.profile.priorSoftware === 'first-time', 'resumable setup health and prior-software profile are retained')
  await h.shot('04-setup-health')
})
