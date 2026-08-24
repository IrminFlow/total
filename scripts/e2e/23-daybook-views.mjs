// Scenario 23 — the Day Book's two extra views.
//
// The list is paged, so the by-type summary has to count the WHOLE period rather than the page on
// screen — that is the property worth testing, because a summary of an arbitrary slice is worse
// than no summary. The reconciliation column has to distinguish "not cleared" from "not a bank
// voucher", which is the difference between a real to-do and a permanent false one.
import { scenario, assert } from '../lib/harness.mjs'

await scenario('23-daybook-views', async (h) => {
  await h.createDemoCompany()
  await h.goto('daybook')

  // ---- by type ----
  await h.click('btn-daybook-by-type')
  await h.page.waitForSelector('[data-testid="rows-daybook-by-type"] tr', { timeout: 15000 })
  const typeRows = await h.page.$$eval('[data-testid="rows-daybook-by-type"] tr', (els) =>
    els.map((tr) => [...tr.querySelectorAll('td')].map((td) => td.textContent.trim()))
  )
  assert(typeRows.length > 1, 'the demo books have more than one voucher type')

  // The summary counts the whole period, which the paged list does not.
  const summed = typeRows.slice(0, -1).reduce((s, cells) => s + Number(cells[1]), 0)
  const total = Number(typeRows[typeRows.length - 1][1])
  assert(summed === total, `the type counts add to the total (${summed} vs ${total})`)

  const { total: periodTotal } = await h.invoke('report:dayBook', {
    from: '1900-01-01',
    to: '2999-12-31',
    limit: 1
  })
  const byType = await h.invoke('report:dayBookByType', { from: '1900-01-01', to: '2999-12-31' })
  const byTypeTotal = byType.reduce((s, r) => s + r.count, 0)
  assert(
    byTypeTotal === periodTotal,
    `the by-type counts cover every voucher in the period, not a page (${byTypeTotal} vs ${periodTotal})`
  )
  await h.shot('01-by-type')

  // ---- reconciliation column ----
  await h.click('btn-daybook-by-type') // back to the entries
  await h.page.waitForSelector('[data-testid="rows-daybook"] tr', { timeout: 15000 })

  const rowsBefore = await h.page.$$eval('[data-testid="rows-daybook"] tr', (els) => els.length)
  await h.click('btn-report-config')
  await h.page.waitForSelector('[data-testid="report-config-reconciled"]', { timeout: 10000 })
  await h.page.click('[data-testid="report-config-reconciled"]')
  await h.page.keyboard.press('Escape')
  await h.page.waitForSelector('[data-testid="daybook-bank-status"]', { timeout: 15000 })

  const statuses = await h.page.$$eval('[data-testid="daybook-bank-status"]', (els) =>
    els.map((e) => e.textContent.trim())
  )
  assert(statuses.length > 0, 'the reconciliation column renders')
  assert(
    statuses.every((t) => ['–', 'Cleared', 'Part-cleared', 'Not cleared'].includes(t)),
    `every value is one of the four states (got ${JSON.stringify([...new Set(statuses)])})`
  )
  // A cash-only book would be all dashes; the demo has bank vouchers, so both must appear.
  assert(statuses.includes('–'), 'non-bank vouchers show a dash, not a false to-do')
  assert(
    statuses.some((t) => t !== '–'),
    'and bank vouchers show a real state'
  )
  // Adding a column must not drop or duplicate rows.
  const rowsAfter = await h.page.$$eval('[data-testid="rows-daybook"] tr', (els) => els.length)
  assert(rowsAfter === rowsBefore, 'showing a column does not change the rows')
  await h.shot('02-reconciled-column')
})
