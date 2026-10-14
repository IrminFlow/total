// WP 10.8 — journey metrics for the "no ledger knowledge" journey (e2e 60) and the beginner study.
//
// Unaided completion can't be measured in CI, so this counts what a beginner would feel instead:
//   screens   distinct screens visited ([data-screen] changes, in order)
//   clicks    pointer clicks the run made (trusted `click` events in the renderer)
//   errors    error messages SHOWN (a field error under its question, an error / warning toast)
//   corrections  Undo / Edit / Remove presses after a save (btn-save-card-undo / -edit, *-remove)
// per step (`step(name)` starts the next one) and in total. `report()` prints a table and compares
// the clicks with a baseline: a step that needs more clicks than its baseline (+ slack) is a
// WARNING, never a failure — a run's flow may legitimately grow.
//
// The counters live in the renderer's sessionStorage, so a page reload keeps them; the init script
// re-installs the listeners on every load. Not a scenario: the runner only picks `NN-*.mjs`.

const KEY = '__totalJourney'

/** Installed in the renderer (and re-installed on each load). Plain JS, no closures over Node. */
function install(key) {
  if (window.__journeyInstalled) return
  window.__journeyInstalled = true
  const read = () => {
    try {
      return JSON.parse(sessionStorage.getItem(key) ?? 'null') ?? { step: 'start', steps: {}, order: [] }
    } catch {
      return { step: 'start', steps: {}, order: [] }
    }
  }
  const write = (s) => sessionStorage.setItem(key, JSON.stringify(s))
  const bump = (field, detail) => {
    const s = read()
    const cur = (s.steps[s.step] ??= { clicks: 0, errors: 0, corrections: 0, screens: [], errorTexts: [] })
    if (field === 'screen') {
      if (cur.screens[cur.screens.length - 1] !== detail) cur.screens.push(detail)
    } else {
      cur[field] += 1
      if (field === 'errors' && detail && cur.errorTexts.length < 8) cur.errorTexts.push(detail.slice(0, 120))
    }
    write(s)
  }
  window.__journeyBump = bump
  document.addEventListener(
    'click',
    (e) => {
      if (!e.isTrusted) return
      bump('clicks')
      const el = e.target instanceof Element ? e.target.closest('[data-testid]') : null
      const id = el?.getAttribute('data-testid') ?? ''
      if (id === 'btn-save-card-undo' || id === 'btn-save-card-edit' || /-remove$/.test(id)) bump('corrections')
    },
    true
  )
  const seen = new WeakSet()
  const scan = (root) => {
    if (!(root instanceof Element)) return
    const nodes = [root, ...root.querySelectorAll('[data-field-error], [data-toasts] > button')]
    for (const n of nodes) {
      if (seen.has(n)) continue
      const isField = n.hasAttribute('data-field-error')
      const isToast = n.parentElement?.hasAttribute('data-toasts') && /text-(danger|warning)/.test(n.className)
      if (!isField && !isToast) continue
      seen.add(n)
      bump('errors', (n.textContent ?? '').trim())
    }
  }
  let lastScreen = ''
  const screenNow = () => {
    const el = document.querySelector('main [data-screen], [data-screen]')
    const name = el?.getAttribute('data-screen') ?? ''
    if (name && name !== lastScreen) {
      lastScreen = name
      bump('screen', name)
    }
  }
  const start = () => {
    new MutationObserver((records) => {
      for (const r of records) for (const n of r.addedNodes) scan(n)
      screenNow()
    }).observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-screen'] })
    screenNow()
  }
  if (document.documentElement) start()
  else document.addEventListener('DOMContentLoaded', start)
}

export class JourneyMetrics {
  /** @param {import('playwright-core').Page} page */
  constructor(page) {
    this.page = page
  }

  async attach() {
    await this.page.addInitScript(install, KEY)
    await this.page.evaluate(install, KEY)
    await this.page.evaluate((key) => sessionStorage.removeItem(key), KEY)
    return this
  }

  /** Start counting a new step (the previous one keeps its figures). */
  async step(name) {
    await this.page.evaluate(
      ([key, n]) => {
        const s = JSON.parse(sessionStorage.getItem(key) ?? 'null') ?? { step: 'start', steps: {}, order: [] }
        s.step = n
        if (!s.order.includes(n)) s.order.push(n)
        s.steps[n] ??= { clicks: 0, errors: 0, corrections: 0, screens: [], errorTexts: [] }
        sessionStorage.setItem(key, JSON.stringify(s))
      },
      [KEY, name]
    )
  }

  async read() {
    return this.page.evaluate((key) => JSON.parse(sessionStorage.getItem(key) ?? 'null') ?? { steps: {}, order: [] }, KEY)
  }

  /**
   * Print the per-step table and the totals; compare clicks with `baseline` ({ step: clicks }).
   * Returns { totals, steps, warnings } — warnings are printed, never thrown.
   */
  async report(baseline = {}, { slack = 2, log = console.log } = {}) {
    const s = await this.read()
    const rows = s.order.map((name) => ({ name, ...(s.steps[name] ?? { clicks: 0, errors: 0, corrections: 0, screens: [] }) }))
    const totals = rows.reduce(
      (t, r) => ({ clicks: t.clicks + r.clicks, errors: t.errors + r.errors, corrections: t.corrections + r.corrections, screens: t.screens + r.screens.length }),
      { clicks: 0, errors: 0, corrections: 0, screens: 0 }
    )
    const distinct = new Set(rows.flatMap((r) => r.screens)).size
    const warnings = []
    for (const r of rows) {
      const base = baseline[r.name]
      if (base != null && r.clicks > base + slack) warnings.push(`${r.name}: ${r.clicks} clicks (baseline ${base})`)
    }
    const pad = (v, n) => String(v).padEnd(n)
    log('journey metrics (WP 10.8):')
    log(`  ${pad('step', 16)}${pad('clicks', 8)}${pad('errors', 8)}${pad('fixes', 7)}screens`)
    for (const r of rows) log(`  ${pad(r.name, 16)}${pad(r.clicks, 8)}${pad(r.errors, 8)}${pad(r.corrections, 7)}${r.screens.join(' → ')}`)
    log(`  ${pad('total', 16)}${pad(totals.clicks, 8)}${pad(totals.errors, 8)}${pad(totals.corrections, 7)}${totals.screens} visits, ${distinct} distinct screens`)
    for (const w of warnings) log(`  WARNING clicks-to-complete grew — ${w}`)
    return { totals: { ...totals, distinctScreens: distinct }, steps: rows, warnings }
  }
}
