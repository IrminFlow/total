// Scenario 42 — multi-GSTIN companies: one book, several registrations (roadmap #108).
//
// One PAN, premises in two states, two GST registrations. It is ONE set of books — one trial
// balance, one P&L — but returns are filed per GSTIN, and the rule that decides CGST+SGST against
// IGST is computed from the state of the registration that MADE the supply.
//
// The properties this asserts, none of which is about pixels:
//
//   1. A company that has only ever had one GSTIN is untouched: exactly one registration, no
//      picker on any screen, and its GSTR-1 is byte-identical before and after a second
//      registration is added.
//   2. A Gujarat registration billing a Gujarat customer charges CGST+SGST. Computed against the
//      company's Maharashtra head-office state — the way every single-GSTIN book does it — the
//      same invoice is IGST. This is the correctness core of the item.
//   3. Each GSTIN's GSTR-1 and GSTR-3B cover only its own supplies, under its own GSTIN, and the
//      two re-add to the whole book.
//   4. The books stay whole: the trial balance does NOT split by registration.
//   5. Stock moved from one registration to the other is REPORTED as a taxable supply under
//      Schedule I para 2, while it has no invoice against it. Raising that invoice is scenario
//      52's subject; this one pins that the movement is never allowed to look innocent.
import { scenario, assert, assertEq } from '../lib/harness.mjs'

// Checksum-valid GSTINs on one PAN.
const MH = '27AAAPA1234A1ZT'
const GJ = '24AAAPA1234A1ZZ'

await scenario('42-multi-gstin', async (h) => {
  await h.createCompanyUI('Two State Traders')
  await h.stubDialogs()

  // ---- the company's own registration, before anything is added ----
  const info = await h.invoke('company:current')
  await h.invoke('company:updateInfo', {
    ...info.info,
    gstin: MH,
    stateCode: '27',
    gstRegistrationType: 'regular'
  })

  let regs = await h.invoke('gstReg:list')
  assertEq(regs.length, 1, 'a company starts with exactly one registration')
  assertEq(regs[0].gstin, MH, "and it mirrors the company's own GSTIN")
  assert(regs[0].isPrimary, 'the one registration is the primary')

  // ---- masters ----
  const groups = await h.invoke('master:groups:list')
  const gid = (name) => groups.find((g) => g.name === name).id
  const mk = (input) => h.invoke('master:ledgers:create', {
    openingBalance: 0, gstin: null, stateCode: null, address: null, taxType: null,
    gstRate: null, hsn: null, tdsSectionId: null, pan: null, ...input
  })
  await mk({ name: 'Buyer Mumbai', groupId: gid('Sundry Debtors'), gstin: '27AAPFU0939F1ZV', stateCode: '27' })
  await mk({ name: 'Buyer Surat', groupId: gid('Sundry Debtors'), gstin: '24AAPFU0939F1Z1', stateCode: '24' })
  await mk({ name: 'Sales 18', groupId: gid('Sales Accounts'), gstRate: 18, hsn: '9983' })
  await mk({ name: 'CGST Output', groupId: gid('Duties & Taxes'), taxType: 'cgst' })
  await mk({ name: 'SGST Output', groupId: gid('Duties & Taxes'), taxType: 'sgst' })

  const ledgers = await h.invoke('master:ledgers:list')
  const L = (name) => ledgers.find((l) => l.name === name).id
  const types = await h.invoke('master:voucherTypes:list')
  const salesType = types.find((t) => t.kind === 'sales').id

  const fyStart = (() => {
    const d = new Date()
    return d.getMonth() >= 3 ? d.getFullYear() : d.getFullYear() - 1
  })()
  const date = `${fyStart}-07-05`
  const from = `${fyStart}-07-01`
  const to = `${fyStart}-07-31`
  const period = `07${fyStart}`

  const postSale = (party, taxable, registrationId) =>
    h.invoke('voucher:save', {
      data: {
        voucherTypeId: salesType,
        date,
        partyLedgerId: L(party),
        gstRegistrationId: registrationId ?? null,
        lines: [
          { ledgerId: L(party), drCr: 'dr', amount: Math.round(taxable * 1.18), costAllocations: [] },
          { ledgerId: L('Sales 18'), drCr: 'cr', amount: taxable, costAllocations: [] },
          { ledgerId: L('CGST Output'), drCr: 'cr', amount: Math.round(taxable * 0.09), costAllocations: [] },
          { ledgerId: L('SGST Output'), drCr: 'cr', amount: Math.round(taxable * 0.09), costAllocations: [] }
        ],
        inventory: [],
        billRefs: [],
        tds: null
      }
    })

  // ---- 1. the one-registration book, and its return ----
  await postSale('Buyer Mumbai', 100000)
  const beforeSecond = await h.invoke('gst:gstr1', { from, to, period })
  assertEq(beforeSecond.gstin, MH, 'the return is filed under the only GSTIN there is')

  await h.goto('gstr1')
  const pickerBefore = await h.page.$('[data-testid="select-gstr1-gstin"]')
  assertEq(pickerBefore, null, 'a one-GSTIN company is never asked which GSTIN — no picker at all')
  await h.shot('01-single-gstin-no-picker')

  // ---- 2. add the Gujarat registration, through the UI ----
  // Company details is not in the sidebar — the company name in the header is the way in.
  await h.clickText('Two State Traders')
  await h.waitScreen('company-info')
  await h.click('btn-add-registration')
  await h.fill('input-registration-gstin', GJ)
  await h.fill('input-registration-trade-name', 'Surat branch')
  await h.click('btn-save-registration')
  await h.page.waitForFunction(
    () => document.querySelectorAll('[data-testid="rows-gst-registrations"] tbody tr').length === 2,
    { timeout: 10000 }
  )
  await h.shot('02-two-registrations')

  regs = await h.invoke('gstReg:list')
  assertEq(regs.length, 2, 'the company now holds two registrations')
  const mhReg = regs.find((r) => r.gstin === MH)
  const gjReg = regs.find((r) => r.gstin === GJ)
  assertEq(gjReg.stateCode, '24', "the state code follows the GSTIN's first two digits")
  assert(mhReg.isPrimary && !gjReg.isPrimary, 'the original registration stays primary')

  // The existing return did not move one rupee.
  const afterSecond = await h.invoke('gst:gstr1', { from, to, period, registrationId: mhReg.id })
  assertEq(
    JSON.stringify(afterSecond.summary),
    JSON.stringify(beforeSecond.summary),
    'adding a second registration changes nothing in the first one\'s return'
  )

  // ---- 3. place of supply against the SUPPLYING registration ----
  await postSale('Buyer Surat', 50000, gjReg.id)

  const gjReturn = await h.invoke('gst:gstr1', { from, to, period, registrationId: gjReg.id })
  assertEq(gjReturn.gstin, GJ, "Gujarat's GSTR-1 is filed under Gujarat's GSTIN")
  const gjB2b = gjReturn.summary.find((s) => s.section === 'b2b')
  assertEq(gjB2b.taxable, 50000, "Gujarat's return covers only Gujarat's supply")
  assert(gjB2b.cgst > 0 && gjB2b.igst === 0, 'Gujarat to Gujarat is CGST+SGST, not IGST')

  const mhReturn = await h.invoke('gst:gstr1', { from, to, period, registrationId: mhReg.id })
  const mhB2b = mhReturn.summary.find((s) => s.section === 'b2b')
  assertEq(mhB2b.taxable, 100000, "Maharashtra's return covers only Maharashtra's supply")

  // The same invoice, attributed to Maharashtra, would be taxed inter-state — the error this
  // whole feature exists to prevent, asserted rather than described.
  const voucherList = await h.invoke('voucher:list', { from, to })
  const suratVoucher = voucherList.find((r) => r.account === 'Buyer Surat')
  const asMh = await h.invoke('voucher:get', { id: suratVoucher.id })
  await h.invoke('voucher:save', { id: asMh.id, data: { ...asMh, gstRegistrationId: mhReg.id } })
  const misfiled = await h.invoke('gst:gstr1', { from, to, period, registrationId: mhReg.id })
  const misfiledB2b = misfiled.summary.find((s) => s.section === 'b2b')
  assert(misfiledB2b.igst > 0, 'billed from Maharashtra, the Surat invoice becomes IGST')
  // Put it back where it belongs.
  await h.invoke('voucher:save', { id: asMh.id, data: { ...asMh, gstRegistrationId: gjReg.id } })

  // ---- 4. GSTR-3B per GSTIN, and the two re-add ----
  const b3mh = await h.invoke('gst:gstr3b', { from, to, period, registrationId: mhReg.id })
  const b3gj = await h.invoke('gst:gstr3b', { from, to, period, registrationId: gjReg.id })
  assertEq(
    b3mh.outward.taxable + b3gj.outward.taxable,
    150000,
    'the two registrations\' 3Bs re-add to the whole book'
  )

  // ---- 5. the books stay whole ----
  const tb = await h.invoke('report:trialBalance', { asOn: to })
  const salesRow = tb.rows.find((r) => r.ledgerName === 'Sales 18')
  assertEq(salesRow.credit, 150000, 'the trial balance is the whole entity, not one registration')

  // ---- 6. the picker appears, now that there is something to pick ----
  await h.goto('gstr1')
  await h.page.waitForSelector('[data-testid="select-gstr1-gstin"]', { timeout: 10000 })
  await h.shot('03-gstin-picker')

  // ---- 7. two GSTINs file two returns for the same month ----
  await h.invoke('filings:record', {
    form: 'GSTR-3B', period: `${fyStart}-07`, dueDate: `${fyStart}-08-20`,
    filedAt: `${fyStart}-08-18`, arn: 'AA27JUL0001X', taxPaid: 18000, notes: null,
    registrationId: mhReg.id
  })
  await h.invoke('filings:record', {
    form: 'GSTR-3B', period: `${fyStart}-07`, dueDate: `${fyStart}-08-20`,
    filedAt: `${fyStart}-08-19`, arn: 'AA24JUL0001X', taxPaid: 9000, notes: null,
    registrationId: gjReg.id
  })
  const arnOf = async (registrationId) => {
    const rows = await h.invoke('filings:register', { fyStartYear: fyStart, registrationId })
    return rows.find((r) => r.form === 'GSTR-3B' && r.period === `${fyStart}-07`)?.record?.arn ?? null
  }
  assertEq(await arnOf(mhReg.id), 'AA27JUL0001X', 'Maharashtra has its own ARN for July')
  assertEq(await arnOf(gjReg.id), 'AA24JUL0001X', 'Gujarat has its own ARN for the same July')

  // ---- 8. stock moved between registrations is a supply, and it is reported ----
  //
  // Schedule I para 2: a supply between two registrations of the same person is taxable even
  // without consideration. Raising that invoice is scenario 52's subject. What this app must
  // never do is let the movement pass silently, and that is what this asserts.
  const godowns = await h.invoke('master:godowns:list')
  const mumbai = godowns[0]
  await h.invoke('master:godowns:update', {
    id: mumbai.id, data: { name: mumbai.name, gstRegistrationId: mhReg.id }
  })
  const surat = await h.invoke('master:godowns:create', {
    name: 'Surat warehouse', gstRegistrationId: gjReg.id
  })

  const units = await h.invoke('master:units:list')
  await h.invoke('master:stockItems:create', {
    name: 'Widget', unitId: units[0].id, gstRate: 18, hsn: '8481', openingQtyMilli: 0, openingValue: 0
  })
  const items = await h.invoke('master:stockItems:list')
  const widget = items.find((i) => i.name === 'Widget')

  await mk({ name: 'Purchases 18', groupId: gid('Purchase Accounts'), gstRate: 18 })
  const ledgers2 = await h.invoke('master:ledgers:list')
  const purchases = ledgers2.find((l) => l.name === 'Purchases 18').id
  const cash = ledgers2.find((l) => l.name === 'Cash').id
  const purchaseType = types.find((t) => t.kind === 'purchase').id
  await h.invoke('voucher:save', {
    data: {
      voucherTypeId: purchaseType,
      date: `${fyStart}-07-02`,
      partyLedgerId: null,
      lines: [
        { ledgerId: purchases, drCr: 'dr', amount: 100000, costAllocations: [] },
        { ledgerId: cash, drCr: 'cr', amount: 100000, costAllocations: [] }
      ],
      inventory: [
        { stockItemId: widget.id, godownId: mumbai.id, qtyMilli: 10000, ratePaise: 10000, amount: 100000, direction: 'in' }
      ],
      billRefs: [],
      tds: null
    }
  })

  // ---- 9. the counter uses and stamps the supplying registration ----
  const mhCart = await h.invoke('counter:price', {
    lines: [{ stockItemId: widget.id, qtyMilli: 1000, ratePaise: 10000 }],
    date: `${fyStart}-08-05`, partyLedgerId: L('Buyer Mumbai'), pricingMode: 'exclusive',
    gstRegistrationId: mhReg.id
  })
  const gjCart = await h.invoke('counter:price', {
    lines: [{ stockItemId: widget.id, qtyMilli: 1000, ratePaise: 10000 }],
    date: `${fyStart}-08-05`, partyLedgerId: L('Buyer Mumbai'), pricingMode: 'exclusive',
    gstRegistrationId: gjReg.id
  })
  assert(mhCart.supply === 'intra' && mhCart.gst.cgst > 0, 'the Maharashtra till charges local tax to Mumbai')
  assert(gjCart.supply === 'inter' && gjCart.gst.igst > 0, 'the Gujarat till charges IGST to the same Mumbai buyer')
  const counterSale = await h.invoke('counter:sale', {
    lines: [{ stockItemId: widget.id, qtyMilli: 1000, ratePaise: 10000 }],
    tenders: [{ mode: 'cash', amountPaise: gjCart.payablePaise }],
    date: `${fyStart}-08-05`, partyLedgerId: L('Buyer Mumbai'), pricingMode: 'exclusive',
    gstRegistrationId: gjReg.id
  })
  assertEq(
    (await h.invoke('voucher:get', { id: counterSale.voucherId })).gstRegistrationId,
    gjReg.id,
    'the counter voucher is durably stamped with the selected GSTIN'
  )

  // ---- 10. reverse-charge documents are scoped and use the recipient registration ----
  const rcmVendor = await mk({
    name: 'RCM Freight Vendor', groupId: gid('Sundry Creditors'), stateCode: '27', rcm: true
  })
  const rcmExpense = await mk({
    name: 'RCM Freight Expense', groupId: gid('Direct Expenses'), gstRate: 5, hsn: '996511'
  })
  const postRcm = (registrationId, rcmDate, amount) => h.invoke('voucher:save', {
    data: {
      voucherTypeId: purchaseType, date: rcmDate, partyLedgerId: rcmVendor.id,
      gstRegistrationId: registrationId,
      lines: [
        { ledgerId: rcmExpense.id, drCr: 'dr', amount, costAllocations: [] },
        { ledgerId: rcmVendor.id, drCr: 'cr', amount, costAllocations: [] }
      ],
      inventory: [], billRefs: [], tds: null
    }
  })
  const rcmFrom = `${fyStart}-09-01`
  const rcmTo = `${fyStart}-09-30`
  const mhRcm = await postRcm(mhReg.id, `${fyStart}-09-10`, 100000)
  const gjRcm = await postRcm(gjReg.id, `${fyStart}-09-12`, 200000)
  assertEq(
    (await h.invoke('rcm:register', { from: rcmFrom, to: rcmTo, registrationId: mhReg.id })).pending[0].voucherId,
    mhRcm.id,
    'the Maharashtra RCM desk shows only its purchase'
  )
  assertEq(
    (await h.invoke('rcm:register', { from: rcmFrom, to: rcmTo, registrationId: gjReg.id })).pending[0].voucherId,
    gjRcm.id,
    'the Gujarat RCM desk shows only its purchase'
  )
  const gjSelfInvoice = await h.invoke('rcm:issue', {
    from: rcmFrom, to: rcmTo, consolidate: false, registrationId: gjReg.id
  })
  assertEq(gjSelfInvoice.issued.length, 1, 'only Gujarat issued its self-invoice')
  assert(gjSelfInvoice.issued[0].igst > 0, "Gujarat's document uses Gujarat as the recipient state")
  assertEq(
    (await h.invoke('rcm:register', { from: rcmFrom, to: rcmTo, registrationId: mhReg.id })).issued.length,
    0,
    "Gujarat's issued document never appears on Maharashtra's desk"
  )

  await h.invoke('stock:saveTransfer', {
    date: `${fyStart}-07-12`,
    fromGodownId: mumbai.id,
    toGodownId: surat.id,
    items: [{ stockItemId: widget.id, qtyMilli: 4000 }]
  })

  const crossed = await h.invoke('gstReg:crossTransfers', { from, to })
  assertEq(crossed.length, 1, 'the cross-registration movement is found')
  assertEq(crossed[0].fromGstin, MH, 'it left the Maharashtra registration')
  assertEq(crossed[0].toGstin, GJ, 'and arrived at the Gujarat one')

  // And the GST validation panel carries it, so it is visible where returns are prepared.
  const validation = await h.invoke('gst:validate', { from, to, registrationId: mhReg.id })
  assertEq(
    validation.crossRegistration.length,
    1,
    'the return-preparation check reports the branch transfer that has no invoice yet'
  )

  await h.goto('counter')
  await h.page.waitForSelector('[data-testid="select-counter-gstin"]', { timeout: 10000 })
  assertEq(await h.page.locator('[data-testid="select-counter-gstin"] option').count(), 2, 'the till offers both GSTINs')
  await h.goto('disclosure')
  await h.click('tab-disclosure-rcm')
  await h.page.waitForSelector('[data-testid="select-rcm-gstin"]', { timeout: 10000 })
  assertEq(await h.page.locator('[data-testid="select-rcm-gstin"] option').count(), 2, 'the RCM desk offers both GSTINs')
})
