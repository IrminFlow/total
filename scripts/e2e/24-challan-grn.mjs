// Scenario 24 — challans and GRNs (WP 2.5b), driven through the UI on the demo company with
// Orders & challans on: a delivery challan with no order → a sales invoice raised from it via
// "Add from challans…" → the stock moved once (on the challan) and Pending challans is empty;
// a GRN at ₹100 → a purchase bill from it at ₹110 → the GRN is re-priced in stock and Pending
// GRNs is empty. With WP25B_SHOTS set, the new screens are captured in both themes there.
import * as fs from 'node:fs'
import * as path from 'node:path'
import { scenario, assert, assertEq } from '../lib/harness.mjs'

await scenario('24-challan-grn', async (h) => {
  await h.createDemoCompany()
  const features = await h.invoke('config:features:get')
  await h.invoke('config:features:set', { ...features, inventory: true, orders: true })
  // Fresh renderer state so the feature flag is read anew.
  await h.relaunch()
  assertEq(await h.openCompany('Demo Traders'), 'gateway', 'demo company reopens')
  const page = h.page

  const shotsDir = process.env.WP25B_SHOTS
  if (shotsDir) fs.mkdirSync(shotsDir, { recursive: true })
  const both = async (name) => {
    await h.shot(name)
    if (!shotsDir) return
    for (const theme of ['light', 'dark']) {
      const now = await page.evaluate(() => document.documentElement.dataset.theme ?? 'light')
      if (now !== theme) await page.evaluate(() => document.querySelector('[data-testid="btn-theme"]')?.click())
      await page.waitForTimeout(200)
      await page.screenshot({ path: path.join(shotsDir, `${name}-${theme}.png`) })
    }
    const now = await page.evaluate(() => document.documentElement.dataset.theme ?? 'light')
    if (now !== 'light') await page.evaluate(() => document.querySelector('[data-testid="btn-theme"]')?.click())
  }

  // ---------- masters ----------
  const unit = (await h.invoke('master:units:list'))[0]
  const bolt = await h.invoke('master:stockItems:create', {
    name: 'E2E Bolt', groupId: null, unitId: unit.id, hsn: '7318', gstRate: 18, cessRate: null,
    openingQtyMilli: 50_000, openingValue: 500_000, barcode: null, reorderLevelMilli: null // 50 @ ₹100
  })
  const ledgers = await h.invoke('master:ledgers:list')
  const groups = await h.invoke('master:groups:list')
  const inGroup = (name) => ledgers.find((l) => groups.find((g) => g.id === l.groupId)?.name === name)
  const debtor = inGroup('Sundry Debtors')
  const creditor = inGroup('Sundry Creditors')
  const salesAcc = inGroup('Sales Accounts')
  const purchaseAcc = inGroup('Purchase Accounts')
  assert(debtor && creditor && salesAcc && purchaseAcc, 'demo company has the parties and accounts')
  const types = await h.invoke('master:voucherTypes:list')
  const typeOf = (kind) => types.find((t) => t.kind === kind)
  const FAR = '2099-12-31'
  const stockOf = async () => (await h.invoke('stock:summary', { asOn: FAR })).find((r) => r.stockItemId === bolt.id)
  const count = async (kind) => (await h.invoke('voucher:list', { from: '2000-01-01', to: FAR, voucherTypeId: typeOf(kind).id })).length

  const pick = async (testId, text, nth = 0) => {
    const input = page.locator(`[data-testid="${testId}"]`).nth(nth)
    await input.click()
    await input.fill(text)
    await page.waitForSelector('[role="listbox"] [role="option"]', { timeout: 5000 })
    await input.press('Enter')
  }
  const pickAccount = async (placeholder, name) => {
    const input = page.locator(`input[placeholder="${placeholder}"]`)
    await input.click()
    await input.fill(name)
    await page.waitForSelector('[role="listbox"] [role="option"]', { timeout: 5000 })
    await input.press('Enter')
  }
  const saved = async (kind, n) => {
    await page.waitForFunction(
      async ([id, want]) => {
        const r = await window.total.invoke('voucher:list', { from: '2000-01-01', to: '2099-12-31', voucherTypeId: id })
        return r.ok && r.data.length === want
      },
      [typeOf(kind).id, n],
      { timeout: 10000, polling: 200 }
    )
  }

  // ---------- 1. a delivery challan with no order ----------
  await h.goto('voucher-entry')
  await h.click('tab-voucher-entry-delivery_note')
  await page.waitForSelector('[data-testid="stock-note-delivery_note"]', { timeout: 10000 })
  await pick('picker-party', debtor.name)
  await pick('picker-item', 'E2E Bolt')
  await page.locator('[data-testid="input-line-qty"]').first().fill('10')
  await page.locator('[data-testid="input-line-rate"]').first().fill('150')
  await page.locator('[data-testid="input-line-rate"]').first().press('Tab')
  await page.locator('[data-testid="input-stock-note-vehicle"]').fill('MH12AB1234')
  await page.waitForFunction(() => document.querySelector('[data-testid="stock-note-totals"]')?.textContent?.includes('1,770.00'), null, { timeout: 5000 })
  await both('01-delivery-challan')
  const dcBefore = await count('delivery_note')
  await h.click('btn-save-voucher')
  await saved('delivery_note', dcBefore + 1)
  const afterChallan = await stockOf()
  assertEq(afterChallan.closingQtyMilli, 40_000, 'the challan took 10 out of 50')
  const pendingDc = await h.invoke('trade:pending', { stage: 'delivery_note', asOn: FAR })
  assertEq(pendingDc.filter((r) => r.stockItemId === bolt.id).map((r) => r.pendingMilli).join(','), '10000', 'the challan is pending')

  await h.goto('pending-challans')
  await page.waitForSelector('[data-testid="rows-trade-pending-delivery_note"] tr.dt-row', { timeout: 10000 })
  await both('02-pending-challans')

  // The printed challan (Classic template): triplicate, no tax-invoice wording.
  const dcRow = (await h.invoke('voucher:list', { from: '2000-01-01', to: FAR, voucherTypeId: typeOf('delivery_note').id })).at(-1)
  const classic = await h.invoke('template:get', { id: 'classic' })
  const { html } = await h.invoke('template:previewHtml', { template: classic, voucherId: dcRow.voucherId ?? dcRow.id })
  assert(html.includes('DELIVERY CHALLAN') && html.includes('Triplicate for Consigner'), 'the challan prints in triplicate')
  assert(!/invoice/i.test(html), 'no invoice wording on the challan')
  if (shotsDir) {
    await page.evaluate((srcdoc) => {
      const f = document.createElement('iframe')
      f.id = 'e2e-print-preview'
      f.srcdoc = srcdoc
      f.style.cssText = 'position:fixed;inset:0;width:100vw;height:100vh;z-index:9999;background:#fff;border:0'
      document.body.appendChild(f)
    }, html)
    await page.waitForTimeout(500)
    await page.screenshot({ path: path.join(shotsDir, '02b-challan-print.png') })
    await page.evaluate(() => document.getElementById('e2e-print-preview')?.remove())
  }

  // ---------- 2. the invoice from it ----------
  await h.goto('voucher-entry')
  await h.click('tab-voucher-entry-sales')
  await page.waitForSelector('[data-testid="rows-invoice-lines"]', { timeout: 10000 })
  await pick('picker-party', debtor.name)
  await pickAccount('e.g. Sales', salesAcc.name)
  await h.click('btn-add-from')
  await page.waitForSelector('[data-testid="drawer-add-from"] [data-testid="input-add-from-pick"]', { timeout: 10000 })
  const boltRow = page.locator('[data-testid="drawer-add-from"] tr.dt-row', { hasText: 'E2E Bolt' })
  await boltRow.locator('[data-testid="input-add-from-pick"]').check()
  await page.waitForTimeout(150)
  await both('03-add-from-drawer')
  await h.click('btn-add-from-insert')
  await page.waitForSelector('[data-testid="chip-line-source"]', { timeout: 5000 })
  assertEq(await page.locator('[data-testid="line-item-locked"]').first().textContent(), 'E2E Bolt', 'the drawn row keeps the challan item, read-only')
  await page.waitForSelector('[data-testid="invoice-goods-on-challan"]', { timeout: 5000 })
  await both('04-invoice-from-challan')
  const salesBefore = await count('sales')
  await h.click('btn-save-voucher')
  await saved('sales', salesBefore + 1)

  const afterInvoice = await stockOf()
  assertEq(afterInvoice.closingQtyMilli, afterChallan.closingQtyMilli, 'the invoice moved no stock (one movement: the challan)')
  assertEq(afterInvoice.closingValue, afterChallan.closingValue, 'stock value unchanged by the invoice')
  const reg = await h.invoke('stock:register', { itemId: bolt.id, from: '2000-01-01', to: FAR })
  assertEq(reg.rows.length, 1, 'the movement register shows one row: the challan')
  assertEq(reg.rows[0].kind, 'delivery_note', 'that row is the challan')
  assertEq((await h.invoke('trade:pending', { stage: 'delivery_note', asOn: FAR })).filter((r) => r.stockItemId === bolt.id).length, 0, 'nothing pending')
  await h.goto('pending-challans')
  await page.waitForFunction(() => document.body.innerText.includes('Every challan is invoiced'), null, { timeout: 10000 })
  await both('05-pending-challans-empty')

  // ---------- 3. a GRN at ₹100, the bill at ₹110 ----------
  await h.goto('voucher-entry')
  await h.click('tab-voucher-entry-receipt_note')
  await page.waitForSelector('[data-testid="stock-note-receipt_note"]', { timeout: 10000 })
  await pick('picker-party', creditor.name)
  await pick('picker-item', 'E2E Bolt')
  await page.locator('[data-testid="input-line-qty"]').first().fill('10')
  await page.locator('[data-testid="input-line-rate"]').first().fill('100')
  await page.locator('[data-testid="input-line-rate"]').first().press('Tab')
  await both('06-goods-receipt-note')
  const grnBefore = await count('receipt_note')
  await h.click('btn-save-voucher')
  await saved('receipt_note', grnBefore + 1)
  const afterGrn = await stockOf()
  assertEq(afterGrn.closingQtyMilli, 50_000, 'the GRN brought 10 in')

  await h.goto('voucher-entry')
  await h.click('tab-voucher-entry-purchase')
  await page.waitForSelector('[data-testid="rows-invoice-lines"]', { timeout: 10000 })
  await pick('picker-party', creditor.name)
  await pickAccount('e.g. Purchases', purchaseAcc.name)
  await page.keyboard.press('Alt+KeyA')
  await page.waitForSelector('[data-testid="drawer-add-from"] [data-testid="input-add-from-pick"]', { timeout: 10000 })
  await page.locator('[data-testid="drawer-add-from"] tr.dt-row', { hasText: 'E2E Bolt' }).locator('[data-testid="input-add-from-pick"]').check()
  await h.click('btn-add-from-insert')
  await page.waitForSelector('[data-testid="chip-line-source"]', { timeout: 5000 })
  const rate = page.locator('[data-testid="input-line-rate"]').first()
  await rate.fill('110')
  await rate.press('Tab')
  const billBefore = await count('purchase')
  await h.click('btn-save-voucher')
  await saved('purchase', billBefore + 1)

  const afterBill = await stockOf()
  assertEq(afterBill.closingQtyMilli, afterGrn.closingQtyMilli, 'the bill moved no stock')
  assertEq(afterBill.closingValue - afterGrn.closingValue, 10_000, 'the GRN is re-priced by the bill: 10 × (₹110 − ₹100)')
  assertEq((await h.invoke('trade:pending', { stage: 'receipt_note', asOn: FAR })).filter((r) => r.stockItemId === bolt.id).length, 0, 'GRN billed')
  await h.goto('pending-grns')
  await page.waitForFunction(() => document.body.innerText.includes('Every GRN is billed'), null, { timeout: 10000 })

  // ---------- 4. the challan's e-way bill row and the invoice's ----------
  await h.goto('edocs')
  await page.waitForSelector('[data-testid="rows-edocs"] tr.dt-row', { timeout: 10000 })
  const edocs = await h.invoke('edoc:list', { from: '2000-01-01', to: FAR })
  const chl = edocs.filter((r) => r.docType === 'CHL')
  assert(chl.length >= 1, 'the challan is listed for an e-way bill')
  const inv = edocs.find((r) => r.ewbReason?.startsWith('Goods moved on challan'))
  assert(inv, 'the invoice from the challan needs no second e-way bill')
  await both('07-edocs-challan')

  // Leave clean.
  await h.goto('gateway')
})
