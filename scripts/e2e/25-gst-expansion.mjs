// Scenario 25 — GST expansion (WP 3.4): open GSTR-9 for the demo year and see the year-vs-months
// comparison (ties, then a highlighted difference after an export + a later voucher); run the
// ITC reversal workings for a month with blocked credit, apply them to 3B and post the journal;
// paste a GSTR-2B for a demo month, bulk-accept the matched records on the IMS tab, reject the
// stray one, and export the action list. Also opens ITC-04 and the RCM self-invoice list.
import { scenario, assert, assertEq } from '../lib/harness.mjs'
import * as fs from 'node:fs'

const pad = (n) => String(n).padStart(2, '0')
const monthOf = (y, m) => {
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate()
  return { key: `${y}-${pad(m)}`, from: `${y}-${pad(m)}-01`, to: `${y}-${pad(m)}-${pad(last)}`, period: `${pad(m)}${y}` }
}

await scenario('25-gst-expansion', async (h) => {
  await h.createDemoCompany()
  await h.stubDialogs()

  const today = new Date()
  const months = [0, 1, 2].map((k) => {
    const d = new Date(Date.UTC(today.getFullYear(), today.getMonth() - k, 1))
    return monthOf(d.getUTCFullYear(), d.getUTCMonth() + 1)
  })
  const fyStart = today.getMonth() + 1 >= 4 ? today.getFullYear() : today.getFullYear() - 1

  // ---------- GSTR-9: the demo year ties to Σ the months ----------
  await h.goto('gstr1')
  await h.click('tab-gstr1-gstr9')
  await h.waitScreen('gstr9')
  await h.page.waitForSelector('[data-testid="gstr9-compare-status"]', { timeout: 20000 })
  const status = await h.page.textContent('[data-testid="gstr9-compare-status"]')
  assert(/ties/.test(status ?? ''), `GSTR-9 ties to the monthly returns on a fresh demo (got ${JSON.stringify(status)})`)
  const r9 = await h.invoke('gst:gstr9', { fyStartYear: fyStart })
  const b2b = r9.rows.find((r) => r.id === '4B')
  assert(b2b && b2b.amounts.taxable > 0 && b2b.docs.length > 0, 'GSTR-9 4B carries the demo B2B sales with their vouchers')
  assert(r9.compare.every((c) => c.diff.taxable === 0 && c.diff.igst + c.diff.cgst + c.diff.sgst === 0), 'every comparison line is nil')
  // Drill: expand 4B to its vouchers.
  await h.page.click('[data-testid="rows-gstr9"] tr[data-row="4B"] [aria-expanded]')
  await h.page.waitForSelector('[data-testid="rows-gstr9-docs-4b"] tr', { timeout: 10000 })
  await h.shot('01-gstr9')

  // Export one month's GSTR-1, then add a sale in it: the comparison must highlight the difference.
  const m0 = months[0]
  try {
    await h.invoke('gst:exportGstr1', { from: m0.from, to: m0.to, period: m0.period })
  } catch (err) {
    assert(/valid|issue|block/i.test(String(err)), `GSTR-1 export refused only by validation (${err})`)
  }
  const exported = (await h.invoke('gst:gstr9', { fyStartYear: fyStart })).months.find((m) => m.period === m0.period)
  if (exported?.source === 'exported') {
    const ledgers = await h.invoke('master:ledgers:list')
    const id = (name) => ledgers.find((l) => l.name === name)?.id
    const types = await h.invoke('master:voucherTypes:list')
    const salesType = types.find((t) => t.kind === 'sales').id
    await h.invoke('voucher:save', {
      data: {
        voucherTypeId: salesType, date: m0.from, partyLedgerId: id('Umbrella Retail'),
        lines: [
          { ledgerId: id('Umbrella Retail'), drCr: 'dr', amount: 118000 },
          { ledgerId: id('Sales A/c'), drCr: 'cr', amount: 100000 },
          { ledgerId: id('CGST Output'), drCr: 'cr', amount: 9000 },
          { ledgerId: id('SGST Output'), drCr: 'cr', amount: 9000 }
        ]
      }
    })
    const after = await h.invoke('gst:gstr9', { fyStartYear: fyStart })
    // A ledger-only sale (the demo's Sales A/c carries no GST rate) lands in nil-rated (5E /
    // GSTR-1 Table 8) — that line now differs from the exported month.
    const changed = after.compare.filter((c) => c.diff.taxable !== 0)
    assert(changed.some((c) => c.against === 'GSTR-1' && c.diff.taxable === 100000), `the post-export sale shows as a GSTR-1 difference (got ${JSON.stringify(changed.map((c) => [c.id, c.diff.taxable]))})`)
    assert(after.compare.filter((c) => c.against === 'GSTR-3B').every((c) => c.diff.taxable === 0), 'GSTR-3B (never exported) still ties')
    // Leave and come back: the screen re-reads its family on becoming visible.
    await h.click('tab-gstr9-gstr1')
    await h.waitScreen('gstr1')
    await h.click('tab-gstr1-gstr9')
    await h.waitScreen('gstr9')
    await h.page.waitForSelector('[data-testid="rows-gstr9-compare"] tr[data-diff="yes"]', { timeout: 20000 })
    await h.shot('02-gstr9-difference')
  }

  // ---------- ITC reversal: exempt turnover + blocked credit → apply to 3B → post the journal ----------
  // A nil-rated cash sale in every demo month gives rule 42 an exempt turnover (E); one supplier
  // marked blocked gives s.17(5) credit.
  const ledgers = await h.invoke('master:ledgers:list')
  const lid = (name) => ledgers.find((l) => l.name === name)?.id
  const vtypes = await h.invoke('master:voucherTypes:list')
  for (const m of months) {
    await h.invoke('voucher:save', {
      data: {
        voucherTypeId: vtypes.find((t) => t.kind === 'sales').id, date: m.from, partyLedgerId: lid('Cash'),
        lines: [{ ledgerId: lid('Cash'), drCr: 'dr', amount: 5000000 }, { ledgerId: lid('Sales A/c'), drCr: 'cr', amount: 5000000 }]
      }
    })
  }
  const gujarat = ledgers.find((x) => x.name === 'Gujarat Components Pvt Ltd')
  await h.invoke('master:ledgers:update', { id: gujarat.id, data: { ...gujarat, itcEligibility: 'blocked' } })
  let target = null
  for (const m of months) {
    const v = await h.invoke('gst:itcReversal', { from: m.from, to: m.to, period: m.period })
    const rule42 = v.summary.table4B1.igst + v.summary.table4B1.cgst + v.summary.table4B1.sgst
    if (v.proposal.length > 0 && rule42 > 0) {
      target = m
      break
    }
  }
  assert(target, 'some demo month has common credit to apportion (rule 42) and a journal to propose')
  await h.click('tab-gstr9-itc-reversal')
  await h.waitScreen('itc-reversal')
  await h.page.selectOption('[data-testid="input-itc-reversal-month"]', target.key)
  await h.page.waitForSelector('[data-testid="rows-itc-reversal-proposal"] tr', { timeout: 20000 })
  await h.shot('03-itc-reversal')
  await h.click('btn-itc-reversal-apply')
  await h.page.waitForSelector('[data-testid="btn-itc-reversal-apply"]:has-text("Applied")', { timeout: 15000 })
  const manual = await h.invoke('gst:3bManualGet', { period: target.period })
  const v = await h.invoke('gst:itcReversal', { from: target.from, to: target.to, period: target.period })
  assert(v.applied, 'the workings are applied to the 3B manual adjustments')
  assertEq(manual.itcRevRul.cgst, v.summary.table4B1.cgst, '3B 4(B)(1) carries the rule 42/43 figure')
  await h.click('btn-itc-reversal-post')
  await h.click('confirm-ok')
  await h.page.waitForSelector('[data-testid="itc-reversal-posted"]', { timeout: 15000 })
  const posted = (await h.invoke('gst:itcReversal', { from: target.from, to: target.to, period: target.period })).posted
  assert(posted?.voucherId, 'the ITC reversal journal is posted')
  const j = await h.invoke('voucher:get', { id: posted.voucherId })
  const dr = j.lines.filter((l) => l.drCr === 'dr').reduce((t, l) => t + l.amount, 0)
  const cr = j.lines.filter((l) => l.drCr === 'cr').reduce((t, l) => t + l.amount, 0)
  assert(dr === cr && dr === v.proposal.filter((l) => l.drCr === 'dr').reduce((t, l) => t + l.amount, 0), 'the journal balances and equals the proposal')
  await h.shot('04-itc-reversal-posted')

  // ---------- ITC-04 and self-invoices open ----------
  await h.click('tab-itc-reversal-itc04')
  await h.waitScreen('itc04')
  await h.shot('05-itc04')

  // ---------- GSTR-2B → IMS actions ----------
  let rows = []
  let month2b = null
  for (const m of months) {
    const list = (await h.invoke('voucher:list', { from: m.from, to: m.to })).filter((r) => r.kind === 'purchase' && !r.isOptional)
    if (list.length > 0) {
      rows = list
      month2b = m
      break
    }
  }
  assert(month2b, 'a demo month has purchases')
  const gstinOf = new Map(ledgers.map((l) => [l.id, l.gstin]))
  const groups = new Map()
  for (const r of rows) {
    const vch = await h.invoke('voucher:get', { id: r.id })
    const gstin = gstinOf.get(vch.partyLedgerId)
    if (!gstin) continue
    const sumTax = (name) => vch.lines.filter((l) => ledgers.find((x) => x.id === l.ledgerId)?.name === name).reduce((t, l) => t + l.amount, 0) / 100
    const val = vch.lines.filter((l) => l.ledgerId === vch.partyLedgerId && l.drCr === 'cr').reduce((t, l) => t + l.amount, 0) / 100
    const camt = sumTax('CGST Input'), samt = sumTax('SGST Input'), iamt = sumTax('IGST Input')
    const [y, mo, d] = vch.date.split('-')
    const inv = { inum: vch.reference ?? vch.number, idt: `${d}-${mo}-${y}`, val, items: [{ txval: val - camt - samt - iamt, camt, samt, iamt }] }
    groups.set(gstin, [...(groups.get(gstin) ?? []), inv])
  }
  const first = [...groups.keys()][0]
  groups.get(first).push({ inum: 'STRAY-999', idt: `05-${month2b.key.slice(5)}-${month2b.key.slice(0, 4)}`, val: 118, items: [{ txval: 100, camt: 9, samt: 9 }] })
  const twoB = JSON.stringify({ data: { rtnprd: month2b.period, docdata: { b2b: [...groups.entries()].map(([ctin, inv]) => ({ ctin, inv })) } } })

  await h.goto('gstr2b')
  await h.page.selectOption('[data-testid="input-gstr2b-month"]', month2b.key)
  await h.click('btn-2b-paste')
  await h.fill('input-2b-paste', twoB)
  await h.click('btn-2b-paste-apply')
  await h.page.waitForSelector('[data-testid="btn-2b-bucket-matched"]', { timeout: 20000 })
  await h.click('tab-gstr2b-ims')
  await h.page.waitForSelector('[data-testid="btn-ims-bulk-accept"]', { timeout: 10000 })
  await h.click('btn-ims-bulk-accept')
  await h.page.waitForSelector('[data-testid="rows-ims"] tr[data-action="accept"]', { timeout: 10000 })
  await h.click('chk-ims-STRAY-999')
  await h.page.selectOption('[data-testid="input-ims-set-selected"]', 'reject')
  await h.fill('prompt-input', 'Not our purchase')
  await h.click('prompt-ok')
  await h.page.waitForSelector('[data-testid="rows-ims"] tr[data-action="reject"]', { timeout: 10000 })
  const actions = await h.invoke('gst:imsList', { period: month2b.period })
  assert(actions.some((a) => a.action === 'accept' && a.voucherId), 'bulk accept stored accepted records with their vouchers')
  assert(actions.some((a) => a.docNo === 'STRAY-999' && a.action === 'reject' && a.note === 'Not our purchase'), 'the stray record is rejected with its remark')
  await h.shot('06-ims')
  await h.click('btn-ims-export')
  const ex = await h.invoke('gst:imsExport', { period: month2b.period })
  assert(fs.existsSync(ex.jsonPath) && fs.existsSync(ex.csvPath), 'the IMS action list is exported as JSON + CSV')
  const exported2 = JSON.parse(fs.readFileSync(ex.jsonPath, 'utf8'))
  assertEq(exported2.records.length, actions.length, 'every decision is in the export')

  // ---------- RCM self-invoice: an unregistered RCM supplier's purchase → generate → PDF ----------
  const accountGroups = await h.invoke('master:groups:list')
  const gid = (n) => accountGroups.find((g) => g.name === n).id
  const transporter = await h.invoke('master:ledgers:create', { name: 'Local Transporter', groupId: gid('Sundry Creditors'), stateCode: '27', rcm: true })
  const freight = await h.invoke('master:ledgers:create', { name: 'Freight Inward', groupId: gid('Direct Expenses'), gstRate: 5, hsn: '9965' })
  const rcmBill = await h.invoke('voucher:save', {
    data: {
      voucherTypeId: vtypes.find((t) => t.kind === 'purchase').id, date: months[0].from, partyLedgerId: transporter.id, reference: 'LR-55',
      lines: [{ ledgerId: freight.id, drCr: 'dr', amount: 1200000 }, { ledgerId: transporter.id, drCr: 'cr', amount: 1200000 }]
    }
  })
  await h.goto('edocs')
  await h.click('tab-edocs-self-invoices')
  await h.page.waitForSelector(`[data-testid="btn-self-invoice-generate-${rcmBill.id}"]`, { timeout: 10000 })
  await h.click(`btn-self-invoice-generate-${rcmBill.id}`)
  await h.page.waitForSelector(`[data-testid="self-invoice-status-${rcmBill.id}"]:has-text("Generated")`, { timeout: 10000 })
  const si = (await h.invoke('gst:selfInvoices', { from: months[0].from, to: months[0].to })).find((r) => r.voucherId === rcmBill.id)
  assert(/^SI\/\d\d-\d\d\/0001$/.test(si.selfInvoiceNumber ?? ''), `self-invoice numbered in the FY series (got ${si.selfInvoiceNumber})`)
  assertEq(si.tax, 60000, 'RCM tax at the ledger rate (5% of ₹12,000)')
  const pdf = await h.invoke('gst:selfInvoicePdf', { voucherId: rcmBill.id })
  assert(fs.existsSync(pdf.path) && fs.statSync(pdf.path).size > 1000, 'the self-invoice prints to PDF through the print templates')
  const g3 = await h.invoke('gst:gstr3b', { from: months[0].from, to: months[0].to, period: months[0].period })
  assert(g3.rcm.taxable >= 1200000 && g3.itcParts.isrc.cgst >= 30000, 'the RCM purchase is in 3B 3.1(d) and 4(A)(3)')
  await h.shot('07-self-invoices')
})
