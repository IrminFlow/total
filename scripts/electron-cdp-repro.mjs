// Bounded reproducer for the Electron 38+ CDP navigation wedge documented in HANDOFF.md.
// Build first, then optionally point the harness at an alternate binary:
//   TOTAL_ELECTRON_PATH=/path/to/Electron npm exec -- node scripts/electron-cdp-repro.mjs
//
// All three transitions use Playwright's real pointer action. A DOM-click workaround would make
// this pass while hiding the focus/input regression the test exists to catch.
import { Harness } from './lib/harness.mjs'

const h = new Harness()
const started = Date.now()
const domClick = process.argv.includes('--dom-click')
const hardStop = setTimeout(() => {
  console.error(JSON.stringify({ ok: false, ms: Date.now() - started, error: 'hard timeout: CDP remained wedged' }))
  process.exit(124)
}, 45_000)
hardStop.unref()

try {
  await h.launch()
  await h.createDemoCompany('trading')
  for (const screen of ['edocs', 'daybook', 'edocs']) {
    console.log(`[cdp-repro] ${domClick ? 'DOM' : 'native'} click -> ${screen}`)
    if (domClick) {
      await h.page.evaluate((name) => {
        const control = document.querySelector(`[data-testid="nav-${name}"]`)
        if (!(control instanceof HTMLElement)) throw new Error(`navigation control not found: ${name}`)
        control.click()
      }, screen)
      await h.waitScreen(screen, 20_000)
    } else {
      await h.goto(screen, 20_000)
    }
  }
  h.assertNoConsoleErrors()
  h.assertNoKeyWarnings()
  console.log(JSON.stringify({ ok: true, ms: Date.now() - started }))
} catch (error) {
  console.error(JSON.stringify({
    ok: false,
    ms: Date.now() - started,
    error: error instanceof Error ? error.stack ?? error.message : String(error)
  }))
  process.exitCode = 1
} finally {
  // Closing through CDP can itself wedge after this regression. Give graceful shutdown a moment,
  // then let process exit tear down the child rather than turning a useful failure into a hang.
  await Promise.race([h.close(), new Promise((resolve) => setTimeout(resolve, 2_000))])
  clearTimeout(hardStop)
  // A wedged Electron child keeps Node's event loop alive even after the close grace period.
  process.exit(process.exitCode ?? 0)
}
