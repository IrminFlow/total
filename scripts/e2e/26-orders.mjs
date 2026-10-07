// Scenario 26 — quotations, sales orders and purchase orders (WP 2.5c), driven through the UI on
// the demo company with Orders & challans on:
//   quotation (10) → "Convert to sales order" (8, quotation partly converted)
//   → "Convert to delivery challan" (5 of 8: SO partly delivered, 3 pending in Pending SOs)
//   → sales invoice "Add from orders / challans…" drawing the challan's 5 (no stock) and the SO's
//     last 3 (stock moves) → SO delivered, Pending SOs and Pending challans empty, the quotation
//     pipeline shows it partly converted;
//   purchase order (20) → "Convert to goods receipt" (12) → bill drawing the GRN's 12 and the PO's
//     last 8 → Pending POs empty, stock in by 20 once.
// With WP25C_SHOTS set, the new screens are captured in both themes there.
import * as fs from 'node:fs'
import * as path from 'node:path'
import { scenario, assert, assertEq } from '../lib/harness.mjs'

await scenario('26-orders', async (h) => {
  await h.createDemoCompany()
  const features = await h.invoke('config:features:get')
  await h.invoke('config:features:set', { ...features, inventory: true, orders: true })
  await h.relaunch()
  assertEq(await h.openCompany('Demo Traders'), 'gateway', 'demo company reopens')
  const page = h.page

  const shotsDir = process.env.WP25C_SHOTS
  if (shotsDir) fs.mkdirSync(shotsDir, { recursive: true })
  const theme = () => page.evaluate(() => document.documentElement.dataset.theme ?? 'light')
  const both = async (name) => {
    await h.shot(name)
    if (!shotsDir) return
    for (const want of ['light', 'dark']) {
      if ((await theme()) !== want) await page.evaluate(() => document.querySelector('[data-testid="btn-theme"]')?.click())
      await page.waitForTimeout(200)
      await page.screenshot({ path: path.join(shotsDir, `${name}-${want}.png`) })
    }
    if ((await theme()) !== 'light') await page.evaluate(() => document.querySelector('[data-testid="btn-theme"]')?.click())
  }
  const printShot = async (name, html) => {
    if (!shotsDir) return
    await page.evaluate((srcdoc) => {
      const f = document.createElement('iframe')
      f.id = 'e2e-print-preview'
      f.srcdoc = srcdoc
      f.style.cssText = 'position:fixed;inset:0;width:100vw;height:100vh;z-index:9999;background:#fff;border:0'
      document.body.appendChild(f)
    }, html)
    await page.waitForTimeout(500)
    await page.screenshot({ path: path.join(shotsDir, `${name}.png`) })
    await page.evaluate(() => document.getElementById('e2e-print-preview')?.remove())
  }

  // ---------- masters ----------
  const unit = (await h.invoke('master:units:list'))[0]
  const valve = await h.invoke('master:stockItems:create', {
    name: 'E2E Valve', groupId: null, unitId: unit.id, hsn: '8481', gstRate: 18, cessRate: null,
    openingQtyMilli: 100_000, openingValue: 1_000_000, barcode: null, reorderLevelMilli: null // 100 @ ₹100
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
  const stockOf = async () => (await h.invoke('stock:summary', { asOn: FAR })).find((r) => r.stockItemId === valve.id)
  const count = async (kind) => (await h.invoke('voucher:list', { from: '2000-01-01', to: FAR, voucherTypeId: typeOf(kind).id })).length
  const docs = async (kind) => h.invoke('tradeDocs:list', { kind, from: '2000-01-01', to: FAR })
  const docOf = async (kind) => (await docs(kind)).at(-1)

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
  const savedVoucher = async (kind, n) => {
    await page.waitForFunction(
      async ([id, want]) => {
        const r = await window.total.invoke('voucher:list', { from: '2000-01-01', to: '2099-12-31', voucherTypeId: id })
        return r.ok && r.data.length === want
      },
      [typeOf(kind).id, n],
      { timeout: 10000, polling: 200 }
    )
  }
  const savedDoc = async (kind, n) => {
    await page.waitForFunction(
      async ([k, want]) => {
        const r = await window.total.invoke('tradeDocs:list', { kind: k, from: '2000-01-01', to: '2099-12-31' })
        return r.ok && r.data.length === want
      },
      [kind, n],
      { timeout: 10000, polling: 200 }
    )
    // The form stays on the saved document.
    await page.waitForSelector('[data-testid="trade-doc-actions"]', { timeout: 10000 })
  }
  const action = async (testId) => {
    await h.click('trade-doc-actions')
    await page.waitForSelector(`[data-testid="${testId}"]`, { timeout: 5000 })
    await h.click(testId)
  }
  const setQty = async (value, nth = 0) => {
    const q = page.locator('[data-testid="input-line-qty"]').nth(nth)
    await q.fill(String(value))
    await q.press('Tab')
  }

  // ---------- 1. a quotation ----------
  await h.goto('quotations')
  await both('01-quotations-empty')
  await h.click('btn-trade-doc-new')
  await page.waitForSelector('[data-testid="trade-doc-quotation"]', { timeout: 10000 })
  await pick('picker-party', debtor.name)
  await pick('picker-item', 'E2E Valve')
  await setQty(10)
  const rate = page.locator('[data-testid="input-line-rate"]').first()
  await rate.fill('200')
  await rate.press('Tab')
  const valid = page.locator('[data-testid="input-trade-doc-valid-until"]')
  await valid.fill('31/3/2099')
  await valid.press('Enter')
  await page.locator('[data-testid="input-trade-doc-terms"]').fill('50% advance, balance before dispatch.\nFreight extra.')
  await page.locator('[data-testid="input-trade-doc-reference"]').fill('RFQ-118')
  await page.waitForFunction(() => document.querySelector('[data-testid="trade-doc-totals"]')?.textContent?.includes('2,360.00'), null, { timeout: 5000 })
  await both('02-quotation-entry')
  await h.click('btn-trade-doc-save')
  await savedDoc('quotation', 1)
  const qt = await docOf('quotation')
  assertEq(qt.status, 'open', 'a fresh quotation is open')
  assertEq(qt.total, 236_000, 'quoted 10 × ₹200 + 18% GST')
  const { html: qtHtml } = await h.invoke('tradeDocs:previewHtml', { id: qt.id })
  assert(qtHtml.includes('QUOTATION') && qtHtml.includes('Valid until') && qtHtml.includes('Freight extra'), 'the quotation prints with validity and terms')
  assert(!qtHtml.includes('IRN'), 'no e-invoice block on a quotation')
  await printShot('03-quotation-print', qtHtml)

  // ---------- 2. → sales order (8 of 10) ----------
  await action('trade-doc-action-convert-sales_order')
  await page.waitForSelector('[data-testid="trade-doc-sales_order"] [data-testid="chip-line-source"]', { timeout: 10000 })
  await setQty(8)
  await both('04-sales-order-from-quotation')
  await h.click('btn-trade-doc-save')
  await savedDoc('sales_order', 1)
  const so = await docOf('sales_order')
  assertEq((await docOf('quotation')).status, 'partly_fulfilled', 'the quotation is partly converted')
  assertEq(so.status, 'open', 'the new order is open')
  await page.waitForSelector('[data-testid="trade-doc-linked"]', { timeout: 5000 })
  await both('04b-sales-order-saved')

  // ---------- 3. → delivery challan (5 of 8) ----------
  await action('trade-doc-action-convert-delivery_note')
  await page.waitForSelector('[data-testid="stock-note-delivery_note"] [data-testid="chip-line-source"]', { timeout: 10000 })
  await setQty(5)
  await both('05-challan-from-order')
  const dcBefore = await count('delivery_note')
  await h.click('btn-save-voucher')
  await savedVoucher('delivery_note', dcBefore + 1)
  assertEq((await stockOf()).closingQtyMilli, 95_000, 'the challan took 5 out')
  assertEq((await docOf('sales_order')).status, 'partly_fulfilled', 'the SO is partly delivered')
  const pendSo = (await h.invoke('trade:pendingOrders', { kind: 'sales_order', asOn: FAR })).filter((r) => r.stockItemId === valve.id)
  assertEq(pendSo.map((r) => r.pendingMilli).join(','), '3000', '3 still to deliver on the SO')

  await h.goto('pending-sales-orders')
  await page.waitForSelector('[data-testid="rows-trade-pending-sales_order"] tr.dt-row', { timeout: 10000 })
  await both('06-pending-sales-orders')
  await h.goto('sales-orders')
  await page.waitForSelector('[data-testid="rows-trade-docs-sales_order"] tr.dt-row', { timeout: 10000 })
  await both('07-sales-orders-list')

  // ---------- 4. the invoice: the challan's 5 + the SO's last 3 ----------
  await h.goto('voucher-entry')
  await h.click('tab-voucher-entry-sales')
  await page.waitForSelector('[data-testid="rows-invoice-lines"]', { timeout: 10000 })
  await pick('picker-party', debtor.name)
  await pickAccount('e.g. Sales', salesAcc.name)
  await h.click('btn-add-from')
  await page.waitForSelector('[data-testid="drawer-add-from"] [data-testid="input-add-from-pick"]', { timeout: 10000 })
  const valveRows = page.locator('[data-testid="drawer-add-from"] tr.dt-row', { hasText: 'E2E Valve' })
  // Quotation (2 left), SO (3 left) and challan (5) lines are all on offer.
  assertEq(await valveRows.count(), 3, 'quotation, order and challan lines are offered')
  await valveRows.filter({ hasText: 'Sales Order' }).locator('[data-testid="input-add-from-pick"]').check()
  await valveRows.filter({ hasText: 'Delivery' }).locator('[data-testid="input-add-from-pick"]').check()
  await page.waitForTimeout(150)
  await both('08-invoice-add-from-orders')
  await h.click('btn-add-from-insert')
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="chip-line-source"]').length === 2, null, { timeout: 5000 })
  await both('09-invoice-from-order-and-challan')
  const salesBefore = await count('sales')
  await h.click('btn-save-voucher')
  await savedVoucher('sales', salesBefore + 1)
  assertEq((await stockOf()).closingQtyMilli, 92_000, 'only the SO line moved stock on the invoice (3); the challan line had already gone')
  assertEq((await docOf('sales_order')).status, 'fulfilled', 'the SO is fully delivered')
  assertEq((await h.invoke('trade:pendingOrders', { kind: 'sales_order', asOn: FAR })).filter((r) => r.stockItemId === valve.id).length, 0, 'no pending SO lines')
  assertEq((await h.invoke('trade:pending', { stage: 'delivery_note', asOn: FAR })).filter((r) => r.stockItemId === valve.id).length, 0, 'the challan is invoiced')
  await h.goto('pending-sales-orders')
  await page.waitForFunction(() => document.body.innerText.includes('Every sales order is delivered'), null, { timeout: 10000 })
  // The delivered order: status, the documents drawn from it, per-line "8 of 8 delivered".
  await h.goto('sales-orders')
  await page.locator('[data-testid="rows-trade-docs-sales_order"] tr.dt-row').first().click()
  await page.waitForSelector('[data-testid="chip-line-done"]', { timeout: 10000 })
  assertEq(await page.locator('[data-testid="trade-doc-status"]').first().textContent(), 'Delivered', 'the order shows Delivered')
  await both('09b-sales-order-delivered')
  await h.click('trade-doc-actions')
  await page.waitForSelector('[data-testid="trade-doc-action-pdf"]', { timeout: 5000 })
  if (shotsDir) await page.screenshot({ path: path.join(shotsDir, '09c-actions-menu-light.png') })
  await page.keyboard.press('Escape')

  // ---------- 5. the quotation pipeline ----------
  await h.goto('quotation-pipeline')
  await page.waitForSelector('[data-testid="rows-quotation-pipeline"] tr.dt-row', { timeout: 10000 })
  const pipe = await h.invoke('trade:quotationPipeline', { from: '2000-01-01', to: FAR, asOn: FAR })
  assertEq(pipe.rows.find((r) => r.docId === qt.id)?.outcome, 'partly_converted', 'the pipeline shows it partly converted')
  await both('10-quotation-pipeline')
  await h.goto('quotations')
  await page.waitForSelector('[data-testid="rows-trade-docs-quotation"] tr.dt-row', { timeout: 10000 })
  await both('11-quotations-list')

  // ---------- 6. purchase order (20) → GRN (12) → bill (12 from the GRN + 8 from the PO) ----------
  await h.goto('purchase-orders')
  await h.click('btn-trade-doc-new')
  await page.waitForSelector('[data-testid="trade-doc-purchase_order"]', { timeout: 10000 })
  await pick('picker-party', creditor.name)
  await pick('picker-item', 'E2E Valve')
  await setQty(20)
  const poRate = page.locator('[data-testid="input-line-rate"]').first()
  await poRate.fill('90')
  await poRate.press('Tab')
  await both('12-purchase-order-entry')
  await h.click('btn-trade-doc-save')
  await savedDoc('purchase_order', 1)
  const { html: poHtml } = await h.invoke('tradeDocs:previewHtml', { id: (await docOf('purchase_order')).id })
  assert(poHtml.includes('PURCHASE ORDER') && poHtml.includes('Supplier'), 'the PO prints as a purchase order')
  await printShot('13-purchase-order-print', poHtml)

  await action('trade-doc-action-convert-receipt_note')
  await page.waitForSelector('[data-testid="stock-note-receipt_note"] [data-testid="chip-line-source"]', { timeout: 10000 })
  await setQty(12)
  const grnBefore = await count('receipt_note')
  await h.click('btn-save-voucher')
  await savedVoucher('receipt_note', grnBefore + 1)
  assertEq((await stockOf()).closingQtyMilli, 104_000, 'the GRN brought 12 in')
  assertEq((await docOf('purchase_order')).status, 'partly_fulfilled', 'the PO is partly received')

  await h.goto('pending-purchase-orders')
  await page.waitForSelector('[data-testid="rows-trade-pending-purchase_order"] tr.dt-row', { timeout: 10000 })
  await both('14-pending-purchase-orders')

  await h.goto('voucher-entry')
  await h.click('tab-voucher-entry-purchase')
  await page.waitForSelector('[data-testid="rows-invoice-lines"]', { timeout: 10000 })
  await pick('picker-party', creditor.name)
  await pickAccount('e.g. Purchases', purchaseAcc.name)
  await page.keyboard.press('Alt+KeyA')
  await page.waitForSelector('[data-testid="drawer-add-from"] [data-testid="input-add-from-pick"]', { timeout: 10000 })
  const billRows = page.locator('[data-testid="drawer-add-from"] tr.dt-row', { hasText: 'E2E Valve' })
  await billRows.filter({ hasText: 'Purchase Order' }).locator('[data-testid="input-add-from-pick"]').check()
  await billRows.filter({ hasText: 'Receipt' }).locator('[data-testid="input-add-from-pick"]').check()
  await h.click('btn-add-from-insert')
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="chip-line-source"]').length === 2, null, { timeout: 5000 })
  const billBefore = await count('purchase')
  await h.click('btn-save-voucher')
  await savedVoucher('purchase', billBefore + 1)
  assertEq((await stockOf()).closingQtyMilli, 112_000, 'the bill moved only the PO line (8); the GRN line had already come in')
  assertEq((await docOf('purchase_order')).status, 'fulfilled', 'the PO is fully received')
  assertEq((await h.invoke('trade:pendingOrders', { kind: 'purchase_order', asOn: FAR })).filter((r) => r.stockItemId === valve.id).length, 0, 'no pending PO lines')
  await h.goto('pending-purchase-orders')
  await page.waitForFunction(() => document.body.innerText.includes('Every purchase order is received'), null, { timeout: 10000 })

  // ---------- 7. masters: the quotation / order series ----------
  await h.goto('masters')
  await page.click('[role="tab"]:has-text("Voucher types")').catch(() => {})
  await page.waitForSelector('[data-testid="rows-masters-trade-types"] tr.dt-row', { timeout: 10000 })
  await both('15-masters-series')

  await h.goto('gateway')
})
