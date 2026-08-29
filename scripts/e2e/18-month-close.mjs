// Scenario 18 — the month-close cockpit moves from preparation to a durable period lock.
import { scenario, assert, assertEq } from '../lib/harness.mjs'

await scenario('18-month-close', async (h) => {
  await h.createCompanyUI('Month Close Books')
  await h.goto('month-close')
  await h.page.waitForFunction(() => document.body.innerText.includes('4/5 gates'))
  assert(!(await h.page.getByTestId('btn-month-close-lock').isDisabled()), 'automatic open snapshot satisfies the verified-backup gate')
  await h.shot('01-close-preflight')

  await h.click('btn-month-close-backup')
  await h.page.waitForFunction(() => document.body.innerText.includes('Latest manual backup'))
  assert(!(await h.page.getByTestId('btn-month-close-lock').isDisabled()), 'clean preparation gates enable lock')
  await h.shot('02-ready-to-lock')

  await h.click('btn-month-close-lock')
  await h.page.getByRole('dialog').getByRole('button', { name: 'Lock month' }).click()
  await h.page.waitForFunction(() => document.body.innerText.includes('5/5 gates'))
  const selectedMonth = await h.page.locator('input[aria-label="Month to close"]').inputValue()
  const [year, month] = selectedMonth.split('-').map(Number)
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate()
  assertEq((await h.invoke('company:lock:get')).date, `${selectedMonth}-${String(last).padStart(2, '0')}`, 'month end is the durable lock boundary')
  await h.shot('03-month-locked')
})
