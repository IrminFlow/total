// Scenario 23 — TCS on sales (WP 3.3), driven through the UI: a motor-vehicle sale above ₹10 lakh
// saved WITHOUT TCS shows on the TCS screen's Eligible tab → Move to TCS → Collected lists it, the
// tagged TCS payable ledger carries the credit and the buyer's debit includes it → a second sale
// typed in the invoice form gets the TCS banner, Apply adds "TCS" after GST and the total → the
// deposit (a payment voucher) becomes a challan with both collections allocated → Returns shows
// the Form 143 / 27EQ collectee rows and exports the CSV → deleting a collection leaves the sale
// balanced.
import { scenario, assert, assertEq } from '../lib/harness.mjs'

await scenario('23-tcs', async (h) => {
  await h.createCompanyUI('TCS Motors')
  await h.stubDialogs()
  const page = h.page
  const today = await page.evaluate(() => {
    const d = new Date()
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  })
  const features = await h.invoke('config:features:get')
  assert(features.tcs === true, 'TCS feature on by default')
  const groups = await h.invoke('master:groups:list')
  const groupId = (name) => groups.find((g) => g.name === name).id
  const types = await h.invoke('master:voucherTypes:list')
  const typeOf = (kind) => types.find((t) => t.kind === kind)
  const vehicle = (await h.invoke('tcs:sections')).find((s) => s.code === '206C(1F) VEHICLE')
  assert(vehicle, 'the 206C(1F) motor-vehicle section is seeded')
  const mkLedger = (name, group, extra = {}) =>
    h.invoke('master:ledgers:create', {
      name, groupId: groupId(group), openingBalance: 0, gstin: null, stateCode: null, address: null,
      taxType: null, gstRate: null, hsn: null, ...extra
    })
  const buyer = await mkLedger('E2E Car Buyer', 'Sundry Debtors', { pan: 'ABCPK1234L', tcsSectionId: vehicle.id })
  const dealer = await mkLedger('E2E Car Maker', 'Sundry Creditors')
  const sales = await mkLedger('E2E Vehicle Sales', 'Sales Accounts')
  const purchases = await mkLedger('E2E Vehicle Purchases', 'Purchase Accounts')
  const cgst = await mkLedger('E2E CGST', 'Duties & Taxes', { taxType: 'cgst' })
  const sgst = await mkLedger('E2E SGST', 'Duties & Taxes', { taxType: 'sgst' })
  const bank = await mkLedger('E2E Bank', 'Bank Accounts')
  const unit = (await h.invoke('master:units:list'))[0]
  const car = await h.invoke('master:stockItems:create', {
    name: 'E2E Sedan', groupId: null, unitId: unit.id, hsn: '8703', gstRate: 18, cessRate: null,
    openingQtyMilli: 0, openingValue: 0, barcode: null, reorderLevelMilli: null
  })
  await h.invoke('voucher:save', {
    data: {
      voucherTypeId: typeOf('purchase').id, date: today, partyLedgerId: dealer.id,
      lines: [{ ledgerId: purchases.id, drCr: 'dr', amount: 180000000 }, { ledgerId: dealer.id, drCr: 'cr', amount: 180000000 }],
      inventory: [{ stockItemId: car.id, godownId: null, qtyMilli: 2000, ratePaise: 90000000, amount: 180000000, direction: 'in' }]
    }
  })

  const waitText = (selector, needle, timeout = 10000) =>
    page.waitForFunction(([s, n]) => (document.querySelector(s)?.textContent ?? '').includes(n), [selector, needle], { timeout })
  const balanced = (v) => {
    const dr = v.lines.filter((l) => l.drCr === 'dr').reduce((s, l) => s + l.amount, 0)
    const cr = v.lines.filter((l) => l.drCr === 'cr').reduce((s, l) => s + l.amount, 0)
    return dr === cr && dr > 0
  }

  // ---------- a ₹10.5 lakh (+ GST = ₹12,39,000) car sold without TCS ----------
  const sale = await h.invoke('voucher:save', {
    data: {
      voucherTypeId: typeOf('sales').id, date: today, partyLedgerId: buyer.id, narration: 'Sedan, no TCS',
      lines: [
        { ledgerId: buyer.id, drCr: 'dr', amount: 123900000 }, { ledgerId: sales.id, drCr: 'cr', amount: 105000000 },
        { ledgerId: cgst.id, drCr: 'cr', amount: 9450000 }, { ledgerId: sgst.id, drCr: 'cr', amount: 9450000 }
      ],
      inventory: [{ stockItemId: car.id, godownId: null, qtyMilli: 1000, ratePaise: 105000000, amount: 105000000, direction: 'out' }],
      billRefs: [{ kind: 'new', name: 'CAR-1', amount: 123900000, dueDate: null }]
    }
  })
  assertEq(sale.tcs ?? null, null, 'saved without TCS')

  await h.goto('tcs')
  await page.waitForSelector('[data-testid="rows-tcs-eligible"] tr.dt-row', { timeout: 15000 })
  await waitText('[data-testid="rows-tcs-eligible"]', 'E2E Car Buyer')
  const eligibleText = await page.textContent('[data-testid="rows-tcs-eligible"]')
  assert(/206C\(1F\) VEHICLE/.test(eligibleText) && /12,390\.00/.test(eligibleText), `Eligible suggests ₹12,390 (1% of ₹12,39,000) (got: ${eligibleText})`)
  assert(/Single sale above the limit/.test(eligibleText), 'reason: single sale above the ₹10 lakh limit')
  await h.shot('01-eligible')

  // ---------- Move to TCS ----------
  await h.click(`btn-tcs-move-${sale.id}`)
  await page.waitForFunction(() => !document.querySelector('[data-testid="rows-tcs-eligible"] tr.dt-row'), null, { timeout: 15000 })
  const moved = await h.invoke('voucher:get', { id: sale.id })
  assertEq(moved.tcs && moved.tcs.tcsAmount, 1239000, 'the sale now carries ₹12,390 TCS')
  assert(balanced(moved), 'the sale still balances')
  assertEq(moved.lines.find((l) => l.ledgerId === buyer.id).amount, 123900000 + 1239000, "the buyer's debit includes the TCS")
  assertEq(moved.billRefs[0].amount, 123900000 + 1239000, 'and so does the bill')
  const payable = (await h.invoke('master:ledgers:list')).find((l) => l.tcsPayableSectionId === vehicle.id)
  assert(payable && payable.name === 'TCS Payable 206C(1F) VEHICLE', 'the tagged TCS payable ledger was created')
  const last = moved.lines[moved.lines.length - 1]
  assert(last.ledgerId === payable.id && last.drCr === 'cr' && last.amount === 1239000, 'TCS payable credited ₹12,390 (last line)')
  await waitText('[data-testid="rows-tcs-summary"]', '12,390.00')

  await h.click('tab-tcs-deducted')
  await page.waitForSelector('[data-testid="rows-tcs-deducted"] tr.dt-row', { timeout: 10000 })
  const collectedText = await page.textContent('[data-testid="rows-tcs-deducted"]')
  assert(/E2E Car Buyer/.test(collectedText) && /12,390\.00/.test(collectedText) && /Not on a challan/.test(collectedText), `Collected lists it (got: ${collectedText})`)
  await h.shot('02-collected')

  // ---------- a second sale typed in the invoice form: the TCS banner ----------
  await h.goto('voucher-entry')
  await h.click('tab-voucher-entry-sales')
  await page.waitForSelector('[data-testid="rows-invoice-lines"]', { timeout: 10000 })
  const pick = async (testId, text) => {
    const input = page.locator(`[data-testid="${testId}"]`).first()
    await input.click()
    await input.fill(text)
    await page.waitForSelector('[role="listbox"] [role="option"]', { timeout: 5000 })
    await input.press('Enter')
  }
  await pick('picker-party', 'E2E Car Buyer')
  const salesPicker = page.locator('input[placeholder="e.g. Sales"]')
  await salesPicker.click()
  await salesPicker.fill('E2E Vehicle Sales')
  await page.waitForSelector('[role="listbox"] [role="option"]', { timeout: 5000 })
  await salesPicker.press('Enter')
  await pick('picker-item', 'E2E Sedan')
  await page.locator('[data-testid="input-line-qty"]').first().fill('1')
  await page.locator('[data-testid="input-line-rate"]').first().fill('1100000')
  await page.locator('[data-testid="input-line-rate"]').first().press('Tab')
  await page.waitForSelector('[data-testid="banner-tcs"]', { timeout: 10000 })
  const bannerText = await page.textContent('[data-testid="banner-tcs"]')
  assert(/TCS u\/s 206C\(1F\) VEHICLE/.test(bannerText) && /12,980\.00/.test(bannerText), `banner: 1% of ₹12,98,000 (got: ${bannerText})`)
  await h.shot('03-invoice-banner')
  await h.click('btn-tcs-apply')
  await page.waitForSelector('[data-testid="invoice-tcs-summary"]', { timeout: 5000 })
  assert(/12,980\.00/.test(await page.textContent('[data-testid="invoice-tcs-summary"]')), 'TCS line after GST in the totals')
  await h.shot('04-invoice-tcs-applied')
  await h.click('btn-save-voucher')
  await page.waitForFunction(() => document.body.innerText.includes('saved'), null, { timeout: 10000 })
  const collected = await h.invoke('tcs:deducted', { from: today, to: today })
  assertEq(collected.length, 2, 'two collections')
  const typed = await h.invoke('voucher:get', { id: collected.find((c) => c.voucherId !== sale.id).voucherId })
  assertEq(typed.tcs.tcsAmount, 1298000, 'the typed invoice carries ₹12,980 TCS')
  assertEq(typed.lines[0].amount, 129800000 + 1298000, 'the buyer is debited the invoice total plus TCS')
  assertEq(typed.lines[typed.lines.length - 1].ledgerId, payable.id, 'its TCS payable credit is the last line')

  // ---------- the deposit, then a challan from it ----------
  const deposit = await h.invoke('voucher:save', {
    data: {
      voucherTypeId: typeOf('payment').id, date: today, narration: 'ITNS 281 — TCS',
      lines: [{ ledgerId: payable.id, drCr: 'dr', amount: 2537000 }, { ledgerId: bank.id, drCr: 'cr', amount: 2537000 }]
    }
  })
  await h.goto('tcs')
  await h.click('tab-tcs-challans')
  await h.click('btn-tcs-challan-new')
  await page.waitForSelector('[data-testid="select-tcs-challan-payment"]', { timeout: 10000 })
  assertEq(await page.locator('[data-testid="select-tcs-challan-payment"]').inputValue(), String(deposit.id), 'the deposit is offered')
  await h.fill('input-tcs-challan-bsr', '0510308')
  await h.fill('input-tcs-challan-no', '77')
  await h.click('btn-tcs-challan-create')
  await page.waitForSelector('[data-testid="rows-tcs-challans"] tr.dt-row', { timeout: 10000 })
  const challanText = await page.textContent('[data-testid="rows-tcs-challans"]')
  assert(/77/.test(challanText) && /0510308/.test(challanText) && /25,370\.00/.test(challanText), `challan listed (got: ${challanText})`)
  const after = await h.invoke('tcs:deducted', { from: today, to: today })
  assert(after.every((e) => e.challanStatus === 'paid'), 'both collections are allocated to the paid challan')
  assertEq((await h.invoke('tds:challanRows', { fyStartYear: Number(today.slice(0, 4)) - (Number(today.slice(5, 7)) < 4 ? 1 : 0) })).length, 0, 'no TDS challan was created')
  await h.shot('05-challans')

  // ---------- Returns ----------
  await h.click('tab-tcs-returns')
  await page.waitForSelector('[data-testid="rows-tcs-26q"] tr.dt-row', { timeout: 10000 })
  const q = await page.textContent('[data-testid="rows-tcs-26q"]')
  assert(/E2E Car Buyer/.test(q) && /ABCPK1234L/.test(q) && /12,390\.00/.test(q) && /12,980\.00/.test(q), `27EQ / Form 143 collectee rows (got: ${q})`)
  await waitText('[data-testid="rows-tcs-26q-challans"]', '0510308')
  await page.waitForSelector('[data-testid="rows-tcs-16a"] tr.dt-row', { timeout: 10000 })
  await h.click('btn-tcs-export')
  await h.shot('06-returns')

  // ---------- delete a collection: the sale balances, it is eligible again ----------
  await h.click('tab-tcs-deducted')
  await page.waitForSelector('[data-testid="rows-tcs-deducted"] tr.dt-row', { timeout: 10000 })
  const first = after.find((e) => e.voucherId === sale.id)
  await h.click(`btn-tcs-delete-${first.entryId}`)
  await h.click('confirm-ok')
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="rows-tcs-deducted"] tr.dt-row').length === 1, null, { timeout: 15000 })
  const back = await h.invoke('voucher:get', { id: sale.id })
  assertEq(back.tcs, null, 'collection removed')
  assert(balanced(back), 'the sale balances after the delete')
  assertEq(back.lines.find((l) => l.ledgerId === buyer.id).amount, 123900000, "the buyer's debit is back to the invoice total")
  await h.click('tab-tcs-eligible')
  await waitText('[data-testid="rows-tcs-eligible"]', 'E2E Car Buyer')
  await h.shot('07-eligible-again')

  // ---------- dark theme pass ----------
  await h.click('btn-theme')
  await page.waitForFunction(() => document.documentElement.getAttribute('data-theme') === 'dark', null, { timeout: 5000 })
  await h.shot('08-eligible-dark')
  await h.click('tab-tcs-returns')
  await page.waitForSelector('[data-testid="rows-tcs-26q"] tr.dt-row', { timeout: 10000 })
  await h.shot('09-returns-dark')
  await h.click('tab-tcs-sections')
  await page.waitForSelector('[data-testid="rows-tcs-sections"] tr.dt-row', { timeout: 10000 })
  await h.shot('10-sections-dark')
  await h.goto('voucher-entry')
  await h.click('tab-voucher-entry-sales')
  await page.waitForSelector('[data-testid="rows-invoice-lines"]', { timeout: 10000 })
  await pick('picker-party', 'E2E Car Buyer')
  await salesPicker.click()
  await salesPicker.fill('E2E Vehicle Sales')
  await page.waitForSelector('[role="listbox"] [role="option"]', { timeout: 5000 })
  await salesPicker.press('Enter')
  await pick('picker-item', 'E2E Sedan')
  await page.locator('[data-testid="input-line-qty"]').first().fill('1')
  await page.locator('[data-testid="input-line-rate"]').first().fill('1050000')
  await page.locator('[data-testid="input-line-rate"]').first().press('Tab')
  await page.waitForSelector('[data-testid="banner-tcs"]', { timeout: 10000 })
  await h.shot('11-invoice-banner-dark')
  await h.click('btn-tcs-apply')
  await page.waitForSelector('[data-testid="invoice-tcs-summary"]', { timeout: 5000 })
  await h.shot('12-invoice-tcs-dark')
  // Save it, so closing the app doesn't raise the unsaved-changes prompt.
  await h.click('btn-save-voucher')
  await page.waitForFunction(() => document.body.innerText.includes('3 saved'), null, { timeout: 10000 })
  assertEq((await h.invoke('tcs:deducted', { from: today, to: today })).length, 2, 'the third sale collected too (the first one was deleted)')
})
