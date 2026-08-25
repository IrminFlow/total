// Photograph every screen in both themes and compare it against a committed signature (#326).
//
//   node scripts/visual-regression.mjs            # compare, fail on drift
//   node scripts/visual-regression.mjs --update   # accept what is on screen as the new baseline
//
// SIGNATURES, NOT IMAGES. Seventy 1440x900 PNGs is about 25 MB of binaries in a repository, and a
// binary in a diff is a diff nobody reads. The baseline is one line of hex per screen instead: a
// 32x20 grid of average colour, plus a 64-bucket palette histogram. What gets reviewed is not the
// hex, it is the LIST OF SCREENS that moved — because accepting a baseline is accepting that a
// screen is meant to look different now, and that is a decision, not a formality.
//
// It is also the right instrument. Comparing whole screenshots would fail on today's date in the
// compliance calendar, on "last backup 3 minutes ago", and on antialiasing that differs between
// machines. This ignores all of that and still moves decisively when a column shifts, a card
// changes height, a colour changes, or a control disappears.
//
// WHAT THIS DOES NOT CATCH, measured rather than assumed: changing the accent bar from indigo to
// red passes this sweep clean across all seventy screens. A 3px rule down the side of one row is
// about 0.007% of the pixels on screen — below the resolution of any tolerance loose enough to
// survive antialiasing. The small, load-bearing colours are covered by an exact snapshot of every
// theme token instead (src/renderer/src/__tests__/palette.test.ts), which is the instrument that
// suits a colour you cannot see enough of to measure.
//
// Run `npm run build` first — this drives the built app, not the dev server.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import { Harness } from './lib/harness.mjs'
import { decodePng, signature, compare } from './lib/png.mjs'

const UPDATE = process.argv.includes('--update')
const BASELINE = path.join(process.cwd(), 'scripts', 'visual-baseline.json')
const OUT = path.join(process.cwd(), 'smoke-out', 'visual')

/**
 * How much a cell may move before it counts as a change.
 *
 * `worst` is the tolerance that does the work: a real layout change moves at least one cell a
 * long way, while machine-to-machine noise moves every cell a little. 24 of 255 is roughly a
 * tenth, which is wider than font rendering differs and far narrower than a moved card.
 *
 * `mean` catches the opposite shape — a change too diffuse to spike any single cell, like a
 * background tint or the whole content column shifting by a few pixels.
 */
const TOLERANCE = {
  grid: { worst: 24, mean: 4 },
  // Tighter, and in different units: a histogram byte is a share of the screen, so 6/255 is about
  // 2% of the pixels changing colour — far more than antialiasing and far less than a restyle.
  hist: { worst: 6, mean: 0.5 }
}

const baseline = existsSync(BASELINE) ? JSON.parse(readFileSync(BASELINE, 'utf8')) : { screens: {} }
const captured = {}
const findings = []

const h = new Harness({ outDir: OUT })
mkdirSync(OUT, { recursive: true })

try {
  await h.launch()
  await h.createDemoCompany()

  const screens = await h.page.$$eval('[data-testid^="nav-"]', (els) =>
    els.map((e) => e.getAttribute('data-testid').replace(/^nav-/, ''))
  )

  for (const theme of ['light', 'dark']) {
    const current = await h.page.getAttribute('html', 'data-theme')
    if (current !== theme) {
      await h.page.click('[data-testid="btn-theme"]')
      await h.page.waitForFunction((t) => document.documentElement.dataset.theme === t, theme, { timeout: 5000 })
    }

    for (const name of screens) {
      try {
        await h.goto(name, 30_000)
      } catch {
        findings.push(`${theme}/${name}: never settled`)
        continue
      }
      // Put the keyboard cursor on the first row before photographing.
      //
      // Without this the accent bar — the app's signature, and the thing most likely to be
      // changed by accident — is not on screen at all, because a freshly navigated list has no
      // active row. The first version of this test proved the point: changing the accent from
      // indigo to red passed clean across all seventy screens, since the colour was nowhere in
      // any of them. It is also the more honest photograph: a screen in use has a cursor on it.
      //
      // ArrowDown is a no-op on a screen with no list, so this is unconditional.
      await h.page.keyboard.press('ArrowDown')
      await h.page.waitForTimeout(120) // the 120ms row-action fade, so the frame is settled

      const shot = await h.page.screenshot()
      const sig = signature(decodePng(shot))
      const key = `${theme}/${name}`
      captured[key] = sig.toString('hex')

      const before = baseline.screens[key]
      if (!before) {
        findings.push(`${key}: no baseline (new screen — run with --update to accept it)`)
        continue
      }
      const d = compare(Buffer.from(before, 'hex'), sig)
      const movedLayout = d.grid.worst > TOLERANCE.grid.worst || d.grid.mean > TOLERANCE.grid.mean
      const movedColour = d.hist.worst > TOLERANCE.hist.worst || d.hist.mean > TOLERANCE.hist.mean
      if (movedLayout || movedColour) {
        // The image only when it is wanted: a failure is the one moment somebody needs to look.
        const file = path.join(OUT, `${theme}-${name}.png`)
        writeFileSync(file, shot)
        // Say WHICH of the two moved, because they send the reader to different places: layout to
        // a component, colour to a token.
        const what = movedLayout && movedColour ? 'layout and colour' : movedLayout ? 'layout' : 'colour'
        findings.push(
          `${key}: ${what} — grid worst ${d.grid.worst}/${TOLERANCE.grid.worst} mean ` +
            `${d.grid.mean.toFixed(1)}/${TOLERANCE.grid.mean}, palette worst ${d.hist.worst}/` +
            `${TOLERANCE.hist.worst} mean ${d.hist.mean.toFixed(2)}/${TOLERANCE.hist.mean} — ${file}`
        )
      }
    }
  }

  // A screen that disappears is a change too, and comparing only what was captured would miss it.
  for (const key of Object.keys(baseline.screens)) {
    if (!(key in captured)) findings.push(`${key}: in the baseline but not reachable any more`)
  }
} finally {
  await h.close()
}

if (UPDATE) {
  writeFileSync(
    BASELINE,
    JSON.stringify(
      {
        note: 'Generated by scripts/visual-regression.mjs --update. Per screen: a 32x20 grid of average RGB, then a 64-bucket palette histogram, as hex. Accepting a change here is accepting that the screen is MEANT to look different now.',
        cols: 32,
        rows: 20,
        buckets: 64,
        screens: Object.fromEntries(Object.entries(captured).sort(([a], [b]) => a.localeCompare(b)))
      },
      null,
      2
    ) + '\n'
  )
  console.log(`baseline updated: ${Object.keys(captured).length} screens → ${path.relative(process.cwd(), BASELINE)}`)
  process.exit(0)
}

console.log(`compared ${Object.keys(captured).length} screens against the baseline`)
if (findings.length > 0) {
  console.error(`\n${findings.length} screen(s) drifted:\n` + findings.map((f) => `  ${f}`).join('\n'))
  console.error('\nIf these changes are intended: node scripts/visual-regression.mjs --update')
  process.exit(1)
}
console.log('no drift')
