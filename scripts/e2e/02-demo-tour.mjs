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

  // ---- purchase suggestions turn a reorder flag into an action ----
  // The stock summary already flags an item below its level; a flag is not an action. Set one
  // deliberately low so the suggestion has something to say.
  const items = await h.invoke('master:stockItems:list')
  assert(items.length > 0, 'the demo books have stock items')
  const target = items[0]

  const before = await h.invoke('report:purchaseSuggestions', { asOn: '2027-03-31' })
  assert(
    !before.some((r) => r.stockItemId === target.id),
    'nothing suggested for an item with no reorder level — nobody has expressed an opinion about it'
  )

  await h.invoke('master:stockItems:update', {
    id: target.id,
    data: { ...target, reorderLevelMilli: 9_999_000 }
  })
  const after = await h.invoke('report:purchaseSuggestions', { asOn: '2027-03-31' })
  const row = after.find((r) => r.stockItemId === target.id)
  assert(row, 'the item is now suggested')
  assert(row.shortfallQtyMilli > 0, 'with a positive shortfall')
  assert(
    row.reorderLevelMilli - row.closingQtyMilli === row.shortfallQtyMilli,
    'and the shortfall is exactly what it takes to reach the level'
  )
  // A price only when one was actually paid: never-bought items must not carry a guessed one.
  if (row.lastRatePaise == null) {
    assert(row.estimatedCost === null, 'no last price means no estimate rather than a guess')
  } else {
    assert(
      row.estimatedCost === Math.round((row.shortfallQtyMilli * row.lastRatePaise) / 1000),
      'the estimate is the shortfall at the last price'
    )
  }

  await h.goto('stock-summary')
  await h.page.waitForSelector('[data-testid="rows-purchase-suggestions"]', { timeout: 15000 })
  await h.shot('purchase-suggestions')

  // ---- a count sheet to walk the shelves with ----
  // Printed, carried, and written on: Counted and Difference are blank, and the book quantity is
  // beside them so a discrepancy is visible at the shelf rather than an hour later at a desk.
  await h.stubDialogs()
  await h.page.click('[data-testid="btn-count-sheet"]')
  await h.page.waitForFunction(
    () => /count sheet|Saved|saved/i.test(document.body.textContent ?? ''),
    null,
    { timeout: 20000 }
  )

  // ---- per-item negative-stock block ----
  // The company-wide flag is all-or-nothing; a business that books a sale before the purchase
  // invoice arrives has to leave it off, which leaves it off where it matters most.
  assert(features.preventNegativeStock === false, 'the demo company allows negative stock')

  await h.invoke('master:stockItems:update', {
    id: target.id,
    data: { ...target, blockNegative: true }
  })
  const reread = (await h.invoke('master:stockItems:list')).find((i) => i.id === target.id)
  assert(reread.blockNegative === true, 'the per-item block round-trips')

  // Put it back, so the tour screenshots above are of ordinary books.
  await h.invoke('master:stockItems:update', {
    id: target.id,
    data: { ...target, reorderLevelMilli: null, blockNegative: null }
  })
})
