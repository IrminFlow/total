import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'fs'
import { join } from 'path'

/**
 * The design system, enforced.
 *
 * app.css has defined a ten-step type scale since v0.3, with a comment saying screens would
 * "converge opportunistically". They never did: before this test there were 431 raw
 * `text-[Npx]` values against 13 uses of the scale, and five different corner radii chosen ad
 * hoc. A design system nothing checks is a document, not a system.
 *
 * These are deliberately mechanical. They fail when someone ADDS a one-off, which is the moment
 * the drift starts rather than the moment it becomes visible.
 */

const SRC = join(__dirname, '..')

function tsxFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) return name === '__tests__' ? [] : tsxFiles(full)
    return name.endsWith('.tsx') ? [full] : []
  })
}

const FILES = tsxFiles(SRC)
const rel = (f: string): string => f.slice(SRC.length + 1)

describe('type scale', () => {
  it('has files to check', () => {
    expect(FILES.length).toBeGreaterThan(20)
  })

  it('is used everywhere — no raw pixel font sizes', () => {
    const offenders = FILES.flatMap((file) => {
      const matches = readFileSync(file, 'utf8').match(/text-\[\d+(?:\.\d+)?px\]/g) ?? []
      return matches.map((m) => `${rel(file)}: ${m}`)
    })
    expect(offenders, 'use a scale token from app.css (text-body, text-caption, …)').toEqual([])
  })

  it('uses no Tailwind default sizes either — those bypass the scale just as quietly', () => {
    const offenders = FILES.flatMap((file) => {
      const matches = readFileSync(file, 'utf8').match(/\btext-(xs|sm|base|lg|xl|2xl|3xl|4xl)\b/g) ?? []
      return matches.map((m) => `${rel(file)}: ${m}`)
    })
    expect(offenders).toEqual([])
  })
})

describe('corner radius', () => {
  /**
   * Three tiers, and a rule:
   *   rounded-md   controls — buttons, inputs, chips, rows
   *   rounded-lg   containers — panels, cards, modals, overlays
   *   rounded-full pills and status dots
   * Bare `rounded` and `rounded-xl` are the ones that crept in without a reason.
   */
  const ALLOWED = new Set(['rounded-md', 'rounded-lg', 'rounded-full', 'rounded-none'])

  it('sticks to the three documented tiers', () => {
    const offenders = FILES.flatMap((file) => {
      const src = readFileSync(file, 'utf8')
      // Only inside className strings: `rounded` is also a variable name in InvoiceEntry.
      const classAttrs = src.match(/className=\{?[`"'][^`"']*[`"']/g) ?? []
      return classAttrs
        .flatMap((attr) => attr.match(/\brounded(?:-[a-z0-9]+)?\b/g) ?? [])
        .filter((cls) => !ALLOWED.has(cls))
        .map((cls) => `${rel(file)}: ${cls}`)
    })
    expect(offenders).toEqual([])
  })
})

describe('colour tokens', () => {
  it('never reaches into Tailwind default palettes', () => {
    const offenders = FILES.flatMap((file) => {
      const matches =
        readFileSync(file, 'utf8').match(
          /\b(?:text|bg|border|ring|from|to|via)-(?:slate|gray|zinc|neutral|stone|red|orange|yellow|green|teal|sky|indigo|violet|purple|pink|rose)-\d{2,3}\b/g
        ) ?? []
      return matches.map((m) => `${rel(file)}: ${m}`)
    })
    expect(offenders, 'use a --t-* token via the @theme mapping in app.css').toEqual([])
  })

  it('has no hardcoded hex or rgb colours', () => {
    const offenders = FILES.flatMap((file) => {
      const matches = readFileSync(file, 'utf8').match(/(?:text|bg|border)-\[(?:#|rgba?\()[^\]]+\]/g) ?? []
      return matches.map((m) => `${rel(file)}: ${m}`)
    })
    expect(offenders).toEqual([])
  })
})
