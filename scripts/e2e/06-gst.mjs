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
  const prepare = h.page.locator('[data-testid="btn-gstr1-return-freeze"]')
  await prepare.waitFor({ state: 'visible', timeout: 10000 })
  assert(!(await prepare.isDisabled()), 'clean GSTR-1 period can be prepared')
  await prepare.click()
  await h.page.waitForSelector('[data-testid="input-gstr1-return-arn"]', { timeout: 10000 })
  await h.fill('input-gstr1-return-arn', 'AA2707261234567')
  await h.fill('input-gstr1-return-json', JSON.stringify({ filing: 'portal-copy', period }))
  await h.click('btn-gstr1-return-filed')
  await h.page.waitForFunction(() => document.body.textContent?.includes('Filed on') && document.body.textContent?.includes('AA2707261234567'))

  const lifecycle = await h.invoke('gst:returnStatus', { type: 'gstr1', from, to, period })
  assert(lifecycle.status === 'filed', 'GSTR-1 lifecycle is filed')
  assert(lifecycle.arn === 'AA2707261234567', 'GSTR-1 filing ARN is retained')
  assert(lifecycle.hasSubmittedJson === true, 'exact submitted portal JSON is retained')
  await h.shot('01-gstr1')

  const b2b = g1.summary.find((row) => row.section === 'b2b')
  assert(b2b?.voucherIds.length > 0, 'B2B summary exposes its exact contributing vouchers')
  await h.page.click('[data-testid="rows-gstr1"] tr[data-row-id="b2b"]')
  await h.waitScreen('daybook')
  const sourceRows = await h.page.locator('[data-testid="rows-daybook"] tr[data-row-id]').count()
  assert(sourceRows === b2b.voucherIds.length, `books-to-return drill shows only B2B source vouchers (${sourceRows}/${b2b.voucherIds.length})`)
  await h.shot('02-gstr1-source-vouchers')

  await h.goto('gstr3b')
  await h.shot('03-gstr3b')
  const g3 = await h.invoke('gst:gstr3b', { from, to, period })
  assert(g3.voucherIds.outward.length > 0, 'GSTR-3B outward row exposes source vouchers')
  await h.page.click('[data-testid="rows-gstr3b"] tr[data-source="outward"]')
  await h.waitScreen('daybook')
  const g3Rows = await h.page.locator('[data-testid="rows-daybook"] tr[data-row-id]').count()
  assert(g3Rows === g3.voucherIds.outward.length, `GSTR-3B drill shows exact outward source set (${g3Rows}/${g3.voucherIds.outward.length})`)
})
