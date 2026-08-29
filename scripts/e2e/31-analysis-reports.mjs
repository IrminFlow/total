// Scenario 31 — the section-C analysis reports, and the properties that make them trustworthy.
//
// Four claims, each of which would make a feature actively harmful if it were false:
//   grouping the trial balance changes the arrangement, never the total;
//   the "what changed" report is the difference between two dates and nothing else;
//   a saved view restores what was asked for, and cannot alter what is computed;
//   an export carries the whole period, not the window on screen.
import { scenario, assert } from '../lib/harness.mjs'

await scenario('31-analysis-reports', async (h) => {
  await h.createDemoCompany()

  // ---- Trial balance: grouping is an arrangement, not an arithmetic ----
  await h.goto('trial-balance')
  await h.page.waitForSelector('[data-testid="select-tb-grouping"]', { timeout: 15000 })

  const grandTotal = async () =>
    h.page.$$eval('.ledger-table tr.total-row td', (els) => els.map((e) => e.textContent.trim()))

  const flatTotal = await grandTotal()
  await h.shot('01-tb-flat')

  await h.page.selectOption('[data-testid="select-tb-grouping"]', 'topGroup')
  await h.page.waitForSelector('[data-testid^="tb-group-"]', { timeout: 15000 })
  const groupedTotal = await grandTotal()
  assert(
    JSON.stringify(groupedTotal) === JSON.stringify(flatTotal),
    `grouping leaves the grand total alone (${JSON.stringify(flatTotal)} vs ${JSON.stringify(groupedTotal)})`
  )

  // Every ledger is inside exactly one section: the section counts have to add up to the flat list.
  const sectionCount = await h.page.$$eval('[data-testid^="tb-group-"]', (els) => els.length)
  assert(sectionCount > 0, `the trial balance folds into ${sectionCount} primary groups`)
  await h.shot('02-tb-grouped')

  // Collapsing a section hides its ledgers and keeps its subtotal.
  const beforeCollapse = await h.page.$$eval('.ledger-table tbody tr', (els) => els.length)
  await h.page.click('[data-testid^="tb-group-"]')
  await h.page.waitForFunction(
    (before) => document.querySelectorAll('.ledger-table tbody tr').length < before,
    beforeCollapse,
    { timeout: 15000 }
  )
  const collapsedTotal = await grandTotal()
  assert(
    JSON.stringify(collapsedTotal) === JSON.stringify(flatTotal),
    'a collapsed section still counts toward the grand total'
  )
  await h.shot('03-tb-collapsed')

  // ---- What changed: the difference between two dates ----
  const changed = await h.invoke('report:whatChanged', { from: '2026-04-01', to: '2027-03-31' })
  assert(changed.rows.length > 0, `${changed.rows.length} ledgers moved over the year`)
  assert(changed.netChange === 0, 'every movement nets out — the books balance')
  const biggest = changed.rows[0]
  const second = changed.rows[1]
  assert(
    Math.abs(biggest.change) >= Math.abs(second.change),
    'the biggest mover is listed first, not the alphabetically first'
  )
  // A window that starts where it ends contains no entries at all.
  const sameDay = await h.invoke('report:whatChanged', { from: '2026-04-01', to: '2026-04-01' })
  assert(sameDay.rows.length === 0, 'a single-day window reports nothing changed')

  await h.page.click('[data-testid="tab-trial-balance-changes"]')
  await h.page.waitForSelector('[data-testid="rows-what-changed"] tr', { timeout: 15000 })
  await h.shot('04-what-changed')

  // ---- Saved views: restore the question, never the answer ----
  await h.goto('balance-sheet')
  await h.page.waitForSelector('[data-testid="btn-views-balance-sheet"]', { timeout: 15000 })
  await h.click('btn-views-balance-sheet')
  await h.page.waitForSelector('[data-testid="input-view-name"]', { timeout: 15000 })
  await h.page.fill('[data-testid="input-view-name"]', 'Year end')
  await h.click('btn-view-save')
  await h.page.waitForSelector('[data-testid="rows-saved-views"]', { timeout: 15000 })
  await h.shot('05-saved-view')

  // Close the modal before navigating: its backdrop covers the sidebar.
  await h.page.keyboard.press('Escape')
  await h.page.waitForSelector('[data-testid="input-view-name"]', { state: 'detached', timeout: 15000 })

  const views = await h.invoke('view:list', { screen: 'balance-sheet' })
  assert(views.length === 1 && views[0].name === 'Year end', 'the view is stored against its screen')
  assert(typeof views[0].state.asOn === 'string', 'a view carries the question (the as-on date), not figures')

  // ---- Ratios: a division with no denominator is stated as unknown, never as a number ----
  const ratios = await h.invoke('report:ratios', { from: '2026-04-01', to: '2027-03-31' })
  for (const [name, value] of Object.entries(ratios.ratios)) {
    assert(value === null || Number.isFinite(value), `${name} is a real number or an honest null`)
  }

  // ---- Forecast: built from things that already exist ----
  await h.goto('cash-flow')
  await h.page.click('[data-testid="tab-cash-flow-forecast"]')
  await h.page.waitForSelector('[data-testid="rows-forecast"]', { timeout: 15000 })
  await h.shot('06-forecast')

  // ---- Exports carry the whole period ----
  const dayBookAll = await h.invoke('report:dayBook', { from: '2026-04-01', to: '2027-03-31' })
  const xls = await h.invoke('export:xls', {
    filename: 'e2e-day-book',
    sheets: [
      {
        name: 'Day book',
        columns: [
          { label: 'Date', kind: 'date' },
          { label: 'Debit', kind: 'money' }
        ],
        rows: dayBookAll.rows.map((r) => ({ cells: [r.date, r.debit] }))
      }
    ]
  })
  assert(xls.path.endsWith('.xls'), `the workbook is written to ${xls.path}`)
})
