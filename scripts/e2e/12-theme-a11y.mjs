// Scenario 12 — theme + a11y: both themes paint real (different) backgrounds, body text clears
// WCAG AA, the amber selection bar is an inset box-shadow (the tr::before phantom-cell rule), the
// skip link works, and — on EVERY sidebar screen in BOTH themes — an automated sweep with plain
// DOM / computed styles (no axe dependency):
//   contrast   every visible text node's colour vs. its composited background ≥ 4.5 (3 for large
//              text); disabled controls and aria-hidden content are exempt.
//   labels     every visible input/select/textarea and button has an accessible name; every
//              role="tab" sits in a role="tablist".
//   focus      Tab through the first stops: each focused element shows a visible indicator
//              (outline, ring/box-shadow, underline or a background change).
// The checks live in scripts/lib/a11y.mjs (shared with 63-keyboard-simple). Each sweep waits
// for the screen's animations / transitions to finish first (waitForSettled): the old "flake" —
// 9 findings at 4.41 on light/report-builder — was the result table's refetch dim (opacity-70,
// transition-opacity) caught mid-fade, not a token.
//
// WP 10.5: then the SIMPLE shell — the same company switched to simple mode, every simple
// screen reachable from its sidebar (section pages + their simple entries) plus the Help and
// Ask Total panels, in both themes at 1280×800 and 1024×700: contrast, names, labels, tabs,
// aria-describedby, and the window-size / landmark checks (layoutInPage: the window itself never
// scrolls, no button cut off or its label clipped, one banner / a navigation / one main, named
// panels and dialogs that fit the window); focus indicators at 1280×800.
import { scenario, assert } from '../lib/harness.mjs'
import { contrast, sweepInPage, snapshotFocusablesInPage, focusedIndicatorInPage, waitForSettled, sweepSimpleShell, layoutInPage, plantToastInPage } from '../lib/a11y.mjs'

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

  // Skip link: the first Tab stop, visible when focused, and it moves focus to <main>.
  // From the first header control, Shift+Tab must land on the skip link (it precedes everything).
  await h.page.focus('header button')
  await h.page.keyboard.press('Shift+Tab')

  const skip = await h.page.evaluate(() => {
    const el = document.activeElement
    return { id: el?.getAttribute('data-testid'), w: el?.getBoundingClientRect().width ?? 0 }
  })
  assert(skip.id === 'skip-to-content', `the skip link is the first Tab stop (got ${skip.id})`)
  assert(skip.w > 20, 'the skip link is visible while focused')
  await h.page.keyboard.press('Enter')
  assert((await h.page.evaluate(() => document.activeElement?.id)) === 'main', 'Enter on the skip link focuses <main>')

  // The sweep, on every sidebar screen in both themes.
  const screens = await h.page.evaluate(() =>
    [...document.querySelectorAll('[data-testid^="nav-"]')]
      .map((b) => b.getAttribute('data-testid').slice(4))
      .filter((n) => !n.startsWith('section-'))
  )
  assert(screens.length >= 20, `found the sidebar screens (${screens.length})`)
  const failures = []
  let drawers = 0
  for (const theme of ['light', 'dark']) {
    await setTheme(theme)
    for (const name of screens) {
      await h.goto(name)
      await h.page.waitForTimeout(150)
      await waitForSettled(h.page)
      const r = await h.page.evaluate(sweepInPage)
      for (const c of r.lowContrast) failures.push(`${theme}/${name} contrast: ${c}`)
      for (const u of r.unlabeled) failures.push(`${theme}/${name} unlabeled: ${u}`)
      for (const t of r.orphanTabs) failures.push(`${theme}/${name} tab outside a tablist: ${t}`)

      // Focus: from <main>, Tab through the first stops of the screen.
      const rest = await h.page.evaluate(snapshotFocusablesInPage)
      await h.page.evaluate(() => document.getElementById('main')?.focus())
      for (let i = 0; i < 12; i++) {
        await h.page.keyboard.press('Tab')
        const f = await h.page.evaluate(focusedIndicatorInPage, rest)
        if (!f.ok) failures.push(`${theme}/${name} focus not visible: ${f.what}`)
      }

      // The screen's Options drawer gets the same sweep, then Esc closes it (the top layer only).
      const optionsBtn = `[data-testid="btn-${name}-options"]`
      if (await h.page.$(optionsBtn)) {
        await h.page.click(optionsBtn)
        await h.page.waitForSelector(`[data-testid="options-${name}"]`, { timeout: 5000 })
        await h.page.waitForTimeout(300) // let the slide-in (opacity) animation finish
        await waitForSettled(h.page)
        const d = await h.page.evaluate(sweepInPage)
        for (const c of d.lowContrast) failures.push(`${theme}/${name} options contrast: ${c}`)
        for (const u of d.unlabeled) failures.push(`${theme}/${name} options unlabeled: ${u}`)
        await h.page.keyboard.press('Escape')
        await h.page.waitForSelector(`[data-testid="options-${name}"]`, { state: 'detached', timeout: 5000 })
        assert((await h.page.$(`[data-screen="${name}"]`)) !== null, `${name}: Esc closed the drawer without leaving the screen`)
        drawers++
      }
    }

  }
  const unique = [...new Set(failures)]
  if (unique.length) console.log(`[12-theme-a11y] ${unique.length} findings:\n  ${unique.join('\n  ')}`)
  assert(unique.length === 0, `a11y sweep: ${unique.length} findings (see log above)`)
  assert(drawers >= 30, `swept the Options drawer on most screens in both themes (${drawers})`)

  await h.shot('03-sweep-done')

  // ---------- WP 10.5: the simple shell, both themes, two window sizes ----------
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
  if (simpleUnique.length) console.log(`[12-theme-a11y] simple shell: ${simpleUnique.length} findings:\n  ${simpleUnique.join('\n  ')}`)
  assert(simpleUnique.length === 0, `simple-shell a11y sweep: ${simpleUnique.length} findings (see log above)`)
  assert(simpleSwept >= 4 * 30, `swept the simple screens at both sizes in both themes (${simpleSwept})`)

  await setTheme('light') // leave the shared profile in the default theme for later scenarios
})
