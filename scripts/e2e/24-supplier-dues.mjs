// Scenario 24 — supplier priorities and cash coverage render from the real payable books.
import { scenario, assert } from '../lib/harness.mjs'

await scenario('24-supplier-dues', async (h) => {
  await h.createDemoCompany()
  await h.goto('supplier-dues')
  await h.page.waitForFunction(() => document.body.innerText.includes('Gujarat Components Pvt Ltd'))
  assert((await h.page.getByText(/Covered|Shortfall/).count()) > 0, 'cash coverage is explicit for each supplier')
  await h.page.getByText('Gujarat Components Pvt Ltd', { exact: true }).click()
  await h.page.getByText('Open supplier ledger', { exact: true }).waitFor()
  await h.shot('01-supplier-priority-and-coverage')
})
