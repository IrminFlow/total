// Scenario 46 — WP 8.0, an unregistered shop: a company created through the UI with no GSTIN
// (unregistered) → an item that still carries an 18% rate (as an import would leave it) → the
// Sales form shows no GST column and says why → a counter sale charges no GST (total = price) →
// the bill prints a plain "INVOICE" (rule 49's bill of supply is for registered persons), never
// "TAX INVOICE", with no GST rows or place of supply → a hand-built sale with CGST / SGST
// lines is refused with the plain message → GSTR-3B shows nothing owed → Outstandings ageing is
// as on today (not the FY end) and the dashboard shows no TDS deadline.
import { scenario, assert, assertEq } from '../lib/harness.mjs'

await scenario('46-unregistered-sale', async (h) => {
  const page = h.page
  await h.createCompanyUI('Sharma Kirana')
  await h.stubDialogs()
  const { info } = await h.invoke('company:current')
  assertEq(info.gstRegistrationType, 'unregistered', 'a company without a GSTIN is unregistered')

  // ---------- masters: a sales ledger, GST ledgers (as a template might seed them), one item ----------
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
  const ramesh = await ledger('Ramesh', 'Sundry Debtors', { stateCode: '27', creditDays: 15 })
  const units = await h.invoke('master:units:list')
  const pcs = units.find((u) => u.symbol === 'Pcs')
  const sugar = await h.invoke('master:stockItems:create', {
    name: 'Sugar 1kg', groupId: null, unitId: pcs.id, hsn: null, gstRate: 18, cessRate: null,
    openingQtyMilli: 50_000, openingValue: 225_000, barcode: '8902000000017', reorderLevelMilli: null
  })

  // ---------- the Sales form: no GST column, and the reason ----------
  await h.waitScreen('gateway')
  await page.keyboard.press('F8')
  await h.waitScreen('voucher-entry')
  await page.waitForSelector('[data-testid="rows-invoice-lines"]', { timeout: 10000 })
  const headers = await page.$$eval('table.ledger-table thead th', (ths) => ths.map((t) => t.textContent?.trim()))
  assert(!headers.includes('GST %'), `no GST % column on an unregistered company's bill (${headers.join(' | ')})`)
  const narrationHint = await page.getAttribute('[data-testid="input-invoice-narration"]', 'placeholder')
  assertEq(narrationHint, 'Being goods sold…', 'the sales narration hint')
  await h.shot('01-sales-form-no-gst')

  // ---------- a counter sale: 2 × ₹45 = ₹90, no GST ----------
  // Through the services the Counter screen's F9 calls (counter:quote / counter:checkout); the
  // screen itself is covered by e2e 29.
  const today = await page.evaluate(() => {
    const d = new Date()
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  })
  const lines = [{ itemId: sugar.id, qtyMilli: 2000, ratePaise: 4500, discountPaise: 0 }]
  const quote = await h.invoke('counter:quote', { date: today, lines })
  assertEq([quote.taxable, quote.cgst, quote.sgst, quote.igst, quote.cess, quote.total].join(), '9000,0,0,0,0,9000', 'the quote charges no GST')
  const sale = await h.invoke('counter:checkout', { date: today, lines, payments: [{ mode: 'cash', amountPaise: 9000 }] })
  const inv = await h.invoke('voucher:get', { id: sale.invoiceId })
  assert(!inv.lines.some((l) => l.ledgerId === cgst.id || l.ledgerId === sgst.id), 'the invoice has no tax lines')
  assertEq(inv.lines.find((l) => l.ledgerId === sales.id)?.amount, 9000, 'the sales ledger takes the whole ₹90')
  await h.shot('02-after-sale')

  // ---------- print: a plain invoice, no GST ----------
  for (const templateId of ['classic', 'receipt-80mm']) {
    const { html } = await h.invoke('counter:printHtml', { voucherId: inv.id, templateId })
    assert(/>INVOICE</.test(html) && !/bill of supply/i.test(html), `${templateId}: the print title is INVOICE`)
    assert(!/>CGST<|>SGST<|Place of supply/.test(html), `${templateId}: no GST rows or place of supply`)
    assert(!/tax invoice/i.test(html), `${templateId}: never "Tax invoice"`)
  }

  // ---------- a sale with CGST / SGST lines is refused, plainly ----------
  const types = await h.invoke('master:voucherTypes:list')
  const salesType = types.find((t) => t.kind === 'sales')
  const header = {
    narration: null, reference: null, instrumentNo: null, instrumentDate: null, transporterId: null, vehicleNo: null,
    transportDistanceKm: null, currencyCode: null, exchangeRate: null, inventory: [], billRefs: [], tds: null
  }
  let refused = ''
  try {
    await h.invoke('voucher:save', {
      data: {
        ...header, voucherTypeId: salesType.id, date: today, partyLedgerId: ramesh.id,
        lines: [
          { ledgerId: ramesh.id, drCr: 'dr', amount: 11800, costAllocations: [] },
          { ledgerId: sales.id, drCr: 'cr', amount: 10000, costAllocations: [] },
          { ledgerId: cgst.id, drCr: 'cr', amount: 900, costAllocations: [] },
          { ledgerId: sgst.id, drCr: 'cr', amount: 900, costAllocations: [] }
        ]
      }
    })
  } catch (err) {
    refused = String(err.message)
  }
  assert(refused.includes('not registered for GST') && refused.includes('Company details'), `the save is refused with the cause: ${refused}`)

  // A credit sale to Ramesh (no tax) for the ageing check.
  await h.invoke('voucher:save', {
    data: {
      ...header, voucherTypeId: salesType.id, date: today, partyLedgerId: ramesh.id,
      lines: [{ ledgerId: ramesh.id, drCr: 'dr', amount: 50000, costAllocations: [] }, { ledgerId: sales.id, drCr: 'cr', amount: 50000, costAllocations: [] }],
      billRefs: [{ kind: 'new', name: 'R-1', amount: 50000, dueDate: today }]
    }
  })

  // ---------- GSTR-3B: nothing owed ----------
  const [y, m] = today.split('-')
  const lastDay = new Date(Number(y), Number(m), 0).getDate()
  const r3b = await h.invoke('gst:gstr3b', { from: `${y}-${m}-01`, to: `${y}-${m}-${String(lastDay).padStart(2, '0')}`, period: `${m}${y}` })
  const owed = ['igst', 'cgst', 'sgst', 'cess'].reduce((s, k) => s + (r3b.netPayable[k] ?? 0), 0)
  assertEq(owed, 0, 'GSTR-3B: nothing owed')
  const outTax = ['igst', 'cgst', 'sgst', 'cess'].reduce((s, k) => s + (r3b.outward?.[k] ?? 0), 0)
  assertEq(outTax, 0, 'GSTR-3B: no output tax')

  // The GST returns are not in the sidebar of an unregistered company.
  assertEq(await page.$('[data-testid="nav-gstr3b"]'), null, 'no GSTR-3B in the sidebar')
  assertEq(await page.$('[data-testid="nav-gstr1"]'), null, 'no GSTR-1 in the sidebar')

  // ---------- Outstandings: as on today; the dashboard: no TDS deadline ----------
  await h.goto('outstandings')
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
  const [ty, tm, td] = today.split('-').map(Number)
  const display = `${String(td).padStart(2, '0')}-${months[tm - 1]}-${String(ty % 100).padStart(2, '0')}`
  await page.waitForFunction((want) => document.querySelector('[data-testid="page-period"]')?.textContent?.includes(want), `as on ${display}`, { timeout: 10000 })
  await page.waitForFunction(() => document.body.textContent?.includes('Ramesh'), null, { timeout: 10000 })
  await h.shot('03-outstandings-today')

  await h.goto('gateway')
  await page.waitForSelector('[data-testid="dash-compliance"]', { timeout: 15000 })
  await page.waitForTimeout(500)
  const compliance = await page.textContent('[data-testid="dash-compliance"]')
  assert(!/TDS/.test(compliance ?? ''), `no TDS deadline for a shop that never deducted (${compliance})`)
  assert(!/GSTR/.test(compliance ?? ''), 'no GST return deadlines for an unregistered company')
  await h.shot('04-dashboard')
})
