// Scenario 37 — GST rate history per item (roadmap D-92).
//
// One property, asserted end to end through the same handlers the UI calls: an invoice dated
// BEFORE a rate change is taxed at the old rate, and one dated AFTER it at the new rate. The rate
// an item charges is dated data, so a change recorded today must not reach back and reprice an
// invoice that was already raised — or a return that was already filed.
//
// The boundary is inclusive, because a notification "with effect from the 22nd" applies ON the
// 22nd. That is checked too, since off-by-one here is a whole day of invoices at the wrong rate.
import { scenario, assert, assertEq } from '../lib/harness.mjs'

const iso = (d) => d.toISOString().slice(0, 10)
const daysAgo = (n) => {
  const d = new Date()
  d.setUTCDate(d.getUTCDate() - n)
  return iso(d)
}

await scenario('37-rate-history', async (h) => {
  await h.createCompanyUI('Rate History Books')

  // A registered seller and a registered buyer in the same state, so the invoices land in b2b
  // where the per-invoice rate is visible in the return itself.
  const { info } = await h.invoke('company:current')
  await h.invoke('company:updateInfo', { ...info, stateCode: '27', gstin: '27AAPFU0939F1ZV' })

  const groups = await h.invoke('master:groups:list')
  const groupId = (name) => groups.find((g) => g.name === name).id

  const buyer = await h.invoke('master:ledgers:create', {
    name: 'Kumar Stores', groupId: groupId('Sundry Debtors'), openingBalance: 0,
    gstin: '27AAPFU0939F1ZV', stateCode: '27'
  })
  const sales = await h.invoke('master:ledgers:create', {
    name: 'Sales', groupId: groupId('Sales Accounts'), openingBalance: 0
  })
  const cgst = await h.invoke('master:ledgers:create', {
    name: 'CGST Output', groupId: groupId('Duties & Taxes'), openingBalance: 0, taxType: 'cgst'
  })
  const sgst = await h.invoke('master:ledgers:create', {
    name: 'SGST Output', groupId: groupId('Duties & Taxes'), openingBalance: 0, taxType: 'sgst'
  })

  const units = await h.invoke('master:units:list')
  const item = await h.invoke('master:stockItems:create', {
    name: 'Hair Oil', unitId: units[0].id, hsn: '3305', gstRate: 12
  })

  // ---- the change ----
  const before = daysAgo(40)
  const change = daysAgo(20)
  const after = daysAgo(10)

  await h.invoke('item:rates:save', {
    data: { stockItemId: item.id, effectiveFrom: daysAgo(400), ratePercent: 12, cessPercent: 0, note: '1/2017-CTR' }
  })
  await h.invoke('item:rates:save', {
    data: { stockItemId: item.id, effectiveFrom: change, ratePercent: 18, cessPercent: 0, note: '9/2025-CTR' }
  })

  // The rate a document would be priced at, asked date by date.
  assertEq((await h.invoke('stock:effectiveTax', { stockItemId: item.id, onDate: before })).gstRate, 12,
    'the day before the change bills at the old rate')
  assertEq((await h.invoke('stock:effectiveTax', { stockItemId: item.id, onDate: change })).gstRate, 18,
    'the change is in force ON its own effective date, not from the next day')
  assertEq((await h.invoke('stock:effectiveTax', { stockItemId: item.id, onDate: after })).gstRate, 18,
    'and after it')

  // ---- two invoices, one on each side ----
  const types = await h.invoke('master:voucherTypes:list')
  const salesType = types.find((t) => t.kind === 'sales')

  const invoice = async (date, taxPaise) =>
    h.invoke('voucher:save', {
      data: {
        voucherTypeId: salesType.id, date, partyLedgerId: buyer.id,
        narration: null, reference: null, instrumentNo: null, instrumentDate: null,
        transporterId: null, vehicleNo: null, transportDistanceKm: null,
        currencyCode: null, exchangeRate: null,
        lines: [
          { ledgerId: buyer.id, drCr: 'dr', amount: 100000 + taxPaise },
          { ledgerId: sales.id, drCr: 'cr', amount: 100000 },
          { ledgerId: cgst.id, drCr: 'cr', amount: taxPaise / 2 },
          { ledgerId: sgst.id, drCr: 'cr', amount: taxPaise / 2 }
        ],
        inventory: [
          {
            stockItemId: item.id, godownId: null, qtyMilli: 1000,
            ratePaise: 100000, amount: 100000, direction: 'out'
          }
        ]
      }
    })

  const old = await invoice(before, 12000)
  const fresh = await invoice(after, 18000)

  // ---- THE property, read out of the return itself ----
  const today = new Date()
  const period = `${String(today.getMonth() + 1).padStart(2, '0')}${today.getFullYear()}`
  const g1 = await h.invoke('gst:gstr1', { from: daysAgo(60), to: iso(today), period })
  const invoices = (g1.json.b2b ?? []).flatMap((c) => c.inv)
  assert(invoices.length === 2, `both invoices reach b2b (got ${invoices.length})`)

  const rateOf = (number) => {
    const row = invoices.find((i) => i.inum === number)
    assert(row, `invoice ${number} is in the return`)
    assertEq(row.itms.length, 1, `invoice ${number} has one rate bucket`)
    return row.itms[0].itm_det.rt
  }
  assertEq(rateOf(old.number), 12, 'the invoice raised BEFORE the change is taxed at the old rate')
  assertEq(rateOf(fresh.number), 18, 'the invoice raised AFTER it is taxed at the new one')

  // And the whole point: recording a FURTHER change now does not move either of them.
  await h.invoke('item:rates:save', {
    data: { stockItemId: item.id, effectiveFrom: iso(today), ratePercent: 5, cessPercent: 0, note: 'later' }
  })
  const again = await h.invoke('gst:gstr1', { from: daysAgo(60), to: iso(today), period })
  assertEq(
    JSON.stringify(again.json.b2b),
    JSON.stringify(g1.json.b2b),
    'a change recorded afterwards leaves the already-raised invoices untouched'
  )

  // ---- the screen ----
  await h.goto('masters')
  await h.click('tab-masters-items')
  await h.page.waitForSelector('[data-testid="rows-masters-items"] tr', { timeout: 15000 })
  await h.clickText('Edit')
  await h.page.waitForSelector('[data-testid="section-item-rate-history"]', { timeout: 10000 })

  const rows = await h.page.$$('[data-testid="rows-item-rate-history"] tr')
  assertEq(rows.length, 3, 'the editor lists every recorded change')
  const inForce = await h.page.textContent('[data-testid="text-item-rate-in-force"]')
  assert(/5%/.test(inForce) && /in force today/.test(inForce), `the in-force line names today's rate (got "${inForce}")`)

  // The section sits below the fold in the item editor — scroll it into view so the screenshot
  // is of the feature rather than of the fields above it.
  await h.page.$eval('[data-testid="section-item-rate-history"]', (el) => el.scrollIntoView(false))
  await h.shot('01-item-rate-history')
})
