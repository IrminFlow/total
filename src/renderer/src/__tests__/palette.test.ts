import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { resolve } from 'path'

/**
 * The palette, as a snapshot (roadmap Q #326's other half).
 *
 * The visual-regression harness photographs every screen and compares a colour grid plus a
 * palette histogram, and it catches a card moving or a surface changing colour. What it cannot
 * catch is the accent bar: a 3px rule down the side of one row is about 0.007% of the pixels on
 * screen, which is below the resolution of any tolerance loose enough to survive antialiasing.
 * That was measured, not assumed — changing the accent from indigo to red passed the visual sweep
 * clean across all seventy screens.
 *
 * So the small, load-bearing colours get the instrument that suits them: an exact snapshot. Every
 * `--t-*` token in every theme, read out of the stylesheet. Changing one is then a deliberate act
 * with a reviewable diff, which is the right bar for the colour the whole product is built around.
 *
 * This is a snapshot of INTENT, not of taste. It does not say indigo is right. It says that if
 * indigo becomes something else, somebody chose that.
 */

const CSS = readFileSync(resolve(__dirname, '../app.css'), 'utf8')

/** Every `--t-name: value;` inside one selector block, in file order. */
function tokensIn(selector: string): Record<string, string> {
  const at = CSS.indexOf(`${selector} {`)
  if (at < 0) throw new Error(`no ${selector} block in app.css`)
  // The blocks are flat — no nesting — so the first closing brace at column 0 ends it.
  const end = CSS.indexOf('\n}', at)
  const body = CSS.slice(at, end)
  const out: Record<string, string> = {}
  for (const m of body.matchAll(/^\s*(--t-[a-z0-9-]+)\s*:\s*([^;]+);/gm)) {
    out[m[1]!] = m[2]!.replace(/\s+/g, ' ').trim()
  }
  return out
}

describe('the theme palette', () => {
  const themes = {
    light: tokensIn(':root'),
    dark: tokensIn("[data-theme='dark']"),
    contrast: tokensIn("[data-theme='contrast']")
  }

  it('every theme defines the same tokens', () => {
    // A token defined in light and missing in dark does not fail loudly — it falls back to the
    // light value, which is the exact bug that produces one unreadable element after dark.
    const light = Object.keys(themes.light).filter((k) => k !== '--t-font-scale')
    for (const [name, tokens] of Object.entries(themes)) {
      if (name === 'light') continue
      expect({ theme: name, missing: light.filter((k) => !(k in tokens)) }).toEqual({ theme: name, missing: [] })
    }
  })

  it('has not changed colour without somebody saying so', () => {
    expect(themes).toMatchSnapshot()
  })

  it('never lets the accent and the credit red be the same colour', () => {
    // They mean opposite things — "this is selected" and "this is money going the wrong way" —
    // and on a dense ledger screen they are eight pixels apart. This is the one palette rule
    // worth asserting as a rule rather than as a snapshot.
    for (const [name, t] of Object.entries(themes)) {
      expect({ theme: name, same: t['--t-accent'] === t['--t-cr'] }).toEqual({ theme: name, same: false })
      expect({ theme: name, same: t['--t-accent-bar'] === t['--t-cr'] }).toEqual({ theme: name, same: false })
    }
  })
})
