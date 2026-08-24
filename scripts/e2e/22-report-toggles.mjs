// Scenario 22 — the two report toggles, and the fact that a toggle never changes a total.
//
// Hiding zero-balance ledgers and showing percentages are both view-only: they change what is on
// screen and must not change a figure. That is the property worth testing, because it is the one
// that would make either feature dangerous if it were wrong.
import { scenario, assert } from '../lib/harness.mjs'

await scenario('22-report-toggles', async (h) => {
  await h.createDemoCompany()

  // The demo books have no dormant ledgers, so make one: a ledger with no opening balance and no
  // vouchers is exactly what the toggle exists to hide.
  const groups = await h.invoke('master:groups:list')
  const expenses = groups.find((g) => g.name === 'Indirect Expenses')
  await h.invoke('master:ledgers:create', {
    name: 'Dormant Expense', groupId: expenses.id, openingBalance: 0,
    gstin: null, stateCode: null, address: null, taxType: null, gstRate: null, hsn: null
  })

  // ---- Trial balance: zero-balance ledgers hidden by default ----
  await h.goto('trial-balance')
  await h.page.waitForSelector('[data-testid="btn-tb-hide-zeros"]', { timeout: 15000 })

  const totals = async () =>
    h.page.$$eval('.ledger-table tr.total-row td', (els) => els.map((e) => e.textContent.trim()))
  const rowCount = async () => h.page.$$eval('.ledger-table tbody tr', (els) => els.length)

  const hiddenTotals = await totals()
  const hiddenRows = await rowCount()
  await h.shot('01-zeros-hidden')

  await h.click('btn-tb-hide-zeros')
  // The query key changes, so the table blanks while it refetches — wait for MORE rows rather
  // than for a different count, which would catch the empty intermediate state.
  await h.page.waitForFunction(
    (before) => document.querySelectorAll('.ledger-table tbody tr').length > before,
    hiddenRows,
    { timeout: 15000 }
  )
  const shownRows = await rowCount()
  assert(shownRows > hiddenRows, `showing zeros adds rows (${hiddenRows} → ${shownRows})`)

  // The whole safety argument: a hidden zero cannot change a total.
  const shownTotals = await totals()
  assert(
    JSON.stringify(shownTotals) === JSON.stringify(hiddenTotals),
    `the totals are identical either way (${JSON.stringify(hiddenTotals)} vs ${JSON.stringify(shownTotals)})`
  )
  await h.shot('02-zeros-shown')

  // And the preference sticks: hide them again and reopen the screen.
  await h.click('btn-tb-hide-zeros')
  await h.goto('gateway')
  await h.goto('trial-balance')
  await h.page.waitForFunction(
    (expected) => document.querySelectorAll('.ledger-table tbody tr').length === expected,
    hiddenRows,
    { timeout: 15000 }
  )

  // ---- Profit & Loss: percentage of turnover ----
  await h.goto('profit-loss')
  await h.page.waitForSelector('[data-testid="btn-pnl-pct"]', { timeout: 15000 })
  const before = await h.page.$$eval('[data-testid="statement-pct"]', (els) => els.length)
  assert(before === 0, 'percentages are off by default')

  await h.click('btn-pnl-pct')
  await h.page.waitForSelector('[data-testid="statement-pct"]', { timeout: 15000 })
  const pcts = await h.page.$$eval('[data-testid="statement-pct"]', (els) =>
    els.map((e) => e.textContent.trim())
  )
  assert(pcts.length > 0, 'percentages appear on the statement lines')
  assert(
    pcts.every((t) => t === '–' || /^\d+(\.\d)?%$/.test(t)),
    `every percentage is a number or a dash (got ${JSON.stringify(pcts.slice(0, 5))})`
  )
  // Sales must be 100% of turnover. This is the assertion that catches a wrong base: including
  // closing stock in turnover made it read 60%, which looks plausible and is nonsense.
  assert(
    pcts.includes('100.0%'),
    `the income the base is drawn from reads as 100% (got ${JSON.stringify(pcts)})`
  )
  await h.shot('03-pnl-percent')

  // ---- Profit & Loss: against the same period last year ----
  await h.click('btn-pnl-compare')
  await h.page.waitForSelector('[data-testid="statement-change"]', { timeout: 15000 })
  const changes = await h.page.$$eval('[data-testid="statement-change"]', (els) =>
    els.map((e) => e.textContent.trim())
  )
  assert(changes.length > 0, 'a change column appears against last year')
  assert(
    changes.every((t) => t === '—' || /^[+-]?\d+%$/.test(t)),
    `every change is a percentage or an em dash (got ${JSON.stringify(changes.slice(0, 5))})`
  )
  // The demo books start this financial year, so last year is empty and every line is new —
  // which must read as "no prior figure to compare", not as a fabricated -100%.
  assert(changes.includes('—'), 'a line with no prior figure shows a dash rather than a percentage')
  await h.shot('04-pnl-compare')

  // ---- Balance Sheet: the same comparison, and it must still balance ----
  await h.goto('balance-sheet')
  await h.page.waitForSelector('[data-testid="btn-bs-compare"]', { timeout: 15000 })
  const totalsBefore = await h.page.$$eval('.total-row', (els) => els.map((e) => e.textContent.trim()))
  await h.click('btn-bs-compare')
  await h.page.waitForSelector('[data-testid="statement-change"]', { timeout: 15000 })
  const totalsAfter = await h.page.$$eval('.total-row', (els) => els.map((e) => e.textContent.trim()))
  // A comparison column is a view, not a recomputation: the sheet's own totals cannot move.
  assert(
    JSON.stringify(totalsAfter) === JSON.stringify(totalsBefore),
    'showing last year does not change this year’s totals'
  )
  await h.shot('05-bs-compare')

  // ---- Registers: who the business actually came from ----
  await h.goto('registers')
  await h.page.click('[data-testid="tab-registers-parties"]')
  await h.page.waitForSelector('[data-testid="rows-parties"] tr', { timeout: 15000 })

  const shares = await h.page.$$eval('[data-testid="rows-parties"] tr', (els) =>
    els.map((tr) => [...tr.querySelectorAll('td')].map((td) => td.textContent.trim()))
  )
  assert(shares.length > 1, 'the demo books have parties to rank')
  // The last row is the total; it must read 100%.
  assert(shares[shares.length - 1][3] === '100.0%', 'the shares add up to the whole')

  // Ranked largest first — the whole point of the table.
  const values = shares
    .slice(0, -1)
    .map((cells) => Number(cells[2].replace(/[^0-9.]/g, '')))
  for (let i = 1; i < values.length; i++) {
    assert(values[i] <= values[i - 1], `parties are ranked largest first (${values[i - 1]} then ${values[i]})`)
  }
  // Cumulative share is monotonic and ends at the whole.
  const cumulative = shares.slice(0, -1).map((cells) => parseFloat(cells[4]))
  for (let i = 1; i < cumulative.length; i++) {
    assert(cumulative[i] >= cumulative[i - 1], 'cumulative share never goes down')
  }
  assert(Math.abs(cumulative[cumulative.length - 1] - 100) < 0.2, 'and reaches 100%')
  await h.shot('06-parties')

  // Switching to suppliers asks a different question of the same books.
  await h.page.click('[data-testid="tab-parties-purchase"]')
  await h.page.waitForFunction(
    (before) => {
      const rows = document.querySelectorAll('[data-testid="rows-parties"] tr')
      return rows.length > 0 && rows[0].textContent !== before
    },
    shares[0].join(''),
    { timeout: 15000 }
  )
  await h.shot('07-suppliers')
})
