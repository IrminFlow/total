// Scenario 70 — e-invoice JSON + IRN (WP 3.5) and the effective-dated GST registration + filing
// frequency (WP 8.0 / 8.3), in the full app:
//   1. Demo Traders (regular): a B2B sale of 2 Office Chairs to Umbrella Retail dated today
//      (₹13,000 + CGST / SGST 9% = ₹15,340) → e-Documents → "Export e-invoice JSON" (the export is
//      period-wide; the screen has no per-row e-invoice export) → the written einvoice-<period>.json
//      holds that invoice with the NIC schema fields equal to the voucher: Version 1.1, TranDtls
//      (GST / B2B), DocDtls No / Dt, SellerDtls / BuyerDtls GSTIN, ItemList HsnCd / AssAmt /
//      GstRt / CGST / SGST, ValDtls TotInvVal = the voucher total.
//   2. Live filing against the fake NIC sandbox (nicFake.testutil.ts on 127.0.0.1, as e2e 13):
//      the row's "Generate IRN" → the live-API confirmation → the IRN is stored (64 hex, ack no.,
//      audited), the row shows "IRN ✓" and no longer offers Generate IRN; renumbering the invoice
//      is refused (irn_renumber), a save that keeps its number goes through and keeps the IRN.
//      NIC follow-up: the signed invoice / QR are stored and shown read-only in "IRN details" (Save
//      JSON writes them); while the IRN is live an amount change is refused (irn_frozen) and the bin
//      too (irn_live); Cancel IRN (reason + remark + confirmation) records the cancel and the change
//      goes through; a second invoice's e-way bill is cancelled from the same panel (history kept),
//      and Extend says when its ±8 h window opens.
//   3. An unregistered company (created through the UI) → Company details: GSTIN + "Regular from"
//      10 days ago → company:current carries gstRegistrationSince / gstPreviousRegistrationType and
//      the screen says "Regular since … · unregistered before"; a sale with CGST / SGST lines dated
//      the day before is refused (WP 8.0), one dated on the registration day is accepted.
//   4. The GSTR-1 filing picker (shown once the company is regular) → Quarterly → gstProfile:get
//      says quarterly, and the Gateway's Compliance card shows the quarter (not a month) with the
//      "Quarterly filer — dates UNVERIFIED" chip.
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { scenario, assert, assertEq, fixedToday, relativeDate } from '../lib/harness.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const { createFakeNic } = await import(path.join(here, '../../src/main/services/nicFake.testutil.ts'))

/** Serve a fake NIC over HTTP on an ephemeral 127.0.0.1 port (as e2e 13). */
async function serveFake(fake) {
  const server = http.createServer((req, res) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', async () => {
      try {
        const body = chunks.length ? Buffer.concat(chunks).toString('utf8') : undefined
        const headers = Object.fromEntries(Object.entries(req.headers).map(([k, v]) => [k, Array.isArray(v) ? v.join(',') : String(v)]))
        const r = await fake.fetch(`http://127.0.0.1${req.url}`, { method: req.method, headers, body })
        let payload
        try { payload = JSON.stringify(await r.json()) } catch { payload = '<html>Bad gateway</html>' }
        res.writeHead(r.status, { 'Content-Type': 'application/json' })
        res.end(payload)
      } catch (e) {
        res.writeHead(500)
        res.end(String(e))
      }
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return { server, url: `http://127.0.0.1:${server.address().port}` }
}

const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const slash = (iso) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`
const display = (iso) => `${iso.slice(8, 10)}-${MON[Number(iso.slice(5, 7)) - 1]}-${iso.slice(2, 4)}`
const typed = (iso) => `${iso.slice(8, 10)}-${iso.slice(5, 7)}-${iso.slice(0, 4)}`

/** The quarter the Compliance card shows for a quarterly filer in Maharashtra (rule 61(1)(ii):
 *  GSTR-3B on the 22nd after the quarter; shared/gst/filing.ts): the quarter whose GSTR-3B falls
 *  in the next 45 days (services/dashboard.ts dashGst), else the running quarter "so far". */
function expectedQuarter(today) {
  const ty = Number(today.slice(0, 4))
  const tm = Number(today.slice(5, 7))
  const horizon = relativeDate(45, today)
  for (let k = -4; k <= 2; k++) {
    const idx = ty * 12 + (tm - 1) + k
    const qy = Math.floor(idx / 12)
    const qm = (idx % 12) + 1
    if (qm % 3 !== 0) continue
    const dueIdx = idx + 1
    const due = `${Math.floor(dueIdx / 12)}-${String((dueIdx % 12) + 1).padStart(2, '0')}-22`
    if (due >= today && due <= horizon) return { label: `${MON[qm - 3]}–${MON[qm - 1]} ${qy}`, due }
  }
  const qs = tm - ((tm - 1) % 3)
  return { label: `${MON[qs - 1]}–${MON[tm - 1]} ${ty} so far`, due: null }
}

const HEADER = {
  narration: null, reference: null, instrumentNo: null, instrumentDate: null, transporterId: null, vehicleNo: null,
  transportDistanceKm: null, currencyCode: null, exchangeRate: null, inventory: [], billRefs: [], tds: null
}

await scenario('70-einvoice-gst-profile', async (h) => {
  const page = h.page
  const today = fixedToday

  // ================= 1. e-invoice JSON from the e-Documents screen =================
  await h.createDemoCompany()
  await h.stubDialogs()
  const { info: demo, slug } = await h.invoke('company:current')
  assertEq(demo.gstRegistrationType, 'regular', 'Demo Traders is a regular registration')
  const ledgers = await h.invoke('master:ledgers:list')
  const L = (name) => {
    const l = ledgers.find((x) => x.name === name)
    assert(l, `demo ledger ${name}`)
    return l
  }
  const buyer = L('Umbrella Retail')
  const chair = (await h.invoke('master:stockItems:list')).find((i) => i.name === 'Office Chair')
  assert(chair && chair.hsn === '9401' && chair.gstRate === 18, 'Office Chair: HSN 9401, 18%')
  const salesType = (await h.invoke('master:voucherTypes:list')).find((t) => t.kind === 'sales')
  // 2 × ₹6,500 = ₹13,000 taxable; intra-state (27 → 27): CGST + SGST 9% = ₹1,170 each → ₹15,340.
  const saleData = {
    ...HEADER, voucherTypeId: salesType.id, date: today, partyLedgerId: buyer.id, narration: 'e2e 70 B2B sale',
    lines: [
      { ledgerId: buyer.id, drCr: 'dr', amount: 1_534_000, costAllocations: [] },
      { ledgerId: L('Sales A/c').id, drCr: 'cr', amount: 1_300_000, costAllocations: [] },
      { ledgerId: L('CGST Output').id, drCr: 'cr', amount: 117_000, costAllocations: [] },
      { ledgerId: L('SGST Output').id, drCr: 'cr', amount: 117_000, costAllocations: [] }
    ],
    inventory: [{ stockItemId: chair.id, godownId: null, qtyMilli: 2000, ratePaise: 650_000, discountPaise: 0, amount: 1_300_000, direction: 'out' }]
  }
  const saved = await h.invoke('voucher:save', { data: saleData })
  const sale = await h.invoke('voucher:get', { id: saved.id })
  const total = sale.lines.find((l) => l.ledgerId === buyer.id).amount
  assertEq(total, 1_534_000, 'the invoice total')

  // Live filing set up before the screen first loads (Settings → NIC itself is e2e 13's).
  const LIVE = { username: 'api_e2e70_user', password: 'E2e70#Sandbox', clientId: 'AAACL07TXE70', clientSecret: 'cs-e2e70-Secret' }
  const fake = createFakeNic({ ...LIVE, gstins: [demo.gstin] })
  const { server, url } = await serveFake(fake)
  try {
    await h.invoke('nic:save', { baseUrlEinvoice: url, baseUrlEwb: '', ...LIVE, publicKeyPem: fake.publicKeyPem })

    await h.goto('edocs')
    const row = `[data-testid="rows-edocs"] [data-row-id="${sale.id}"]`
    await page.waitForSelector(row, { timeout: 15000 })
    assertEq((await page.textContent('[data-testid="edocs-live-status"]'))?.trim(), 'Live filing on', 'NIC credentials → live filing')
    assert((await page.textContent(row)).includes('no IRN'), 'the new invoice has no IRN yet')

    const exportsDir = path.join(h.dataDir, 'companies', slug, 'exports')
    const einvFiles = () => (fs.existsSync(exportsDir) ? fs.readdirSync(exportsDir).filter((f) => /^einvoice-\d{6}\.json$/.test(f)) : [])
    assertEq(einvFiles().length, 0, 'no e-invoice file before the export')
    await h.click('btn-edocs-export-einvoice')
    await page.waitForFunction(() => /B2B invoices? written for IRN generation/.test(document.body.textContent ?? ''), null, { timeout: 15000 })
    await h.shot('01-edocs-einvoice-exported')
    const files = einvFiles()
    assertEq(files.length, 1, `one e-invoice file written (${files.join(', ')})`)
    const docs = JSON.parse(fs.readFileSync(path.join(exportsDir, files[0]), 'utf8'))
    assert(Array.isArray(docs) && docs.length >= 1, 'the file is an array of e-invoice documents')
    const doc = docs.find((d) => d.DocDtls?.No === sale.number)
    assert(doc, `the file carries invoice ${sale.number}`)
    assertEq(doc.Version, '1.1', 'Version')
    assertEq(JSON.stringify(doc.TranDtls), JSON.stringify({ TaxSch: 'GST', SupTyp: 'B2B', RegRev: 'N', IgstOnIntra: 'N' }), 'TranDtls')
    assertEq(doc.DocDtls.Typ, 'INV', 'DocDtls.Typ')
    assertEq(doc.DocDtls.Dt, slash(today), 'DocDtls.Dt (dd/mm/yyyy)')
    assertEq(doc.SellerDtls.Gstin, demo.gstin, 'SellerDtls.Gstin')
    assertEq(doc.SellerDtls.Stcd, '27', 'SellerDtls.Stcd')
    assertEq(doc.BuyerDtls.Gstin, buyer.gstin, 'BuyerDtls.Gstin')
    assertEq(doc.BuyerDtls.Pos, '27', 'BuyerDtls.Pos (intra-state)')
    assertEq(doc.ItemList.length, 1, 'one item line')
    const it = doc.ItemList[0]
    assertEq(it.HsnCd, '9401', 'ItemList HsnCd')
    assertEq(it.Qty, 2, 'ItemList Qty')
    assertEq(it.UnitPrice, 6500, 'ItemList UnitPrice')
    assertEq(it.AssAmt, 13000, 'ItemList AssAmt')
    assertEq(it.GstRt, 18, 'ItemList GstRt')
    assertEq(it.CgstAmt, 1170, 'ItemList CgstAmt')
    assertEq(it.SgstAmt, 1170, 'ItemList SgstAmt')
    assertEq(it.IgstAmt, 0, 'ItemList IgstAmt')
    assertEq(it.TotItemVal, 15340, 'ItemList TotItemVal')
    assertEq(doc.ValDtls.AssVal, 13000, 'ValDtls AssVal')
    assertEq(doc.ValDtls.CgstVal + doc.ValDtls.SgstVal, 2340, 'ValDtls CGST + SGST')
    assertEq(doc.ValDtls.TotInvVal, total / 100, 'ValDtls TotInvVal = the voucher total')

    // ================= 2. Generate IRN against the fake NIC =================
    assertEq(fake.irns.size, 0, 'nothing filed by the JSON export')
    await page.locator(row).locator('button', { hasText: 'Generate IRN' }).click()
    await page.waitForSelector('text=Live government API call', { timeout: 10000 })
    await page.getByLabel('I understand this calls the live government API').check()
    await page.getByRole('button', { name: 'Continue' }).click()
    await page.waitForFunction((sel) => document.querySelector(sel)?.textContent?.includes('IRN ✓'), row, { timeout: 20000 })
    await page.waitForFunction(() => /IRN generated — ack \d+/.test(document.body.textContent ?? ''), null, { timeout: 10000 })
    await h.shot('02-edocs-irn-generated')
    assertEq(await page.locator(row).locator('button', { hasText: 'Generate IRN' }).count(), 0, 'Generate IRN is no longer offered')
    assertEq(fake.irns.size, 1, 'exactly one IRN filed')
    const filed = [...fake.irns.values()][0]
    assert(fake.calls.some((c) => c.path === '/eicore/v1.03/Invoice'), 'the Generate IRN call was made')
    assertEq(filed.doc.DocDtls.No, sale.number, 'NIC received this invoice')
    const withIrn = await h.invoke('voucher:get', { id: sale.id })
    assert(/^[0-9a-f]{64}$/i.test(withIrn.irn ?? ''), `the IRN is stored (${withIrn.irn})`)
    assertEq(withIrn.irn, filed.irn, 'the stored IRN is the one NIC issued')
    assertEq(withIrn.irnAckNo, filed.ackNo, 'the ack number is stored')
    assertEq(await page.getAttribute(`${row} [title="${withIrn.irn}"]`, 'title'), withIrn.irn, 'the row carries the IRN')
    const vAudit = await h.invoke('audit:list', { entity: 'voucher', entityId: sale.id })
    assert(JSON.stringify(vAudit).includes(withIrn.irn), 'the IRN is audited on the voucher')

    // The invoice can no longer be renumbered …
    let refused = ''
    try {
      await h.invoke('voucher:save', { id: sale.id, data: { ...saleData, number: `${sale.number}-R` } })
    } catch (err) {
      refused = String(err.message)
    }
    assert(refused.includes('has an e-invoice IRN'), `renumbering refused: ${refused}`)
    assertEq((await h.invoke('voucher:get', { id: sale.id })).number, sale.number, 'the number is unchanged')
    // … but a save that keeps its number (a narration fix) goes through and keeps the IRN.
    await h.invoke('voucher:save', { id: sale.id, data: { ...saleData, number: sale.number, narration: 'e2e 70 B2B sale (checked)' } })
    const resaved = await h.invoke('voucher:get', { id: sale.id })
    assertEq(resaved.narration, 'e2e 70 B2B sale (checked)', 'the narration fix saved')
    assertEq(resaved.irn, withIrn.irn, 'the IRN survives an ordinary edit')

    // ---- 2b. The signed copies (generate-irn v1.03 SignedInvoice / SignedQRCode), read-only ----
    const record = await h.invoke('nic:record', { voucherId: sale.id })
    assertEq(record.signedQrCode, filed.signedQr, 'the signed QR NIC returned is stored')
    assertEq(record.signedInvoice, filed.signedInvoice, 'the signed invoice NIC returned is stored')
    await page.locator(row).locator('[data-testid="btn-edocs-details"]').click()
    await page.waitForSelector('[data-testid="edoc-details-signed-qr"]', { timeout: 10000 })
    assertEq(await page.inputValue('[data-testid="edoc-details-signed-qr"]'), filed.signedQr, 'IRN details shows the signed QR')
    assertEq((await page.textContent('[data-testid="edoc-details-ack-no"]'))?.trim(), filed.ackNo, 'IRN details shows the ack no.')
    assert((await page.textContent('[data-testid="edoc-details-unverified"]')).includes('never run against the real NIC portal'), 'the UNVERIFIED list is on the screen')
    await h.click('btn-edoc-signed-save')
    await page.waitForFunction(() => /Signed e-invoice JSON written/.test(document.body.textContent ?? ''), null, { timeout: 10000 })
    const signedDir = path.join(exportsDir, 'einvoice-signed')
    const signedFiles = fs.readdirSync(signedDir)
    assertEq(signedFiles.length, 1, `one signed-copy file (${signedFiles.join(', ')})`)
    const signedJson = JSON.parse(fs.readFileSync(path.join(signedDir, signedFiles[0]), 'utf8'))
    assertEq(signedJson.Irn, withIrn.irn, 'the saved JSON carries the IRN')
    assertEq(signedJson.SignedQRCode, filed.signedQr, 'the saved JSON carries the signed QR')
    await h.shot('02b-edocs-irn-details')

    // ---- 2c. Correction workflow: a live IRN freezes amounts and keeps the invoice out of the bin ----
    const raw = (channel, payload) => page.evaluate(([c, p]) => window.total.invoke(c, p), [channel, payload])
    const more = {
      ...saleData, number: sale.number,
      lines: [
        { ...saleData.lines[0], amount: 2_301_000 }, { ...saleData.lines[1], amount: 1_950_000 },
        { ...saleData.lines[2], amount: 175_500 }, { ...saleData.lines[3], amount: 175_500 }
      ],
      inventory: [{ ...saleData.inventory[0], qtyMilli: 3000, amount: 1_950_000 }]
    }
    const frozen = await raw('voucher:save', { id: sale.id, data: more })
    assertEq(frozen.ok, false, 'an amount change on a live IRN is refused')
    assertEq(frozen.code, 'irn_frozen', `irn_frozen (${frozen.error})`)
    assert(frozen.error.includes('Cancel the IRN first'), 'the message points to Cancel IRN')
    const binned = await raw('voucher:delete', { id: sale.id })
    assertEq(binned.ok, false, 'binning a live IRN is refused')
    assertEq(binned.code, 'irn_live', `irn_live (${binned.error})`)

    // ---- 2d. Cancel IRN (cancel-irn v1.03, within 24 h): reason + remark + confirmation ----
    await h.click('btn-edoc-irn-cancel')
    await page.selectOption('[data-testid="input-edoc-irn-cancel-reason"]', 'data_entry_mistake')
    await h.fill('input-edoc-irn-cancel-remark', 'Wrong quantity')
    await page.check('[data-testid="input-edoc-irn-cancel-understood"]')
    await h.click('btn-edoc-irn-cancel-confirm')
    await page.waitForSelector('[data-testid="edoc-irn-cancelled-state"]', { timeout: 15000 })
    assertEq(fake.irns.get(withIrn.irn).status, 'CNL', 'NIC holds the IRN as cancelled')
    const cancelCall = fake.calls.findLast((c) => c.path === '/eicore/v1.03/Invoice/Cancel')
    assertEq(JSON.stringify(cancelCall.plain), JSON.stringify({ Irn: withIrn.irn, CnlRsn: '2', CnlRem: 'Wrong quantity' }), 'the cancel request (CnlRsn 2 = data entry mistake)')
    const afterCancel = await h.invoke('nic:record', { voucherId: sale.id })
    assertEq(afterCancel.irn, withIrn.irn, 'the cancelled IRN is kept')
    assertEq(afterCancel.irnCancelledAt, fake.irns.get(withIrn.irn).cancelDate, 'the cancel date is recorded')
    assertEq(afterCancel.irnCancelRemark, 'Wrong quantity', 'the remark is recorded')
    await h.shot('02d-edocs-irn-cancelled')
    await page.keyboard.press('Escape')
    await page.waitForFunction((sel) => document.querySelector(sel)?.textContent?.includes('IRN cancelled'), row, { timeout: 10000 })
    const cAudit = await h.invoke('audit:list', { entity: 'voucher', entityId: sale.id })
    assert(JSON.stringify(cAudit).includes('irnCancelledAt'), 'the cancel is audited on the voucher')
    // The correction can now be made.
    await h.invoke('voucher:save', { id: sale.id, data: more })
    assertEq((await h.invoke('voucher:get', { id: sale.id })).inventory[0].qtyMilli, 3000, 'after the cancel the amounts can change')

    // ---- 2e. e-Way bill on a second invoice: cancel (CANEWB, 24 h); extend says when it opens ----
    const second = await h.invoke('voucher:save', { data: { ...saleData, narration: 'e2e 70 second sale' } })
    await h.invoke('nic:generateIrn', { voucherId: second.id })
    await h.invoke('edoc:transportSet', {
      voucherId: second.id,
      data: {
        transMode: '1', transDistanceKm: 120, transporterId: null, transporterName: 'Local Carrier', transDocNo: null, transDocDate: null,
        vehicleNo: 'MH12AB1234', vehicleType: 'R', shipToName: null, shipToGstin: null, shipToAddr1: null, shipToAddr2: null, shipToPlace: null, shipToPincode: null, shipToState: null
      }
    })
    const ewb = await h.invoke('nic:generateEwb', { voucherId: second.id })
    assert(/^\d{12}$/.test(ewb.ewbNo), `an e-way bill (${ewb.ewbNo})`)
    await h.goto('gateway')
    await h.goto('edocs')
    const row2 = `[data-testid="rows-edocs"] [data-row-id="${second.id}"]`
    await page.waitForSelector(row2, { timeout: 15000 })
    await page.locator(row2).locator('[data-testid="btn-edocs-details"]').click()
    await page.waitForSelector('[data-testid="edoc-ewb-event-generate"]', { timeout: 10000 })
    assert((await page.textContent('[data-testid="edoc-irn-cancel-closed"]')).includes('Cancel the e-way bill first'), 'Cancel IRN waits for the e-way bill')
    assert((await page.textContent('[data-testid="edoc-ewb-extend-closed"]')).includes('Validity can be extended from'), 'Extend says when its window opens')
    await h.click('btn-edoc-ewb-cancel')
    await page.selectOption('[data-testid="input-edoc-ewb-cancel-reason"]', 'duplicate')
    await h.fill('input-edoc-ewb-cancel-remark', 'Raised twice')
    await page.check('[data-testid="input-edoc-ewb-cancel-understood"]')
    await h.click('btn-edoc-ewb-cancel-confirm')
    await page.waitForSelector('[data-testid="edoc-ewb-event-cancel"]', { timeout: 15000 })
    assertEq(fake.ewbs.get(Number(ewb.ewbNo)).status, 'CNL', 'NIC holds the e-way bill as cancelled')
    const canCall = fake.calls.findLast((c) => c.path === '/ewaybillapi/v1.03/ewayapi')
    assertEq(canCall.plain.action, 'CANEWB', 'the CANEWB action')
    assertEq(canCall.plain.cancelRsnCode, 1, 'cancelRsnCode 1 = duplicate')
    const afterEwb = await h.invoke('nic:record', { voucherId: second.id })
    assertEq(afterEwb.ewbNo, null, 'the live e-way bill is cleared')
    assertEq(afterEwb.ewbHistory.map((e) => e.action).join(','), 'generate,cancel', 'the history keeps both events')
    await h.shot('02e-edocs-ewb-cancelled')
    await page.keyboard.press('Escape')
  } finally {
    server.close()
  }

  // ================= 3. Unregistered → Regular, effective-dated =================
  await h.click('btn-switch-company')
  await h.createCompanyUI('Registration Change Co')
  const { info: before } = await h.invoke('company:current')
  assertEq(before.gstRegistrationType, 'unregistered', 'created unregistered')
  const groups = await h.invoke('master:groups:list')
  const gid = (name) => groups.find((g) => g.name === name).id
  const ledger = (name, group, extra = {}) =>
    h.invoke('master:ledgers:create', {
      name, groupId: gid(group), openingBalance: 0, gstin: null, stateCode: null, address: null, taxType: null, gstRate: null, hsn: null,
      tdsSectionId: null, pan: null, creditDays: null, exportType: null, ...extra
    })
  const sales = await ledger('Sales', 'Sales Accounts')
  const cgst = await ledger('CGST Output', 'Duties & Taxes', { taxType: 'cgst' })
  const sgst = await ledger('SGST Output', 'Duties & Taxes', { taxType: 'sgst' })
  const party = await ledger('Joshi Hardware', 'Sundry Debtors', { stateCode: '27' })
  const ownSalesType = (await h.invoke('master:voucherTypes:list')).find((t) => t.kind === 'sales')

  const GSTIN = '27AAPFU0939F1ZV'
  const since = relativeDate(-10)
  await page.click('header button[title="Company details"]')
  await h.waitScreen('company-info')
  assertEq(await page.$('[data-testid="select-gst-filing"]'), null, 'no filing picker while unregistered')
  const gstinInput = page.locator('label', { has: page.locator('span', { hasText: /^GSTIN$/ }) }).locator('input')
  await gstinInput.fill(GSTIN)
  await page.waitForSelector('[data-testid="input-company-reg-since"]', { timeout: 5000 })
  assert((await page.textContent('body')).includes('Regular from'), 'a new registration asks from when')
  await h.fill('input-company-reg-since', typed(since))
  await page.press('[data-testid="input-company-reg-since"]', 'Enter')
  await page.waitForFunction((want) => document.querySelector('[data-testid="input-company-reg-since"]')?.value === want, display(since), { timeout: 5000 })
  await h.shot('03-company-details-registering')
  await page.getByRole('button', { name: 'Save details' }).click()
  await page.waitForSelector('[data-testid="company-reg-history"]', { timeout: 10000 })
  assertEq(
    (await page.textContent('[data-testid="company-reg-history"]'))?.trim(),
    `Regular since ${display(since)} · unregistered before`,
    'Company details states the registration history'
  )
  const { info: after } = await h.invoke('company:current')
  assertEq(after.gstin, GSTIN, 'GSTIN saved')
  assertEq(after.gstRegistrationType, 'regular', 'now regular')
  assertEq(after.gstRegistrationSince, since, 'gstRegistrationSince = the date given')
  assertEq(after.gstPreviousRegistrationType, 'unregistered', 'gstPreviousRegistrationType = unregistered')

  // A taxed sale the day before the registration is refused; on the day it is accepted.
  const taxedSale = (date) => ({
    data: {
      ...HEADER, voucherTypeId: ownSalesType.id, date, partyLedgerId: party.id,
      lines: [
        { ledgerId: party.id, drCr: 'dr', amount: 11_800, costAllocations: [] },
        { ledgerId: sales.id, drCr: 'cr', amount: 10_000, costAllocations: [] },
        { ledgerId: cgst.id, drCr: 'cr', amount: 900, costAllocations: [] },
        { ledgerId: sgst.id, drCr: 'cr', amount: 900, costAllocations: [] }
      ]
    }
  })
  let early = ''
  try {
    await h.invoke('voucher:save', taxedSale(relativeDate(-1, since)))
  } catch (err) {
    early = String(err.message)
  }
  assert(early.includes('not registered for GST') && early.includes('Company details'), `a GST sale before the registration date is refused: ${early}`)
  const onTheDay = await h.invoke('voucher:save', taxedSale(since))
  const posted = await h.invoke('voucher:get', { id: onTheDay.id })
  assertEq(posted.lines.filter((l) => l.ledgerId === cgst.id || l.ledgerId === sgst.id).length, 2, 'a GST sale on the registration date is accepted with its tax lines')

  // ================= 4. GSTR-1 filing frequency: quarterly =================
  await page.waitForSelector('[data-testid="select-gst-filing"]', { timeout: 10000 })
  assertEq((await h.invoke('gstProfile:get')).filing, 'monthly', 'monthly until changed')
  await page.selectOption('[data-testid="select-gst-filing"]', 'quarterly')
  await page.getByRole('button', { name: 'Save details' }).click()
  await page.waitForFunction(() => /Company details saved/.test(document.body.textContent ?? ''), null, { timeout: 10000 })
  await page.waitForFunction(async () => (await window.total.invoke('gstProfile:get')).data?.filing === 'quarterly', null, { timeout: 10000 })
  assertEq((await h.invoke('gstProfile:get')).filing, 'quarterly', 'gstProfile:get says quarterly')
  await h.shot('04-company-details-quarterly')

  await h.goto('gateway')
  await page.waitForSelector('[data-testid="chip-gst-quarterly"]', { timeout: 15000 })
  assertEq((await page.textContent('[data-testid="chip-gst-quarterly"]'))?.trim(), 'Quarterly filer — dates UNVERIFIED', 'the quarterly chip')
  const want = expectedQuarter(today)
  const gstRow = await page.textContent('[data-testid="dash-gst"]')
  assert(gstRow.includes(`GST returns · ${want.label}`), `the GST row covers the quarter "${want.label}" (${gstRow})`)
  if (want.due) {
    const chip = (await page.textContent('[data-testid="chip-gstr3b"]'))?.trim() ?? ''
    assert(/^GSTR-3B (today|tomorrow|in \d+ days)$/.test(chip), `the GSTR-3B chip (${chip})`)
  }
  await h.shot('05-gateway-quarterly')
})
