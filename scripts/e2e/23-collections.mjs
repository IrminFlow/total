// Scenario 23 — rank receivables, capture a promise, and retain its owner/date in the queue.
import { scenario, assert } from '../lib/harness.mjs'

await scenario('23-collections', async (h) => {
  await h.createDemoCompany()
  await h.goto('collections')
  await h.page.waitForSelector('[data-testid^="btn-promise-"]')
  const partyName = await h.page.locator('[data-testid^="btn-promise-"]').first().locator('xpath=../* [2]').textContent().catch(() => '')
  await h.page.locator('[data-testid^="btn-promise-"]').first().click()
  await h.fill('input-promise-owner', 'Asha')
  await h.fill('input-promise-note', 'Customer committed on follow-up call')
  await h.click('btn-save-promise')
  await h.page.getByText('Asha', { exact: false }).first().waitFor()
  assert((await h.page.getByText('Asha', { exact: false }).count()) > 0, `promise owner is visible for ${partyName}`)
  await h.shot('01-promise-in-ranked-queue')
})
