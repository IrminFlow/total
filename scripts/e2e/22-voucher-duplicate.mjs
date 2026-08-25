// Scenario 22 — duplicate a posted voucher into a fresh, unposted entry with no reused identity.
import { scenario, assert, assertEq } from '../lib/harness.mjs'

await scenario('22-voucher-duplicate', async (h) => {
  await h.createDemoCompany()
  const before = await h.invoke('voucher:list', { from: '2026-04-01', to: '2027-03-31' })
  const source = before[0]
  assert(source, 'demo has a source voucher')
  await h.invoke('voucher:get', { id: source.id })
  await h.goto('daybook')
  await h.page.locator(`[data-row-id="${source.id}"]`).click()
  await h.waitScreen('voucher-entry')
  const originalHeading = await h.page.locator('h2').innerText()
  assert(originalHeading.includes(source.number), 'source identity is visible in alteration mode')

  await h.click('btn-duplicate-voucher')
  await h.waitScreen('voucher-entry')
  assert((await h.page.locator('h2').innerText()) === 'Voucher entry', 'duplicate opens as a fresh voucher')
  assert((await h.page.getByTestId('btn-duplicate-voucher').count()) === 0, 'fresh copy has no stored identity')
  assertEq((await h.invoke('voucher:list', { from: '2026-04-01', to: '2027-03-31' })).length, before.length, 'duplication alone never posts')
  await h.shot('01-safe-duplicate-draft')
  await h.page.click('[data-testid="nav-gateway"]')
  await h.page.getByRole('dialog').getByRole('button', { name: 'Discard changes' }).click()
  await h.waitScreen('gateway')
})
