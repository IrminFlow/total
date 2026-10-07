// Scenario 28 — returns, linked documents and the trade-cycle reports (WP 2.5d), on the demo
// company with Orders & challans on:
//   a sales invoice (10 @ ₹150, stock leaves at ₹100) → Ctrl+F8 credit note → "Against invoice…"
//   picks the invoice whole, 2 returned with a reason → the invoice can't be over-returned → the
//   Linked documents drawer (from the credit note's header and the Day book) shows both → stock
//   comes back at the engine cost (₹100, not the ₹150 sale value) → the returns register lists it
//   with the reason;
//   then, for the reports: PO → GRN @ ₹100 → bill @ ₹110 for part (three-way match: rate variance
//   + billed in part), a pending challan and the GRN's unbilled rest (GRNI / GDNI and the year-end
//   warning), an expired quotation (stale documents, bulk close), a large SO (demand vs stock),
//   the order book, lead time, and a challan short-close / reopen.
// With WP25D_SHOTS set, every new screen is captured in both themes there.
import * as fs from 'node:fs'
import * as path from 'node:path'
import { scenario, assert, assertEq } from '../lib/harness.mjs'

await scenario('28-trade-returns', async (h) => {
  await h.createDemoCompany()
  const features = await h.invoke('config:features:get')
  await h.invoke('config:features:set', { ...features, inventory: true, orders: true })
  // Books start a year back, so last FY is a completed (closeable) year for the year-end check.
  const now = new Date()
  const currentFyStart = now.getMonth() >= 3 ? now.getFullYear() : now.getFullYear() - 1
  const { info } = await h.invoke('company:current')
  await h.invoke('company:updateInfo', { ...info, booksFrom: Math.min(info.booksFrom, currentFyStart - 1) })
  await h.relaunch()
  assertEq(await h.openCompany('Demo Traders'), 'gateway', 'demo company reopens')
  const page = h.page

  const shotsDir = process.env.WP25D_SHOTS
  if (shotsDir) fs.mkdirSync(shotsDir, { recursive: true })
  const theme = () => page.evaluate(() => document.documentElement.dataset.theme ?? 'light')
  const both = async (name) => {
    await h.shot(name)
    if (!shotsDir) return
    for (const want of ['light', 'dark']) {
      if ((await theme()) !== want) await page.evaluate(() => document.querySelector('[data-testid="btn-theme"]')?.click())
      await page.waitForTimeout(250)
      await page.screenshot({ path: path.join(shotsDir, `${name}-${want}.png`) })
    }
    if ((await theme()) !== 'light') await page.evaluate(() => document.querySelector('[data-testid="btn-theme"]')?.click())
  }

  // ---------- masters ----------
  const unit = (await h.invoke('master:units:list'))[0]
  const gear = await h.invoke('master:stockItems:create', {
    name: 'E2E Gear', groupId: null, unitId: unit.id, hsn: '8483', gstRate: 18, cessRate: null,
    openingQtyMilli: 50_000, openingValue: 500_000, barcode: null, reorderLevelMilli: null // 50 @ ₹100
  })
  const ledgers = await h.invoke('master:ledgers:list')
  const groups = await h.invoke('master:groups:list')
  const inGroup = (name) => ledgers.find((l) => groups.find((g) => g.id === l.groupId)?.name === name)
  const debtor = inGroup('Sundry Debtors')
  const creditor = inGroup('Sundry Creditors')
  const salesAcc = inGroup('Sales Accounts')
  const purchaseAcc = inGroup('Purchase Accounts')
  assert(debtor && creditor && salesAcc && purchaseAcc, 'demo company has the parties and accounts')
  const types = await h.invoke('master:voucherTypes:list')
  const typeOf = (kind) => types.find((t) => t.kind === kind)
  const docTypes = await h.invoke('tradeDocTypes:list')
  const docTypeOf = (kind) => docTypes.find((t) => t.kind === kind)
  const FAR = '2099-12-31'
  const stockOf = async () => (await h.invoke('stock:summary', { asOn: FAR })).find((r) => r.stockItemId === gear.id)
  const list = async (kind) => h.invoke('voucher:list', { from: '2000-01-01', to: FAR, voucherTypeId: typeOf(kind).id })
  const saved = async (kind, n) => {
    await page.waitForFunction(
      async ([id, want]) => {
        const r = await window.total.invoke('voucher:list', { from: '2000-01-01', to: '2099-12-31', voucherTypeId: id })
        return r.ok && r.data.length === want
      },
      [typeOf(kind).id, n],
      { timeout: 10000, polling: 200 }
    )
  }
  const pick = async (testId, text, nth = 0) => {
    const input = page.locator(`[data-testid="${testId}"]`).nth(nth)
    await input.click()
    await input.fill(text)
    await page.waitForSelector('[role="listbox"] [role="option"]', { timeout: 5000 })
    await input.press('Enter')
  }
  const pickAccount = async (placeholder, name) => {
    const input = page.locator(`input[placeholder="${placeholder}"]`)
    await input.click()
    await input.fill(name)
    await page.waitForSelector('[role="listbox"] [role="option"]', { timeout: 5000 })
    await input.press('Enter')
  }
  const idOf = (v) => v.voucherId ?? v.id

  // ---------- 1. the invoice ----------
  await h.goto('voucher-entry')
  await h.click('tab-voucher-entry-sales')
  await page.waitForSelector('[data-testid="rows-invoice-lines"]', { timeout: 10000 })
  await pick('picker-party', debtor.name)
  await pickAccount('e.g. Sales', salesAcc.name)
  await pick('picker-item', 'E2E Gear')
  await page.locator('[data-testid="input-line-qty"]').first().fill('10')
  await page.locator('[data-testid="input-line-rate"]').first().fill('150')
  await page.locator('[data-testid="input-line-rate"]').first().press('Tab')
  const salesBefore = (await list('sales')).length
  await h.click('btn-save-voucher')
  await saved('sales', salesBefore + 1)
  const invoice = (await list('sales')).at(-1)
  const invoiceId = idOf(invoice)
  const afterSale = await stockOf()
  assertEq(afterSale.closingQtyMilli, 40_000, 'the invoice took 10 out')
  assertEq(afterSale.closingValue, 400_000, 'at ₹100 each')

  // ---------- 2. Ctrl+F8 → credit note, "Against invoice…" ----------
  await h.goto('voucher-entry')
  await page.waitForSelector('[data-testid="tab-voucher-entry-sales"]', { timeout: 10000 })
  await page.keyboard.press('Control+F8')
  await page.waitForSelector('[data-testid="tab-voucher-entry-credit_note"][aria-selected="true"]', { timeout: 5000 })
  await page.waitForSelector('[data-testid="rows-invoice-lines"]', { timeout: 10000 })
  await pick('picker-party', debtor.name)
  await pickAccount('e.g. Sales', salesAcc.name)
  await h.click('btn-add-from')
  await page.waitForSelector('[data-testid="drawer-add-from"] [data-testid="input-add-from-against"]', { timeout: 10000 })
  const option = await page.locator('[data-testid="input-add-from-against"] option', { hasText: invoice.number }).first().getAttribute('value')
  await page.selectOption('[data-testid="input-add-from-against"]', option)
  const qty = page.locator('[data-testid="drawer-add-from"] [data-testid="input-add-from-qty"]').first()
  assertEq(await qty.inputValue(), '10', 'picking the invoice fills its returnable quantity')
  await qty.fill('25')
  assertEq(await qty.inputValue(), '10', 'a return is capped at what was sold')
  await qty.fill('2')
  await page.fill('[data-testid="input-add-from-reason"]', 'Damaged in transit')
  await both('01-against-invoice-picker')
  await h.click('btn-add-from-insert')
  await page.waitForSelector('[data-testid="chip-line-source"]', { timeout: 5000 })
  assert((await page.locator('[data-testid="chip-line-source"]').first().textContent()).includes('against'), 'the row is a return against the invoice')
  await page.locator('[data-testid="input-line-rate"]').first().press('Tab')
  await both('02-credit-note-against-invoice')
  const cnBefore = (await list('credit_note')).length
  await h.click('btn-save-voucher')
  await saved('credit_note', cnBefore + 1)
  const cn = (await list('credit_note')).at(-1)
  const cnId = idOf(cn)
  const cnFull = await h.invoke('voucher:get', { id: cnId })
  assertEq(cnFull.narration, 'Damaged in transit', 'the reason went to the narration')
  assertEq(cnFull.inventory[0].source.linkType, 'return', 'the credit note line returns the invoice line')

  // Stock back at the engine cost (₹100), not the sale value (₹150).
  const afterReturn = await stockOf()
  assertEq(afterReturn.closingQtyMilli, 42_000, '2 came back')
  assertEq(afterReturn.closingValue, 420_000, 'at the cost they left at')
  // Never more than sold: 8 left to return; 9 is refused by the server.
  const open = await h.invoke('links:openSourceLines', { partyLedgerId: debtor.id, targetKind: 'credit_note', linkType: 'return' })
  assertEq(open.find((l) => l.voucherId === invoiceId)?.pendingMilli, 8000, '8 still returnable')

  // ---------- 3. linked documents ----------
  await h.goto('daybook')
  await page.waitForSelector(`[data-testid="rows-daybook"] tr[data-row-id="${cnId}"]`, { timeout: 10000 })
  await page.locator(`[data-testid="rows-daybook"] tr[data-row-id="${cnId}"] [data-testid="btn-daybook-links"]`).click()
  await page.waitForSelector('[data-testid="drawer-linked-docs"] [data-testid="chain-node"]', { timeout: 10000 })
  const keys = await page.locator('[data-testid="drawer-linked-docs"] [data-testid="chain-node"]').evaluateAll((ns) =>
    ns.map((n) => [n.getAttribute('data-key'), n.getAttribute('data-status'), n.getAttribute('data-root')])
  )
  assertEq(JSON.stringify(keys), JSON.stringify([[`v${invoiceId}`, 'partly_returned', null], [`v${cnId}`, 'posted', 'true']]), 'the chain shows the invoice and the credit note')
  await both('03-linked-documents-from-daybook')
  await page.keyboard.press('Escape')
  await page.waitForSelector('[data-testid="drawer-linked-docs"]', { state: 'detached', timeout: 5000 })
  // From the invoice's own header (⌥L).
  await page.locator(`[data-testid="rows-daybook"] tr[data-row-id="${invoiceId}"]`).click()
  await h.waitScreen('voucher-entry', 20000)
  await page.waitForSelector('[data-testid="btn-linked-docs"]', { timeout: 10000 })
  await page.keyboard.press('Alt+KeyL')
  await page.waitForSelector('[data-testid="drawer-linked-docs"] [data-root="true"]', { timeout: 10000 })
  assertEq(await page.getAttribute('[data-testid="drawer-linked-docs"] [data-root="true"]', 'data-key'), `v${invoiceId}`, 'opened on the invoice')
  await page.keyboard.press('Escape')

  // ---------- 4. returns register ----------
  await h.goto('trade-returns')
  await page.waitForSelector('[data-testid="rows-returns-register"] tr.dt-row', { timeout: 10000 })
  const reg = await h.invoke('trade:returnsRegister', { side: 'sales', from: '2000-01-01', to: FAR })
  const mine = reg.find((r) => r.voucherId === cnId)
  assert(mine && mine.againstVoucherId === invoiceId && mine.reason === 'Damaged in transit' && mine.qtyMilli === 2000, 'the register lists the return, its invoice and reason')
  assert((await page.locator('[data-testid="rows-returns-register"]').textContent()).includes('Damaged in transit'), 'the reason shows')
  await both('04-returns-register')
  await h.click('tab-trade-returns-item')
  await page.waitForSelector('[data-testid="rows-returns-rate-item"] tr.dt-row', { timeout: 10000 })
  const rate = (await h.invoke('trade:returnsRate', { side: 'sales', from: '2000-01-01', to: FAR, by: 'item' })).find((r) => r.stockItemId === gear.id)
  assertEq(rate.qtyRatePct, 20, '2 of 10 came back')
  await both('05-returns-rate-by-item')

  // ---------- 5. data for the reports ----------
  const today = invoice.date
  const blank = {
    number: undefined, narration: null, reference: null, instrumentNo: null, instrumentDate: null,
    transporterId: null, vehicleNo: null, transportDistanceKm: null, currencyCode: null, exchangeRate: null
  }
  const docLine = (qty, rate, from) => ({
    stockItemId: gear.id, qtyMilli: qty * 1000, ratePaise: rate * 100, discountPaise: 0, amount: qty * rate * 100,
    ...(from ? { source: { lineUid: from, linkType: 'fulfil' } } : {})
  })
  const po = (await h.invoke('tradeDocs:save', { data: { docTypeId: docTypeOf('purchase_order').id, date: today, partyLedgerId: creditor.id, lines: [docLine(10, 100)] } })).doc
  const grn = await h.invoke('voucher:save', {
    data: {
      ...blank, voucherTypeId: typeOf('receipt_note').id, date: today, partyLedgerId: creditor.id, lines: [],
      inventory: [{ stockItemId: gear.id, godownId: null, qtyMilli: 10_000, ratePaise: 10_000, amount: 100_000, direction: 'in', source: { lineUid: po.lines[0].lineUid, linkType: 'fulfil' } }]
    }
  })
  const grnLine = (await h.invoke('voucher:get', { id: grn.id })).inventory[0].lineUid
  await h.invoke('voucher:save', {
    data: {
      ...blank, voucherTypeId: typeOf('purchase').id, date: today, partyLedgerId: creditor.id,
      lines: [{ ledgerId: creditor.id, drCr: 'cr', amount: 66_000 }, { ledgerId: purchaseAcc.id, drCr: 'dr', amount: 66_000 }],
      inventory: [{ stockItemId: gear.id, godownId: null, qtyMilli: 6000, ratePaise: 11_000, amount: 66_000, direction: 'in', source: { lineUid: grnLine, linkType: 'fulfil' } }]
    }
  })
  const dc = await h.invoke('voucher:save', {
    data: {
      ...blank, voucherTypeId: typeOf('delivery_note').id, date: today, partyLedgerId: debtor.id, lines: [],
      inventory: [{ stockItemId: gear.id, godownId: null, qtyMilli: 3000, ratePaise: 15_000, amount: 45_000, direction: 'out' }]
    }
  })
  const so = (await h.invoke('tradeDocs:save', { data: { docTypeId: docTypeOf('sales_order').id, date: today, partyLedgerId: debtor.id, lines: [docLine(80, 150)] } })).doc
  await h.invoke('voucher:save', {
    data: {
      ...blank, voucherTypeId: typeOf('delivery_note').id, date: today, partyLedgerId: debtor.id, lines: [],
      inventory: [{ stockItemId: gear.id, godownId: null, qtyMilli: 20_000, ratePaise: 15_000, amount: 300_000, direction: 'out', source: { lineUid: so.lines[0].lineUid, linkType: 'fulfil' } }]
    }
  })
  const qt = (await h.invoke('tradeDocs:save', { data: { docTypeId: docTypeOf('quotation').id, date: today, validUntil: today, partyLedgerId: debtor.id, lines: [docLine(5, 150)] } })).doc

  // Three-way match: the bill's ₹110 against the PO's ₹100, and 4 received not billed.
  await h.goto('three-way-match')
  await page.waitForSelector('[data-testid="rows-three-way-match"] tr.dt-row', { timeout: 10000 })
  const exc = await page.locator('[data-testid="rows-three-way-match"] tr.dt-row').evaluateAll((rs) => rs.map((r) => r.getAttribute('data-exception')).sort())
  assertEq(exc.join(','), 'qty_unbilled,rate_variance', 'rate variance and billed in part')
  await both('06-three-way-match')
  // A row opens the linked documents: PO → GRN → bill, three columns.
  await page.locator('[data-testid="rows-three-way-match"] tr.dt-row[data-exception="rate_variance"]').click()
  await page.waitForSelector('[data-testid="drawer-linked-docs"] [data-testid="chain-node"]', { timeout: 10000 })
  assertEq(await page.locator('[data-testid="drawer-linked-docs"] [data-testid="chain-level"]').count(), 3, 'PO, GRN and bill in three columns')
  await both('06b-linked-documents-po-grn-bill')
  await page.keyboard.press('Escape')
  await page.waitForSelector('[data-testid="drawer-linked-docs"]', { state: 'detached', timeout: 5000 })
  // A 10 % tolerance accepts the ₹110 bill.
  await page.keyboard.press('F12')
  await page.waitForSelector('[data-testid="input-match-rate-pct"]', { timeout: 5000 })
  await page.fill('[data-testid="input-match-rate-pct"]', '10')
  await both('07-three-way-match-tolerances')
  await page.keyboard.press('Escape')
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="rows-three-way-match"] tr.dt-row[data-exception="rate_variance"]').length === 0, null, { timeout: 10000 })

  // GRNI / GDNI, equal to the pending reports.
  await h.goto('unbilled-goods')
  await page.waitForSelector('[data-testid="rows-unbilled-goods"] tr.dt-row', { timeout: 10000 })
  const asOn = FAR
  const u = await h.invoke('trade:unbilledGoods', { asOn })
  const pendingGrn = (await h.invoke('trade:pending', { stage: 'receipt_note', asOn })).filter((r) => r.purpose === 'purchase').reduce((s, r) => s + r.pendingValue, 0)
  const pendingDc = (await h.invoke('trade:pending', { stage: 'delivery_note', asOn })).filter((r) => r.purpose === 'supply' || r.purpose === 'approval').reduce((s, r) => s + r.pendingValue, 0)
  assertEq(u.grni.value, pendingGrn, 'GRNI = Pending GRNs value')
  assertEq(u.gdni.value, pendingDc, 'GDNI = Pending challans value')
  assertEq(u.grni.value, 40_000, '4 unbilled @ ₹100')
  await both('08-grni-gdni')

  // The year-end close preview warns with them: a GRN of last FY, still unbilled on 31 March.
  const lastFy = currentFyStart - 1
  await h.invoke('voucher:save', {
    data: {
      ...blank, voucherTypeId: typeOf('receipt_note').id, date: `${lastFy + 1}-03-20`, partyLedgerId: creditor.id, lines: [],
      inventory: [{ stockItemId: gear.id, godownId: null, qtyMilli: 5000, ratePaise: 10_000, amount: 50_000, direction: 'in' }]
    }
  })
  const preview = await h.invoke('yearend:preview', { fyStartYear: lastFy })
  assertEq(preview.unbilled.grni.value, 50_000, 'the close preview carries GRNI on 31 March')
  assertEq((await h.invoke('yearend:preview', { fyStartYear: currentFyStart })).unbilled.grni.value, 90_000, 'and the running year all of it')
  await h.goto('year-end')
  await page.waitForSelector('[data-testid="year-end-unbilled"]', { timeout: 10000 })
  await both('09-year-end-unbilled-warning')

  // Demand vs stock: the SO's 60 still to deliver against the stock.
  await h.goto('item-demand')
  await page.waitForSelector(`[data-testid="rows-item-demand"] tr[data-item-id="${gear.id}"]`, { timeout: 10000 })
  await both('10-demand-vs-stock')

  // Order book and lead time.
  await h.goto('order-book')
  await page.waitForSelector('[data-testid="rows-order-book-party"] tr.dt-row', { timeout: 10000 })
  await both('11-order-book-by-party')
  await h.click('tab-order-book-lead-time')
  await page.waitForSelector('[data-testid="rows-order-lead-time"] tr.dt-row', { timeout: 10000 })
  await both('12-fulfilment-lead-time')

  // Stale documents: the quotation (valid until today) is stale as on the period end; close it.
  await h.goto('stale-documents')
  await page.waitForSelector('[data-testid="rows-stale-documents"] tr.dt-row', { timeout: 10000 })
  await both('13-stale-documents')
  const stale = await h.invoke('trade:staleDocuments', { asOn: FAR, orderAgeDays: 30, noteAgeDays: 30 })
  assert(stale.some((r) => r.tradeDocId === qt.id && r.why === 'expired'), 'the quotation past its validity is stale')
  await page.locator(`[data-testid="rows-stale-documents"] tr[data-kind="quotation"] [data-testid="input-stale-pick"]`).first().check()
  await h.click('btn-close-stale-quotations')
  await page.waitForSelector('[data-testid="prompt-input"]', { timeout: 5000 })
  await page.fill('[data-testid="prompt-input"]', 'Customer bought elsewhere')
  await h.click('prompt-ok')
  await page.waitForFunction(
    async (id) => {
      const r = await window.total.invoke('tradeDocs:get', { id })
      return r.ok && r.data.status === 'closed'
    },
    qt.id,
    { timeout: 10000, polling: 200 }
  )
  assertEq((await h.invoke('tradeDocs:get', { id: qt.id })).closeReason, 'Customer bought elsewhere', 'the stale quotation is closed with the reason')

  // A challan short-close and reopen, from the challan form.
  await h.goto('daybook')
  await page.waitForSelector(`[data-testid="rows-daybook"] tr[data-row-id="${dc.id}"]`, { timeout: 10000 })
  await page.locator(`[data-testid="rows-daybook"] tr[data-row-id="${dc.id}"]`).click()
  await h.waitScreen('voucher-entry', 20000)
  await page.waitForSelector('[data-testid="btn-stock-note-close"]', { timeout: 10000 })
  await h.click('btn-stock-note-close')
  await page.waitForSelector('[data-testid="prompt-input"]', { timeout: 5000 })
  await page.fill('[data-testid="prompt-input"]', 'Kept as samples')
  await h.click('prompt-ok')
  await page.waitForSelector('[data-testid="stock-note-closed"]', { timeout: 10000 })
  assertEq((await h.invoke('trade:noteClosure', { voucherId: dc.id })).closeReason, 'Kept as samples', 'the challan is short-closed with its reason')
  assertEq((await h.invoke('trade:unbilledGoods', { asOn: FAR })).gdni.value, pendingDc - 45_000, 'a short-closed challan leaves GDNI')
  await both('14-challan-short-closed')
  await h.invoke('trade:reopenVoucher', { voucherId: dc.id, reason: 'Invoicing after all' })
  assertEq((await h.invoke('trade:noteClosure', { voucherId: dc.id })).closedAt, null, 'reopened')

  // The rejection picker on a GRN (goods back against a challan not yet invoiced).
  await h.goto('voucher-entry')
  await page.waitForSelector('[data-testid="tab-voucher-entry-sales"]', { timeout: 10000 })
  await page.keyboard.press('Alt+F9')
  await page.waitForSelector('[data-testid="stock-note-receipt_note"]', { timeout: 5000 })
  await pick('picker-party', debtor.name)
  await h.click('btn-add-rejection')
  await page.waitForSelector('[data-testid="drawer-add-from"] [data-testid="input-add-from-against"]', { timeout: 10000 })
  await both('15-rejection-against-challan')
  await page.keyboard.press('Escape')
  await page.waitForSelector('[data-testid="drawer-add-from"]', { state: 'detached', timeout: 5000 })
  // Leave the half-filled GRN (discard it) so closing the window isn't blocked.
  await page.locator('[data-testid="stock-note-receipt_note"] button', { hasText: 'Cancel' }).click()
  await page.waitForSelector('[data-testid="confirm-ok"]', { timeout: 5000 })
  await h.click('confirm-ok')
  await page.waitForSelector('[data-testid="stock-note-receipt_note"]', { state: 'detached', timeout: 5000 })
})
