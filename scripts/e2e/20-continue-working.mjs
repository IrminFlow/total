// Scenario 20 — restore the last safe workspace, working period and screen scroll after restart.
import { scenario, assert } from '../lib/harness.mjs'

await scenario('20-continue-working', async (h) => {
  await h.createDemoCompany()
  await h.page.keyboard.press('Control+k')
  await h.page.fill('[data-testid="input-palette"]', 'set period this month')
  await h.page.keyboard.press('Enter')
  await h.page.waitForFunction(() => document.body.innerText.includes('01-Aug-26 → 31-Aug-26'))
  await h.page.locator('main[data-screen="gateway"]').evaluate((element) => element.scrollTo({ top: 520 }))
  await h.page.waitForFunction(() => document.querySelector('main')?.scrollTop > 100)
  const savedScroll = await h.page.locator('main').evaluate((element) => element.scrollTop)

  await h.relaunch()
  await h.openCompany('Demo Traders')
  await h.page.waitForFunction(() => document.body.innerText.includes('01-Aug-26 → 31-Aug-26'))
  await h.page.waitForFunction(() => document.querySelector('main')?.scrollTop > 100)
  const restoredScroll = await h.page.locator('main').evaluate((element) => element.scrollTop)
  // Async dashboard panels can shift the exact pixel through browser scroll anchoring; the same
  // reading region must be restored, not necessarily the identical sub-pixel coordinate.
  assert(Math.abs(restoredScroll - savedScroll) < 100, `Gateway reading position restored (${savedScroll} → ${restoredScroll})`)

  await h.goto('registers')
  await h.page.waitForFunction(() => (document.querySelector('main')?.scrollTop ?? -1) < 5)
  await h.relaunch()
  await h.waitScreen('company-select')
  await h.clickText('Demo Traders')
  await h.waitScreen('registers')
  assert(true, 'last safe workspace reopens after restart')
  await h.page.waitForFunction(() => document.body.innerText.includes('01-Aug-26 → 31-Aug-26'))
  await h.shot('01-continued-workspace')
})
