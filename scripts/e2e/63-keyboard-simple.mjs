// Scenario 63 — WP 10.5: the simple shell by keyboard alone, in a small window. No mouse from the
// first screen to the last: the setup wizard (Enter / Tab / Space / arrow keys), the tour (Esc),
// Make a bill (Tab to "Just an amount", type it, ⌘↵ saves — the save card takes the focus),
// ⌘K → Money in (arrow keys pick "I put in my own money", ⌘↵ saves), then the Esc layers on a
// dirty form: ⌘/ opens Help over the screen (overlay under 1600 px — the screen keeps its width),
// Esc closes Help only (focus back on the form), Esc on the form asks before discarding, Esc closes
// that question only. At 1024×700 the sidebar is icons only, each named and labelled on focus;
// at 819×560 (1024×700 at 125 % zoom) nothing is cut off and the window never scrolls. Light +
// dark screenshots at 1024×700 and 1440×900 for the visual review (WP105_SHOTS=<dir> copies them).
import * as fs from 'node:fs'
import * as path from 'node:path'
import { scenario, assert, assertEq } from '../lib/harness.mjs'
import { layoutInPage, sweepInto, waitForSettled } from '../lib/a11y.mjs'

await scenario('63-keyboard-simple', async (h) => {
  const page = h.page
  const attached = (sel, timeout = 10000) => page.waitForSelector(sel, { state: 'attached', timeout })
  const active = () => page.evaluate(() => document.activeElement?.getAttribute('data-testid') ?? document.activeElement?.tagName ?? null)
  /** Tab (or Shift+Tab) until the control with this test id has the keyboard. */
  const tabTo = async (testId, { max = 60, back = false } = {}) => {
    for (let i = 0; i < max; i++) {
      if ((await active()) === testId) return
      await page.keyboard.press(back ? 'Shift+Tab' : 'Tab')
    }
    throw new Error(`Tab never reached ${testId} (on ${await active()})`)
  }
  /** Reach a choice the keyboard way (WAI radio group: a question is ONE Tab stop — Tab to the
   *  group, then the arrow keys move along it and pick). */
  const radioTo = async (testId, { back = false } = {}) => {
    const inGroup = () =>
      page.evaluate((id) => {
        const a = document.activeElement
        const target = document.querySelector(`[data-testid="${id}"]`)
        return !!a && !!target && a.getAttribute('role') === 'radio' && a.closest('[role="radiogroup"]') === target.closest('[role="radiogroup"]')
      }, testId)
    for (let i = 0; i < 60 && !(await inGroup()); i++) await page.keyboard.press(back ? 'Shift+Tab' : 'Tab')
    assert(await inGroup(), `Tab reached the group of ${testId} (on ${await active()})`)
    for (let i = 0; i < 12; i++) {
      if ((await active()) === testId) return
      await page.keyboard.press('ArrowDown')
    }
    throw new Error(`the arrow keys never reached ${testId} (on ${await active()})`)
  }
  const shots = []
  const shot = async (name) => shots.push(await h.shot(name))
  const layout = async (where) => {
    await waitForSettled(page)
    const p = await page.evaluate(layoutInPage)
    assert(p.length === 0, `${where}: the window fits — ${p.join('; ')}`)
  }

  await page.setViewportSize({ width: 1024, height: 700 })

  // ---------- the setup wizard, keys only ----------
  await attached('[data-testid="setup-wizard"]')
  assertEq(await active(), 'setup-name', 'the wizard starts in the name box')
  await page.keyboard.type('Keyboard Kirana')
  await page.keyboard.press('Enter') // the form submits: Next
  await attached('[data-testid="setup-wizard"][data-step="type"]')
  assertEq(await page.evaluate(() => document.activeElement?.getAttribute('role')), 'radio', 'Next moved the keyboard to the first card')
  await page.keyboard.press('Space') // the first card (a shop)
  await tabTo('setup-next')
  await page.keyboard.press('Enter')
  await attached('[data-testid="setup-wizard"][data-step="gst"]')
  // Arrow keys move between the cards and pick the one they land on (a radio group).
  await page.keyboard.press('Space') // regular …
  const firstGst = await active()
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('ArrowDown')
  const gst = await active()
  assert(gst !== firstGst && gst.startsWith('setup-gst-'), `↓ moved along the GST cards (${firstGst} → ${gst})`)
  assertEq(await page.getAttribute(`[data-testid="${gst}"]`, 'aria-checked'), 'true', '↓ picked the card it landed on')
  if (gst !== 'setup-gst-no') {
    await radioTo('setup-gst-no')
  }
  await tabTo('setup-next')
  await page.keyboard.press('Enter')
  await attached('[data-testid="setup-wizard"][data-step="stock"]')
  await radioTo('setup-stock-yes')
  await page.keyboard.press('Space')
  await tabTo('setup-next')
  await page.keyboard.press('Enter')
  await attached('[data-testid="setup-wizard"][data-step="start"]')
  await radioTo('setup-start-fy')
  await page.keyboard.press('Space')
  await radioTo('setup-fresh-new')
  await page.keyboard.press('Space')
  await tabTo('setup-next')
  await page.keyboard.press('Enter')
  await attached('[data-testid="setup-wizard"][data-step="tally"]')
  await tabTo('setup-finish')
  await page.keyboard.press('Enter')
  await h.waitScreen('gateway', 30000)
  await attached('[data-testid="simple-home"]', 20000)

  // The first-run tour: Esc ends it.
  await attached('[data-testid="tour-card"]')
  await page.keyboard.press('Escape')
  await page.waitForSelector('[data-testid="tour"]', { state: 'detached', timeout: 5000 })
  await h.waitIdle()

  // ---------- 1024×700: icons-only sidebar, named, labelled on focus ----------
  const nav = await page.evaluate(() => {
    const n = document.querySelector('[data-testid="simple-nav"]')
    const sell = document.querySelector('[data-testid="simple-nav-sell"]')
    return { collapsed: n?.getAttribute('data-collapsed'), width: n?.getBoundingClientRect().width ?? 0, sellName: sell?.getAttribute('aria-label'), sellText: sell?.textContent ?? '' }
  })
  assertEq(nav.collapsed, 'true', 'under 1200 px the sidebar is icons only')
  assert(nav.width <= 80, `the narrow sidebar is narrow (${nav.width} px)`)
  assertEq(nav.sellName, 'Sell', 'each icon button is named by its label')
  assertEq(nav.sellText.trim(), '', 'no label text squeezed beside the icon')
  await page.focus('[data-testid="simple-nav-sell"]')
  await attached('[data-testid="simple-nav-tip"]')
  assertEq((await page.textContent('[data-testid="simple-nav-tip"]')).trim(), 'Sell', 'focus shows the label beside the icon')
  await layout('Home at 1024×700')
  await shot('01-home-light-1024')

  // ---------- Make a bill, keys only ----------
  await page.keyboard.press('Meta+k')
  await attached('[data-testid="input-palette"]')
  await page.keyboard.type('Make a bill')
  await attached('[data-testid="palette-simple-make-bill"]')
  await page.keyboard.press('Enter')
  await h.waitScreen('simple-sell')
  await attached('[data-testid="btn-sell-save"]:not([disabled])', 15000)
  await tabTo('btn-sell-toggle-mode')
  await page.keyboard.press('Enter') // "Just an amount instead"
  await attached('[data-testid="input-sell-amount"]')
  await tabTo('input-sell-amount', { back: true }).catch(() => tabTo('input-sell-amount'))
  await page.keyboard.type('500')
  await page.waitForFunction(() => (document.querySelector('[data-testid="sell-preview"]')?.textContent ?? '').includes('₹500.00'), null, { timeout: 10000 })
  // The preview line sits in the Save bar — in view with the Save button at 700 px.
  const bar = await page.evaluate(() => {
    const p = document.querySelector('[data-testid="sell-preview"]')
    const r = p.getBoundingClientRect()
    return { inBar: !!p.closest('[data-testid="save-bar"]'), visible: r.top >= 0 && r.bottom <= innerHeight }
  })
  assert(bar.inBar && bar.visible, `the preview line is in the Save bar and on screen (${JSON.stringify(bar)})`)
  await layout('Make a bill at 1024×700')
  await shot('02-bill-light-1024')
  await page.keyboard.press('Meta+Enter')
  await attached('[data-testid="save-card"][data-state="saved"]', 15000)
  await page.waitForFunction(() => (document.querySelector('[data-testid="save-card-text"]')?.textContent ?? '').includes('saved'), null, { timeout: 10000 })
  assertEq(await active(), 'save-card', 'after ⌘↵ the save card has the keyboard (Tab reaches New / Undo next)')
  assertEq(await page.getAttribute('[data-testid="save-card"]', 'aria-live'), 'polite', 'the save card is announced')

  // ---------- ⌘K → Money in, keys only ----------
  await page.keyboard.press('Meta+k')
  await attached('[data-testid="input-palette"]')
  await page.keyboard.type('Money in')
  await attached('[data-testid="palette-simple-money-in"]')
  await page.keyboard.press('Enter')
  await h.waitScreen('simple-money-in')
  await attached('[data-testid="money-in-who-customer"]')
  await radioTo('money-in-who-customer', { back: true })
  await page.keyboard.press('ArrowRight') // → "I put in my own money"
  assertEq(await active(), 'money-in-who-owner', '→ moved to the next choice')
  assertEq(await page.getAttribute('[data-testid="money-in-who-owner"]', 'aria-checked'), 'true', '→ picked it')
  await tabTo('input-money-amount')
  await page.keyboard.type('1000')
  await page.waitForFunction(() => (document.querySelector('[data-testid="money-preview"]')?.textContent ?? '').includes('₹1,000.00'), null, { timeout: 10000 })
  await page.keyboard.press('Meta+Enter')
  await attached('[data-testid="save-card"][data-state="saved"]', 15000)

  // ---------- Esc closes the topmost layer only: panel → form's question → back ----------
  assertEq(await active(), 'save-card', 'the money save card has the keyboard too')
  await tabTo('btn-save-card-new', { max: 10 })
  await page.keyboard.press('Enter') // a new Money in
  await attached('[data-testid="money-in-who-customer"]')
  await tabTo('input-money-amount')
  await page.keyboard.type('250') // the form is dirty now
  const mainWidth = await page.evaluate(() => document.getElementById('main').clientWidth)
  await page.keyboard.press('Meta+/') // Help, from inside a box
  await attached('[data-testid="help-panel"][data-overlay]')
  assertEq(await page.evaluate(() => document.getElementById('main').clientWidth), mainWidth, 'under 1600 px Help overlays: the screen keeps its width')
  assertEq(await active(), 'help-panel', 'the keyboard moved into the panel')
  await waitForSettled(page)
  const helpFindings = []
  await sweepInto(page, 'help over Money in', helpFindings)
  assert(helpFindings.length === 0, helpFindings.join('; '))
  await shot('03-help-over-money-light-1024')
  await page.keyboard.press('Escape')
  await page.waitForSelector('[data-testid="help-panel"]', { state: 'detached', timeout: 5000 })
  assertEq(await page.getAttribute('[data-screen]', 'data-screen'), 'simple-money-in', 'Esc closed Help only — still on Money in')
  assertEq(await active(), 'input-money-amount', 'the keyboard is back where it was')
  assert(/^250(\.00)?$/.test(await page.inputValue('[data-testid="input-money-amount"]')), 'the answer is kept')
  // Help open again, keyboard on the FORM: Esc still closes the top layer (Help) first.
  await page.keyboard.press('Meta+/')
  await attached('[data-testid="help-panel"]')
  await page.focus('[data-testid="money-in-who-owner"]')
  await page.keyboard.press('Escape')
  await page.waitForSelector('[data-testid="help-panel"]', { state: 'detached', timeout: 5000 })
  assertEq(await page.$('[data-testid="confirm-ok"]'), null, 'that Esc did not reach the form')
  // Now the form: Esc asks before discarding; Esc closes that question only.
  await page.keyboard.press('Escape')
  await attached('[data-testid="confirm-ok"]')
  await page.keyboard.press('Escape')
  await page.waitForSelector('[data-testid="confirm-ok"]', { state: 'detached', timeout: 5000 })
  assertEq(await page.getAttribute('[data-screen]', 'data-screen'), 'simple-money-in', 'Esc closed the question only')
  assert(/^250(\.00)?$/.test(await page.inputValue('[data-testid="input-money-amount"]')), 'and kept the answers')

  // ---------- 1024×700 at 125 % zoom (819×560 CSS px): nothing cut off, the window never scrolls ----------
  await page.setViewportSize({ width: 819, height: 560 })
  await page.waitForTimeout(200)
  await layout('Money in at 125 %')
  await page.keyboard.press('Meta+k')
  await attached('[data-testid="input-palette"]')
  await page.keyboard.type('Make a bill')
  await attached('[data-testid="palette-simple-make-bill"]')
  await page.keyboard.press('Enter')
  // Leaving the unsaved Money in asks first; Enter answers the focused "Discard".
  const asked = await page.waitForSelector('[data-testid="confirm-ok"]', { state: 'attached', timeout: 3000 }).catch(() => null)
  if (asked) await page.keyboard.press('Enter')
  await h.waitScreen('simple-sell')
  await layout('Make a bill at 125 %')
  await shot('04-bill-light-819-zoom125')

  // ---------- the visual review: light + dark at 1024×700 and 1440×900 ----------
  for (const [w, hh] of [[1024, 700], [1440, 900]]) {
    await page.setViewportSize({ width: w, height: hh })
    for (const theme of ['dark', 'light']) {
      const now = await page.evaluate(() => document.documentElement.dataset.theme ?? 'light')
      if (now !== theme) {
        await page.focus('[data-testid="btn-theme"]')
        await page.keyboard.press('Enter')
        await page.waitForFunction((t) => (document.documentElement.dataset.theme ?? 'light') === t, theme)
      }
      if (w === 1024 && theme === 'light') continue // taken above
      await waitForSettled(page)
      await shot(`05-bill-${theme}-${w}`)
    }
  }
  await page.setViewportSize({ width: 1440, height: 900 })

  const dest = process.env.WP105_SHOTS
  if (dest) {
    fs.mkdirSync(dest, { recursive: true })
    for (const f of shots) fs.copyFileSync(f, path.join(dest, path.basename(f)))
  }
})
