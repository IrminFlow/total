// Scenario 12 — theme + a11y sanity: both themes paint real (different) backgrounds, body
// text clears WCAG AA contrast in each, the accent selection bar is an inset box-shadow (the
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

  // The header button cycles light → dark → high contrast, so reaching a named theme can take
  // more than one press. Bounded, so a broken toggle fails the scenario instead of spinning.
  const setTheme = async (theme) => {
    for (let i = 0; i < 4; i++) {
      const now = await h.page.evaluate(() => document.documentElement.dataset.theme ?? 'light')
      if (now === theme) return
      await h.click('btn-theme')
    }
    throw new Error(`could not reach theme ${theme} by cycling the header button`)
  }

  const byTheme = {}
  // High contrast (#278) is held to AAA rather than AA: a theme that exists for low vision and
  // only manages the ordinary threshold has not done anything.
  for (const [theme, floor] of [
    ['light', 4.5],
    ['dark', 4.5],
    ['contrast', 7]
  ]) {
    await setTheme(theme)
    const s = await sample()
    assert(s.theme === theme, `data-theme is ${theme}`)
    assert(!/rgba\(0, 0, 0, 0\)|transparent/.test(s.bg), `${theme}: body paints a real background (got ${s.bg})`)
    const ratio = contrast(s.fg, s.bg)
    assert(ratio >= floor, `${theme}: body text contrast ${ratio.toFixed(2)} ≥ ${floor} (fg ${s.fg} on bg ${s.bg})`)
    byTheme[theme] = s
    await h.shot(`01-${theme}-gateway`)
  }
  assert(byTheme.light.bg !== byTheme.dark.bg, 'light and dark actually differ')
  assert(
    byTheme.contrast.bg !== byTheme.light.bg || byTheme.contrast.fg !== byTheme.light.fg,
    'high contrast is not just the light theme again'
  )

  // Muted text is the tone most likely to fail: it exists to be quieter than the ink. In the
  // high-contrast theme it still has to clear AA for body text.
  await setTheme('contrast')
  const mutedRatio = await h.page.evaluate(() => {
    const el = document.querySelector('.text-muted')
    if (!el) return null
    return [getComputedStyle(el).color, getComputedStyle(document.body).backgroundColor]
  })
  if (mutedRatio) {
    const r = contrast(mutedRatio[0], mutedRatio[1])
    assert(r >= 4.5, `high contrast: muted text contrast ${r.toFixed(2)} ≥ 4.5`)
  }
  await h.shot('01-contrast-muted')
  await setTheme('light') // the rest of the scenario checks structure, not colour

  // The accent selection bar: inset box-shadow on the active row, never a ::before pseudo-cell.
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

  // ---- row selection is announced (#275) ----
  // The accent bar moving changes no accessible state at all, so without a live region the whole
  // Day Book is silent to a screen reader. Assert the region exists, is polite, and says which
  // row of how many — the thing a sighted user gets free from the scrollbar.
  await h.goto('daybook')
  await h.page.waitForSelector('tr.kbar-row[data-active="true"]', { timeout: 10000 })
  const region = await h.page.evaluate(() => {
    const el = document.querySelector('[data-testid="live-announcer"]')
    return el ? { live: el.getAttribute('aria-live'), atomic: el.getAttribute('aria-atomic') } : null
  })
  assert(region?.live === 'polite', `the row-selection live region is polite (got ${JSON.stringify(region)})`)
  assert(region?.atomic === 'true', 'the live region is atomic, so the whole row is re-read')
  await h.page.keyboard.press('ArrowDown')
  await h.page.waitForFunction(
    () => /^Row \d+ of \d+/.test(document.querySelector('[data-testid="live-announcer"]')?.textContent ?? ''),
    undefined,
    { timeout: 5000 }
  )
  const announced = await h.page.textContent('[data-testid="live-announcer"]')
  assert(/^Row \d+ of \d+: .+/.test(announced), `arrowing down announces the row it landed on (got "${announced}")`)

  // ---- every hover-revealed action is reachable without a pointer (#283) ----
  // Two screens moved their row actions onto hover. A hover-only action is unreachable by
  // keyboard and invisible to a reader, so each one has to light up on the keyboard-active row
  // and when focus lands on it — checked with computed opacity, never by reading the classes.
  for (const [screen, selector] of [
    ['daybook', 'tr[data-active="true"] .row-action'],
    ['masters', 'tr[data-active="true"] .row-action']
  ]) {
    await h.goto(screen)
    await h.page.waitForSelector('tr.kbar-row[data-active="true"]', { timeout: 10000 })
    const onActiveRow = await h.page.evaluate((sel) => {
      const el = document.querySelector(sel)
      return el ? getComputedStyle(el).opacity : null
    }, selector)
    if (onActiveRow !== null) {
      assert(Number(onActiveRow) === 1, `${screen}: the action on the keyboard-active row is visible (opacity ${onActiveRow})`)
    }
    // And on focus, on a row the keyboard bar is NOT on — the pure Tab case.
    const found = await h.page.evaluate(() => {
      const el = [...document.querySelectorAll('tr:not([data-active="true"]) .row-action')].find(
        (e) => e instanceof HTMLElement
      )
      if (!el) return false
      el.dataset.a11yProbe = '1'
      return true
    })
    if (found) {
      // Polled, not read once. The claim under test is about the RESTING state of an idle row,
      // and the arrow press a few lines up left the row the selection came from part-way through
      // a 120ms fade — so an immediate read is a coin toss on a fact that is not in doubt. What
      // would actually be a bug is the opacity never coming down, which is what a timeout here
      // reports.
      await h.page.waitForFunction(
        () => Number(getComputedStyle(document.querySelector('[data-a11y-probe]')).opacity) < 0.5,
        undefined,
        { timeout: 3000 }
      )
      await h.page.evaluate(() => document.querySelector('[data-a11y-probe]').focus())
      // Polled, not read once: the reveal is a 120ms opacity transition, so an immediate read
      // catches it a third of the way up and proves nothing either way.
      await h.page.waitForFunction(
        () => getComputedStyle(document.querySelector('[data-a11y-probe]')).opacity === '1',
        undefined,
        { timeout: 3000 }
      )
      await h.page.evaluate(() => document.querySelector('[data-a11y-probe]')?.removeAttribute('data-a11y-probe'))
    }
  }

  // The Masters group tree carries three actions on one node; they were the ones with no focus
  // rule at all. Tabbing to Rename must reveal Move and Delete beside it.
  await h.goto('masters')
  await h.click('tab-masters-groups').catch(() => {})
  const groupActions = await h.page.evaluate(() => {
    const btn = document.querySelector('[data-testid="btn-masters-group-rename"]')
    if (!btn) return 'absent'
    btn.focus()
    const sibling = document.querySelector('[data-testid="btn-masters-group-delete"]')
    return `${getComputedStyle(btn.parentElement ?? btn).opacity}/${sibling ? getComputedStyle(sibling.parentElement ?? sibling).opacity : '?'}`
  })
  if (groupActions !== 'absent') {
    assert(groupActions.startsWith('1/1'), `focusing Rename reveals the whole group-action row (got ${groupActions})`)
  }

  // ---- the command palette is a real dialog and traps focus (#280) ----
  // It used to be an unlabelled <div> whose only a11y behaviour was autoFocus on the input, so
  // Tab walked straight out into the sidebar behind the dimmer.
  await h.goto('daybook')
  await h.page.keyboard.press('Control+k')
  await h.page.waitForSelector('[data-testid="input-palette"]', { timeout: 10000 })
  const paletteRole = await h.page.evaluate(() => {
    const el = document.querySelector('[data-testid="command-palette"]')
    return el ? { role: el.getAttribute('role'), modal: el.getAttribute('aria-modal'), name: el.getAttribute('aria-label') } : null
  })
  assert(paletteRole?.role === 'dialog', `the palette is a dialog (got ${JSON.stringify(paletteRole)})`)
  assert(paletteRole?.modal === 'true', 'and it is modal')
  assert(!!paletteRole?.name, 'and it has an accessible name')
  for (let i = 0; i < 6; i++) await h.page.keyboard.press('Tab')
  const trapped = await h.page.evaluate(() => !!document.activeElement?.closest('[data-testid="command-palette"]'))
  assert(trapped, 'Tab stays inside the palette instead of escaping to the sidebar behind it')
  await h.page.keyboard.press('Escape')
  await h.page.waitForSelector('[data-testid="input-palette"]', { state: 'detached', timeout: 10000 })
  const restored = await h.page.evaluate(() => ({
    tag: document.activeElement?.tagName,
    id: document.activeElement?.getAttribute('data-testid')
  }))
  console.log('[12-theme-a11y] focus after palette close:', JSON.stringify(restored))
  assert(restored.tag !== 'BODY', `closing the palette hands focus back rather than dropping it on <body> (got ${JSON.stringify(restored)})`)

  // ---- text size preference scales the scale, and only the scale (#279) ----
  await h.goto('settings')
  await h.click('tab-settings-appearance')
  await h.shot('03-appearance-settings')
  const before = await h.page.evaluate(() => {
    const cell = document.querySelector('.ledger-table td')
    return {
      body: parseFloat(getComputedStyle(document.body).fontSize),
      cellPad: cell ? getComputedStyle(cell).paddingLeft : null
    }
  })
  await h.click('opt-text-size-largest')
  const after = await h.page.evaluate(() => {
    const cell = document.querySelector('.ledger-table td')
    return {
      body: parseFloat(getComputedStyle(document.body).fontSize),
      cellPad: cell ? getComputedStyle(cell).paddingLeft : null,
      scale: getComputedStyle(document.documentElement).getPropertyValue('--t-font-scale').trim()
    }
  })
  assert(after.scale === '1.3', `Largest sets the font scale (got "${after.scale}")`)
  assert(after.body > before.body * 1.2, `body text actually grew (${before.body} → ${after.body})`)
  await h.shot('03-text-size-largest')

  // The density check: bigger text must not turn a dense ledger into a comfortable one, so the
  // horizontal rhythm — column padding — is the same number of pixels as before.
  await h.goto('daybook')
  const dense = await h.page.evaluate(() => {
    const cell = document.querySelector('.ledger-table td')
    return cell ? getComputedStyle(cell).paddingLeft : null
  })
  assert(dense === '12px', `table gutters are unchanged by the text-size preference (got ${dense})`)
  await h.shot('04-daybook-largest-text')

  // Back to default, so later scenarios see the app they expect.
  await h.goto('settings')
  await h.click('tab-settings-appearance')
  await h.click('opt-text-size-default')
  const restoredScale = await h.page.evaluate(() =>
    getComputedStyle(document.documentElement).getPropertyValue('--t-font-scale').trim()
  )
  assert(restoredScale === '1', `the preference goes back to 1 (got "${restoredScale}")`)

  // ---- reduced motion (#277) ----
  // Asserted on computed style, because the rule that matters is the one the browser applies —
  // a class name proves nothing. The transition is squashed to nothing; the spinner keeps a
  // non-vestibular opacity animation so "still working" is never silent.
  await h.click('opt-motion-reduced')
  const reduced = await h.page.evaluate(() => {
    const probe = document.createElement('div')
    probe.className = 'row-action'
    document.body.appendChild(probe)
    const spinner = document.createElement('span')
    spinner.className = 'animate-spin'
    document.body.appendChild(spinner)
    const out = {
      attr: document.documentElement.dataset.motion ?? null,
      transition: getComputedStyle(probe).transitionDuration,
      spin: getComputedStyle(spinner).animationName
    }
    probe.remove()
    spinner.remove()
    return out
  })
  assert(reduced.attr === 'reduced', `the preference reaches <html> (got ${reduced.attr})`)
  assert(parseFloat(reduced.transition) < 0.01, `transitions are squashed (got ${reduced.transition})`)
  assert(reduced.spin === 't-quiet-pulse', `the spinner keeps a non-vestibular pulse (got ${reduced.spin})`)

  await h.click('opt-motion-system')
  const back = await h.page.evaluate(() => document.documentElement.dataset.motion ?? null)
  assert(back === null, 'and it goes back to following the system')


  // ---- the focus-ring audit (#20) ----
  //
  // The deliverable for "every interactive control reachable by Tab" is a test, not a component,
  // and the thing it has to catch is not "is there an outline property" — there is, globally, in
  // app.css. It is a ring that EXISTS and is INVISIBLE: drawn in a colour that does not separate
  // from the surface behind it, or on a control the tab order never reaches at all. So this
  // asserts on computed style and on contrast, the way the rest of this scenario does.
  //
  // WCAG 2.2 SC 1.4.11 puts non-text contrast at 3:1, and a focus ring is the example the
  // specification itself gives. That is the floor used here.
  const FOCUS_RING_MIN_CONTRAST = 3

  await setTheme('light')

  // Transitions off for the duration of the audit.
  //
  // `transition-colors` on every button includes `outline-color`, so a computed style read the
  // instant after .focus() catches the ring part-way from its resting `currentColor` to the
  // accent — which reports a white ring on a white primary button and a grey one on a ghost. The
  // claim under test is about the RESTING focused state, not the 150ms getting there.
  await h.page.addStyleTag({ content: '*, *::before, *::after { transition: none !important; }' })

  // One real Tab first. Chromium decides :focus-visible from the last input modality, so a
  // script-driven .focus() only matches it once the browser believes the keyboard is in use —
  // and without this every ring below would read as absent for a reason that is not a bug.
  await h.goto('gateway')
  await h.page.evaluate(() => {
    document.body.setAttribute('tabindex', '-1')
    document.body.focus()
  })
  await h.page.keyboard.press('Tab')

  // Proof that the modality trick worked, before anything is concluded from it. If Chromium ever
  // stops honouring it, this fails here rather than passing the whole audit vacuously.
  const modality = await h.page.evaluate(() => {
    const el = document.querySelector('[data-testid="skip-to-content"]')
    if (!(el instanceof HTMLElement)) return null
    el.focus()
    const cs = getComputedStyle(el)
    return { matches: el.matches(':focus-visible'), outline: cs.outlineWidth, style: cs.outlineStyle }
  })
  assert(
    modality?.matches === true,
    `script focus counts as keyboard focus after a real Tab (got ${JSON.stringify(modality)}) — the audit below depends on it`
  )

  /**
   * Walk every focusable control on the current screen and report the ones that are wrong.
   *
   * `bg` is resolved up the ancestor chain, because a ring is painted over whatever is actually
   * behind the control and almost every control sits on a transparent background of its own.
   */
  const auditScreen = async (screenName) =>
    h.page.evaluate((name) => {
      const FOCUSABLE = 'button, a[href], input:not([type="hidden"]), select, textarea, [tabindex]'
      /**
       * What is actually painted behind the control.
       *
       * Composited, not just "the first ancestor with a background". The selected row's tint is
       * `rgba(67, 56, 202, 0.1)` — 10% indigo — and comparing an indigo ring against that raw
       * value says 1:1, which is nonsense: over paper the tint renders as pale lavender and the
       * ring is perfectly visible. An audit that reports a fault where there is none gets
       * switched off, which is worse than not having it.
       */
      const behind = (el) => {
        const layers = []
        let node = el.parentElement
        while (node) {
          const bg = getComputedStyle(node).backgroundColor
          const m = bg && bg.match(/rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?\)/)
          if (m) {
            const alpha = m[4] === undefined ? 1 : Number(m[4])
            if (alpha > 0) {
              layers.push({ r: Number(m[1]), g: Number(m[2]), b: Number(m[3]), a: alpha })
              if (alpha >= 1) break
            }
          }
          node = node.parentElement
        }
        // Bottom-up: the opaque layer first, then each translucent one over it.
        let out = { r: 255, g: 255, b: 255 }
        for (const layer of layers.reverse()) {
          out = {
            r: layer.r * layer.a + out.r * (1 - layer.a),
            g: layer.g * layer.a + out.g * (1 - layer.a),
            b: layer.b * layer.a + out.b * (1 - layer.a)
          }
        }
        return `rgb(${Math.round(out.r)}, ${Math.round(out.g)}, ${Math.round(out.b)})`
      }
      const id = (el) =>
        `${name}:${el.getAttribute('data-testid') ?? `${el.tagName.toLowerCase()}.${(el.className || '').toString().slice(0, 30)}`}`

      // A control, as opposed to a focus TARGET. `<main id="main-content" tabindex="-1">` is in
      // the selector because it can be focused, but it is where the skip link lands, not something
      // a person operates — and demanding it be in the tab order would be demanding a second stop
      // between the skip link and the first real control.
      const isControl = (el) =>
        el.matches('button, a[href], input, select, textarea') ||
        ['button', 'link', 'checkbox', 'radio', 'switch', 'menuitem', 'tab', 'combobox'].includes(
          el.getAttribute('role') ?? ''
        )

      const unreachable = []
      const ringless = []
      const rings = []
      const active = document.activeElement

      for (const el of document.querySelectorAll(FOCUSABLE)) {
        if (!(el instanceof HTMLElement) || !isControl(el)) continue
        // Hidden or disabled controls cannot be reached, so they cannot be unreachable.
        if (el.offsetParent === null && getComputedStyle(el).position !== 'fixed') continue
        if (el.hasAttribute('disabled') || el.getAttribute('aria-hidden') === 'true') continue
        if (getComputedStyle(el).visibility === 'hidden') continue

        // A visible, enabled control the tab order skips. Not a style problem — a control a
        // keyboard user simply cannot get to.
        if (el.getAttribute('tabindex') === '-1') {
          unreachable.push(id(el))
          continue
        }

        // Measured as a DIFFERENCE, before and after focus. Reading only the focused state
        // would count every button's resting `panel-shadow` as a focus indicator, which is how a
        // ring that never actually appears passes an audit — the bug this test exists to catch.
        const before = getComputedStyle(el)
        const resting = { outline: before.outlineStyle, width: before.outlineWidth, shadow: before.boxShadow }

        el.focus()
        if (document.activeElement !== el) {
          unreachable.push(`${id(el)} (refused focus)`)
          continue
        }
        const cs = getComputedStyle(el)
        const width = parseFloat(cs.outlineWidth) || 0
        const gainedOutline =
          cs.outlineStyle !== 'none' && width >= 1 && (resting.outline === 'none' || resting.width !== cs.outlineWidth)
        // A ring drawn as a box-shadow counts, but only when the shadow CHANGED: several controls
        // in this app indicate focus that way, and what matters to a keyboard user is that
        // something appeared that was not there a moment ago.
        const gainedShadow = cs.boxShadow !== resting.shadow

        if (!gainedOutline && !gainedShadow) {
          ringless.push(id(el))
          continue
        }
        const colour = gainedOutline
          ? cs.outlineColor
          : (cs.boxShadow.match(/rgba?\([^)]+\)/) ?? [])[0]
        if (colour) rings.push({ id: id(el), colour, bg: behind(el) })
      }

      if (active instanceof HTMLElement) active.focus()
      return { unreachable, ringless, rings }
    }, screenName)

  const screensToAudit = await h.page.$$eval('[data-testid^="nav-"]', (els) =>
    els.map((el) => (el.dataset.testid || '').replace(/^nav-/, ''))
  )

  const unreachable = []
  const ringless = []
  const lowContrast = []
  let ringsChecked = 0

  for (const name of screensToAudit) {
    await h.goto(name, 20000)
    // Navigating CLICKS a sidebar button, and a click puts Chromium back into pointer modality —
    // at which point :focus-visible stops matching a scripted .focus() and every ring on the
    // screen would read as absent. One Tab per screen puts the keyboard back in charge. (This is
    // not a workaround for a bug: it is the same reason a mouse user does not see focus rings.)
    await h.page.keyboard.press('Tab')
    const result = await auditScreen(name)
    unreachable.push(...result.unreachable)
    ringless.push(...result.ringless)
    for (const ring of result.rings) {
      ringsChecked++
      const ratio = contrast(ring.colour, ring.bg)
      if (ratio < FOCUS_RING_MIN_CONTRAST) {
        lowContrast.push(`${ring.id}: ${ratio.toFixed(2)}:1 (${ring.colour} on ${ring.bg})`)
      }
    }
  }

  // A floor, so a refactor that quietly stops finding controls fails here rather than passing
  // an audit of nothing.
  assert(ringsChecked > 1000, `the audit actually looked at controls (checked ${ringsChecked} rings)`)
  assert(unreachable.length === 0, `controls a keyboard cannot reach: ${unreachable.join(' | ')}`)
  assert(ringless.length === 0, `focused controls that draw nothing at all: ${ringless.join(' | ')}`)
  assert(
    lowContrast.length === 0,
    `focus rings that exist but are invisible against what is behind them (need ${FOCUS_RING_MIN_CONTRAST}:1): ${lowContrast.join(' | ')}`
  )
  console.log(`[12-theme-a11y] focus-ring audit: ${ringsChecked} rings across ${screensToAudit.length} screens`)

  // And the same in the dark and high-contrast themes: a ring tuned against paper is exactly the
  // one that disappears on a dark panel, and that is the bug this half exists to catch.
  for (const theme of ['dark', 'contrast']) {
    await setTheme(theme)
    await h.goto('daybook')
    await h.page.keyboard.press('Tab') // pointer modality again — see the loop above
    const result = await auditScreen(`${theme}:daybook`)
    const bad = result.rings
      .map((r) => ({ ...r, ratio: contrast(r.colour, r.bg) }))
      .filter((r) => r.ratio < FOCUS_RING_MIN_CONTRAST)
    assert(
      bad.length === 0,
      `${theme}: focus rings invisible against the panel: ${bad.map((b) => `${b.id} ${b.ratio.toFixed(2)}:1`).join(' | ')}`
    )
    assert(result.ringless.length === 0, `${theme}: focused controls that draw nothing: ${result.ringless.join(' | ')}`)
  }
  await setTheme('light')
  await h.shot('05-focus-ring-audit')

  await setTheme('light') // leave the shared profile as the next scenario expects it
})
