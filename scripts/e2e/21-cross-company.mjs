// Scenario 21 - switch directly between companies, restoring company context while personal pins follow the user.
import { scenario, assert } from '../lib/harness.mjs'

await scenario('21-cross-company', async (h) => {
  await h.createCompanyUI('Alpha Books')
  await h.goto('registers')
  await h.click('btn-pin-screen')
  await h.click('btn-switch-company')
  await h.waitScreen('company-select')
  await h.createCompanyUI('Beta Books')
  assert((await h.page.textContent('aside'))?.includes('Pinned'), 'personal pinned section follows the user into another company')
  assert((await h.page.textContent('aside'))?.includes('Registers'), 'personal pinned screen is synchronized across companies')
  await h.goto('month-close')

  await h.click('btn-cross-company')
  await h.page.getByTestId('switch-company-alpha-books').click()
  await h.waitScreen('registers')
  assert((await h.page.textContent('aside'))?.includes('Alpha Books'), 'target company identity is visible')
  await h.shot('01-alpha-context-restored')

  await h.click('btn-cross-company')
  await h.page.getByTestId('switch-company-beta-books').click()
  await h.waitScreen('month-close')
  assert((await h.page.textContent('aside'))?.includes('Beta Books'), 'second company returns to its own workspace')
  await h.shot('02-beta-context-restored')
})
