// Scenario 75 — the GST gateway in test mode (Phase 4): a bill → IRN → e-way bill → GSTR-1 filed →
// GSTR-2B fetched, all through the built-in Test GSP (no network, nothing reaches the portal),
// driven from the accountant screens:
//   e-Invoice & e-way bill → "Portal (test)" → Generate IRN → Generate e-way bill (simulated; the
//   bill itself, its print and the e-documents list keep no IRN);
//   GSTR-1 → sign in (test OTP) → Send → Check status → File with EVC → ARN (labelled test, never
//   counted as filed: the Taxes / Home "filed" marks stay empty);
//   GSTR-2B → Fetch from the portal (test mode) → the screen's matcher shows the purchase bill
//   matched (the 2B assistant / Home / Taxes never take a simulated 2B for the portal's).
// Dates: the bills are two months back (that month is over and its GSTR-2B — the 14th of the next
// month — exists on every day of the year); the books begin early enough and the working period is
// moved to that bill's FY when it is not the current one.
import { scenario, assert, assertEq, fixedToday, fyStartYearOf } from '../lib/harness.mjs'

const GSTIN = '27AAPFU0939F1ZV'
const BUYER_GSTIN = '29AAACU1234F1ZM'
const SUPPLIER_GSTIN = '24AAACS1234C1Z4'
const OTP = '575757'

const [ty, tm] = fixedToday.split('-').map(Number)
const back = new Date(Date.UTC(ty, tm - 1 - 2, 1))
const month = `${back.getUTCFullYear()}-${String(back.getUTCMonth() + 1).padStart(2, '0')}`
const retPeriod = `${month.slice(5)}${month.slice(0, 4)}`
const saleDate = `${month}-05`
const purchaseDate = `${month}-03`
const daysBack = Math.ceil((Date.parse(fixedToday) - Date.parse(purchaseDate)) / 86_400_000) + 1

await scenario('75-gst-gateway', async (h) => {
  await h.createCompanyUI('Gateway Traders', { gstin: GSTIN, coverDaysBack: daysBack })
  const { info } = await h.invoke('company:current')
  await h.invoke('company:updateInfo', { ...info, gstin: GSTIN, address: '12 MG Road\nPune 411001' })

  // ---------- books: a sale to a Karnataka buyer, a purchase from a Gujarat supplier ----------
  const groups = await h.invoke('master:groups:list')
  const gid = (name) => groups.find((g) => g.name === name).id
  const mkLedger = (name, group, extra = {}) =>
    h.invoke('master:ledgers:create', { name, groupId: gid(group), openingBalance: 0, gstin: null, stateCode: null, address: null, taxType: null, gstRate: null, hsn: null, ...extra })
  const buyer = await mkLedger('Karnataka Buyer', 'Sundry Debtors', { gstin: BUYER_GSTIN, stateCode: '29', address: 'Shop 4, Brigade Road\nBengaluru 560001' })
  const supplier = await mkLedger('Gujarat Supplier', 'Sundry Creditors', { gstin: SUPPLIER_GSTIN, stateCode: '24', address: 'Ring Road\nSurat 395002' })
  const sales = await mkLedger('Sales GW', 'Sales Accounts')
  const purchases = await mkLedger('Purchases GW', 'Purchase Accounts')
  const igst = await mkLedger('IGST GW', 'Duties & Taxes', { taxType: 'igst' })
  const unit = (await h.invoke('master:units:list'))[0]
  const laptop = await h.invoke('master:stockItems:create', {
    name: 'Laptop 14', groupId: null, unitId: unit.id, hsn: '84713010', gstRate: 18, cessRate: null,
    openingQtyMilli: 10_000, openingValue: 30_000_000, barcode: null, reorderLevelMilli: null
  })
  const types = await h.invoke('master:voucherTypes:list')
  const typeOf = (kind) => types.find((t) => t.kind === kind).id
  const header = { narration: null, reference: null, instrumentNo: null, instrumentDate: null, transporterId: null, vehicleNo: null, transportDistanceKm: null, currencyCode: null, exchangeRate: null }
  // 2 × ₹45,000 = ₹90,000 + IGST 18 % ₹16,200 = ₹1,06,200.
  const sale = await h.invoke('voucher:save', {
    data: {
      ...header, voucherTypeId: typeOf('sales'), date: saleDate, partyLedgerId: buyer.id, number: 'GW-101',
      lines: [
        { ledgerId: buyer.id, drCr: 'dr', amount: 10_620_000 },
        { ledgerId: sales.id, drCr: 'cr', amount: 9_000_000 },
        { ledgerId: igst.id, drCr: 'cr', amount: 1_620_000 }
      ],
      inventory: [{ stockItemId: laptop.id, godownId: null, qtyMilli: 2000, ratePaise: 4_500_000, discountPaise: 0, amount: 9_000_000, direction: 'out' }]
    }
  })
  await h.invoke('edoc:transportSet', {
    voucherId: sale.id,
    data: { transMode: '1', transDistanceKm: 840, transporterId: null, transporterName: null, transDocNo: null, transDocDate: null, vehicleNo: 'MH12AB1234', vehicleType: 'R', shipToName: null, shipToGstin: null, shipToAddr1: null, shipToAddr2: null, shipToPlace: null, shipToPincode: null, shipToState: null }
  })
  // 1 × ₹40,000 + IGST ₹7,200 = ₹47,200 (their bill G-55).
  await h.invoke('voucher:save', {
    data: {
      ...header, voucherTypeId: typeOf('purchase'), date: purchaseDate, partyLedgerId: supplier.id, reference: 'G-55',
      lines: [
        { ledgerId: purchases.id, drCr: 'dr', amount: 4_000_000 },
        { ledgerId: igst.id, drCr: 'dr', amount: 720_000 },
        { ledgerId: supplier.id, drCr: 'cr', amount: 4_720_000 }
      ],
      inventory: [{ stockItemId: laptop.id, godownId: null, qtyMilli: 1000, ratePaise: 4_000_000, discountPaise: 0, amount: 4_000_000, direction: 'in' }]
    }
  })

  // The working period: the bill's FY.
  const billFy = fyStartYearOf(saleDate)
  if (billFy !== fyStartYearOf(fixedToday)) {
    await h.goto('edocs')
    await h.click('btn-period')
    await h.page.locator('[role="dialog"]').getByRole('button', { name: new RegExp(`FY ${billFy}`) }).click()
    await h.click('btn-apply-period')
  }

  const st = await h.invoke('gateway:status')
  assertEq(st.testMode, true, 'the gateway is in test mode')
  assertEq(st.liveFilingAvailable, false, 'live filing cannot be turned on')

  // ---------- 1. IRN and e-way bill from the e-documents screen ----------
  await h.goto('edocs')
  const row = `[data-row-id="${sale.id}"]`
  await h.page.waitForSelector(`${row} [data-testid="btn-edocs-gateway"]`, { timeout: 15000 })
  await h.page.click(`${row} [data-testid="btn-edocs-gateway"]`)
  await h.page.waitForSelector('[data-testid="gw-edoc-test-note"]', { timeout: 10000 })
  assert((await h.page.textContent('[data-testid="gw-edoc-test-note"]')).includes('nothing is sent to the GST portal'), 'the modal says test mode in plain words')
  await h.click('gw-edoc-irn-generate')
  await h.page.waitForFunction(() => /^[0-9a-f]{64}$/.test(document.querySelector('[data-testid="gw-edoc-irn"]')?.textContent ?? ''), null, { timeout: 15000 })
  const irn = await h.page.textContent('[data-testid="gw-edoc-irn"]')
  await h.click('gw-edoc-ewb-generate')
  await h.page.waitForFunction(() => /^\d{12} · valid till/.test(document.querySelector('[data-testid="gw-edoc-ewb"]')?.textContent ?? ''), null, { timeout: 15000 })
  await h.shot('01-irn-ewb-test')
  const rec = await h.invoke('gateway:edoc:record', { voucherId: sale.id })
  assertEq(rec.test, true, 'answered by the Test GSP')
  assertEq(rec.record.irn, irn, 'the stored simulated IRN is the one shown')
  assert(/^\d{12}$/.test(rec.record.ewbNo), `a 12-digit e-way bill (${rec.record.ewbNo})`)
  // The bill itself carries no IRN: the e-documents list, the print and the edit lock never see it.
  const list = await h.invoke('edoc:list', { from: `${month}-01`, to: `${month}-28` })
  assertEq(list.find((r) => r.voucherId === sale.id).irn, null, 'the e-documents list shows no IRN for the bill')
  assertEq((await h.invoke('nic:record', { voucherId: sale.id })).irn, null, 'the voucher keeps no IRN')
  await h.page.keyboard.press('Escape')

  // ---------- 2. GSTR-1 sent and filed (test) ----------
  await h.goto('gstr1')
  await h.page.waitForSelector('[data-testid="input-gstr1-month"]', { timeout: 15000 })
  await h.page.selectOption('[data-testid="input-gstr1-month"]', { value: month })
  await h.page.waitForSelector('[data-testid="gw-gstr1-panel"]', { timeout: 15000 })
  assert((await h.page.textContent('[data-testid="gw-gstr1-test-note"]')).includes('nothing is sent to the GST portal'), 'the panel says test mode')
  await h.click('gw-gstr1-signin')
  await h.fill('gw-gstr1-signin-otp', OTP)
  await h.click('gw-gstr1-signin-submit')
  await h.click('gw-gstr1-send')
  await h.page.waitForSelector('[data-testid="gw-gstr1-check"]', { timeout: 15000 })
  await h.click('gw-gstr1-check') // → the portal is checking it
  await h.page.waitForFunction(() => document.querySelector('[data-testid="gw-gstr1-state"]')?.textContent?.includes('checking'), null, { timeout: 10000 })
  await h.click('gw-gstr1-check') // → checked, ready to file
  await h.click('gw-gstr1-evc')
  await h.fill('gw-gstr1-file-otp', OTP)
  await h.click('gw-gstr1-file-submit')
  await h.page.waitForSelector('[data-testid="gw-gstr1-arn"]', { timeout: 15000 })
  const arn = (await h.page.textContent('[data-testid="gw-gstr1-arn"]')).trim()
  assert(new RegExp(`^AA27${retPeriod.slice(0, 2)}${retPeriod.slice(4)}\\d{7}[A-Z]$`).test(arn), `a simulated ARN (${arn})`)
  assert((await h.page.textContent('[data-testid="gw-gstr1-filed"]')).includes('does not count as filed'), 'the filing is labelled as a test')
  await h.shot('02-gstr1-filed-test')
  const ret = await h.invoke('gateway:return:get', { form: 'gstr1', period: retPeriod })
  assertEq(ret.state, 'filed', 'the return is filed on the Test GSP')
  assertEq(ret.test, true, 'and marked as a test')

  // ---------- 3. GSTR-2B fetched into the matcher ----------
  await h.goto('gstr2b')
  await h.page.waitForSelector('[data-testid="input-gstr2b-month"]', { timeout: 15000 })
  await h.page.selectOption('[data-testid="input-gstr2b-month"]', { value: month })
  await h.page.waitForSelector('[data-testid="gw-2b-fetch"]', { timeout: 15000 }) // still signed in from step 2
  await h.click('gw-2b-fetch')
  await h.page.waitForFunction(() => document.body.innerText.includes('G-55'), null, { timeout: 20000 })
  await h.page.waitForSelector('[data-testid="gstr2b-simulated"]', { timeout: 10000 })
  assertEq(await h.page.getByRole('tab', { name: /IMS actions/ }).count(), 0, 'no IMS actions tab on a simulated 2B')
  await h.shot('03-gstr2b-fetched')
  // The screen's matcher on the fetched JSON: the bill is matched.
  const recon = await h.invoke('gst:recon2b', { jsonText: (await h.invoke('gateway:2b:fetch', { period: retPeriod })).jsonText, from: `${month}-01`, to: `${month}-28` })
  assertEq(recon.result.pairs.filter((p) => p.bucket === 'matched').length, 1, 'the purchase bill matches the simulated 2B')
  // A simulation is built from the books: the 2B assistant, Home and Taxes never take it for the portal's.
  const mism = await h.invoke('assist:gst2b', { period: month })
  assertEq(mism.statement, null, 'the 2B assistant sees no portal statement')

  // ---------- nothing counts as really filed ----------
  const taxes = await h.invoke('simple:taxes', { period: month })
  assertEq(taxes.kind, 'regular', 'Taxes reads the regular GST answer')
  assertEq(taxes.filed.gstr1 ?? null, null, 'Taxes: a test filing is not a filed mark')
  assertEq(taxes.testFiled?.gstr1?.arn, arn, 'Taxes: the test filing is kept, labelled')
})
