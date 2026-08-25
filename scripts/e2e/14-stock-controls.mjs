// Scenario 14 — stock integrity: the report ties to the Balance Sheet, an expanded item exposes
// a running valuation trail, and a movement opens its exact source voucher.
import { scenario, assert } from '../lib/harness.mjs'

await scenario('14-stock-controls', async (h) => {
  await h.createDemoCompany()
  await h.goto('stock-summary')

  await h.page.waitForFunction(() => document.body.innerText.includes('Stock-to-Balance-Sheet reconciliation'))
  const reconciliation = await h.invoke('stock:reconcile', { asOn: new Date().toISOString().slice(0, 10) })
  assert(reconciliation.difference === 0, `demo stock reconciles to Balance Sheet (difference ${reconciliation.difference})`)

  const itemRows = h.page.locator('[data-testid="rows-stock-summary"] tr[data-row-id]')
  assert(await itemRows.count() > 0, 'stock summary has item rows')
  await itemRows.first().click()
  await h.page.waitForSelector('[data-testid="rows-stock-trail"] tr[data-row-id]', { timeout: 10000 })
  const trailRows = h.page.locator('[data-testid="rows-stock-trail"] tr[data-row-id]')
  assert(await trailRows.count() > 0, 'expanded item has source-linked valuation movements')
  await h.shot('01-stock-trail')

  await trailRows.first().click()
  await h.waitScreen('voucher-entry')
  const entryText = await h.page.locator('[data-screen="voucher-entry"]').innerText()
  assert(entryText.includes('Alter voucher') && entryText.includes('Delete voucher'), 'movement opens an existing source voucher')
})
