// Scenario 03 — voucher lifecycle with trial-balance tie-outs: save → TB ties → visible in
// Day Book (testid rows) → delete → bin → restore → TB ties again.
//
// Voucher creation goes through voucher:save (the same zod+posting path the UI uses);
// the UI-typed entry flow lands with lane S1's VoucherEntry split.
// RECONCILE: after merge, consider driving one voucher through the invoice form itself
// (picker-party / rows-invoice-lines / btn-save-voucher).
import { scenario, assert, assertEq } from '../lib/harness.mjs'

await scenario('03-voucher-lifecycle', async (h) => {
  await h.createCompanyUI('Lifecycle Books')

  const ledgers = await h.invoke('master:ledgers:list')
  const cash = ledgers.find((l) => l.name === 'Cash')
  assert(cash, "seeded 'Cash' ledger")
  const groups = await h.invoke('master:groups:list')
  const sales = groups.find((g) => g.name === 'Sales Accounts')
  await h.invoke('master:ledgers:create', {
    name: 'E2E Sales', groupId: sales.id, openingBalance: 0,
    gstin: null, stateCode: null, address: null, taxType: null, gstRate: null, hsn: null
  })
  const salesLedger = (await h.invoke('master:ledgers:list')).find((l) => l.name === 'E2E Sales')

  const types = await h.invoke('master:voucherTypes:list')
  const receipt = types.find((t) => t.kind === 'receipt')
  const today = new Date().toISOString().slice(0, 10)

  const saved = await h.invoke('voucher:save', {
    data: {
      voucherTypeId: receipt.id, date: today, partyLedgerId: null,
      narration: 'E2E lifecycle receipt', reference: null, instrumentNo: null, instrumentDate: null,
      transporterId: null, vehicleNo: null, transportDistanceKm: null, currencyCode: null, exchangeRate: null,
      lines: [
        { ledgerId: cash.id, drCr: 'dr', amount: 123400 },
        { ledgerId: salesLedger.id, drCr: 'cr', amount: 123400 }
      ],
      inventory: []
    }
  })
  assert(typeof saved.id === 'number', 'voucher:save returned an id')

  // TB tie-out #1.
  const tb1 = await h.invoke('report:trialBalance', { asOn: today })
  assertEq(tb1.totalDebit, 123400, 'TB totalDebit after save')
  assertEq(tb1.totalCredit, 123400, 'TB totalCredit after save')

  // Visible in Day Book, addressable by its data-row-id.
  await h.goto('daybook')
  await h.page.waitForSelector(`[data-testid="rows-daybook"] [data-row-id="${saved.id}"]`, { timeout: 10000 })
  await h.shot('01-daybook-row')

  // Delete → lands in the bin, TB back to zero.
  await h.invoke('voucher:delete', { id: saved.id })
  const bin = await h.invoke('voucher:bin')
  assertEq(bin.length, 1, 'bin holds the deleted voucher')
  const tb2 = await h.invoke('report:trialBalance', { asOn: today })
  assertEq(tb2.totalDebit, 0, 'TB totalDebit after delete')

  // The Day Book no longer shows it (re-navigate so the scoped invalidation refetches; the
  // refetch may start a beat after data-loading flips, so wait for the row to detach).
  await h.goto('gateway')
  await h.goto('daybook')
  await h.page.waitForSelector(`[data-testid="rows-daybook"] [data-row-id="${saved.id}"]`, {
    state: 'detached',
    timeout: 10000
  })

  // Restore → TB ties again.
  await h.invoke('voucher:restore', { id: saved.id })
  const tb3 = await h.invoke('report:trialBalance', { asOn: today })
  assertEq(tb3.totalDebit, 123400, 'TB totalDebit after restore')
  assertEq(tb3.totalCredit, 123400, 'TB totalCredit after restore')
  await h.goto('gateway')
  await h.goto('daybook')
  await h.page.waitForSelector(`[data-testid="rows-daybook"] [data-row-id="${saved.id}"]`, { timeout: 10000 })

  // ---------- WP 1.4: alterations open in the mode that creates the voucher ----------
  const groupId = (name) => groups.find((g) => g.name === name).id
  const mkLedger = async (name, group, extra = {}) =>
    h.invoke('master:ledgers:create', {
      name, groupId: groupId(group), openingBalance: 0, gstin: null, stateCode: null, address: null,
      taxType: null, gstRate: null, hsn: null, ...extra
    })
  const buyer = await mkLedger('E2E Buyer', 'Sundry Debtors')
  const cgst = await mkLedger('CGST', 'Duties & Taxes', { taxType: 'cgst' })
  const sgst = await mkLedger('SGST', 'Duties & Taxes', { taxType: 'sgst' })
  const unit = (await h.invoke('master:units:list'))[0]
  const mkItem = (name, opening) =>
    h.invoke('master:stockItems:create', {
      name, groupId: null, unitId: unit.id, hsn: '8471', gstRate: 18, cessRate: null,
      openingQtyMilli: opening, openingValue: opening * 10, barcode: null, reorderLevelMilli: null
    })
  const widget = await mkItem('E2E Widget', 100_000)
  const steel = await mkItem('E2E Steel', 100_000)
  const chair = await mkItem('E2E Chair', 0)
  await h.invoke('bom:set', { itemId: chair.id, lines: [{ componentId: steel.id, qtyMilliPerUnit: 2000 }] })
  const typeOf = (kind) => types.find((t) => t.kind === kind)
  const blankHeader = {
    partyLedgerId: null, narration: null, reference: null, instrumentNo: null, instrumentDate: null,
    transporterId: null, vehicleNo: null, transportDistanceKm: null, currencyCode: null, exchangeRate: null
  }

  // Sales invoice, exactly as the invoice form posts it: 2 × ₹500 − ₹100 discount = ₹900 taxable,
  // CGST/SGST 9% each → ₹1,062.
  const inv = await h.invoke('voucher:save', {
    data: {
      ...blankHeader, voucherTypeId: typeOf('sales').id, date: today, partyLedgerId: buyer.id, narration: 'E2E invoice',
      lines: [
        { ledgerId: buyer.id, drCr: 'dr', amount: 106200 },
        { ledgerId: salesLedger.id, drCr: 'cr', amount: 90000 },
        { ledgerId: cgst.id, drCr: 'cr', amount: 8100 },
        { ledgerId: sgst.id, drCr: 'cr', amount: 8100 }
      ],
      inventory: [{ stockItemId: widget.id, godownId: null, qtyMilli: 2000, ratePaise: 50000, discountPaise: 10000, amount: 90000, direction: 'out' }]
    }
  })

  const openFromDaybook = async (id, mode) => {
    await h.goto('gateway')
    await h.goto('daybook')
    await h.page.click(`[data-testid="rows-daybook"] [data-row-id="${id}"]`, { timeout: 10000 })
    await h.waitScreen('voucher-entry')
    const el = await h.page.waitForSelector('[data-testid="voucher-entry-mode"]', { timeout: 10000 })
    const banner = await h.page.$eval('[data-testid^="banner-"][data-testid$="-fallback"]', (b) => b.textContent).catch(() => '')
    assertEq(await el.getAttribute('data-mode'), mode, `voucher ${id} opens in ${mode} mode ${banner}`)
  }

  await openFromDaybook(inv.id, 'invoice')
  const qtyInput = h.page.locator('[data-testid="input-line-qty"]').first()
  assertEq(await qtyInput.inputValue(), '2', 'reopened invoice shows its quantity')
  assertEq(await h.page.locator('[data-testid="input-line-discount"]').first().inputValue(), '100.00', 'reopened invoice shows its discount')
  assertEq(await h.page.locator('[data-testid="input-line-rate"]').first().inputValue(), '500.00', 'reopened invoice shows its rate')
  await h.shot('02-invoice-reopened')
  await qtyInput.fill('3')
  await h.click('btn-save-voucher')
  await h.waitScreen('daybook')
  const altered = await h.invoke('voucher:get', { id: inv.id })
  // 3 × ₹500 − ₹100 = ₹1,400 taxable; CGST/SGST ₹126 each → ₹1,652.
  assertEq(altered.number, inv.number, 'alteration keeps the invoice number')
  assertEq(altered.inventory[0].qtyMilli, 3000, 'altered quantity')
  assertEq(altered.inventory[0].discountPaise, 10000, 'discount survives the alteration')
  assertEq(altered.inventory[0].amount, 140000, 'line amount = qty × rate − discount')
  assertEq(altered.lines.find((l) => l.ledgerId === buyer.id).amount, 165200, 'party total after alteration')
  assertEq(altered.lines.find((l) => l.ledgerId === cgst.id).amount, 12600, 'CGST after alteration')
  const sideTotal = (side) => altered.lines.filter((l) => l.drCr === side).reduce((s, l) => s + l.amount, 0)
  assertEq(sideTotal('cr'), sideTotal('dr'), 'altered invoice balances')

  // Legacy stock journal (no manufacture_details row — saved before 0.6.0, or imported): opens
  // as plain stock lines with the "costed at the saved amounts" banner (WP 2.2), never in the
  // Manufacture form; the alteration keeps every stored field. (17-manufacture covers the form.)
  const sj = await h.invoke('voucher:save', {
    data: {
      ...blankHeader, voucherTypeId: typeOf('stock_journal').id, date: today, narration: 'Manufactured 2 × E2E Chair',
      lines: [],
      inventory: [
        { stockItemId: steel.id, godownId: null, qtyMilli: 4000, ratePaise: 15000, amount: 60000, direction: 'out' },
        { stockItemId: chair.id, godownId: null, qtyMilli: 2000, ratePaise: 30000, amount: 60000, direction: 'in' }
      ]
    }
  })
  await openFromDaybook(sj.id, 'stockLines')
  const legacyBanner = await h.page.waitForSelector('[data-testid="banner-stock-lines-legacy"]', { timeout: 10000 })
  assert((await legacyBanner.textContent()).includes('Created before 0.6.0'), 'legacy stock journal banner')
  await h.page.locator('[data-testid="input-stock-line-qty"]').first().fill('6')
  await h.click('btn-save-stock-lines')
  await h.waitScreen('daybook')
  const sj2 = await h.invoke('voucher:get', { id: sj.id })
  assertEq(JSON.stringify(sj2.inventory.map((l) => [l.stockItemId, l.qtyMilli, l.ratePaise, l.amount, l.direction])),
    JSON.stringify([[steel.id, 6000, 15000, 90000, 'out'], [chair.id, 2000, 30000, 60000, 'in']]), 'legacy stock journal altered line by line')
  assertEq(sj2.narration, 'Manufactured 2 × E2E Chair', 'legacy narration kept')

  // Physical stock: count 50 Steel → re-count 40.
  const ps = await h.invoke('voucher:save', {
    data: {
      ...blankHeader, voucherTypeId: typeOf('physical_stock').id, date: today, narration: 'E2E count',
      lines: [],
      inventory: [{ stockItemId: steel.id, godownId: null, qtyMilli: 50_000, ratePaise: 0, amount: 0, direction: 'in', isAbsolute: true }]
    }
  })
  await openFromDaybook(ps.id, 'physical')
  const counted = h.page.locator('[data-testid="input-counted-qty"]').first()
  assertEq(await counted.inputValue(), '50', 'reopened count shows the counted quantity')
  await counted.fill('40')
  await h.click('btn-save-physical')
  await h.waitScreen('daybook')
  const ps2 = await h.invoke('voucher:get', { id: ps.id })
  assertEq(ps2.inventory.length, 1, 'physical stock keeps one line')
  assertEq(ps2.inventory[0].qtyMilli, 40_000, 'altered count')
  assertEq(ps2.inventory[0].isAbsolute, true, 'still a physical-count line')
})
