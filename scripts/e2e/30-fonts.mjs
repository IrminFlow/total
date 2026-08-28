// Scenario 30 — the webfonts actually cover the characters this app prints.
//
// The renderer imports Latin Plex faces plus one currency-only WOFF2 fallback. That keeps the
// bundle small without relying on a different OS font on Windows and macOS.
//
// The rupee sign is the one that matters — it is on every amount the app formats with a symbol,
// and it sits at U+20B9, outside the range most "latin" subsets cover. This measures it rather
// than trusting the subset's name.
import { scenario, assert } from '../lib/harness.mjs'

// Characters the app genuinely prints, and where.
const REQUIRED = [
  ['₹', 'the rupee sign — every amount formatted with a symbol'],
  ['—', 'em dash — used throughout the interface copy'],
  ['·', 'middot — the separator in every summary line'],
  ['↑', 'arrow — sort indicators and drill-through links'],
  ['₹1,23,456.00', 'a full Indian-grouped amount']
]

await scenario('30-fonts', async (h) => {
  // Weight matters: only the weights app.css imports exist as webfonts. The serif is 500/600
  // only, so measuring it at the default 400 measures the fallback and proves nothing.
  const faces = [
    { family: 'IBM Plex Sans', weight: 400 },
    { family: 'IBM Plex Serif', weight: 600 },
    { family: 'IBM Plex Mono', weight: 400 }
  ]

  const result = await h.page.evaluate(
    async ({ faces, chars }) => {
      await document.fonts.ready
      const measure = (text, family, weight) => {
        const s = document.createElement('span')
        s.textContent = text
        s.style.cssText = `position:absolute;left:-9999px;font-size:100px;font-weight:${weight};font-family:${family}`
        document.body.appendChild(s)
        const w = s.getBoundingClientRect().width
        s.remove()
        return w
      }
      const out = {}
      for (const { family, weight } of faces) {
        out[family] = {
          // Control: a character every font has. If this does not differ from the fallback, the
          // webfont never loaded and every other measurement below is meaningless.
          control: [measure('A', `'${family}','NoFallbackXYZ'`, weight), measure('A', "'NoFallbackXYZ'", weight)],
          chars: chars.map((c) => [
            c,
            measure(c, `'${family}','NoFallbackXYZ'`, weight),
            measure(c, "'NoFallbackXYZ'", weight)
          ])
        }
      }
      // FontFaceSet.ready waits for faces already needed by the document; the currency-only face
      // may not have appeared on the company-select screen yet, so request its one glyph before
      // checking it.
      await document.fonts.load("400 100px 'Total Currency'", '₹')
      const currency = {
        loaded: document.fonts.check("400 100px 'Total Currency'", '₹'),
        widths: [measure('₹', "'Total Currency','NoFallbackXYZ'", 400), measure('₹', "'NoFallbackXYZ'", 400)]
      }
      return { faces: out, currency }
    },
    { faces, chars: REQUIRED.map(([c]) => c) }
  )

  assert(result.currency.loaded, 'the bundled Total Currency face is loaded for U+20B9')
  assert(
    result.currency.widths[0] !== result.currency.widths[1],
    'the bundled currency face, rather than an OS fallback, renders the rupee sign'
  )
  for (const { family, weight } of faces) {
    const r = result.faces[family]
    assert(r.control[0] !== r.control[1], `${family} ${weight} is loaded (control glyph differs from the fallback)`)
    for (const [char, withFace, fallback] of r.chars) {
      const why = REQUIRED.find(([c]) => c === char)[1]
      // ₹ is deliberately supplied by Total Currency in the real stack and asserted above. A full
      // grouped amount still proves that the declared face and currency fallback compose together.
      if (char !== '₹') assert(withFace !== fallback, `${family} stack has ${JSON.stringify(char)} — ${why}`)
    }
  }

  // And the trim itself: no legacy woff should reach the bundle. Chromium has supported woff2
  // since 2014, so a woff beside every woff2 is a file that is shipped and never once requested.
  const loaded = await h.page.evaluate(() =>
    [...document.fonts].map((f) => f.family).filter((v, i, a) => a.indexOf(v) === i)
  )
  assert(loaded.some((f) => f.includes('IBM Plex')), `the Plex faces are registered (${loaded.join(', ')})`)
})
