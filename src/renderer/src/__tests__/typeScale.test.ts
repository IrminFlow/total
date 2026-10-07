// Lint-like guard: the renderer uses the type-scale tokens (text-label … text-heading, defined in
// app.css `@theme inline`) — never a raw bracket font size like `text-[13px]` or an inline
// `fontSize`. Reintroducing one anywhere under src/renderer/src (outside app.css) fails here.
import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'

const ROOT = resolve(__dirname, '..')

/**
 * Files still allowed a raw size. Each entry must still contain one (stale entries fail), so the
 * list can only shrink. What's left is WP 1.10b's Gateway dashboard and its chart, built in
 * parallel with the type scale and owned by that work package (WP 1.10a was asked not to edit
 * them) — they convert with the mechanical mapping:
 * 9/10→micro 10.5→label 11→caption 11.5→hint 12→small 12.5→body-sm 13→detail 13.5→body
 * 14/14.5→lead 15→subtitle 16→title 17→brand 19/20→heading 28→display 34→hero.
 * (SlotChart's SVG <text fontSize> may stay numeric; give it a reason here if it does.)
 */
const ALLOWLIST: string[] = [
  'screens/Gateway.tsx',
  'screens/gateway/cards.tsx',
  'screens/gateway/parts.tsx',
  'components/charts/SlotChart.tsx'
]


const RAW_SIZE = /\btext-\[(?:length:)?\d+(?:\.\d+)?(?:px|rem|em|pt)\]|\bfontSize\s*:/g

function walk(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) out.push(...walk(p))
    else if (/\.(tsx?|jsx?)$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(p)
  }
  return out
}

describe('type scale guard', () => {
  const files = walk(ROOT)
  const offenders = new Map<string, string[]>()
  for (const f of files) {
    const hits = readFileSync(f, 'utf8').match(RAW_SIZE)
    if (hits) offenders.set(relative(ROOT, f).split('\\').join('/'), hits)
  }

  it('no raw font sizes outside app.css (use text-micro … text-hero)', () => {
    const bad = [...offenders.entries()].filter(([f]) => !ALLOWLIST.includes(f)).map(([f, h]) => `${f}: ${[...new Set(h)].join(', ')}`)
    expect(bad).toEqual([])
  })

  it('every allowlisted file still needs its entry (the allowlist only shrinks)', () => {
    expect(ALLOWLIST.filter((f) => !offenders.has(f))).toEqual([])
  })

  it('every scale token used in the renderer is defined in app.css', () => {
    const css = readFileSync(join(ROOT, 'app.css'), 'utf8')
    const defined = new Set([...css.matchAll(/--text-([a-z-]+):/g)].map((m) => m[1]))
    expect(defined.size).toBeGreaterThanOrEqual(10)
    for (const t of ['micro', 'label', 'caption', 'hint', 'small', 'body-sm', 'detail', 'body', 'lead', 'subtitle', 'title', 'heading']) {
      expect(defined.has(t), `--text-${t}`).toBe(true)
    }
  })
})
