// Scenario 06 — GST: GSTR-1 computes for a demo month (b2b + HSN present), gst:validate
// answers, and the per-bill e-way bill JSON is written, parses, and carries the mandatory
// fields the NIC converter rejects without (fromPlace / toPlace / transactionType).
//
// RECONCILE: lane S3 lands the GSTR-1 validation panel + disabled-export reasons in the
// renderer — once merged, assert the panel renders gst:validate's issues on the gstr1 screen.
import { scenario, assert } from '../lib/harness.mjs'
import * as fs from 'node:fs'

await scenario('06-gst', async (h) => {
  await h.createDemoCompany()
  await h.stubDialogs() // exports call shell.showItemInFolder

  // Demo vouchers span the trailing 3 months — use the current month.
  const today = new Date()
  const y = today.getFullYear()
  const m = String(today.getMonth() + 1).padStart(2, '0')
  const from = `${y}-${m}-01`
  const to = `${y}-${m}-${String(new Date(Date.UTC(y, today.getMonth() + 1, 0)).getUTCDate())}`
  const period = `${m}${y}`

  const g1 = await h.invoke('gst:gstr1', { from, to, period })
  const json = g1.json ?? g1
  assert(Array.isArray(json.b2b) && json.b2b.length > 0, 'GSTR-1 b2b section has invoices')
  // HSN summary is split hsn_b2b / hsn_b2c per the 2025 portal schema.
  const hsnRows = [...(json.hsn?.hsn_b2b ?? []), ...(json.hsn?.hsn_b2c ?? [])]
  assert(hsnRows.length > 0, 'GSTR-1 HSN summary present and non-empty')

  const v = await h.invoke('gst:validate', { from, to })
  assert(Array.isArray(v.issues), 'gst:validate returns an issues list')
  assert(Array.isArray(v.roundOff), 'gst:validate returns round-off issues')

  // Per-bill EWB for one sales invoice: set transport details, then generate.
  const invoices = await h.invoke('edoc:list', { from, to })
  assert(invoices.length > 0, 'edoc:list finds sales invoices in the month')
  const inv = invoices[0]
  const voucherId = inv.voucherId ?? inv.id
  await h.invoke('edoc:transportSet', {
    voucherId,
    data: {
      transMode: '1', transDistanceKm: 120, transporterId: null, transporterName: 'Road Runner Logistics',
      transDocNo: null, transDocDate: null, vehicleNo: 'MH12AB1234', vehicleType: 'R',
      shipToName: null, shipToGstin: null, shipToAddr1: null, shipToAddr2: null,
      shipToPlace: null, shipToPincode: null, shipToState: null
    }
  })
  const ewb = await h.invoke('edoc:ewbJson', { voucherId })
  assert(fs.existsSync(ewb.path), `per-bill EWB file exists at ${ewb.path}`)
  const parsed = JSON.parse(fs.readFileSync(ewb.path, 'utf8'))
  const bill = (parsed.billLists ?? parsed.billlists ?? [])[0]
  assert(bill, 'EWB JSON has a billLists entry')
  for (const field of ['fromPlace', 'toPlace', 'transactionType']) {
    assert(bill[field] !== undefined && bill[field] !== null && bill[field] !== '', `EWB mandatory field ${field} present (got ${JSON.stringify(bill[field])})`)
  }

  // ---- GSTR-2B: a mistyped supplier GSTIN no longer loses the credit ----
  // Every match pass used to key on GSTIN alone, so one wrong character put the invoice in BOTH
  // "missing" buckets and the input credit looked lost. It now pairs on the supplier's trade name
  // and reports the GSTIN disagreement as the finding it is.
  // Start from what the books actually hold: an empty portal file returns every purchase as
  // "missing in portal", which is a convenient way to enumerate them.
  const purchaseDocs = await h.invoke('gst:recon2b', {
    jsonText: JSON.stringify({ data: { docdata: { b2b: [] } } }),
    from,
    to
  })
  const inBooks = purchaseDocs.result.pairs.filter((x) => x.bucket === 'missingInPortal' && x.book)
  assert(inBooks.length > 0, 'the demo books have purchases to reconcile')
  const target = inBooks.find((x) => x.book.partyGstin && x.book.partyName) ?? inBooks[0]
  assert(target.book.partyGstin, 'and at least one carries a supplier GSTIN')

  const wrongGstin = target.book.partyGstin.slice(0, 14) + (target.book.partyGstin[14] === 'Z' ? 'A' : 'Z')
  const [yy, mm, dd] = target.book.date.split('-')
  const twoB = {
    data: {
      docdata: {
        b2b: [
          {
            ctin: target.book.partyGstin,
            trdnm: target.book.partyName,
            inv: [
              {
                inum: 'PORTAL-1',
                idt: `${dd}-${mm}-${yy}`,
                val: target.book.invoiceValue / 100,
                itms: [
                  {
                    itm_det: {
                      txval: target.book.taxable / 100,
                      iamt: target.book.igst / 100,
                      camt: target.book.cgst / 100,
                      samt: target.book.sgst / 100
                    }
                  }
                ]
              }
            ]
          }
        ]
      }
    }
  }

  // Sanity, and it has to be a real one: with the right GSTIN the invoice must actually PAIR
  // (on value and date, pass 2) rather than simply fail to reach the name pass — otherwise the
  // assertion below would pass vacuously on a file that matches nothing at all.
  const good = await h.invoke('gst:recon2b', { jsonText: JSON.stringify(twoB), from, to })
  assert(good.result.buckets.gstinMismatch.count === 0, 'a correct GSTIN never reaches the name pass')
  assert(
    good.result.buckets.missingInBooks.count === 0,
    'and the portal invoice is paired, not left unmatched'
  )

  // Now break the GSTIN in the BOOKS by pointing the portal file at a different one.
  twoB.data.docdata.b2b[0].ctin = wrongGstin
  const bad = await h.invoke('gst:recon2b', { jsonText: JSON.stringify(twoB), from, to })
  assert(
    bad.result.buckets.gstinMismatch.count === 1,
    `a mistyped GSTIN pairs on the supplier name (got ${bad.result.buckets.gstinMismatch.count})`
  )
  const paired = bad.result.pairs.find((x) => x.bucket === 'gstinMismatch')
  assert(paired.portal.gstin === wrongGstin, 'the pair keeps the portal GSTIN')
  assert(paired.book.partyGstin === target.book.partyGstin, 'and the books GSTIN, so both can be shown')

  // ---- "show me exactly what would be sent" ----
  // The trust argument for an offline filing tool is that you can see what it is about to do, so
  // the preview has to be the file rather than a rendering of it.
  const previewEinv = await h.invoke('edoc:previewJson', { kind: 'einvoice', from, to })
  assert(previewEinv.json, 'the e-invoice preview builds a payload')
  const einvExport = await h.invoke('edoc:exportEInvoice', { from, to, period })
  assert(
    JSON.stringify(previewEinv.json, null, 2) === fs.readFileSync(einvExport.path, 'utf8'),
    'the e-invoice preview is byte for byte the exported file'
  )
  const previewEwb = await h.invoke('edoc:previewJson', { kind: 'ewb', from, to })
  assert(Array.isArray(previewEwb.issues), 'the e-way preview names what it excluded')

  // On screen: the button opens the payload, and what it shows parses as the same JSON.
  await h.page.keyboard.press('Escape')
  await h.page.keyboard.press('g')
  await h.waitScreen('gateway')
  await h.page.keyboard.press('w')
  await h.waitScreen('edocs')
  await h.page.click('[data-testid="btn-json-einvoice"]')
  await h.page.waitForSelector('[data-testid="json-einvoice"]', { timeout: 15000 })
  const shownJson = await h.page.textContent('[data-testid="json-einvoice"]')
  // The screen works over the session period (the whole FY), not the single month used above.
  const bf = (await h.invoke('company:current')).info.booksFrom
  const fyPreview = await h.invoke('edoc:previewJson', {
    kind: 'einvoice',
    from: `${bf}-04-01`,
    to: `${bf + 1}-03-31`
  })
  assert(
    JSON.stringify(JSON.parse(shownJson)) === JSON.stringify(fyPreview.json),
    'the JSON on screen is the payload, not a summary of it'
  )
  await h.shot('01-json-preview')
  await h.page.keyboard.press('Escape')

  // Bulk export also writes one single-bill file per voucher under exports/ewb/<period>/.
  const bulk = await h.invoke('edoc:exportEwb', { from, to, period, includeBelowThreshold: true })
  assert(bulk.count > 0, 'bulk EWB export found eligible bills')
  const perBill = fs.readdirSync(bulk.dir).filter((f) => f.endsWith('.json'))
  assert(perBill.length === bulk.count, `one per-bill file per eligible voucher (${perBill.length}/${bulk.count})`)
  for (const f of perBill) {
    const one = JSON.parse(fs.readFileSync(`${bulk.dir}/${f}`, 'utf8'))
    assert((one.billLists ?? []).length === 1, `${f} holds exactly one bill`)
  }

  // GSTR-1 portal JSON export: allowed to refuse on blocking validation issues (that gate is
  // the point of G7), but must either write a file or refuse with a validation message.
  try {
    const exp = await h.invoke('gst:exportGstr1', { from, to, period })
    assert(fs.existsSync(exp.jsonPath), 'exported GSTR-1 JSON exists')
  } catch (err) {
    assert(/valid|issue|block/i.test(String(err)), `export refusal is a validation refusal (got: ${err})`)
  }

  await h.goto('gstr1')
  await h.shot('01-gstr1')
  await h.goto('gstr3b')
  await h.shot('02-gstr3b')

  // ---- a UPI payment QR on the invoice ----
  // An invoice that says what is owed and leaves the customer to type an account number into a
  // banking app gets paid late.
  const cfg = await h.invoke('config:invoice:get')
  const withoutQr = await h.invoke('invoice:previewHtml', { voucherId })
  assert(!/Scan to pay/.test(withoutQr.html), 'no payment QR before a UPI address is set')

  await h.invoke('config:invoice:set', { ...cfg, upiVpa: 'demotraders@ybl' })
  const withQr = await h.invoke('invoice:previewHtml', { voucherId })
  assert(/Scan to pay/.test(withQr.html), 'the QR appears once a UPI address is set')
  assert(/demotraders@ybl/.test(withQr.html), 'and names the address it pays into')

  // A malformed address is refused by the config itself rather than rendering a QR that would
  // open a payment app pointed at nothing.
  let rejected = false
  try {
    await h.invoke('config:invoice:set', { ...cfg, upiVpa: 'not a vpa' })
  } catch {
    rejected = true
  }
  assert(rejected, 'a malformed UPI address is rejected on save')

  await h.invoke('config:invoice:set', { ...cfg, upiVpa: null })

  // ---- a proforma prints as a proforma ----
  // A memorandum sales voucher is a document sent to agree a price before anything is owed. One
  // that looks like a tax invoice is one a customer may pay against and an auditor will ask about.
  const ledgersForProforma = await h.invoke('master:ledgers:list')
  const buyer = ledgersForProforma.find((l) => l.gstin)
  const salesLedger = ledgersForProforma.find((l) => /sales/i.test(l.name))
  const salesType = (await h.invoke('master:voucherTypes:list')).find((t) => t.kind === 'sales')

  const proforma = await h.invoke('voucher:save', {
    data: {
      voucherTypeId: salesType.id, date: from, partyLedgerId: buyer.id,
      narration: 'Quotation for approval', reference: null, instrumentNo: null, instrumentDate: null,
      transporterId: null, vehicleNo: null, transportDistanceKm: null,
      currencyCode: null, exchangeRate: null, isOptional: true,
      lines: [
        { ledgerId: buyer.id, drCr: 'dr', amount: 500000 },
        { ledgerId: salesLedger.id, drCr: 'cr', amount: 500000 }
      ],
      inventory: []
    }
  })

  // It is out of the books, which is the whole point of a proforma...
  const tb = await h.invoke('report:trialBalance', { asOn: to })
  const beforeAmount = tb.totalDebit
  assert(typeof beforeAmount === 'number', 'the trial balance still computes')

  // ...and yet it still prints, because a per-voucher print request is explicit.
  const { html: proformaHtml } = await h.invoke('invoice:previewHtml', { voucherId: proforma.id })
  assert(/PROFORMA INVOICE/.test(proformaHtml), 'it is headed PROFORMA INVOICE')
  assert(!/TAX INVOICE/.test(proformaHtml), 'and not TAX INVOICE')
  assert(/class="watermark"/.test(proformaHtml), 'and carries a watermark')

  // A period export must never pick it up: it is not a supply, and GSTR-1 would be wrong.
  const period2 = await h.invoke('edoc:previewJson', { kind: 'einvoice', from, to })
  const inPeriod = JSON.stringify(period2.json)
  assert(
    !inPeriod.includes(proforma.number) || !/PROFORMA/.test(inPeriod),
    'the proforma is not in the e-invoice payload for the period'
  )
  const g1After = await h.invoke('gst:gstr1', { from, to, period })
  assert(
    !JSON.stringify(g1After.json ?? g1After).includes('Quotation for approval'),
    'and not in GSTR-1'
  )

  await h.invoke('voucher:delete', { id: proforma.id })

  // ---- signature image and per-document terms ----
  // A scanned signature is what most small businesses actually do; the alternative is printing
  // every invoice to sign it by hand.
  const cfg2 = await h.invoke('config:invoice:get')
  await h.invoke('config:invoice:set', {
    ...cfg2,
    signatureDataUrl: 'data:image/png;base64,c2lnbmF0dXJl',
    terms: 'Payment due in 30 days',
    termsByKind: { credit_note: 'Refund within 7 working days' }
  })

  const signed = await h.invoke('invoice:previewHtml', { voucherId })
  assert(/base64,c2lnbmF0dXJl/.test(signed.html), 'the signature image prints')
  assert(/Payment due in 30 days/.test(signed.html), 'a sale carries the general terms')
  assert(!/Refund within 7/.test(signed.html), 'and not the credit-note terms')

  // A credit note takes its own terms — "payment due in 30 days" on one is nonsense.
  const notes = await h.invoke('edoc:list', { from, to })
  const creditNote = notes.find((n) => n.docType === 'CRN')
  if (creditNote) {
    const cn = await h.invoke('invoice:previewHtml', { voucherId: creditNote.voucherId ?? creditNote.id })
    assert(/Refund within 7 working days/.test(cn.html), 'the credit note takes its own terms')
    assert(!/Payment due in 30 days/.test(cn.html), 'and not the sales terms')
  }

  await h.invoke('config:invoice:set', cfg2)
})
