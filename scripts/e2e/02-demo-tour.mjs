// Scenario 02 — demo tour: build the Demo Traders sample company, walk EVERY sidebar screen
// in light theme, flip to dark, walk them all again — with zero console errors and zero React
// key warnings across the whole tour.
import { scenario, assert } from '../lib/harness.mjs'

// Sidebar screens in registry order (lib/screens.ts) with their feature gates. Kept as a
// static list on purpose: if a lane adds a screen to the registry without covering it here,
// the registry-integrity renderer test still counts it — this tour is about rendering.
const TOUR = [
  ['voucher-entry'], ['daybook'], ['masters'], ['recurring'], ['import-tally'],
  ['trial-balance'], ['profit-loss'], ['balance-sheet'], ['cash-flow'],
  ['stock-summary', 'inventory'], ['year-end'],
  ['registers'], ['outstandings'], ['consolidated'], ['cost-centres', 'costCentres'],
  ['budgets'], ['exceptions'], ['banking'], ['payroll', 'payroll'],
  ['gstr1'], ['gstr3b'], ['gstr2b'], ['edocs'], ['tds', 'tds'],
  ['settings'], ['filings'], ['composition'], ['gateway']
]

await scenario('02-demo-tour', async (h) => {
  await h.createDemoCompany()
  const features = await h.invoke('config:features:get')

  for (const theme of ['light', 'dark']) {
    const current = await h.page.evaluate(() => document.documentElement.dataset.theme ?? 'light')
    if (current !== theme) {
      await h.click('btn-theme')
      const now = await h.page.evaluate(() => document.documentElement.dataset.theme)
      assert(now === theme, `theme toggled to ${theme}`)
    }
    for (const [name, feature] of TOUR) {
      if (feature && features[feature] === false) continue
      await h.goto(name, 20000)
      await h.shot(`${theme}-${name}`)
    }
  }

  // scenario() asserts no console errors / key warnings on exit — that's the real check here.
})
