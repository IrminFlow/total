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
import { scenario, assert } from '../lib/harness.mjs'

/** WCAG relative-luminance contrast between two 'rgb(r, g, b)' strings. */
function contrast(a, b) {
  const lum = (css) => {
    const [r, g, b2] = css.match(/[\d.]+/g).map(Number)
    const f = (c) => {
      const s = c / 255
      return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4)
    }
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b2)
  }
  const [l1, l2] = [lum(a), lum(b)].sort((x, y) => y - x)
  return (l1 + 0.05) / (l2 + 0.05)
}

/**
 * The in-page sweep (runs in the renderer). Colour parsing covers what Chromium's computed style
 * returns for our CSS: rgb()/rgba() (comma or space syntax), color(srgb …) and oklab(…) — the
 * last is how Tailwind v4's opacity modifiers (bg-amberbar/15, color-mix in oklab) come back.
 */
function sweepInPage() {
  const parse = (css) => {
    if (!css || css === 'transparent') return [0, 0, 0, 0]
    let m = /^rgba?\(([^)]+)\)$/.exec(css)
    if (m) {
      const p = m[1].split(/[\s,/]+/).filter(Boolean).map(Number)
      return [p[0], p[1], p[2], p[3] ?? 1]
    }
    m = /^color\(srgb ([^)]+)\)$/.exec(css)
    if (m) {
      const p = m[1].split(/[\s/]+/).filter(Boolean).map(Number)
      return [p[0] * 255, p[1] * 255, p[2] * 255, p[3] ?? 1]
    }
    m = /^oklab\(([^)]+)\)$/.exec(css)
    if (m) {
      const p = m[1].split(/[\s/]+/).filter(Boolean).map((x) => (x.endsWith('%') ? parseFloat(x) / 100 : Number(x)))
      const [L, A, B] = p
      const l = (L + 0.3963377774 * A + 0.2158037573 * B) ** 3
      const mm = (L - 0.1055613458 * A - 0.0638541728 * B) ** 3
      const s = (L - 0.0894841775 * A - 1.291485548 * B) ** 3
      const lin = [4.0767416621 * l - 3.3077115913 * mm + 0.2309699292 * s, -1.2684380046 * l + 2.6097574011 * mm - 0.3413193965 * s, -0.0041960863 * l - 0.7034186147 * mm + 1.707614701 * s]
      const enc = (c) => {
        const v = Math.max(0, Math.min(1, c))
        return 255 * (v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(v, 1 / 2.4) - 0.055)
      }
      return [enc(lin[0]), enc(lin[1]), enc(lin[2]), p[3] ?? 1]
    }
    return null
  }
  const blend = (top, bottom) => {
    const a = top[3]
    return [top[0] * a + bottom[0] * (1 - a), top[1] * a + bottom[1] * (1 - a), top[2] * a + bottom[2] * (1 - a), 1]
  }
  const lum = ([r, g, b]) => {
    const f = (c) => {
      const s = c / 255
      return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4)
    }
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b)
  }
  const ratio = (a, b) => {
    const [l1, l2] = [lum(a), lum(b)].sort((x, y) => y - x)
    return (l1 + 0.05) / (l2 + 0.05)
  }
  const bodyBg = parse(getComputedStyle(document.body).backgroundColor)
  /** Composited background behind `el`: stack ancestors' backgrounds bottom-up over the body. */
  const backgroundOf = (el) => {
    const layers = []
    for (let n = el; n && n !== document.documentElement; n = n.parentElement) {
      const c = parse(getComputedStyle(n).backgroundColor)
      if (c && c[3] > 0) {
        layers.push(c)
        if (c[3] >= 1) break
      }
    }
    let bg = bodyBg[3] > 0 ? bodyBg : [255, 255, 255, 1]
    for (let i = layers.length - 1; i >= 0; i--) bg = blend(layers[i], bg)
    return bg
  }
  const opacityOf = (el) => {
    let o = 1
    for (let n = el; n && n !== document.documentElement; n = n.parentElement) o *= Number(getComputedStyle(n).opacity)
    return o
  }
  const visible = (el) => {
    const r = el.getBoundingClientRect()
    if (r.width === 0 || r.height === 0) return false
    const cs = getComputedStyle(el)
    return cs.visibility !== 'hidden' && cs.display !== 'none'
  }
  const exempt = (el) =>
    !!el.closest('[aria-hidden="true"], [hidden], .sr-only, option, [data-drawer-root] [inert]') ||
    !!el.closest('button:disabled, input:disabled, select:disabled, textarea:disabled, fieldset:disabled, [aria-disabled="true"]')
  const describe = (el) => {
    const id = el.getAttribute('data-testid') || el.closest('[data-testid]')?.getAttribute('data-testid') || ''
    const text = (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 40)
    return `${el.tagName.toLowerCase()}${id ? `[${id}]` : ''} "${text}"`
  }

  const lowContrast = []
  for (const el of document.querySelectorAll('body *')) {
    const hasText = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim() !== '')
    if (!hasText || exempt(el) || !visible(el)) continue
    const cs = getComputedStyle(el)
    const fg = parse(cs.color)
    if (!fg) continue
    const bg = backgroundOf(el)
    const op = opacityOf(el)
    const fgEff = blend([fg[0], fg[1], fg[2], fg[3] * op], bg)
    const size = parseFloat(cs.fontSize)
    const large = size >= 24 || (size >= 18.66 && Number(cs.fontWeight) >= 700)
    const r = ratio(fgEff, bg)
    if (r < (large ? 3 : 4.5)) lowContrast.push(`${describe(el)} ${r.toFixed(2)}`)
  }

  const unlabeled = []
  const nameOf = (el) => {
    if (el.getAttribute('aria-label')?.trim()) return true
    const by = el.getAttribute('aria-labelledby')
    if (by && by.split(/\s+/).some((id) => document.getElementById(id)?.textContent.trim())) return true
    if (el.id && document.querySelector(`label[for="${CSS.escape(el.id)}"]`)) return true
    if (el.closest('label')) return true
    if (el.getAttribute('title')?.trim()) return true
    return false
  }
  for (const el of document.querySelectorAll('input:not([type="hidden"]), select, textarea')) {
    if (!visible(el) || exempt(el)) continue
    if (!nameOf(el)) unlabeled.push(describe(el))
  }
  for (const el of document.querySelectorAll('button, [role="button"], a[href]')) {
    if (!visible(el)) continue
    const text = (el.textContent || '').trim()
    if (!text && !nameOf(el)) unlabeled.push(describe(el))
  }
  const orphanTabs = [...document.querySelectorAll('[role="tab"]')].filter((t) => !t.closest('[role="tablist"]')).map(describe)
  return { lowContrast, unlabeled, orphanTabs }
}

/** Snapshot every focusable's resting styles, keyed by a temporary data attribute. */
function snapshotFocusablesInPage() {
  const sel = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
  const out = {}
  document.querySelectorAll(sel).forEach((el, i) => {
    el.setAttribute('data-a11y-i', String(i))
    const cs = getComputedStyle(el)
    out[i] = { outline: `${cs.outlineStyle} ${cs.outlineWidth}`, shadow: cs.boxShadow, bg: cs.backgroundColor, deco: cs.textDecorationLine, border: cs.borderColor }
  })
  return out
}

function focusedIndicatorInPage(rest) {
  const el = document.activeElement
  if (!el || el === document.body) return { ok: true, what: 'body' }
  const i = el.getAttribute('data-a11y-i')
  const cs = getComputedStyle(el)
  const what = `${el.tagName.toLowerCase()}[${el.getAttribute('data-testid') ?? ''}] "${(el.textContent || el.getAttribute('aria-label') || '').trim().slice(0, 30)}"`
  const outline = cs.outlineStyle !== 'none' && parseFloat(cs.outlineWidth) >= 1
  const before = i != null ? rest[i] : null
  const changed =
    !!before &&
    (cs.boxShadow !== before.shadow || cs.backgroundColor !== before.bg || cs.textDecorationLine !== before.deco || cs.borderColor !== before.border)
  return { ok: outline || changed, what }
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

  await setTheme('light') // leave the shared profile in the default theme for later scenarios
})
