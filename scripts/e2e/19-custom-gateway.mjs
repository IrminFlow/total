// Scenario 19 — personalize Gateway order, visibility and density, then prove it survives restart.
import { scenario, assert } from '../lib/harness.mjs'

async function assertLayout(h) {
  assert((await h.page.locator('[data-testid="card-month-close"]').count()) === 0, 'hidden workspace stays off the Gateway')
  const first = await h.page.locator('[data-testid^="card-"]').first().getAttribute('data-testid')
  assert(first === 'card-voucher-entry', 'reordered workspace becomes the first Gateway card')
  const gridClass = await h.page.locator('[data-testid="card-voucher-entry"]').locator('..').getAttribute('class')
  assert(gridClass?.includes('grid-cols-4'), 'compact density uses the four-column layout')
}

await scenario('19-custom-gateway', async (h) => {
  await h.createCompanyUI('Personal Gateway Books')
  await h.click('btn-customize-home')
  await h.page.getByTestId('home-visibility-month-close').click()
  await h.page.getByTestId('home-density-compact').click()
  const moveVoucherUp = h.page.getByRole('button', { name: 'Move Voucher entry up' })
  await moveVoucherUp.click()
  await moveVoucherUp.click()
  await moveVoucherUp.click()
  await h.click('btn-save-home-layout')
  await assertLayout(h)
  await h.page.getByTestId('select-workspace-profile').selectOption('gst')
  await h.expandNavigation()
  assert((await h.page.getByTestId('nav-gstr1').count()) === 1, 'GST workspace keeps return preparation visible')
  assert((await h.page.getByTestId('nav-payroll').count()) === 0, 'GST workspace removes unrelated payroll navigation')
  await h.shot('01-personalized-gateway')

  await h.relaunch()
  await h.openCompany('Personal Gateway Books')
  await assertLayout(h)
  assert((await h.page.getByTestId('select-workspace-profile').inputValue()) === 'gst', 'saved workspace profile survives restart')
  assert((await h.page.getByTestId('nav-payroll').count()) === 0, 'restored profile keeps the focused navigation')
  await h.shot('02-layout-restored')
})
