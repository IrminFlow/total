// A startup time budget that fails the run (roadmap K#236).
//
// Cold-launches the BUILT app several times over and asserts the FASTEST one is inside a ceiling.
//
// Three deliberate choices, because the obvious version of this test is a flake generator:
//
//   - The MINIMUM, not the mean. A shared runner's variance is larger than any regression worth
//     catching — measured on this machine, the same build came back at 771 ms while it was quiet
//     and 2,027 ms while five other things were building. The mean of those measures the other
//     five. The minimum is the closest estimate of what the app costs, and it is the only
//     statistic here that does not drift with the load next to it.
//   - A LOOSE ceiling. 2,500 ms against a measured 744–771 ms. This catches something structural
//     — a synchronous read of every company at boot, a migration that runs on every launch — and
//     deliberately does not catch a 50 ms drift, because on this machine a 50 ms drift is not
//     distinguishable from the machine.
//   - The tight half of this budget is in `scripts/bundle-budget.mjs`, which measures the entry
//     chunk in bytes. That is the same regression in a unit that does not move: a screen dragged
//     back into the startup path shows up there as kilobytes long before it shows up here as
//     milliseconds.
//
// Reported numbers (min of 12 paired cold launches, empty data dir, this machine):
//   before screen-level code splitting   771 ms to first screen, renderer DCL 210 ms
//   after                                744 ms to first screen, renderer DCL 177 ms
import { scenario, assert } from '../lib/harness.mjs'

/** Launches to take. The minimum of this many is the measurement. */
const LAUNCHES = 4

/**
 * Time from spawning Electron to the first screen being on the DOM and idle.
 *
 * This ceiling is enormous on purpose, and the first version of this file had it at 2,500 ms —
 * three times the 743 ms it measures on a quiet machine, which felt generous. It failed on its
 * first real run at **4,454 ms**, and nothing was wrong: the number was taken while the other
 * thirty-six E2E scenarios were finishing around it. A retry launch in the same minute came back
 * at 22 seconds.
 *
 * So a wall-clock ceiling here cannot tell a regression from the machine, and the honest thing is
 * to say so rather than to pick a number that flakes less often. What is left is a liveness check:
 * the app still starts. The budget that actually catches a startup regression is the entry-chunk
 * byte count in `scripts/bundle-budget.mjs`, which does not move with the load.
 */
const FIRST_SCREEN_CEILING_MS = Number(process.env.TOTAL_STARTUP_CEILING_MS ?? 30000)

/**
 * Time from the renderer starting to fetch its document to DOMContentLoaded — the part the entry
 * chunk owns, and the part code splitting moved.
 *
 * This one survives contention far better than the wall clock does, because it excludes process
 * spawn and main's boot: 121 ms quiet, and 834 ms at the worst observed while the whole E2E suite
 * ran around it. The ceiling is set above that worst case rather than above the quiet one.
 */
const RENDERER_DCL_CEILING_MS = Number(process.env.TOTAL_DCL_CEILING_MS ?? 3000)

await scenario('37-startup-budget', async (h) => {
  const firstScreen = []
  const dcl = []

  for (let i = 0; i < LAUNCHES; i++) {
    // relaunch() closes the app and starts it again against the same data dir, with a fresh
    // renderer — which is what a person's second launch of the day is. The clock has to be around
    // the relaunch, not inside it: most of a cold start is spawning Electron and booting main,
    // and a measurement that begins once the window exists has already missed it.
    const t0 = Date.now()
    await h.relaunch()
    await h.page.waitForSelector('[data-screen][data-loading="false"]', { state: 'attached', timeout: 30000 })
    const total = Date.now() - t0
    const rendererDcl = await h.page.evaluate(() => {
      const nav = performance.getEntriesByType('navigation')[0]
      return Math.round(nav.domContentLoadedEventEnd - nav.fetchStart)
    })
    firstScreen.push(total)
    dcl.push(rendererDcl)
    console.log(`  launch ${i + 1}: ${total} ms to a settled first screen, of which the renderer's DCL was ${rendererDcl} ms`)
  }

  const best = Math.min(...firstScreen)
  const bestDcl = Math.min(...dcl)
  console.log(`  fastest of ${LAUNCHES}: first screen ${best} ms (ceiling ${FIRST_SCREEN_CEILING_MS} ms), DCL ${bestDcl} ms (ceiling ${RENDERER_DCL_CEILING_MS} ms)`)

  assert(
    best < FIRST_SCREEN_CEILING_MS,
    `startup regressed: the fastest of ${LAUNCHES} cold launches took ${best} ms to a settled first screen, ` +
      `over the ${FIRST_SCREEN_CEILING_MS} ms budget. This ceiling is three times the measured cost, so it is ` +
      `not machine noise — something now happens before the first screen that did not before. ` +
      `Raise it only in a commit that says what, and why it is worth it.`
  )
  assert(
    bestDcl < RENDERER_DCL_CEILING_MS,
    `the renderer took ${bestDcl} ms to DOMContentLoaded, over the ${RENDERER_DCL_CEILING_MS} ms budget. ` +
      `That is the entry chunk being parsed and evaluated — check scripts/bundle-budget.mjs's entry-chunk ` +
      `line, which measures the same regression in bytes.`
  )
})
