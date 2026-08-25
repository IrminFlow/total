// Scenario 28 - focused working surfaces and a bidirectional navigation timeline.
import { scenario, assert, assertEq } from '../lib/harness.mjs'

await scenario('28-focus-history', async (h) => {
  await h.createDemoCompany()

  await h.goto('daybook')
  await h.page.locator('[data-testid="rows-daybook"] tr[data-row-id]').first().click()
  await h.waitScreen('voucher-entry')

  await h.click('btn-focus-mode')
  assertEq(await h.page.getByTestId('primary-navigation').count(), 0, 'focus mode hides unrelated navigation')
  await h.page.getByText('Focus mode', { exact: true }).waitFor()
  assert((await h.page.getByTestId('btn-focus-mode').getAttribute('aria-pressed')) === 'true', 'focus control exposes pressed state')
  await h.shot('01-voucher-focus-mode')

  await h.click('btn-history-back')
  await h.waitScreen('daybook')
  assertEq(await h.page.getByTestId('primary-navigation').count(), 1, 'leaving a focus-capable workflow restores navigation')
  assert(!(await h.page.getByTestId('btn-history-forward').isDisabled()), 'back navigation preserves a forward path')

  await h.click('btn-history-forward')
  await h.waitScreen('voucher-entry')
  await h.click('btn-history-timeline')
  await h.page.getByText('Navigation history', { exact: true }).waitFor()
  await h.page.getByText(/Voucher #\d+/, { exact: true }).waitFor()
  await h.shot('02-navigation-timeline')

  const dayBookHistory = h.page.locator('button').filter({ hasText: 'Day book' }).last()
  await dayBookHistory.click()
  await h.waitScreen('daybook')
  assert(!(await h.page.getByTestId('btn-history-forward').isDisabled()), 'timeline jump retains later history')

  await h.goto('banking')
  await h.page.keyboard.press('Control+Shift+f')
  assertEq(await h.page.getByTestId('primary-navigation').count(), 0, 'keyboard shortcut enters focus mode for reconciliation')
  await h.page.keyboard.press('Control+Shift+f')
  assertEq(await h.page.getByTestId('primary-navigation').count(), 1, 'keyboard shortcut exits focus mode')
})
