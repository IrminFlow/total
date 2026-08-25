// Scenario 34 — CMA data for a working-capital application (roadmap #371).
//
// The assertions here are almost all about one boundary. A CMA pack mixes figures the books can
// prove with figures the borrower is asserting about their own future, and a bank is entitled to
// know which is which. So: the audited columns must come from the books and must not be typeable,
// the estimate and projections must start BLANK rather than at zero, and a column for a year the
// books do not reach must say so in words rather than print a column of confident nils.
//
// The demo company's books open this financial year, which makes it exactly the awkward case the
// roadmap called out: a business with under two years of history applying for a limit.
import { scenario, assert } from '../lib/harness.mjs'

const fyStartYear = (iso) => {
  const [y, m] = iso.split('-').map(Number)
  return m >= 4 ? y : y - 1
}

await scenario('34-cma', async (h) => {
  await h.createDemoCompany()

  const info = (await h.invoke('company:current')).info
  const thisFy = fyStartYear(new Date().toISOString().slice(0, 10))

  // ---- the screen ----
  await h.goto('borrowing')
  await h.click('tab-borrowing-cma')
  await h.waitIdle()

  await h.click('btn-cma-new')
  await h.fill('input-cma-name', 'Renewal with Bank of Baroda')
  await h.fill('input-cma-year', String(thisFy))
  await h.click('btn-cma-save')
  await h.waitIdle()

  const packs = await h.invoke('cma:packs')
  assert(packs.length === 1, 'the pack is created')
  const packId = packs[0].id

  const view = await h.invoke('cma:pack', { id: packId })
  assert(view.columns.length === 5, 'five columns: two audited, an estimate and two projections')
  assert(
    view.columns.map((c) => c.fyStartYear).join(',') === [thisFy - 2, thisFy - 1, thisFy, thisFy + 1, thisFy + 2].join(','),
    'counting two years back and two forward from the estimate'
  )
  assert(
    view.columns.map((c) => c.source).join(',') === 'audited,audited,estimate,projection,projection',
    'and saying which kind of claim each one makes'
  )

  // ---- the edge the roadmap named: a company with under two years of history ----
  assert(info.booksFrom === thisFy, 'the demo books open this financial year')
  assert(view.columns[0].booksCover === false && view.columns[1].booksCover === false,
    'so neither audited year is covered by the books')
  const uncovered = view.warnings.filter((w) => w.includes('the books do not cover'))
  assert(uncovered.length === 2, `both uncovered years are called out in words (${view.warnings.length} warnings)`)

  const formII = view.forms.find((f) => f.id === 'II')
  const netSales = formII.lines.find((l) => l.key === 'ii_net_sales_total')
  assert(netSales.cells.every((c) => c.value === null),
    'and every cell of the pack is BLANK — a pack that prints zeros for a year that did not exist gets refused')

  // The header says it on screen too, not just in the payload.
  const headerText = await h.page.textContent('[data-testid="cma-col-a2"]')
  assert(headerText.includes('books do not reach'), `the column header explains itself: ${headerText}`)

  // ---- computed and typed must not look alike ----
  await h.fill('cma-e-ii_net_sales_total', '2500000')
  await h.page.keyboard.press('Tab')
  await h.waitIdle()

  const typed = await h.invoke('cma:pack', { id: packId })
  const typedSales = typed.forms.find((f) => f.id === 'II').lines.find((l) => l.key === 'ii_net_sales_total')
  assert(typedSales.cells[2].value === 2500000_00, 'the typed figure is stored in paise')
  assert(typedSales.cells[2].source === 'typed', 'and is marked as the borrower’s own claim')
  assert(typed.columns[2].state === 'typed', 'which turns the whole estimate column into a typed one')

  const pat = typed.forms.find((f) => f.id === 'II').lines.find((l) => l.key === 'ii_pat')
  assert(pat.cells[2].source === 'derived', 'a subtotal is derived, never typed')
  assert(pat.editable === false, 'and is not offered as an input at all')
  assert(pat.cells[2].value === 2500000_00, 'the whole of it being profit, since nothing else is entered yet')

  // The three states are visually distinct in the DOM, which is what the legend promises.
  const sources = await h.page.$$eval('[data-testid="cma-line-ii_pat"] td[data-cell-source]',
    (tds) => tds.map((td) => td.getAttribute('data-cell-source')))
  assert(sources.every((s) => s === 'derived'), `a total row is derived across the board (${sources})`)

  // ---- MPBF under both Tandon methods ----
  for (const [key, value] of [
    ['iii_inventory', 1800000_00],
    ['iii_receivables_6m', 1200000_00],
    ['iii_cash', 200000_00],
    ['iii_creditors', 900000_00],
    ['iii_bank_borrowing', 1000000_00]
  ]) {
    await h.invoke('cma:setInput', { packId, columnKey: 'e', lineKey: key, value })
  }
  const withBs = await h.invoke('cma:pack', { id: packId })
  const formV = withBs.forms.find((f) => f.id === 'V')
  const at = (key) => formV.lines.find((l) => l.key === key).cells[2].value

  assert(at('v_tca') === 3200000_00, `total current assets (${at('v_tca')})`)
  assert(at('v_ocl') === 900000_00, 'current liabilities other than the bank borrowing')
  assert(at('v_wcg') === 2300000_00, 'the working capital gap')
  assert(at('v_min_nwc_1') === Math.round(at('v_wcg') / 4), 'method I stipulates a quarter of the gap')
  assert(at('v_min_nwc_2') === Math.round(at('v_tca') / 4), 'method II a quarter of current assets')
  assert(at('v_mpbf_2') <= at('v_mpbf_1'), 'so method II is never the more generous of the two')
  assert(at('v_mpbf_1') === Math.max(0, Math.min(at('v_gap_less_min_1'), at('v_gap_less_actual_1'))),
    'and MPBF is the LOWER limb, not the higher')

  // ---- the ratios a credit officer reads ----
  const ratioKeys = withBs.ratios.map((r) => r.key)
  for (const key of ['current_ratio', 'tol_tnw', 'dscr', 'inventory_turnover', 'receivable_turnover']) {
    assert(ratioKeys.includes(key), `${key} is on the ratio sheet`)
  }
  const current = withBs.ratios.find((r) => r.key === 'current_ratio')
  assert(current.values[2] === 1.68, `current ratio computed for the estimate (${current.values[2]})`)
  assert(current.values[0] === null, 'and left blank for the year that has nothing behind it')
  const dscr = withBs.ratios.find((r) => r.key === 'dscr')
  assert(dscr.values[2] === null, 'DSCR is blank rather than confident when there is no term debt to service')

  // ---- the fund flow only spans years that both exist ----
  const ff = withBs.fundFlow
  assert(ff.columns.length === 4, 'four movements across five years')
  assert(ff.columns.every((c) => c.available === false), 'none of them available while a2 and a1 are blank')
  assert(ff.sources[0].values.every((v) => v === null), 'so no movement is invented')

  // ---- Form I reads an outstanding off the books when a ledger is linked ----
  const ledgers = await h.invoke('master:ledgers:list')
  const bank = ledgers.find((l) => l.name === 'HDFC Bank')
  await h.invoke('cma:saveFacility', {
    packId,
    data: {
      facility: 'Cash credit', existingLimitPaise: 5000000_00, proposedLimitPaise: 7500000_00,
      outstandingPaise: 999_00, ledgerId: bank.id, security: 'Hypothecation of stock and book debts',
      notes: null, seq: 0
    }
  })
  const withFacility = await h.invoke('cma:pack', { id: packId })
  const facility = withFacility.facilities[0]
  assert(facility.outstandingFromBooks === true, 'a linked facility reports from the books')
  assert(facility.outstandingPaise !== 999_00, 'not the figure somebody typed beside it')
  assert(withFacility.facilityTotals.proposedLimitPaise === 7500000_00, 'and Form I totals the limits')

  // ---- starting a projection from a year that exists is the user's act, not the app's ----
  const copied = await h.invoke('cma:prefill', { packId, fromKey: 'e', toKey: 'p1' })
  assert(copied > 0, `${copied} figures copied forward`)
  const prefilled = await h.invoke('cma:pack', { id: packId })
  const p1Sales = prefilled.forms.find((f) => f.id === 'II').lines.find((l) => l.key === 'ii_net_sales_total')
  assert(p1Sales.cells[3].value === 2500000_00, 'the copy lands')
  assert(p1Sales.cells[3].source === 'typed', 'as the borrower’s own figures, not as anything the books said')

  await h.shot('cma-pack')
  h.assertNoConsoleErrors()
})
