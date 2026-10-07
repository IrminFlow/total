// Scenario 16 — Gateway dashboard (WP 1.10b): on the demo company every card loads (no card in
// an error state), the tiles show the same figures as the reports they summarise (trial-balance
// cash/bank, Outstandings), and two click-throughs land on the right screens.
import { scenario, assert, assertEq } from '../lib/harness.mjs'

const digits = (s) => (s ?? '').replace(/[^0-9-]/g, '')

await scenario('16-dashboard', async (h) => {
  await h.createDemoCompany()
  await h.page.waitForSelector('[data-testid="tile-cash"] [data-testid="spark-cash"]', { timeout: 20000 })
  await h.page.waitForFunction(
    () => [...document.querySelectorAll('[data-testid^="dash-"][data-state]')].every((el) => el.getAttribute('data-state') !== 'loading'),
    null,
    { timeout: 20000 }
  )
  const states = await h.page.$$eval('[data-testid^="dash-"][data-state]', (els) => els.map((el) => [el.getAttribute('data-testid'), el.getAttribute('data-state')]))
  for (const [id, state] of states) assert(state === 'ready', `${id} is ready (got ${state})`)
  for (const id of ['dash-trade', 'dash-profit', 'dash-ageing', 'dash-top-customers', 'dash-compliance', 'dash-cash', 'dash-stock', 'dash-recent']) {
    assert(states.some(([t]) => t === id), `${id} rendered`)
  }
  await h.shot('01-dashboard')

  // Figures reconcile with the reports.
  const today = await h.page.evaluate(() => {
    const d = new Date()
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  })
  const tb = await h.invoke('report:trialBalance', { asOn: today })
  const cashBank = tb.rows.filter((r) => r.ledgerName === 'Cash' || r.ledgerName === 'HDFC Bank').reduce((s, r) => s + r.debit - r.credit, 0)
  const cashTile = await h.page.textContent('#tile-cash-value')
  assertEq(digits(cashTile), String(cashBank), 'Cash & bank tile = trial balance cash + bank')
  const rec = await h.invoke('analysis:outstandings', { side: 'receivable', asOn: today })
  const recTile = await h.page.textContent('#tile-receivables-value')
  assertEq(digits(recTile), String(rec.reduce((s, p) => s + p.pending, 0)), 'Receivables tile = Outstandings total')

  // Chart keyboard: focus the trade chart, step with arrows, the live region reads a month.
  await h.page.focus('[data-testid="chart-trade"] [role="group"]')
  await h.page.keyboard.press('ArrowLeft')
  const live = await h.page.textContent('[data-testid="chart-trade"] [aria-live="polite"]')
  assert(/: Sales /.test(live ?? ''), `chart announces the focused month (${live})`)

  // Click-through 1: the Receivables tile opens Outstandings.
  await h.click('tile-receivables')
  await h.waitScreen('outstandings', 20000)
  await h.shot('02-outstandings')

  // Click-through 2: a top-customer row (not its name) opens that ledger's statement.
  await h.goto('gateway', 20000)
  const row = await h.page.waitForSelector('[data-testid="dash-top-customers"] [data-testid="top-ledger"]', { timeout: 20000 })
  const box = await row.boundingBox()
  await h.page.mouse.click(box.x + box.width - 140, box.y + box.height / 2) // the amount column, not the name
  await h.waitScreen('ledger-statement', 20000)
  await h.shot('03-statement')
})
