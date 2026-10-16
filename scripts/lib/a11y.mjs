// Shared a11y / layout checks for the E2E scenarios (12-theme-a11y, 63-keyboard-simple). Plain
// DOM + computed styles, no axe dependency. The `*InPage` functions run inside the renderer
// (page.evaluate), so they must stay self-contained.
//
//   sweepInPage           contrast (text ≥ 4.5, large ≥ 3; disabled / aria-hidden exempt), names
//                         (inputs, buttons, links), role="tab" inside a tablist, and — WP 10.5 —
//                         inputs whose aria-describedby points at nothing.
//   plantToastInPage      put a toast-sized stand-in into the real toast stack (layoutInPage then
//                         checks it keeps clear of the Save bar / a docked panel's input)
//   layoutInPage          WP 10.5 window-size checks: the document never scrolls (only the screen
//                         and the panels do), no button / link is cut off by the window or has
//                         its own text clipped, and the landmarks are there (one banner, a
//                         navigation, one main; every docked panel a named complementary).
//   waitForSettled        no finite CSS animation / transition still running — a sweep taken
//                         mid-fade reads the faded colour (the report builder's refetch dim was
//                         the 4.41 "flake" of e2e 12).

/** WCAG relative-luminance contrast between two 'rgb(r, g, b)' strings. */
export function contrast(a, b) {
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
export function sweepInPage() {
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
  // aria-describedby must point at something that is there (an error / hint the field names).
  const brokenDescribedBy = []
  for (const el of document.querySelectorAll('[aria-describedby]')) {
    if (!visible(el)) continue
    const ids = el.getAttribute('aria-describedby').split(/\s+/).filter(Boolean)
    if (ids.some((id) => !document.getElementById(id))) brokenDescribedBy.push(describe(el))
  }
  return { lowContrast, unlabeled, orphanTabs, brokenDescribedBy }
}

/** A stand-in toast in the real `[data-toasts]` stack (same box as Toasts in ui.tsx renders), so
 *  the stack's placement can be checked without a screen raising one. `remove` takes it out. */
export function plantToastInPage(remove = false) {
  const stack = document.querySelector('[data-toasts]')
  if (!stack) return false
  stack.querySelector('[data-planted-toast]')?.remove()
  if (remove) return true
  const b = document.createElement('button')
  b.setAttribute('data-planted-toast', '')
  b.className = 'pointer-events-auto rounded-lg border bg-raised px-4 py-2.5 text-left text-detail shadow-elev-2 border-info/50 text-info'
  b.textContent = 'Saved a planted toast with a long enough sentence to wrap onto two lines'
  stack.appendChild(b)
  return true
}

/** WP 10.5: window-size + landmark checks (runs in the renderer). */
export function layoutInPage() {
  const problems = []
  const doc = document.scrollingElement || document.documentElement
  if (doc.scrollTop > 0 || doc.scrollLeft > 0) problems.push(`the window itself is scrolled (${doc.scrollLeft}, ${doc.scrollTop})`)
  if (doc.scrollWidth > innerWidth + 1) problems.push(`the window scrolls sideways (${doc.scrollWidth} > ${innerWidth})`)
  if (doc.scrollHeight > innerHeight + 1) problems.push(`the window scrolls (${doc.scrollHeight} > ${innerHeight})`)
  const visible = (el) => {
    const r = el.getBoundingClientRect()
    if (r.width === 0 || r.height === 0) return false
    const cs = getComputedStyle(el)
    return cs.visibility !== 'hidden' && cs.display !== 'none' && !el.closest('[aria-hidden="true"], .sr-only')
  }
  const describe = (el) => {
    const id = el.getAttribute('data-testid') || el.closest('[data-testid]')?.getAttribute('data-testid') || ''
    const text = (el.textContent || el.getAttribute('aria-label') || '').trim().replace(/\s+/g, ' ').slice(0, 30)
    return `${el.tagName.toLowerCase()}${id ? `[${id}]` : ''} "${text}"`
  }
  for (const el of document.querySelectorAll('header button, nav button, nav a, #main button, aside button, [role="dialog"] button')) {
    if (!visible(el)) continue
    const r = el.getBoundingClientRect()
    // Off the window horizontally (a header chip pushed out, a save button cut by the panel) —
    // unless it sits in a box that scrolls sideways (a wide table: reachable by scrolling).
    const inScroller = (() => {
      for (let n = el.parentElement; n && n !== document.body; n = n.parentElement) {
        const ox = getComputedStyle(n).overflowX
        if ((ox === 'auto' || ox === 'scroll') && n.scrollWidth > n.clientWidth + 1) return true
      }
      return false
    })()
    if (!inScroller && (r.right > innerWidth + 1 || r.left < -1)) problems.push(`off the window: ${describe(el)} (${Math.round(r.left)}–${Math.round(r.right)})`)
    // Its own label cut off (a button narrower than its text, overflow hidden). Truncating
    // labels that carry their full text in title / aria-label are fine.
    const cs = getComputedStyle(el)
    if (el.scrollWidth > el.clientWidth + 2 && cs.overflowX !== 'visible' && !el.title && !el.getAttribute('aria-label')) problems.push(`label clipped: ${describe(el)}`)
  }
  // Inside a scroll box the button may be scrolled away — that is fine; but a button cut by a
  // box that does NOT scroll is lost for good.
  for (const el of document.querySelectorAll('#main button')) {
    if (!visible(el)) continue
    const r = el.getBoundingClientRect()
    for (let n = el.parentElement; n && n.id !== 'main'; n = n.parentElement) {
      const cs = getComputedStyle(n)
      if (cs.overflowX === 'hidden' || cs.overflowX === 'clip') {
        const pr = n.getBoundingClientRect()
        if (r.right > pr.right + 1 && n.scrollWidth <= n.clientWidth + 1) problems.push(`cut off by its box: ${describe(el)}`)
        break
      }
    }
  }
  const count = (sel) => [...document.querySelectorAll(sel)].filter(visible).length
  // A <header> inside main / aside / nav / article / section is not a banner (ARIA in HTML).
  const banners = [...document.querySelectorAll('header, [role="banner"]')].filter(
    (el) => visible(el) && (el.getAttribute('role') === 'banner' || !el.parentElement.closest('main, aside, nav, article, section, [role="dialog"]'))
  ).length
  if (banners !== 1) problems.push(`banner landmarks: ${banners}`)
  if (count('nav, [role="navigation"]') < 1) problems.push('no navigation landmark')
  if (count('main, [role="main"]') !== 1) problems.push(`main landmarks: ${count('main, [role="main"]')}`)
  for (const el of document.querySelectorAll('aside[data-docked]')) {
    if (!el.getAttribute('aria-labelledby') && !el.getAttribute('aria-label')) problems.push(`docked panel without a name: ${describe(el)}`)
  }
  // A toast never sits on the Save bar nor on a docked / overlaid panel's input (to-do §4: at
  // 1700 px a toast covered Ask Total's question box; a two-row Save bar had Save under a toast).
  const hits = (a, b) => a.left < b.right - 1 && b.left < a.right - 1 && a.top < b.bottom - 1 && b.top < a.bottom - 1
  const keepClear = [
    ...[...document.querySelectorAll('[data-testid="save-bar"]')].map((el) => ['the Save bar', el]),
    ...[...document.querySelectorAll('aside[data-docked] textarea, aside[data-docked] input')].map((el) => ['a docked panel\'s input', el])
  ].filter(([, el]) => visible(el))
  for (const toast of document.querySelectorAll('[data-toasts] > *')) {
    if (!visible(toast)) continue
    const tr = toast.getBoundingClientRect()
    for (const [what, el] of keepClear) if (hits(tr, el.getBoundingClientRect())) problems.push(`a toast covers ${what}: ${describe(toast)}`)
  }
  for (const d of document.querySelectorAll('[role="dialog"]')) {
    if (!visible(d)) continue
    const r = d.getBoundingClientRect()
    if (r.bottom > innerHeight + 1 || r.top < -1) problems.push(`dialog taller than the window: ${describe(d)} (${Math.round(r.top)}–${Math.round(r.bottom)})`)
    if (!d.getAttribute('aria-labelledby') && !d.getAttribute('aria-label')) problems.push(`dialog without a name: ${describe(d)}`)
  }
  return problems
}

/** Snapshot every focusable's resting styles, keyed by a temporary data attribute. */
export function snapshotFocusablesInPage() {
  const sel = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
  const out = {}
  document.querySelectorAll(sel).forEach((el, i) => {
    el.setAttribute('data-a11y-i', String(i))
    const cs = getComputedStyle(el)
    out[i] = { outline: `${cs.outlineStyle} ${cs.outlineWidth}`, shadow: cs.boxShadow, bg: cs.backgroundColor, deco: cs.textDecorationLine, border: cs.borderColor }
  })
  return out
}

export function focusedIndicatorInPage(rest) {
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

/** Wait (best effort) until nothing on the page is still loading — no `[data-loading="true"]`
 *  screen and no `[data-state="loading"]` region (WP 7.4: the report builder's result keeps its
 *  refetch dim, opacity-70, for as long as the query runs — a steady state, not a transition, so
 *  waiting for animations alone swept it dimmed on a slow runner: 16 findings at 3.6–4.4 on
 *  report-builder) — then (≤ 3 s) until no finite animation / transition is still running. */
export async function waitForSettled(page, timeout = 3000) {
  try {
    await page.waitForFunction(
      () => !document.querySelector('[data-loading="true"], [data-state="loading"]'),
      null,
      { timeout: 20000, polling: 50 }
    )
  } catch {
    /* still loading after 20 s — sweep what is there (a finding will say so) */
  }
  try {
    await page.waitForFunction(
      () =>
        document.getAnimations().every((a) => a.playState !== 'running' || a.effect?.getComputedTiming?.().iterations === Infinity),
      null,
      { timeout, polling: 50 }
    )
  } catch {
    /* an animation that never ends (a spinner) — sweep anyway */
  }
}

/** Run the content sweep and collect findings under `label`. */
export async function sweepInto(page, label, failures) {
  await waitForSettled(page)
  const r = await page.evaluate(sweepInPage)
  for (const c of r.lowContrast) failures.push(`${label} contrast: ${c}`)
  for (const u of r.unlabeled) failures.push(`${label} unlabeled: ${u}`)
  for (const t of r.orphanTabs) failures.push(`${label} tab outside a tablist: ${t}`)
  for (const d of r.brokenDescribedBy) failures.push(`${label} aria-describedby points at nothing: ${d}`)
}

/**
 * WP 10.5: sweep every SIMPLE screen reachable from the simple sidebar (each section page and
 * every entry on it that opens a simple screen — "Full app" entries are the accountant sweep's),
 * plus the Help and Ask Total panels, at the current window size and theme. `focus` also tabs
 * through each screen's first stops. Returns the number of screens swept.
 */
export async function sweepSimpleShell(h, label, failures, { focus = false } = {}) {
  const page = h.page
  const sections = await page.evaluate(() =>
    [...document.querySelectorAll('[data-testid^="simple-nav-"]')].map((b) => b.getAttribute('data-testid').slice('simple-nav-'.length))
  )
  let swept = 0
  const check = async (where) => {
    await h.waitIdle()
    await waitForSettled(page)
    const tag = `${label}/${where}`
    await sweepInto(page, tag, failures)
    for (const p of await page.evaluate(layoutInPage)) failures.push(`${tag} layout: ${p}`)
    if (focus) await focusInto(page, tag, failures)
    swept++
  }
  for (const s of sections) {
    await h.click(`simple-nav-${s}`)
    await check(s)
    if (s === 'home') continue
    // Entries that open a SIMPLE screen (no "Full app" chip — it carries a title).
    const entries = await page.evaluate(() =>
      [...document.querySelectorAll('#main [data-testid^="simple-entry-"]')]
        .filter((b) => !b.querySelector('span[title]'))
        .map((b) => b.getAttribute('data-testid'))
    )
    for (const e of entries) {
      await h.click(`simple-nav-${s}`)
      await h.click(e)
      if (!(await page.$('[data-testid="simple-nav"]'))) continue // opened in the full app after all
      await check(`${s}/${e.slice('simple-entry-'.length)}`)
    }
  }
  // The panels beside (or over) the screen.
  await h.click('simple-nav-home')
  await h.waitIdle()
  await h.click('btn-help')
  await page.waitForSelector('[data-testid="help-panel"]', { timeout: 5000 })
  await check('help-panel')
  await h.click('btn-help')
  await page.waitForSelector('[data-testid="help-panel"]', { state: 'detached', timeout: 5000 })
  await h.click('btn-assistant')
  await page.waitForSelector('[data-testid="ask-panel"]', { timeout: 5000 })
  await check('ask-panel')
  await h.click('btn-assistant')
  await page.waitForSelector('[data-testid="ask-panel"]', { state: 'detached', timeout: 5000 })
  return swept
}

/** Tab through the first `stops` focus stops from <main>; each must show a visible indicator. */
export async function focusInto(page, label, failures, stops = 12) {
  const rest = await page.evaluate(snapshotFocusablesInPage)
  await page.evaluate(() => document.getElementById('main')?.focus())
  for (let i = 0; i < stops; i++) {
    await page.keyboard.press('Tab')
    const f = await page.evaluate(focusedIndicatorInPage, rest)
    if (!f.ok) failures.push(`${label} focus not visible: ${f.what}`)
  }
}
