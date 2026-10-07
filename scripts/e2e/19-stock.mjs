// Scenario 19 — stock visibility (WP 2.3) on the demo company: a godown transfer through the
// Stock journal screen shows both legs in the movement register (value conserved); a sale of a
// serial-tracked item through the invoice form picks its serial in the line's detail row; the
// reorder report lists an item below its level with max(0, 2R − closing). Screenshots of the new
// screens in both themes (copied to /tmp/wp23 by hand for review).
import { scenario, assert, assertEq } from '../lib/harness.mjs'

await scenario('19-stock', async (h) => {
  await h.createDemoCompany()
  const today = new Date().toISOString().slice(0, 10)

  // ---------- masters: two godowns, a serial-tracked phone with a barcode + reorder level ----------
  const main = await h.invoke('master:godowns:create', { name: 'Main Store' })
  const annex = await h.invoke('master:godowns:create', { name: 'Annex' })
  const unit = (await h.invoke('master:units:list'))[0]
  const phone = await h.invoke('master:stockItems:create', {
    name: 'E2E Phone', groupId: null, unitId: unit.id, hsn: '8517', gstRate: 18, cessRate: null,
    openingQtyMilli: 0, openingValue: 0, barcode: 'PHN-0042', reorderLevelMilli: 10_000, trackSerials: true
  })
  const ledgers = await h.invoke('master:ledgers:list')
  const groups = await h.invoke('master:groups:list')
  const creditor = ledgers.find((l) => groups.find((g) => g.id === l.groupId)?.name === 'Sundry Creditors')
  const purchaseAcc = ledgers.find((l) => groups.find((g) => g.id === l.groupId)?.name === 'Purchase Accounts')
  assert(creditor && purchaseAcc, 'demo company has a creditor and a purchase ledger')
  const types = await h.invoke('master:voucherTypes:list')
  const typeOf = (kind) => types.find((t) => t.kind === kind)
  const blank = {
    partyLedgerId: null, narration: null, reference: null, instrumentNo: null, instrumentDate: null,
    transporterId: null, vehicleNo: null, transportDistanceKm: null, currencyCode: null, exchangeRate: null
  }
  // Purchase 4 phones into Main Store, serials SN-1..SN-4, ₹10,000 each.
  await h.invoke('voucher:save', {
    data: {
      ...blank, voucherTypeId: typeOf('purchase').id, date: today, partyLedgerId: creditor.id, narration: 'E2E phones',
      lines: [
        { ledgerId: creditor.id, drCr: 'cr', amount: 4_000_000 },
        { ledgerId: purchaseAcc.id, drCr: 'dr', amount: 4_000_000 }
      ],
      inventory: [{
        stockItemId: phone.id, godownId: main.id, qtyMilli: 4000, ratePaise: 1_000_000, amount: 4_000_000, direction: 'in',
        serials: ['SN-1', 'SN-2', 'SN-3', 'SN-4']
      }]
    }
  })

  // ---------- godown transfer via the Stock journal screen ----------
  await h.goto('stock-journal')
  await h.page.waitForSelector('[data-testid="rows-stock-transfer"]', { timeout: 10000 })
  const pick = async (testId, text, nth = 0) => {
    const input = h.page.locator(`[data-testid="${testId}"]`).nth(nth)
    await input.click()
    await input.fill(text)
    await h.page.waitForSelector('[role="listbox"] [role="option"]', { timeout: 5000 })
    await input.press('Enter')
  }
  await pick('picker-transfer-item', 'E2E Phone')
  await pick('picker-transfer-from', 'Main Store')
  await pick('picker-transfer-to', 'Annex')
  await h.page.locator('[data-testid="input-transfer-qty"]').first().fill('2')
  // Serial-tracked: the serial picker offers what's in stock.
  await h.page.waitForSelector('[data-testid="serial-pick-SN-1"]', { timeout: 10000 })
  await h.click('serial-pick-SN-1')
  await h.click('serial-pick-SN-2')
  await h.page.waitForFunction(() => document.querySelector('[data-testid="transfer-total"]')?.textContent?.includes('20,000.00'), null, { timeout: 10000 })
  await h.shot('01-stock-journal-transfer-light')
  await h.click('btn-save-transfer')
  await h.page.waitForFunction(() => document.body.innerText.includes('saved'), null, { timeout: 10000 })

  // Value conserved; Annex now holds 2 phones, Main 2.
  const summary = (await h.invoke('stock:summary', { asOn: today })).find((r) => r.stockItemId === phone.id)
  assertEq(summary.closingQtyMilli, 4000, 'company-wide quantity unchanged by the transfer')
  assertEq(summary.closingValue, 4_000_000, 'company-wide value unchanged by the transfer')
  const inAnnex = (await h.invoke('stock:summary', { asOn: today, godownId: annex.id })).find((r) => r.stockItemId === phone.id)
  assertEq(inAnnex.closingQtyMilli, 2000, 'Annex holds the 2 transferred phones')
  const serials = await h.invoke('serials:list', { stockItemId: phone.id })
  assertEq(serials.filter((s) => s.godownName === 'Annex').map((s) => s.serial).join(','), 'SN-1,SN-2', 'transferred serials sit in Annex')

  // ---------- the movement register shows both legs ----------
  await h.goto('stock-movements')
  await pick('picker-movements-item', 'E2E Phone')
  await h.page.waitForSelector('[data-testid="rows-stock-movements"] tr.dt-row', { timeout: 10000 })
  await h.waitIdle()
  const legs = await h.page.$$eval('[data-testid="rows-stock-movements"] tr.dt-row', (trs) => trs.map((tr) => tr.textContent ?? ''))
  assertEq(legs.length, 3, 'purchase + both transfer legs')
  assert(legs.some((t) => t.includes('Main Store') && t.includes('Stock Journal')), 'outward leg from Main Store')
  assert(legs.some((t) => t.includes('Annex') && t.includes('Stock Journal')), 'inward leg into Annex')
  const reg = await h.invoke('stock:register', { itemId: phone.id, from: '2000-01-01', to: today })
  const jLegs = reg.rows.filter((r) => r.kind === 'stock_journal')
  assertEq(jLegs.length, 2, 'register has two journal legs')
  assertEq(jLegs[0].value, jLegs[1].value, 'transfer legs carry the same value')
  assertEq(reg.closing.value, summary.closingValue, 'register closing = stock summary closing')
  await h.shot('02-stock-movements-light')

  // ---------- sale with a serial through the invoice form ----------
  await h.goto('voucher-entry')
  await h.click('tab-voucher-entry-sales')
  await h.page.waitForSelector('[data-testid="rows-invoice-lines"]', { timeout: 10000 })
  const debtor = ledgers.find((l) => groups.find((g) => g.id === l.groupId)?.name === 'Sundry Debtors')
  const salesAcc = ledgers.find((l) => groups.find((g) => g.id === l.groupId)?.name === 'Sales Accounts')
  await pick('picker-party', debtor.name)
  const salesPicker = h.page.locator('input[placeholder="e.g. Sales"]')
  await salesPicker.click()
  await salesPicker.fill(salesAcc.name)
  await h.page.waitForSelector('[role="listbox"] [role="option"]', { timeout: 5000 })
  await salesPicker.press('Enter')
  await pick('picker-item', 'E2E Phone')
  await h.page.locator('[data-testid="input-line-qty"]').first().fill('1')
  await h.page.locator('[data-testid="input-line-rate"]').first().fill('15000')
  await h.page.locator('[data-testid="input-line-rate"]').first().press('Tab')
  // A serial-tracked item opens its line's detail row on its own.
  await h.page.waitForSelector('[data-testid="row-line-detail"] [data-testid="serial-pick-SN-3"]', { timeout: 10000 })
  await h.click('serial-pick-SN-3')
  await h.page.waitForFunction(() => document.querySelector('[data-testid="badge-serial-count"]')?.textContent?.includes('1 of 1'), null, { timeout: 5000 })
  await h.shot('03-sale-serial-light')
  await h.click('btn-save-voucher')
  await h.page.waitForFunction(() => document.body.innerText.includes('saved'), null, { timeout: 10000 })
  const after = await h.invoke('serials:list', { stockItemId: phone.id })
  assertEq(after.find((s) => s.serial === 'SN-3')?.status, 'sold', 'SN-3 sold')
  assertEq(after.filter((s) => s.status === 'in_stock').length, 3, 'three phones left in stock')

  // ---------- reorder report: 3 on hand, level 10 → suggest 17 ----------
  await h.goto('stock-summary')
  await h.click('btn-stock-summary-reorder')
  await h.waitScreen('stock-reports')
  await h.page.waitForSelector(`[data-testid="rows-stock-reorder"] [data-row-id="${phone.id}"]`, { timeout: 10000 })
  const reorderRow = await h.page.$eval(`[data-testid="rows-stock-reorder"] [data-row-id="${phone.id}"]`, (tr) => tr.textContent ?? '')
  assert(reorderRow.includes('17'), `suggested order 17 = 2 × 10 − 3 (row: ${reorderRow})`)
  const plan = (await h.invoke('stock:reorder', { from: '2000-01-01', to: today })).find((r) => r.stockItemId === phone.id)
  assertEq(plan.suggestedMilli, 17_000, 'reorder formula max(0, 2R − closing)')
  await h.shot('04-reorder-light')

  // Labels (preview) and serials tabs render.
  await h.click('tab-stock-reports-labels')
  await h.waitScreen('stock-reports')
  await h.fill(`input-labels-copies-${phone.id}`, '3')
  await h.page.waitForSelector('[data-testid="labels-preview"] iframe', { timeout: 10000 })
  await h.page.waitForTimeout(400)
  await h.shot('05-labels-light')
  await h.click('tab-stock-reports-serials')
  await h.page.waitForSelector('[data-testid="rows-stock-reports-serials"] tr.dt-row', { timeout: 10000 })
  await h.shot('06-serials-light')

  // ---------- dark theme pass over the new screens ----------
  await h.click('btn-theme')
  await h.goto('stock-movements')
  await pick('picker-movements-item', 'E2E Phone')
  await h.page.waitForSelector('[data-testid="rows-stock-movements"] tr.dt-row', { timeout: 10000 })
  await h.waitIdle()
  await h.shot('07-stock-movements-dark')
  await h.goto('stock-journal')
  await pick('picker-transfer-item', 'E2E Phone')
  await pick('picker-transfer-from', 'Annex')
  await pick('picker-transfer-to', 'Main Store')
  await h.page.locator('[data-testid="input-transfer-qty"]').first().fill('1')
  await h.page.waitForTimeout(300)
  await h.shot('08-stock-journal-dark')
  await h.click('stock-journal-mode-adjust')
  await h.page.waitForSelector('[data-testid="rows-stock-lines"]', { timeout: 5000 })
  await h.shot('09-stock-journal-adjust-dark')
  await h.goto('stock-summary')
  await h.click('btn-stock-summary-reorder')
  await h.waitScreen('stock-reports')
  await h.page.waitForSelector(`[data-testid="rows-stock-reorder"] [data-row-id="${phone.id}"]`, { timeout: 10000 })
  await h.shot('10-reorder-dark')
  await h.click('tab-stock-reports-expiry')
  await h.waitIdle()
  await h.shot('11-expiry-dark')
  await h.click('tab-stock-reports-labels')
  await h.fill(`input-labels-copies-${phone.id}`, '2')
  await h.page.waitForSelector('[data-testid="labels-preview"] iframe', { timeout: 10000 })
  await h.page.waitForTimeout(400)
  await h.shot('12-labels-dark')

  // The line detail row in a sales invoice (dark).
  await h.goto('voucher-entry')
  await h.click('tab-voucher-entry-sales')
  await h.page.waitForSelector('[data-testid="rows-invoice-lines"]', { timeout: 10000 })
  await pick('picker-item', 'E2E Phone')
  await h.page.locator('[data-testid="input-line-qty"]').first().fill('1')
  await h.page.waitForSelector('[data-testid="row-line-detail"] [data-testid="serial-pick-SN-4"]', { timeout: 10000 })
  await h.click('serial-pick-SN-4')
  await h.shot('13-sale-serial-dark')
})
