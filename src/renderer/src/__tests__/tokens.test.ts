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

describe('contrast helpers', () => {
  it('parses hex and rgba and computes the WCAG ratio', () => {
    expect(contrastRatio(parseColor('#000')!, parseColor('#ffffff')!)).toBeCloseTo(21, 5)
    expect(parseColor('rgba(245, 184, 46, 0.18)')).toEqual([245, 184, 46, 0.18])
    expect(blend([0, 0, 0, 0.5], [255, 255, 255, 1])[0]).toBeCloseTo(127.5)
  })
})
