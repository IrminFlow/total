// Scenario 37 — the inventory lane's last five, the foreign-currency bank account, and the
// scratchpad, against the built app.
//
// Properties rather than pixels, one per feature:
//
//   #115  a serial cannot leave the building twice, and altering the invoice that sold it puts it
//         back on the shelf — because status is derived from the movements, not stored beside them
//   #118  a standard is dated: revising it in October leaves September saying what it said
//   #127  sending goods for job work moves stock and posts NOTHING, and the section 143 clock runs
//   #128  a price list answers what it said on a day that has passed
//   #111  a label job is refused whole rather than printed in part
//   #119  the picture is a file in the company folder and a name in the database
//   #140  an unrealised difference is a real posting the trial balance sees, at a recorded rate
//   #46   classifying a parked entry edits the line rather than posting a transfer journal
import { scenario, assert } from '../lib/harness.mjs'

await scenario('37-inventory-lane', async (h) => {
  await h.createDemoCompany()

  const units = await h.invoke('master:units:list')
  const pcs = units[0]
  const groups = await h.invoke('master:groups:list')
  const groupId = (name) => groups.find((g) => g.name === name).id
  const ledgers = await h.invoke('master:ledgers:list')
  const cash = ledgers.find((l) => l.name === 'Cash')
  const types = await h.invoke('master:voucherTypes:list')
  const typeOf = (kind) => types.find((t) => t.kind === kind).id

  const supplier = await h.invoke('master:ledgers:create', {
    name: 'Lane Supplier', groupId: groupId('Sundry Creditors')
  })
  const purchases = await h.invoke('master:ledgers:create', {
    name: 'Lane Purchases', groupId: groupId('Purchase Accounts')
  })
  const sales = await h.invoke('master:ledgers:create', { name: 'Lane Sales', groupId: groupId('Sales Accounts') })

  // ---------- #115 serial numbers ----------
  const laptop = await h.invoke('master:stockItems:create', {
    name: 'Lane Laptop', unitId: pcs.id, trackSerials: true, barcode: 'LANE-LAPTOP'
  })

  const buySerials = (serials, id) =>
    h.invoke('voucher:save', {
      id,
      data: {
        voucherTypeId: typeOf('purchase'),
        date: '2026-04-01',
        partyLedgerId: supplier.id,
        lines: [
          { ledgerId: purchases.id, drCr: 'dr', amount: serials.length * 5_000_000 },
          { ledgerId: supplier.id, drCr: 'cr', amount: serials.length * 5_000_000 }
        ],
        inventory: [
          {
            stockItemId: laptop.id, qtyMilli: serials.length * 1000, ratePaise: 5_000_000,
            amount: serials.length * 5_000_000, direction: 'in', serials
          }
        ]
      }
    })

  await buySerials(['LANE-SN1', 'LANE-SN2'])
  const registered = await h.invoke('stock:serials:list', {})
  assert(registered.length === 2, `both serials are on the register (got ${registered.length})`)
  assert(registered.every((r) => r.status === 'in_stock'), 'and both are in stock')

  const sell = (serials, id) =>
    h.invoke('voucher:save', {
      id,
      data: {
        voucherTypeId: typeOf('sales'),
        date: '2026-05-01',
        lines: [
          { ledgerId: cash.id, drCr: 'dr', amount: serials.length * 7_000_000 },
          { ledgerId: sales.id, drCr: 'cr', amount: serials.length * 7_000_000 }
        ],
        inventory: [
          {
            stockItemId: laptop.id, qtyMilli: serials.length * 1000, ratePaise: 7_000_000,
            amount: serials.length * 7_000_000, direction: 'out', serials
          }
        ]
      }
    })

  const sale = await sell(['LANE-SN1'])
  const afterSale = await h.invoke('stock:serials:list', {})
  assert(afterSale.find((r) => r.serial === 'LANE-SN1').status === 'issued', 'the sold unit is issued')
  assert(afterSale.find((r) => r.serial === 'LANE-SN2').status === 'in_stock', 'the other is not')

  let twice = false
  try {
    await sell(['LANE-SN1'])
  } catch {
    twice = true
  }
  assert(twice, 'the same unit cannot be sold twice — the two-warranty-cards bug')

  // Altering the invoice to sell the OTHER one has to un-issue the first. Status is derived from
  // the movements, so replacing the voucher's movements is the whole correction.
  await sell(['LANE-SN2'], sale.id)
  const afterEdit = await h.invoke('stock:serials:list', {})
  assert(afterEdit.find((r) => r.serial === 'LANE-SN1').status === 'in_stock', 'altering the sale puts the first back on the shelf')
  assert(afterEdit.find((r) => r.serial === 'LANE-SN2').status === 'issued', 'and takes the second off it')

  const history = await h.invoke('stock:serials:history', { id: afterEdit.find((r) => r.serial === 'LANE-SN2').id })
  assert(history.length === 2 && history[0].direction === 'in', 'the unit history reads bought-then-sold')

  // ---------- #118 standard costing ----------
  const steel = await h.invoke('master:stockItems:create', { name: 'Lane Steel', unitId: pcs.id })
  await h.invoke('stock:standardCosts:save', { stockItemId: steel.id, effectiveFrom: '2026-04-01', standardCost: 20_000 })
  await h.invoke('stock:standardCosts:save', { stockItemId: steel.id, effectiveFrom: '2026-07-01', standardCost: 25_000 })

  const buySteel = (date, amount) =>
    h.invoke('voucher:save', {
      data: {
        voucherTypeId: typeOf('purchase'),
        date,
        partyLedgerId: supplier.id,
        lines: [
          { ledgerId: purchases.id, drCr: 'dr', amount },
          { ledgerId: supplier.id, drCr: 'cr', amount }
        ],
        inventory: [
          { stockItemId: steel.id, qtyMilli: 10_000, ratePaise: amount / 10, amount, direction: 'in' }
        ]
      }
    })

  await buySteel('2026-06-15', 210_000) // ₹210 a unit against June's ₹200 standard
  const june = await h.invoke('stock:variance', { from: '2026-06-01', to: '2026-06-30', basis: 'purchase' })
  assert(june.standardCostPaise === 200_000, `June is scored against June's standard (${june.standardCostPaise})`)
  assert(june.totalVariancePaise === 10_000, 'and is ₹100 adverse')
  assert(june.priceVariancePaise + june.usageVariancePaise === june.totalVariancePaise, 'and the split adds to the total')

  await buySteel('2026-08-15', 210_000) // the same price, now against ₹250
  const august = await h.invoke('stock:variance', { from: '2026-08-01', to: '2026-08-31', basis: 'purchase' })
  assert(august.standardCostPaise === 250_000, "August is scored against August's standard")
  assert(august.lines[0].verdict === 'favourable', 'so the same purchase reads favourable there')

  const reRunJune = await h.invoke('stock:variance', { from: '2026-06-01', to: '2026-06-30', basis: 'purchase' })
  assert(reRunJune.totalVariancePaise === 10_000, 'and June still says what it said after the revision')

  // ---------- #128 price list versions ----------
  const level = await h.invoke('master:priceLevels:create', { name: 'Lane Wholesale' })
  await h.invoke('priceLevels:saveRate', { priceLevelId: level.id, stockItemId: steel.id, rate: 30_000, effectiveFrom: '2026-04-01' })
  await h.invoke('priceLevels:applyRevision', { priceLevelId: level.id, effectiveFrom: '2026-10-01', changeBp: 1000, rounding: 'rupee' })

  const before = await h.invoke('priceLevels:listAsOn', { priceLevelId: level.id, asOn: '2026-09-30' })
  const after = await h.invoke('priceLevels:listAsOn', { priceLevelId: level.id, asOn: '2026-10-01' })
  assert(before[0].rate === 30_000, `September says the old price (${before[0].rate})`)
  assert(after[0].rate === 33_000, `October says the revised one (${after[0].rate})`)
  const versions = await h.invoke('priceLevels:versions', { priceLevelId: level.id, asOn: '2026-09-30' })
  assert(versions.length === 2, 'two versions exist')
  assert(versions.find((v) => v.effectiveFrom === '2026-10-01').inForce === false, 'and the later one is staged, not in force')
  // The screen and the invoice must agree about what is in force.
  const invoiceRate = await h.invoke('priceLevels:rateFor', { priceLevelId: level.id, stockItemId: steel.id, date: '2026-09-30' })
  assert(invoiceRate === before[0].rate, 'and what prices an invoice is what the screen shows')

  // ---------- #111 barcode labels ----------
  const unlabelled = await h.invoke('master:stockItems:create', { name: 'Lane Unlabelled', unitId: pcs.id })
  const job = await h.invoke('stock:labels:preview', {
    items: [{ stockItemId: laptop.id, copies: 3 }, { stockItemId: unlabelled.id, copies: 1 }]
  })
  assert(job.totalLabels === 3, `only the labellable item is counted (${job.totalLabels})`)
  assert(job.errors.some((e) => e.includes('Lane Unlabelled')), 'and the one with no barcode is named')
  assert(job.preview[0].some((line) => line.includes('LANE-LAPTOP')), 'the preview shows what the label will carry')

  let partial = false
  try {
    await h.invoke('stock:labels:print', {
      job: { items: [{ stockItemId: laptop.id }, { stockItemId: unlabelled.id }] },
      printer: null
    })
  } catch {
    partial = true
  }
  assert(partial, 'a job with one bad label is refused whole rather than printed in part')

  const saved = await h.invoke('stock:labels:print', { job: { items: [{ stockItemId: laptop.id, copies: 2 }] }, printer: null })
  assert(saved.path && saved.bytes > 0, `the job can be written out to be read before it is sent (${saved.bytes} bytes)`)

  // ---------- #119 item images ----------
  const PNG_B64 =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
  const image = await h.invoke('stock:image:set', { stockItemId: laptop.id, bytesBase64: PNG_B64, fileName: 'laptop.png' })
  assert(image.storedName.endsWith('laptop.png'), 'the picture keeps a readable name in the folder')
  assert(!image.storedName.includes('/'), 'and the database holds a name, never a path')
  const fetched = await h.invoke('stock:image:get', { id: laptop.id })
  assert(fetched.dataUrl.startsWith('data:image/png;base64,'), 'it comes back as a data URL the renderer can paint')

  let wrongType = false
  try {
    await h.invoke('stock:image:set', { stockItemId: laptop.id, bytesBase64: PNG_B64, fileName: 'laptop.heic' })
  } catch {
    wrongType = true
  }
  assert(wrongType, 'a format Chromium cannot render is refused, rather than drawing a broken square')

  await h.invoke('stock:image:clear', { id: laptop.id })
  assert((await h.invoke('stock:image:get', { id: laptop.id })).image === null, 'and it can be taken off again')

  // ---------- #127 job work ----------
  const worker = await h.invoke('master:ledgers:create', { name: 'Lane Fabrication', groupId: groupId('Sundry Creditors') })
  const linesBefore = (await h.invoke('report:trialBalance', { asOn: '2026-12-31' })).rows.length

  const challan = await h.invoke('jobwork:send', {
    partyLedgerId: worker.id,
    challanNo: 'LANE-JW-1',
    // After the 15 June purchase, so there is something on the shelf to send.
    sentOn: '2026-06-20',
    goodsType: 'input',
    lines: [{ stockItemId: steel.id, qtyMilli: 5_000 }]
  })
  assert(challan.godownName === 'Job work — Lane Fabrication', 'the goods move to a godown named for the job worker')
  assert(challan.status.dueDate === '2027-06-20', 'and section 143 gives inputs one year')

  const linesAfter = (await h.invoke('report:trialBalance', { asOn: '2026-12-31' })).rows.length
  assert(linesAfter === linesBefore, 'sending goods out is not a sale: no ledger was touched')

  const received = await h.invoke('jobwork:receive', {
    challanId: challan.id,
    receivedOn: '2026-07-01',
    lines: [
      { stockItemId: steel.id, qtyMilli: 4_500, kind: 'goods' },
      { stockItemId: steel.id, qtyMilli: 500, kind: 'waste' }
    ]
  })
  assert(received.status.state === 'closed', 'goods plus waste closes the challan')

  const itc04 = await h.invoke('jobwork:itc04', { from: '2026-04-01', to: '2026-09-30' })
  assert(itc04.length === 1 && itc04[0].challanNo === 'LANE-JW-1', 'and the ITC-04 data is answerable from it')

  // ---------- #140 multi-currency and revaluation ----------
  await h.invoke('currency:create', { code: 'USD', symbol: '$', name: 'US Dollar', decimals: 2 })
  const usdBank = await h.invoke('master:ledgers:create', {
    name: 'Lane USD Account', groupId: groupId('Bank Accounts'), currencyCode: 'USD'
  })
  await h.invoke('voucher:save', {
    data: {
      voucherTypeId: typeOf('receipt'),
      date: '2026-04-01',
      lines: [
        // USD 10,000 at ₹82.00.
        { ledgerId: usdBank.id, drCr: 'dr', amount: 82_000_000, fcAmount: 1_000_000, fcRateMicro: 82_000_000 },
        { ledgerId: sales.id, drCr: 'cr', amount: 82_000_000 }
      ],
      inventory: []
    }
  })

  const accounts = await h.invoke('fx:accounts', { asOn: '2026-06-30' })
  const account = accounts.find((a) => a.ledgerId === usdBank.id)
  assert(account && account.fcMinor === 1_000_000, 'the dollar balance is kept in dollars')
  assert(account.bookPaise === 82_000_000, 'and the rupee balance beside it')

  const preview = await h.invoke('fx:preview', { ledgerId: usdBank.id, asOn: '2026-06-30', closingRateMicro: 83_500_000 })
  assert(preview.differencePaise === 1_500_000, `the unrealised gain is ₹15,000 (${preview.differencePaise})`)
  assert(preview.effect === 'gain' && preview.ledgerSide === 'dr', 'a dollar account worth more rupees is debited')

  const posted = await h.invoke('fx:revalue', { ledgerId: usdBank.id, asOn: '2026-06-30', closingRateMicro: 83_500_000 })
  assert(posted.voucherId != null, 'and it is posted as a real journal, not a display adjustment')
  const voucher = await h.invoke('voucher:get', { id: posted.voucherId })
  const fxLine = voucher.lines.find((l) => l.ledgerId === usdBank.id)
  assert(fxLine.fcRateMicro === 83_500_000, 'the rate USED is recorded on the entry, not looked up again later')

  const tb = await h.invoke('report:trialBalance', { asOn: '2026-06-30' })
  assert(tb.totalDebit === tb.totalCredit, 'and the trial balance still balances with it in')
  assert(
    tb.rows.some((r) => r.ledgerName === 'Exchange Gain / Loss (Unrealised)'),
    'with the difference in a P&L account, where AS 11 puts it'
  )

  let twiceRevalued = false
  try {
    await h.invoke('fx:revalue', { ledgerId: usdBank.id, asOn: '2026-06-30', closingRateMicro: 84_000_000 })
  } catch {
    twiceRevalued = true
  }
  assert(twiceRevalued, 'the same period end cannot be revalued twice')

  // ---------- #46 the scratchpad ----------
  const empty = await h.invoke('scratchpad:list', {})
  assert(empty.ledgerId === null, 'the scratchpad ledger is not seeded into every company')

  const { ledgerId: padId } = await h.invoke('scratchpad:ensure')
  await h.invoke('voucher:save', {
    data: {
      voucherTypeId: typeOf('payment'),
      date: '2026-06-05',
      narration: 'Paid someone, no bill yet',
      lines: [
        { ledgerId: padId, drCr: 'dr', amount: 340_000 },
        { ledgerId: cash.id, drCr: 'cr', amount: 340_000 }
      ],
      inventory: []
    }
  })

  const parked = await h.invoke('scratchpad:list', {})
  assert(parked.entries.length === 1, 'the parked entry is listed')
  assert(parked.balancePaise === 340_000, 'with the balance an accountant wants at zero')
  assert(parked.entries[0].contraNames.includes('Cash'), 'and the other side of it, so the list answers the question')

  const voucherCountBefore = (await h.invoke('voucher:list', { from: '2026-01-01', to: '2026-12-31' })).length
  const classified = await h.invoke('scratchpad:classify', {
    voucherLineId: parked.entries[0].voucherLineId,
    targetLedgerId: purchases.id
  })
  assert(classified.toLedger === 'Lane Purchases', 'classifying names where it went')
  const voucherCountAfter = (await h.invoke('voucher:list', { from: '2026-01-01', to: '2026-12-31' })).length
  assert(voucherCountAfter === voucherCountBefore, 'and it edits the line rather than posting a transfer journal')
  assert((await h.invoke('scratchpad:list', {})).balancePaise === 0, 'leaving the scratchpad at nothing')

  // ---------- and the screens draw ----------
  await h.goto('stock-summary')
  await h.click('tab-stock-summary-serials')
  await h.page.waitForSelector('[data-testid="rows-serials"]', { timeout: 10000 })
  await h.shot('01-serials')

  await h.click('tab-stock-summary-jobwork')
  await h.page.waitForSelector('[data-testid="select-jobwork-state"]', { timeout: 10000 })
  await h.shot('02-job-work')

  await h.click('tab-stock-summary-costing')
  await h.page.waitForSelector('[data-testid="btn-standard-cost-new"]', { timeout: 10000 })
  await h.shot('03-standard-costing')

  await h.click('tab-stock-summary-labels')
  await h.page.waitForSelector('[data-testid="rows-label-items"]', { timeout: 10000 })
  await h.shot('04-labels')

  await h.goto('masters')
  await h.click('tab-masters-price-lists')
  await h.page.waitForSelector('[data-testid="rows-price-versions"]', { timeout: 10000 })
  await h.shot('05-price-lists')

  await h.goto('banking')
  await h.click('tab-banking-fx')
  await h.page.waitForSelector('[data-testid="rows-fx-accounts"]', { timeout: 10000 })
  const rateShown = await h.page.textContent('[data-testid="rows-fx-revaluations"]')
  assert(rateShown.includes('83.5'), `the revaluation row states the rate that was used (got ${rateShown.slice(0, 120)})`)
  await h.shot('06-foreign-currency')

  await h.goto('exceptions')
  await h.page.waitForSelector('[data-testid="btn-scratchpad-create"], [data-testid="rows-scratchpad"], .text-muted', {
    timeout: 10000
  })
  await h.shot('07-scratchpad')
})
