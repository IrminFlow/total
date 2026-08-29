// Scenario 08 — year-end close: preview shows the P&L transfer, posting the close keeps the
// TB tied and the year-end screen renders afterwards.
import { scenario, assert, assertEq } from '../lib/harness.mjs'

await scenario('08-year-end', async (h) => {
  // yearend:close refuses a FY that hasn't ended, so the books must START in the PREVIOUS
  // FY — the create modal defaults to the current one, so create over IPC with booksFrom
  // set back a year, then open through the picker.
  const now = new Date()
  const currentFyStart = now.getMonth() >= 3 ? now.getFullYear() : now.getFullYear() - 1
  const fyStartYear = currentFyStart - 1
  await h.invoke('company:create', {
    name: 'YearEnd Co', stateCode: '27', gstin: null, gstRegistrationType: 'unregistered',
    address: '', booksFrom: fyStartYear, email: null, phone: null, pan: null, tan: null
  })
  await h.relaunch()
  const where = await h.openCompany('YearEnd Co')
  if (where !== 'gateway') throw new Error(`expected gateway, got ${where}`)

  // One sale so the FY has a profit to transfer.
  const ledgers = await h.invoke('master:ledgers:list')
  const cash = ledgers.find((l) => l.name === 'Cash')
  const groups = await h.invoke('master:groups:list')
  const salesGroup = groups.find((g) => g.name === 'Sales Accounts')
  await h.invoke('master:ledgers:create', {
    name: 'YE Sales', groupId: salesGroup.id, openingBalance: 0,
    gstin: null, stateCode: null, address: null, taxType: null, gstRate: null, hsn: null
  })
  const yeSales = (await h.invoke('master:ledgers:list')).find((l) => l.name === 'YE Sales')
  const types = await h.invoke('master:voucherTypes:list')
  const receipt = types.find((t) => t.kind === 'receipt')

  const inFy = `${fyStartYear}-06-15`
  await h.invoke('voucher:save', {
    data: {
      voucherTypeId: receipt.id, date: inFy, partyLedgerId: null,
      narration: 'FY sale', reference: null, instrumentNo: null, instrumentDate: null,
      transporterId: null, vehicleNo: null, transportDistanceKm: null, currencyCode: null, exchangeRate: null,
      lines: [
        { ledgerId: cash.id, drCr: 'dr', amount: 777700 },
        { ledgerId: yeSales.id, drCr: 'cr', amount: 777700 }
      ],
      inventory: []
    }
  })

  const preview = await h.invoke('yearend:preview', { fyStartYear })
  assert(preview && typeof preview === 'object', 'yearend:preview answers')
  const previewText = JSON.stringify(preview)
  assert(previewText.includes('7777') || previewText.includes('777700'), 'preview reflects the FY profit')

  await h.goto('year-end')
  await h.shot('01-year-end-preview')

  const closed = await h.invoke('yearend:close', { fyStartYear })
  assert(closed && typeof closed === 'object', 'yearend:close posted')

  // Books still tie across the FY boundary.
  const fyEnd = `${fyStartYear + 1}-03-31`
  const tb = await h.invoke('report:trialBalance', { asOn: fyEnd })
  assertEq(tb.totalDebit, tb.totalCredit, 'TB ties after year-end close')

  await h.goto('gateway')
  await h.goto('year-end')
  await h.shot('02-year-end-after-close')

  // ---- closing the wrong year is undoable (roadmap #258) ----
  // The close zeroes every income and expense ledger and then locks the books up to 31 March,
  // which locks the closing entry itself: without this, undoing it by hand means lifting the
  // lock, finding one entry among thousands, and hoping the lock date typed back is the one that
  // was there.
  const beforeReverse = await h.invoke('report:trialBalance', { asOn: fyEnd })
  const lockAfterClose = await h.invoke('company:lock:get')
  assertEq(lockAfterClose.date, fyEnd, 'the close locked the books up to 31 March')

  await h.page.waitForSelector('[data-testid="btn-year-end-reverse"]', { timeout: 15000 })
  await h.click('btn-year-end-reverse')
  await h.page.waitForSelector('[data-testid="btn-year-end-reverse"]', { state: 'detached', timeout: 15000 })
  await h.shot('03-year-end-reversed')

  const lockAfterReverse = await h.invoke('company:lock:get')
  assertEq(lockAfterReverse.date, null, 'reversing puts the books lock back where it was')
  const afterReverse = await h.invoke('yearend:preview', { fyStartYear })
  assertEq(afterReverse.alreadyClosed, false, 'and the year is open again')
  const tbAfterReverse = await h.invoke('report:trialBalance', { asOn: fyEnd })
  assertEq(tbAfterReverse.totalDebit, tbAfterReverse.totalCredit, 'the books still tie')
  // The FY's income is back on the income ledger, where the close had moved it to Retained
  // Earnings. Totals alone would not show this: the close moves a balance, it does not create one.
  const closedSales = beforeReverse.rows.find((r) => r.ledgerName === 'YE Sales')
  const reopenedSales = tbAfterReverse.rows.find((r) => r.ledgerName === 'YE Sales')
  assertEq(closedSales === undefined ? 0 : closedSales.credit, 0, 'the close had zeroed the income ledger')
  assertEq(reopenedSales.credit, 777700, 'and reversing put the income back on it')

  // Closing again gives the same answer, which is what "reversed" has to mean.
  const reclosed = await h.invoke('yearend:close', { fyStartYear })
  assertEq(reclosed.netProfit, closed.netProfit, 'closing again reaches the same profit')
})
