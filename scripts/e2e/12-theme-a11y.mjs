// Scenario 12 — theme + a11y sanity: both themes paint real (different) backgrounds, body
// text clears WCAG AA contrast in each, the amber selection bar is an inset box-shadow (the
// tr::before phantom-cell rule), and every sidebar nav control has an accessible name.
import { scenario, assert } from '../lib/harness.mjs'

/** WCAG relative-luminance contrast between two 'rgb(r, g, b)' strings. */
function contrast(a, b) {
  const lum = (css) => {
    const [r, g, b2] = css.match(/\d+/g).map(Number)
    const f = (c) => {
      const s = c / 255
      return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4)
    }
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b2)
  }
  const [l1, l2] = [lum(a), lum(b)].sort((x, y) => y - x)
  return (l1 + 0.05) / (l2 + 0.05)
}

await scenario('12-theme-a11y', async (h) => {
  await h.createDemoCompany()

  const sample = async () =>
    h.page.evaluate(() => {
      const cs = getComputedStyle(document.body)
      const main = document.querySelector('[data-screen]')
      return {
        theme: document.documentElement.dataset.theme ?? 'light',
        bg: cs.backgroundColor,
        fg: cs.color,
        mainBg: main ? getComputedStyle(main).backgroundColor : null
      }
    })

  const setTheme = async (theme) => {
    const now = await h.page.evaluate(() => document.documentElement.dataset.theme ?? 'light')
    if (now !== theme) await h.click('btn-theme')
  }

  const byTheme = {}
  for (const theme of ['light', 'dark']) {
    await setTheme(theme)
    const s = await sample()
    assert(s.theme === theme, `data-theme is ${theme}`)
    assert(!/rgba\(0, 0, 0, 0\)|transparent/.test(s.bg), `${theme}: body paints a real background (got ${s.bg})`)
    const ratio = contrast(s.fg, s.bg)
    assert(ratio >= 4.5, `${theme}: body text contrast ${ratio.toFixed(2)} ≥ 4.5 (fg ${s.fg} on bg ${s.bg})`)
    byTheme[theme] = s
    await h.shot(`01-${theme}-gateway`)
  }
  assert(byTheme.light.bg !== byTheme.dark.bg, 'light and dark actually differ')

  // The amber selection bar: inset box-shadow on the active row, never a ::before pseudo-cell.
  await h.goto('daybook')
  await h.page.waitForSelector('tr.kbar-row[data-active="true"]', { timeout: 10000 })
  const bar = await h.page.evaluate(() => {
    const el = document.querySelector('tr.kbar-row[data-active="true"]')
    const firstCell = el.querySelector('td')
    return {
      cellShadow: firstCell ? getComputedStyle(firstCell).boxShadow : 'no-td',
      beforeContent: getComputedStyle(el, '::before').content
    }
  })
  assert(/inset/.test(bar.cellShadow), `active table row draws the bar as an inset box-shadow on td:first-child (got ${bar.cellShadow})`)
  assert(bar.beforeContent === 'none' || bar.beforeContent === 'normal', `no ::before phantom cell on the table row (got ${bar.beforeContent})`)
  await h.shot('02-selection-bar')

  // Every sidebar nav button has an accessible name (text content).
  const unnamed = await h.page.evaluate(() =>
    [...document.querySelectorAll('[data-testid^="nav-"]')]
      .filter((b) => !(b.textContent ?? '').trim() && !b.getAttribute('aria-label'))
      .map((b) => b.getAttribute('data-testid'))
  )
  assert(unnamed.length === 0, `nav buttons without an accessible name: ${unnamed.join(', ')}`)

  // Inputs across a form-heavy screen carry a label, placeholder, or aria-label.
  await h.goto('masters')
  const nakedInputs = await h.page.evaluate(() =>
    [...document.querySelectorAll('input:not([type="hidden"]), select, textarea')]
      .filter((el) => {
        if (el.getAttribute('aria-label') || el.getAttribute('placeholder')) return false
        if (el.id && document.querySelector(`label[for="${el.id}"]`)) return false
        if (el.closest('label')) return false
        return true
      })
      .map((el) => el.getAttribute('data-testid') ?? el.name ?? el.type)
  )
  // Report rather than hard-fail on legacy fields; but nothing NEW should appear here.
  console.log('[12-theme-a11y] unlabeled inputs on masters:', JSON.stringify(nakedInputs))

  await setTheme('light') // leave the shared profile in the default theme for later scenarios

  // ---- every button on every screen has an accessible name ----
  // A button read out as "button" is a button a screen-reader user cannot use. This walks the
  // sidebar rather than checking one screen, because the screens differ enormously and the ones
  // with icon-only controls are exactly the ones a single-screen check would miss.
  const screens = await h.page.$$eval('[data-testid^="nav-"]', (els) =>
    els.map((el) => (el.dataset.testid || '').replace(/^nav-/, ''))
  )
  const nameless = []
  for (const name of screens) {
    await h.goto(name, 20000)
    const found = await h.page.evaluate(
      (screenName) =>
        [...document.querySelectorAll('button, a[href], [role="button"]')]
          .filter((el) => {
            // Hidden controls cannot be reached, so they cannot be unreadable.
            if (!(el instanceof HTMLElement) || el.offsetParent === null) return false
            const text = (el.textContent ?? '').replace(/\s+/g, ' ').trim()
            return !text && !el.getAttribute('aria-label') && !el.getAttribute('title')
          })
          .map((el) => `${screenName}:${el.getAttribute('data-testid') ?? el.className.slice(0, 40)}`),
      name
    )
    nameless.push(...found)
  }
  assert(
    nameless.length === 0,
    `controls with no accessible name (no text, no aria-label, no title): ${nameless.join(' | ')}`
  )

  // ---- skip-to-content ----
  // The sidebar is twenty-odd links; tabbing past all of them to reach the report you just
  // opened is the difference between keyboard-first and merely having shortcuts.
  await h.goto('gateway')
  // Start from the top of the document: navigating leaves focus on the sidebar link that was
  // clicked, and tabbing from there would just move to the next link.
  // Blurring is not enough: Chromium keeps a sequential-focus starting point where the last
  // focused element was, so Tab would continue from the sidebar. Focusing the body resets it.
  await h.page.evaluate(() => {
    document.body.setAttribute('tabindex', '-1')
    document.body.focus()
  })
  await h.page.keyboard.press('Tab')
  const firstStop = await h.page.evaluate(() => document.activeElement?.getAttribute('data-testid'))
  assert(firstStop === 'skip-to-content', `the first tab stop is the skip link (got ${firstStop})`)
  await h.page.keyboard.press('Enter')
  const focused = await h.page.evaluate(() => document.activeElement?.id)
  assert(focused === 'main-content', `and it moves focus into the content (got ${focused})`)

  // ---- table headers are associated with their cells ----
  await h.goto('trial-balance')
  const unscoped = await h.page.$$eval('th', (els) => els.filter((e) => !e.getAttribute('scope')).length)
  assert(unscoped === 0, `${unscoped} table headers without a scope`)
})
