// Theme-contrast check on the token VALUES in app.css, for both themes: every key foreground /
// background pair clears WCAG AA (4.5:1 text, 3:1 for the focus ring as a non-text indicator).
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { blend, contrastRatio, parseColor, type RGBA } from '../lib/contrast'

const css = readFileSync(resolve(__dirname, '../app.css'), 'utf8')

function block(selector: string): Record<string, string> {
  const start = css.indexOf(`${selector} {`)
  if (start < 0) throw new Error(`no ${selector} block`)
  const body = css.slice(start, css.indexOf('\n}', start))
  const vars: Record<string, string> = {}
  for (const m of body.matchAll(/(--t-[a-z0-9-]+):\s*([^;]+);/g)) vars[m[1]!] = m[2]!.trim()
  return vars
}

const light = block(':root')
const dark = { ...light, ...block("[data-theme='dark']") }

function color(vars: Record<string, string>, name: string, depth = 0): RGBA {
  const raw = vars[name]
  if (!raw) throw new Error(`token ${name} missing`)
  const ref = /^var\((--t-[a-z0-9-]+)\)$/.exec(raw)
  if (ref && depth < 5) return color(vars, ref[1]!, depth + 1)
  const c = parseColor(raw)
  if (!c) throw new Error(`token ${name} is not a colour: ${raw}`)
  return c
}

const TEXT = ['--t-ink', '--t-muted', '--t-dr', '--t-cr', '--t-blue', '--t-amber']
const SURFACES = ['--t-bg', '--t-panel', '--t-panel2', '--t-raised']
const STATUS: [string, string][] = [
  ['--t-success', '--t-success-soft'],
  ['--t-warning', '--t-warning-soft'],
  ['--t-danger', '--t-danger-soft'],
  ['--t-info', '--t-info-soft']
]

describe.each([
  ['light', light],
  ['dark', dark]
] as const)('%s theme tokens', (_name, vars) => {
  it.each(TEXT.flatMap((fg) => SURFACES.map((bg) => [fg, bg] as const)))('%s on %s ≥ 4.5', (fg, bg) => {
    expect(contrastRatio(color(vars, fg), color(vars, bg))).toBeGreaterThanOrEqual(4.5)
  })

  it.each(TEXT.flatMap((fg) => ['--t-panel', '--t-panel2', '--t-raised'].map((bg) => [fg, bg] as const)))(
    '%s on the amber selection row (amber-soft over %s) ≥ 4.5',
    (fg, bg) => {
      const row = blend(color(vars, '--t-amber-soft'), color(vars, bg))
      expect(contrastRatio(color(vars, fg), row)).toBeGreaterThanOrEqual(4.5)
    }
  )


  it.each(STATUS)('%s on %s ≥ 4.5, and ink on the soft tint ≥ 4.5', (fg, bg) => {
    expect(contrastRatio(color(vars, fg), color(vars, bg))).toBeGreaterThanOrEqual(4.5)
    expect(contrastRatio(color(vars, '--t-ink'), color(vars, bg))).toBeGreaterThanOrEqual(4.5)
  })

  it('primary button text on the amber bar ≥ 4.5', () => {
    expect(contrastRatio(color(vars, '--t-on-amber'), color(vars, '--t-amber-bar'))).toBeGreaterThanOrEqual(4.5)
  })

  it.each(['--t-bg', '--t-panel', '--t-panel2'])('focus ring on %s ≥ 3 (non-text contrast)', (bg) => {
    expect(contrastRatio(color(vars, '--t-focus'), color(vars, bg))).toBeGreaterThanOrEqual(3)
  })
})

// WP 10.5: the simple shell's token tweaks (html[data-shell='simple']) — UI chrome ≥ 3:1.
const simpleLight = { ...light, ...block("[data-shell='simple']") }
const simpleDark = { ...dark, ...block("[data-shell='simple']"), ...block("[data-shell='simple'][data-theme='dark']") }

describe.each([
  ['light', simpleLight],
  ['dark', simpleDark]
] as const)('simple shell, %s theme', (_name, vars) => {
  it.each(SURFACES)('the selection bar on %s ≥ 3, and on the amber row tint over it ≥ 3', (bg) => {
    expect(contrastRatio(color(vars, '--t-select-bar'), color(vars, bg))).toBeGreaterThanOrEqual(3)
    const row = blend(color(vars, '--t-amber-soft'), color(vars, bg))
    expect(contrastRatio(color(vars, '--t-select-bar'), row)).toBeGreaterThanOrEqual(3)
  })
  it.each(SURFACES)('a disabled label on %s ≥ 3', (bg) => {
    expect(contrastRatio(color(vars, '--t-disabled'), color(vars, bg))).toBeGreaterThanOrEqual(3)
  })
  it.each(['--t-panel', '--t-panel2'])('a chosen chip (amber tint over %s): its ink label ≥ 4.5 — also when it can’t be changed', (bg) => {
    // PaidHow / RefundHow / the radio chips: border-amber bg-amberbar/15 when chosen. A disabled
    // one used --t-disabled (2.9–3.2:1 on this tint in dark mode); app.css keeps it ink.
    const tint = blend([...color(vars, '--t-amber-bar').slice(0, 3), 0.15] as RGBA, color(vars, bg))
    expect(contrastRatio(color(vars, '--t-ink'), tint)).toBeGreaterThanOrEqual(4.5)
  })
  it('placeholder text is the muted token (≥ 4.5 on every surface — checked above)', () => {
    expect(readFileSync(resolve(__dirname, '../components/kit/Field.tsx'), 'utf8')).toContain('placeholder:text-muted')
  })
})

describe('the full app keeps its colours (WP 10.5 tweaks are simple-only)', () => {
  it('the selection bar is still the signature amber outside the simple shell', () => {
    expect(light['--t-select-bar']).toBe('var(--t-amber-bar)')
    expect(dark['--t-select-bar']).toBe('var(--t-amber-bar)')
    expect(light['--t-disabled']).toBeUndefined()
  })
  it('reduced motion collapses every animation and transition (tour, spotlight, drawers)', () => {
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)[\s\S]*?animation-duration: 0\.01ms !important[\s\S]*?transition-duration: 0\.01ms !important/)
    expect(css).toMatch(/\[data-motion='reduce'\] \*/)
  })
})

describe('to-do §4: the chosen chip that can’t be changed (walk-in "Cash", dark mode)', () => {
  it('keeps the ink label in the simple shell (grey on the amber tint was 3.2:1 in dark mode)', () => {
    expect(css).toMatch(/\[data-shell='simple'\] button\[role='radio'\]\[aria-checked='true'\]:disabled \{\s*color: var\(--t-ink\);\s*\}/)
  })
})

describe('contrast helpers', () => {
  it('parses hex and rgba and computes the WCAG ratio', () => {
    expect(contrastRatio(parseColor('#000')!, parseColor('#ffffff')!)).toBeCloseTo(21, 5)
    expect(parseColor('rgba(245, 184, 46, 0.18)')).toEqual([245, 184, 46, 0.18])
    expect(blend([0, 0, 0, 0.5], [255, 255, 255, 1])[0]).toBeCloseTo(127.5)
  })
})

describe('gate polish: toast placement (simple shell only)', () => {
  it('on Lock and safety / Backups the toast stack moves to the top right, clear of the backup-check card', () => {
    const rule = /\[data-shell='simple'\]:has\(\[data-testid='simple-security'\], \[data-testid='simple-backups'\]\) \[data-toasts\] \{\s*top: 3\.75rem;\s*bottom: auto;\s*\}/
    expect(css).toMatch(rule)
    // Only ever scoped to the simple shell: no bare [data-toasts] rule moves the full app's stack.
    expect(css).not.toMatch(/^\[data-toasts\]/m)
  })
})
