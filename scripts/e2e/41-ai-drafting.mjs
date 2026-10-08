// Scenario 41 — AI voucher drafting and the review flow (WP 5.3), offline: TOTAL_AI_MOCK=1 plays
// the model (src/main/ai/mockDrafting.ts) on the Demo Traders sample company.
//   1. "Record a sales invoice to Umbrella Retail for 2 Laptop 14 at 45,000" → a draft card →
//      Review opens the INVOICE editor pre-filled, GST computed by the editor (CGST + SGST on
//      ₹90,000.00 = ₹1,06,200.00), under the "AI draft — review before saving" banner with its
//      assumptions and matched entities (inspectable), the drafted fields highlighted → save →
//      the draft is consumed and the Day book shows the invoice.
//   2. "Pay Northwind Supplies against bills NW-101 and NW-102 from HDFC Bank" → the amount is the
//      bills' pending total (computed by the app), allocated bill-wise → save → both bills settled.
//   3. "Make a quotation for Umbrella Retail for 3 Office Chair at 6,500" → reviewed in the quotation editor →
//      saved: the draft is consumed by the new document.
//   4. "Create a delivery challan to Umbrella Retail for 1 Laptop 14 at 45,000" → reviewed in the challan editor →
//      Discard draft: nothing saved, the draft is discarded.
//   5. "Manufacture 2 Steel Filing Cabinet" → raw materials from its BOM in the Manufacture form → saved.
//   6. Settings → AI lists the drafts with their status.
// Nothing reaches the books before each save. Every view is shot in both themes; set
// WP53_SHOTS=/tmp/wp53 to also copy the screenshots there.
import fs from 'node:fs'
import path from 'node:path'
import { scenario, assert, assertEq } from '../lib/harness.mjs'

process.env.TOTAL_AI_MOCK = '1'

await scenario('41-ai-drafting', async (h) => {
  await h.createDemoCompany()
  const extraShots = process.env.WP53_SHOTS
  const shot = async (name) => {
    await h.page.mouse.move(0, 0)
    await h.page.waitForTimeout(250)
    await h.shot(name)
    if (extraShots) {
      fs.mkdirSync(extraShots, { recursive: true })
      fs.copyFileSync(path.join(h.outDir, `${name}.png`), path.join(extraShots, `${name}.png`))
    }
  }
  const setTheme = async (theme) => {
    const now = await h.page.evaluate(() => document.documentElement.dataset.theme ?? 'light')
    if (now !== theme) await h.page.evaluate(() => document.querySelector('[data-testid="btn-theme"]').click())
    await h.page.waitForFunction((t) => (document.documentElement.dataset.theme ?? 'light') === t, theme)
    await h.page.waitForTimeout(300)
  }
  const bothThemes = async (name) => {
    await setTheme('light')
    await shot(`${name}-light`)
    await setTheme('dark')
    await shot(`${name}-dark`)
    await setTheme('light')
  }
  const today = await h.page.evaluate(() => {
    const d = new Date()
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  })
  const fy = Number(today.slice(5, 7)) >= 4 ? Number(today.slice(0, 4)) : Number(today.slice(0, 4)) - 1
  const period = { from: `${fy}-04-01`, to: `${fy + 1}-03-31` }

  // ---------- the assistant on (mock provider: no key needed) ----------
  const features = await h.invoke('config:features:get')
  await h.invoke('config:features:set', { ...features, inventory: true, orders: true })
  await h.invoke('ai:notice:accept')
  await h.invoke('ai:settings:set', { enabled: true })
  assertEq((await h.invoke('ai:settings:get')).ready, true, 'assistant ready on the mock provider')
  await h.goto('settings') // the settings screen refreshes the cached AI settings
  await h.goto('gateway')

  // ---------- a supplier with two open bills ----------
  const groups = await h.invoke('master:groups:list')
  const gid = (name) => groups.find((g) => g.name === name).id
  const northwind = await h.invoke('master:ledgers:create', {
    name: 'Northwind Supplies', groupId: gid('Sundry Creditors'), openingBalance: 0, gstin: null, stateCode: '27', address: null, taxType: null,
    gstRate: null, hsn: null, tdsSectionId: null, pan: null, creditDays: 30, exportType: null
  })
  const ledgers = await h.invoke('master:ledgers:list')
  const purchaseAc = ledgers.find((l) => l.name === 'Purchase A/c').id
  const types = await h.invoke('master:voucherTypes:list')
  const journal = types.find((t) => t.kind === 'journal').id
  const bill = (name, amount) =>
    h.invoke('voucher:save', {
      data: {
        voucherTypeId: journal, date: today, partyLedgerId: northwind.id, narration: `Bill ${name}`, reference: null, instrumentNo: null, instrumentDate: null,
        transporterId: null, vehicleNo: null, transportDistanceKm: null, currencyCode: null, exchangeRate: null,
        lines: [
          { ledgerId: purchaseAc, drCr: 'dr', amount, costAllocations: [] },
          { ledgerId: northwind.id, drCr: 'cr', amount, costAllocations: [] }
        ],
        inventory: [], billRefs: [{ kind: 'new', name, amount, dueDate: null }], tds: null
      }
    })
  await bill('NW-101', 1_180_000)
  await bill('NW-102', 590_000)
  const vouchersBefore = (await h.invoke('voucher:list', period)).length

  // ---------- 1. a sales invoice from plain language ----------
  await h.click('btn-assistant')
  await h.page.waitForSelector('[data-testid="ai-panel"]', { timeout: 10000 })
  await h.fill('ai-input', 'Record a sales invoice to Umbrella Retail for 2 Laptop 14 at 45,000')
  await h.page.press('[data-testid="ai-input"]', 'Enter')
  await h.page.waitForSelector('[data-testid="ai-draft-card"][data-status="open"]', { timeout: 20000 })
  await h.page.waitForFunction(() => document.querySelector('[data-testid="btn-ai-send"]'), null, { timeout: 20000 })
  const answer = await (await h.page.waitForSelector('[data-testid="ai-msg-answer"]', { timeout: 20000 })).textContent()
  assert(answer.includes('total ₹1,06,200.00'), `the answer quotes the computed total: ${answer}`)
  assert(!(await h.page.$('[data-testid="ai-unsourced"]')), 'every figure in the answer came from the tool')
  assertEq((await h.invoke('voucher:list', period)).length, vouchersBefore, 'drafting wrote nothing to the books')
  const [inv] = await h.invoke('ai:drafts', { status: 'open' })
  assertEq(inv.payload.form, 'invoice', 'the draft opens in the invoice editor')
  assertEq(inv.payload.total, 10_620_000, 'total computed by the invoice calculation')
  assert(!inv.unrequested, 'the user asked for it')
  await bothThemes('01-panel-invoice-draft')

  await h.click('btn-ai-review-draft')
  await h.waitScreen('voucher-entry')
  await h.page.waitForSelector('[data-testid="ai-draft-banner"][data-form="invoice"]', { timeout: 10000 })
  await h.page.waitForSelector('[data-testid="voucher-entry-mode"][data-mode="invoice"]', { timeout: 10000 })
  await h.page.waitForFunction(() => document.querySelector('[data-testid="input-line-qty"]')?.value === '2', null, { timeout: 10000 })
  const body = await h.page.evaluate(() => document.querySelector('[data-testid="voucher-entry-mode"]').textContent)
  for (const figure of ['90,000.00', '8,100.00', '1,06,200.00']) assert(body.includes(figure), `the invoice editor shows ${figure} (GST computed by the editor)`)
  const banner = await h.page.$eval('[data-testid="ai-draft-banner"]', (el) => el.textContent)
  assert(banner.includes('Review before saving') && banner.includes('18% GST on Laptop 14" from the item master'), `banner lists the assumptions: ${banner}`)
  await h.page.waitForSelector('[data-ai-set="party"]', { timeout: 10000 })
  await h.page.waitForSelector('tr[data-ai-set="line:0"]', { timeout: 10000 })
  await h.page.click('[data-testid="ai-draft-source"][data-field="party"]')
  await h.page.waitForSelector('[data-testid="ai-draft-source-detail"]', { timeout: 5000 })
  assert((await h.page.$eval('[data-testid="ai-draft-source-detail"]', (el) => el.textContent)).includes('27AABCD1234E1Z8'), 'inspecting the party shows its GSTIN')
  await bothThemes('02-review-invoice')
  await h.page.click('[data-testid="ai-draft-summary"]')
  await h.page.keyboard.press('Control+Enter')
  await h.page.waitForFunction(() => document.querySelector('[data-screen]')?.getAttribute('data-screen') !== 'voucher-entry', null, { timeout: 15000 })
  const invAfter = await h.invoke('ai:draft:get', { id: inv.id })
  assertEq(invAfter.status, 'consumed', 'saving the reviewed invoice consumes the draft')
  const sale = await h.invoke('voucher:get', { id: invAfter.voucherId })
  assertEq(sale.lines.find((l) => l.drCr === 'dr').amount, 10_620_000, 'Umbrella Retail debited ₹1,06,200.00')
  assertEq(sale.inventory[0].qtyMilli, 2000, '2 laptops')
  assertEq(sale.lines.filter((l) => l.drCr === 'cr').map((l) => l.amount).sort((a, b) => b - a).join(','), '9000000,810000,810000', 'sales + CGST + SGST')
  await h.goto('daybook')
  await h.page.waitForSelector(`[data-testid="rows-daybook"] [data-row-id="${sale.id}"]`, { timeout: 10000 })
  assert((await h.page.$eval(`[data-testid="rows-daybook"] [data-row-id="${sale.id}"]`, (el) => el.textContent)).includes('Umbrella Retail'), 'the Day book shows the invoice')
  await bothThemes('03-daybook-invoice')

  // ---------- 2. a payment against two open bills ----------
  await h.click('btn-assistant')
  await h.page.waitForSelector('[data-testid="ai-panel"]', { timeout: 10000 })
  await h.fill('ai-input', 'Pay Northwind Supplies against bills NW-101 and NW-102 from HDFC Bank')
  await h.page.press('[data-testid="ai-input"]', 'Enter')
  await h.page.waitForSelector('[data-testid="ai-draft-card"][data-status="open"]', { timeout: 20000 })
  await h.page.waitForFunction(() => document.querySelector('[data-testid="btn-ai-send"]'), null, { timeout: 20000 })
  const [pay] = await h.invoke('ai:drafts', { status: 'open' })
  assertEq(pay.payload.total, 1_770_000, 'the payment is the two bills’ pending total, computed by the app')
  assertEq(pay.payload.billRefs.map((b) => `${b.name}:${b.amount}`).join(','), 'NW-101:1180000,NW-102:590000', 'allocated bill-wise')
  await bothThemes('04-panel-payment-draft')
  await h.page.click(`[data-testid="ai-draft-card"][data-draft-id="${pay.id}"] [data-testid="btn-ai-review-draft"]`)
  await h.waitScreen('voucher-entry')
  await h.page.waitForSelector('[data-testid="ai-draft-banner"][data-form="accounting"]', { timeout: 10000 })
  await h.page.waitForSelector('[data-testid="voucher-entry-mode"][data-mode="accounting"]', { timeout: 10000 })
  const payBanner = await h.page.$eval('[data-testid="ai-draft-banner"]', (el) => el.textContent)
  assert(payBanner.includes('NW-101') && payBanner.includes('NW-102'), `banner lists the matched bills: ${payBanner}`)
  await bothThemes('05-review-payment')
  await h.page.click('[data-testid="ai-draft-summary"]')
  await h.page.keyboard.press('Control+Enter')
  await h.page.waitForFunction(() => document.querySelector('[data-screen]')?.getAttribute('data-screen') !== 'voucher-entry', null, { timeout: 15000 })
  const payAfter = await h.invoke('ai:draft:get', { id: pay.id })
  assertEq(payAfter.status, 'consumed', 'saving the payment consumes its draft')
  const open = (await h.invoke('bills:open', { partyLedgerId: northwind.id, asOn: today })).filter((b) => b.pending > 0)
  assertEq(open.length, 0, 'both bills are settled')

  // ---------- 3. a quotation → the quotation editor → saved ----------
  const ask = async (text) => {
    await h.click('btn-assistant')
    await h.page.waitForSelector('[data-testid="ai-panel"]', { timeout: 10000 })
    await h.fill('ai-input', text)
    await h.page.press('[data-testid="ai-input"]', 'Enter')
    await h.page.waitForSelector('[data-testid="ai-draft-card"][data-status="open"]', { timeout: 20000 })
    await h.page.waitForFunction(() => document.querySelector('[data-testid="btn-ai-send"]'), null, { timeout: 20000 })
    const [d] = await h.invoke('ai:drafts', { status: 'open' })
    await h.page.click(`[data-testid="ai-draft-card"][data-draft-id="${d.id}"] [data-testid="btn-ai-review-draft"]`)
    return d
  }
  const quote = await ask('Make a quotation for Umbrella Retail for 3 Office Chair at 6,500')
  assertEq(quote.payload.form, 'tradeDoc', 'a quotation draft')
  await h.waitScreen('trade-doc')
  await h.page.waitForSelector('[data-testid="ai-draft-banner"][data-form="tradeDoc"]', { timeout: 10000 })
  await h.page.waitForFunction(() => document.querySelector('[data-testid="input-line-qty"]')?.value === '3', null, { timeout: 10000 })
  const totals = await h.page.$eval('[data-testid="trade-doc-totals"]', (el) => el.textContent)
  assert(totals.includes('23,010.00'), `quotation total with GST computed by the invoice maths: ${totals}`)
  await bothThemes('06-review-quotation')
  await h.click('btn-trade-doc-save')
  await h.page.waitForFunction(() => !document.querySelector('[data-testid="ai-draft-banner"]'), null, { timeout: 15000 })
  assertEq((await h.invoke('ai:draft:get', { id: quote.id })).status, 'consumed', 'saving the quotation consumes its draft')

  // ---------- 4. a delivery challan → the challan editor → discarded ----------
  const challan = await ask('Create a delivery challan to Umbrella Retail for 1 Laptop 14 at 45,000')
  await h.waitScreen('voucher-entry')
  await h.page.waitForSelector('[data-testid="voucher-entry-mode"][data-mode="stockNote"]', { timeout: 10000 })
  await h.page.waitForSelector('[data-testid="ai-draft-banner"][data-form="stockNote"]', { timeout: 10000 })
  await bothThemes('07-review-challan')
  const before = (await h.invoke('voucher:list', period)).length
  await h.click('btn-ai-draft-discard')
  await h.click('confirm-ok')
  await h.page.waitForFunction(() => document.querySelector('[data-screen]')?.getAttribute('data-screen') !== 'voucher-entry', null, { timeout: 15000 })
  assertEq((await h.invoke('ai:draft:get', { id: challan.id })).status, 'discarded', 'Discard draft discards it')
  assertEq((await h.invoke('voucher:list', period)).length, before, 'nothing saved from a discarded draft')

  // ---------- 5. a manufacture from the bill of materials ----------
  const items = await h.invoke('master:stockItems:list')
  const cabinet = items.find((i) => i.name === 'Steel Filing Cabinet').id
  const paper = items.find((i) => i.name === 'A4 Paper Ream').id
  await h.invoke('bom:saveVersion', { itemId: cabinet, name: 'v1', isDefault: true, lines: [{ componentId: paper, qtyMilliPerUnit: 3000 }] })
  const make = await ask('Manufacture 2 Steel Filing Cabinet')
  assertEq(make.payload.form, 'manufacture', 'a manufacture draft')
  await h.waitScreen('voucher-entry')
  await h.page.waitForSelector('[data-testid="ai-draft-banner"][data-form="manufacture"]', { timeout: 10000 })
  await h.page.waitForSelector('[data-testid="manufacture-form"]', { timeout: 10000 })
  await h.page.waitForFunction(() => document.querySelector('[data-testid="input-manufacture-raw-qty-0"]')?.value === '6', null, { timeout: 10000 })
  await bothThemes('08-review-manufacture')
  await h.page.click('[data-testid="ai-draft-summary"]')
  await h.page.keyboard.press('Control+Enter')
  await h.page.waitForFunction(() => document.querySelector('[data-screen]')?.getAttribute('data-screen') !== 'voucher-entry', null, { timeout: 15000 })
  const madeAfter = await h.invoke('ai:draft:get', { id: make.id })
  assertEq(madeAfter.status, 'consumed', 'saving the manufacture consumes its draft')
  const mfg = await h.invoke('manufacture:get', { id: madeAfter.voucherId })
  assert(mfg && mfg.details && mfg.details.qtyMilli === 2000, 'manufacture saved with its details row')

  // ---------- 6. Settings → AI: the drafts list ----------
  await h.goto('settings')
  await h.click('tab-settings-ai')
  await h.page.waitForSelector('[data-testid="rows-ai-drafts"] [data-draft-id]', { timeout: 10000 })
  const rows = await h.page.$$eval('[data-testid="rows-ai-drafts"] [data-draft-id]', (els) => els.map((e) => e.getAttribute('data-status')))
  assertEq(rows.join(','), 'consumed,discarded,consumed,consumed,consumed', 'every draft listed with its status')
  assert((await h.invoke('ai:drafts')).every((d) => !d.unrequested), 'every draft was asked for — none carries the unrequested flag')
  await h.page.evaluate(() => document.querySelector('[data-testid="rows-ai-drafts"]')?.scrollIntoView({ block: 'center' }))
  await bothThemes('09-settings-drafts')
})
