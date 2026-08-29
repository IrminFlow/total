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

  // Support diagnostics are allow-listed and visible before consent/submission.
  await h.click('link-support')
  await h.page.waitForSelector('[data-testid="support-diagnostics-preview"]')
  const supportPreview = await h.page.locator('[data-testid="support-diagnostics-preview"] pre').textContent()
  const diagnosticKeys = Object.keys(JSON.parse(supportPreview)).sort()
  assert(JSON.stringify(diagnosticKeys) === JSON.stringify(['arch', 'installationId', 'platform', 'version']), `support payload has only safe keys (got ${diagnosticKeys})`)
  const supportDiagnostics = JSON.parse(supportPreview)
  assert(/^[0-9a-f-]{36}$/i.test(supportDiagnostics.installationId), 'support installation reference is an opaque UUID')
  assert(!supportPreview.includes('Demo Traders'), 'support diagnostics exclude company identity')
  await h.shot('03-support-diagnostics-consent')
  await h.click('modal-close')
})
