// Scenario 73 — a11y sweep of the SIMPLE shell (WP 10.5; split out of 12-theme-a11y by the WP 7.4
// flake audit so each half has its own 5-minute budget). The demo company switched to simple
// mode, every simple screen reachable from its sidebar (section pages + their simple entries)
// plus the Help and Ask Total panels, in both themes at 1280×800 and 1024×700: contrast, names,
// labels, tabs, aria-describedby, and the window-size / landmark checks (layoutInPage: the window
// itself never scrolls, no button cut off or its label clipped, one banner / a navigation / one
// main, named panels and dialogs that fit the window); focus indicators at 1280×800.
import { scenario, assert } from '../lib/harness.mjs'
import { waitForSettled, sweepSimpleShell, layoutInPage, plantToastInPage } from '../lib/a11y.mjs'

await scenario('73-a11y-simple-shell', async (h) => {
  await h.createDemoCompany()

  const setTheme = async (theme) => {
    const now = await h.page.evaluate(() => document.documentElement.dataset.theme ?? 'light')
    if (now !== theme) await h.click('btn-theme')
  }

  await setTheme('light')
  await h.setMode('simple')
  const simpleFailures = []
  let simpleSwept = 0
  for (const theme of ['light', 'dark']) {
    await setTheme(theme)
    for (const [width, height] of [[1280, 800], [1024, 700]]) {
      await h.page.setViewportSize({ width, height })
      simpleSwept += await sweepSimpleShell(h, `simple/${theme}/${width}x${height}`, simpleFailures, { focus: width === 1280 })
      await h.click('simple-nav-home')
      await h.waitIdle()
      await h.shot(`04-simple-${theme}-${width}`)
    }
  }
  // to-do §4: toasts keep clear of the Save bar and of the docked Ask Total's question box —
  // 1700×900 (the panel docks beside the screen ≥ 1600 px) and 1024×700 (overlay, the bar wraps).
  for (const [width, height] of [[1700, 900], [1024, 700]]) {
    await h.page.setViewportSize({ width, height })
    await h.click('simple-nav-sell')
    await h.click('simple-entry-make-bill')
    await h.page.waitForSelector('[data-testid="save-bar"]', { timeout: 10000 })
    await h.click('btn-assistant')
    await h.page.waitForSelector('[data-testid="ask-panel"] textarea', { timeout: 5000 })
    assert(await h.page.evaluate(plantToastInPage), 'the toast stack is mounted')
    await waitForSettled(h.page)
    const tag = `simple/toasts/${width}x${height}`
    const docked = await h.page.evaluate(() => !document.querySelector('aside[data-docked]')?.hasAttribute('data-overlay'))
    if (width === 1700) assert(docked, '1700 px: Ask Total docks beside the screen')
    for (const p of await h.page.evaluate(layoutInPage)) simpleFailures.push(`${tag} layout: ${p}`)
    await h.shot(`05-toast-clear-${width}`)
    await h.page.evaluate(plantToastInPage, true)
    await h.click('btn-assistant')
    await h.page.waitForSelector('[data-testid="ask-panel"]', { state: 'detached', timeout: 5000 })
    await h.click('simple-nav-home')
    await h.waitIdle()
  }
  await h.page.setViewportSize({ width: 1440, height: 900 })
  const simpleUnique = [...new Set(simpleFailures)]
  if (simpleUnique.length) console.log(`[73-a11y-simple-shell] simple shell: ${simpleUnique.length} findings:\n  ${simpleUnique.join('\n  ')}`)
  assert(simpleUnique.length === 0, `simple-shell a11y sweep: ${simpleUnique.length} findings (see log above)`)
  assert(simpleSwept >= 4 * 30, `swept the simple screens at both sizes in both themes (${simpleSwept})`)

  await setTheme('light') // leave the shared profile in the default theme for later scenarios
})
