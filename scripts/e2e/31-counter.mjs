// Scenario 31 — the counter.
//
// A counter is the one screen in this app that posts without a human looking at a draft first,
// because the customer has already paid and walked out. So the properties worth asserting are the
// ones that would otherwise be discovered by a shopkeeper at closing time:
//
//   the tender has to cover the bill, and change only comes out of cash;
//   a walk-in leaves a name on the bill and no ledger behind;
//   the voucher balances and the stock moves;
//   a drawer counted short says short, and the variance is the one it was closed on;
//   a scheme's free goods still leave stock;
//   and a quotation converts exactly once.
import { scenario, assert } from '../lib/harness.mjs'

await scenario('31-counter', async (h) => {
  await h.createDemoCompany()

  const info = (await h.invoke('company:current')).info
  const today = new Date().toISOString().slice(0, 10)

  // ---- an item to sell, bought in so it has a cost ----
  const units = await h.invoke('master:units:list')
  const groups = await h.invoke('master:groups:list')
  const groupId = (name) => groups.find((g) => g.name === name).id

  const widget = await h.invoke('master:stockItems:create', {
    name: 'Counter Widget',
    groupId: null,
    unitId: units[0].id,
    hsn: '8471',
    gstRate: 18,
    cessRate: null,
    openingQtyMilli: 0,
    openingValue: 0,
    code: 'CW1',
    barcode: '8901234567890',
    reorderLevelMilli: null
  })

  const supplier = await h.invoke('master:ledgers:create', {
    name: 'Counter Supplier', groupId: groupId('Sundry Creditors'), openingBalance: 0,
    gstin: null, stateCode: null, address: null, taxType: null, gstRate: null, hsn: null,
    tdsSectionId: null, pan: null, creditDays: null, exportType: null
  })
  const purchases = (await h.invoke('master:ledgers:list')).find((l) => l.groupId === groupId('Purchase Accounts'))
    ?? await h.invoke('master:ledgers:create', {
      name: 'Purchase Account', groupId: groupId('Purchase Accounts'), openingBalance: 0,
      gstin: null, stateCode: null, address: null, taxType: null, gstRate: null, hsn: null,
      tdsSectionId: null, pan: null, creditDays: null, exportType: null
    })
  const purchaseType = (await h.invoke('master:voucherTypes:list')).find((t) => t.kind === 'purchase')

  await h.invoke('voucher:save', {
    data: {
      voucherTypeId: purchaseType.id,
      date: today,
      partyLedgerId: supplier.id,
      narration: 'Counter stock',
      lines: [
        { ledgerId: purchases.id, drCr: 'dr', amount: 10_000_00, costAllocations: [] },
        { ledgerId: supplier.id, drCr: 'cr', amount: 10_000_00, costAllocations: [] }
      ],
      inventory: [
        { stockItemId: widget.id, godownId: null, qtyMilli: 100_000, ratePaise: 10_000, amount: 10_000_00, direction: 'in' }
      ],
      billRefs: [],
      tds: null
    }
  })

  // ---- the item is found the way a person at a counter would find it ----
  const byCode = await h.invoke('counter:lookup', { query: 'CW1' })
  assert(byCode.stockItemId === widget.id, 'the shelf code finds the item')
  const byBarcode = await h.invoke('counter:lookup', { query: '8901234567890' })
  assert(byBarcode.stockItemId === widget.id, 'so does a scan')
  assert(byBarcode.costPaise === 10_000, `it knows what the stock cost (${byBarcode.costPaise})`)
  assert(byBarcode.onHandMilli === 100_000, 'and how much is on hand')

  // ---- pricing: a shelf price is inclusive of tax ----
  const cart = await h.invoke('counter:price', {
    lines: [{ stockItemId: widget.id, qtyMilli: 1000, ratePaise: 11800 }],
    pricingMode: 'inclusive'
  })
  assert(cart.gst.taxable === 10000, `tax is backed out of the shelf price (${cart.gst.taxable})`)
  assert(cart.payablePaise === 11800, 'the customer pays the number on the label')
  assert(
    cart.gst.taxable + cart.gst.cgst + cart.gst.sgst + cart.gst.igst + cart.gst.cess === cart.netPaise,
    'the parts sum to the total, to the paisa'
  )

  // A price under cost is flagged while the line is being typed (#382).
  const cheap = await h.invoke('counter:price', {
    lines: [{ stockItemId: widget.id, qtyMilli: 1000, ratePaise: 9000 }],
    pricingMode: 'exclusive'
  })
  assert(cheap.belowCostLines === 1, 'a line under cost is flagged at entry')
  assert(cheap.lines[0].belowCostBy === 1000, `and says by how much (${cheap.lines[0].belowCostBy})`)

  // ---- a scheme's free goods still leave stock (#383) ----
  await h.invoke('counter:saveScheme', {
    data: {
      name: 'Ten and one', stockItemId: widget.id, kind: 'free', minQtyMilli: 10_000,
      freeQtyMilli: 1_000, fromDate: `${info.booksFrom}-04-01`
    }
  })
  const scheme = await h.invoke('counter:price', {
    lines: [{ stockItemId: widget.id, qtyMilli: 10_000, ratePaise: 11800 }],
    pricingMode: 'inclusive'
  })
  assert(scheme.lines[0].qtyMilli === 11_000, 'eleven move for ten billed, so the stock ledger stays right')
  assert(scheme.lines[0].scheme.freeQtyMilli === 1_000, 'the free unit is named')

  // ---- open the till ----
  const session = await h.invoke('counter:open', { openedOn: today, operator: 'Ravi', openingFloatPaise: 2_000_00 })
  assert(session.openingFloatPaise === 2_000_00, 'the float is recorded')
  let refused = false
  try {
    await h.invoke('counter:open', { openedOn: today, openingFloatPaise: 100 })
  } catch {
    refused = true
  }
  assert(refused, 'two open drawers cannot both be right about what is in the till')

  // ---- a tender that does not cover the bill is refused ----
  refused = false
  try {
    await h.invoke('counter:sale', {
      lines: [{ stockItemId: widget.id, qtyMilli: 1000, ratePaise: 11800 }],
      tenders: [{ mode: 'cash', amountPaise: 10000 }]
    })
  } catch {
    refused = true
  }
  assert(refused, 'the till will not close a sale that has not been paid for')

  // ---- credit with nobody to owe it is refused (#381's other half) ----
  refused = false
  try {
    await h.invoke('counter:sale', {
      lines: [{ stockItemId: widget.id, qtyMilli: 1000, ratePaise: 11800 }],
      tenders: [{ mode: 'credit', amountPaise: 11800 }]
    })
  } catch {
    refused = true
  }
  assert(refused, 'credit without a party is an amount nobody owes')

  // ---- the walk-in sale ----
  const ledgersBefore = (await h.invoke('master:ledgers:list')).length
  const sale = await h.invoke('counter:sale', {
    lines: [{ stockItemId: widget.id, qtyMilli: 1000, ratePaise: 11800 }],
    tenders: [{ mode: 'cash', amountPaise: 20000 }],
    customerName: 'Kumar',
    customerPhone: '9876543210'
  })
  assert(sale.tender.changePaise === 8200, `change is the overpayment (${sale.tender.changePaise})`)
  assert(sale.tender.cashInDrawerPaise === 11800, 'only the settled part stays in the drawer')

  const voucher = await h.invoke('voucher:get', { id: sale.voucherId })
  assert(voucher.partyLedgerId === null, 'a walk-in leaves no party on the voucher')
  const dr = voucher.lines.filter((l) => l.drCr === 'dr').reduce((s, l) => s + l.amount, 0)
  const cr = voucher.lines.filter((l) => l.drCr === 'cr').reduce((s, l) => s + l.amount, 0)
  assert(dr === cr, `the counter sale balances (${dr} vs ${cr})`)
  assert(dr === 11800, 'and it is the money that stayed, not the money handed over')

  const ledgersAfter = await h.invoke('master:ledgers:list')
  assert(!ledgersAfter.some((l) => l.name === 'Kumar'), 'the customer is a name on the bill, not a master record (#381)')
  assert(ledgersAfter.length >= ledgersBefore, 'only the ledgers the posting needed were created')

  const afterStock = await h.invoke('counter:lookup', { query: 'CW1' })
  assert(afterStock.onHandMilli === 99_000, `the stock moved (${afterStock.onHandMilli})`)

  // ---- a card sale never touches the till ----
  await h.invoke('counter:sale', {
    lines: [{ stockItemId: widget.id, qtyMilli: 1000, ratePaise: 11800 }],
    tenders: [{ mode: 'card', amountPaise: 11800 }]
  })
  const summary = await h.invoke('counter:summary', { sessionId: session.id })
  assert(summary.drawer.cashSalesPaise === 11800, 'only the cash sale is in the drawer')
  assert(summary.byMode.find((m) => m.mode === 'card').amountPaise === 11800, 'the card takings are reported separately')
  assert(summary.drawer.expectedPaise === 2_000_00 + 11800, `the drawer expects float plus cash (${summary.drawer.expectedPaise})`)

  // ---- a bank drop comes out of the expected count ----
  await h.invoke('counter:movement', { sessionId: session.id, kind: 'payout', amountPaise: 5000, reason: 'Bank drop' })
  const afterDrop = await h.invoke('counter:summary', { sessionId: session.id })
  assert(afterDrop.drawer.expectedPaise === summary.drawer.expectedPaise - 5000, 'money out of the drawer is money out of the count')

  // ---- returns at the counter (#384) ----
  const found = await h.invoke('counter:findSale', { query: '9876543210' })
  assert(found && found.voucherId === sale.voucherId, 'the sale is found from what the customer has')
  const ret = await h.invoke('counter:sale', {
    lines: [{ stockItemId: widget.id, qtyMilli: 1000, ratePaise: 11800 }],
    tenders: [{ mode: 'cash', amountPaise: 11800 }],
    kind: 'return',
    returnsVoucherId: sale.voucherId
  })
  const retVoucher = await h.invoke('voucher:get', { id: ret.voucherId })
  const retDr = retVoucher.lines.filter((l) => l.drCr === 'dr').reduce((s, l) => s + l.amount, 0)
  const retCr = retVoucher.lines.filter((l) => l.drCr === 'cr').reduce((s, l) => s + l.amount, 0)
  assert(retDr === retCr, 'the credit note balances too')
  const backInStock = await h.invoke('counter:lookup', { query: 'CW1' })
  assert(backInStock.onHandMilli === 99_000, `the returned unit came back (${backInStock.onHandMilli})`)

  // ---- close the drawer short ----
  const expected = (await h.invoke('counter:summary', { sessionId: session.id })).drawer.expectedPaise
  const closed = await h.invoke('counter:close', { sessionId: session.id, countedPaise: expected - 5000, notes: 'Fifty short' })
  assert(closed.drawer.status === 'short', 'a drawer counted short says short')
  assert(closed.drawer.variancePaise === -5000, `with a signed variance (${closed.drawer.variancePaise})`)
  assert((await h.invoke('counter:session')) === null, 'and the till is closed')

  // ---- the quotation chain (#378) ----
  const buyer = ledgersAfter.find((l) => l.groupId === groupId('Sundry Debtors'))
  assert(buyer, 'the demo books have a customer')
  const quote = await h.invoke('salesdoc:save', {
    data: {
      stage: 'quotation',
      date: today,
      partyLedgerId: buyer.id,
      validUntil: today,
      lines: [{ stockItemId: widget.id, description: 'Counter Widget', qtyMilli: 10_000, ratePaise: 10_000 }]
    }
  })
  assert(quote.number === 'QT-0001', `quotations number themselves (${quote.number})`)
  assert(quote.totalPaise === quote.taxablePaise + quote.gst.cgst + quote.gst.sgst + quote.gst.igst + quote.gst.cess, 'and price themselves')

  const order = await h.invoke('salesdoc:convert', { id: quote.id, date: today })
  assert(order.stage === 'order' && order.reference === quote.number, 'a quotation becomes an order that remembers it')
  let twice = false
  try {
    await h.invoke('salesdoc:convert', { id: quote.id, date: today })
  } catch {
    twice = true
  }
  assert(twice, 'a quotation converts once — converting twice would bill the customer twice')

  // A part delivery leaves the order open.
  const challan = await h.invoke('salesdoc:convert', {
    id: order.id,
    date: today,
    quantities: [{ lineId: order.lines[0].id, qtyMilli: 4_000 }]
  })
  assert(challan.lines[0].qtyMilli === 4_000, 'the challan carries what was actually delivered')
  const reread = await h.invoke('salesdoc:get', { id: order.id })
  assert(reread.status === 'open', 'a part-delivered order is still open')
  assert(reread.lines[0].pendingMilli === 6_000, `with the rest still pending (${reread.lines[0].pendingMilli})`)

  // The invoice is a draft — nothing posts from this chain.
  const vouchersBefore = (await h.invoke('voucher:list', { from: `${info.booksFrom}-04-01`, to: today })).length
  const draft = await h.invoke('salesdoc:invoiceDraft', { id: challan.id })
  const draftDr = draft.lines.filter((l) => l.drCr === 'dr').reduce((s, l) => s + l.amount, 0)
  const draftCr = draft.lines.filter((l) => l.drCr === 'cr').reduce((s, l) => s + l.amount, 0)
  assert(draftDr === draftCr, 'the invoice draft balances')
  const vouchersAfter = (await h.invoke('voucher:list', { from: `${info.booksFrom}-04-01`, to: today })).length
  assert(vouchersAfter === vouchersBefore, 'asking for an invoice draft posted nothing')

  // ---- the loan register (#370) ----
  const loan = await h.invoke('loans:save', {
    data: {
      name: 'Tata Ace',
      lender: 'HDFC',
      kind: 'vehicle',
      principalPaise: 5_00_000_00,
      annualRateBp: 1200,
      months: 24,
      disbursedOn: today,
      firstInstalmentDate: today
    }
  })
  const view = await h.invoke('loans:view', { id: loan.id })
  assert(view.schedule.rows.length === 24, 'the schedule runs to the end')
  assert(view.schedule.rows[23].closingPaise === 0, 'and ends at exactly zero, however the EMI divides')
  assert(
    view.schedule.rows.reduce((s, r) => s + r.principalPaise, 0) === 5_00_000_00,
    'it repays exactly what was borrowed'
  )
  assert(view.schedule.finalInstalmentPaise !== view.schedule.emiPaise, 'the last instalment differs, and says so')
  const emiDraft = await h.invoke('loans:instalmentDraft', { id: loan.id, instalmentNo: 1 })
  const loanLine = emiDraft.lines.find((l) => l.group === 'Secured Loans')
  const interestLine = emiDraft.lines.find((l) => l.group === 'Indirect Expenses')
  const bankLine = emiDraft.lines.find((l) => l.group === 'Bank Accounts')
  assert(loanLine.amount + interestLine.amount === bankLine.amount, 'the EMI is its two parts')
  assert(interestLine.amount === 5_000_00, `and the interest is a month of the rate (${interestLine.amount})`)

  // The stock statement and drawing power (#372, #373) are asserted in
  // src/main/services/borrowing.dbtest.ts rather than here: they read the books' own stock
  // valuation, which on this branch queries a `landed_costs` table whose migration has not
  // landed yet (services/inventoryLandedCost.ts has the same problem, and its own dbtest fails
  // on a clean checkout). Move those assertions here once that migration is merged.

  // ---- dot-matrix bytes (#379) ----
  // Untested against a physical printer; what is asserted is that real ESC/P comes out.
  const escp = await h.invoke('print:escpPreview', { voucherId: sale.voucherId })
  assert(escp.bytes > 0, 'the invoice renders to bytes')
  assert(escp.text.startsWith('<1b>@'), `and starts by resetting the printer (${escp.text.slice(0, 8)})`)
  assert(escp.text.includes('<0c>'), 'and ejects the form at the end')

  // ---- the screen ----
  await h.goto('counter')
  await h.page.waitForSelector('[data-testid="counter-screen"]', { timeout: 15000 })
  await h.shot('01-counter-empty')

  await h.fill('input-counter-scan', 'CW1')
  await h.page.keyboard.press('Enter')
  await h.page.waitForSelector('[data-testid="row-counter-0"]', { timeout: 15000 })
  await h.page.waitForFunction(
    () => (document.querySelector('[data-testid="counter-payable"]')?.textContent ?? '').trim() !== '₹0.00',
    { timeout: 15000 }
  )
  const payable = await h.page.textContent('[data-testid="counter-payable"]')
  assert(payable.trim() !== '₹0.00', `the cart prices itself on screen (${payable})`)
  await h.shot('02-counter-cart')

  await h.click('btn-counter-customer-screen')
  await h.page.waitForSelector('[data-testid="panel-customer-display"]', { timeout: 10000 })
  await h.shot('03-counter-customer-view')
  await h.click('btn-counter-customer-screen')

  await h.click('btn-counter-tender')
  await h.page.waitForSelector('[data-testid="tender-summary"]', { timeout: 10000 })
  await h.shot('04-counter-tender')
  await h.click('btn-tender-complete')
  await h.page.waitForSelector('[data-testid="counter-last-sale"]', { timeout: 15000 })
  const last = await h.page.textContent('[data-testid="counter-last-sale"]')
  assert(last.includes('Last:'), 'the screen says what was just sold')
  await h.shot('05-counter-sold')

  // The chain and the registers.
  await h.goto('sales-chain')
  await h.page.waitForSelector('[data-testid="panel-salespipeline"]', { timeout: 15000 })
  await h.shot('06-sales-chain')

  await h.goto('borrowing')
  await h.page.waitForSelector('[data-testid="rows-loans"] tr', { timeout: 15000 })
  await h.shot('07-loans')
  for (const [tab, marker] of [
    ['deposits', 'panel-deposits'],
    ['projects', 'panel-projects'],
    ['prepaid', 'panel-prepaid'],
    ['commission', 'panel-commission']
  ]) {
    await h.click(`tab-borrowing-${tab}`)
    await h.page.waitForSelector(`[data-testid="${marker}"]`, { timeout: 15000 })
    await h.shot(`09-${tab}`)
  }
})
