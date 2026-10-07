// Scenario 17 — the Manufacture voucher (WP 2.2), driven through the UI: open Manufacture from
// the sidebar, build 2 Chairs from 2 raw materials + labour, watch profit update live, save, see
// the finished item inward and the raw materials outward on the voucher date in Stock summary,
// alter the quantity, delete.
import { scenario, assert, assertEq } from '../lib/harness.mjs'

await scenario('17-manufacture', async (h) => {
  await h.createCompanyUI('Manufacture Works')
  const page = h.page
  const unit = (await h.invoke('master:units:list'))[0]
  const mkItem = (name, openingQtyMilli, openingValue) =>
    h.invoke('master:stockItems:create', {
      name, groupId: null, unitId: unit.id, hsn: null, gstRate: null, cessRate: null,
      openingQtyMilli, openingValue, barcode: null, reorderLevelMilli: null
    })
  const steel = await mkItem('E2E Steel', 10_000, 150_000) // 10 @ ₹150
  const paint = await mkItem('E2E Paint', 2_000, 80_000) // 2 @ ₹400
  const chair = await mkItem('E2E Chair', 0, 0)

  const text = async (testId) => (await page.locator(`[data-testid="${testId}"]`).first().textContent()) ?? ''
  const waitText = async (testId, needle) =>
    page.waitForFunction(
      ([id, n]) => (document.querySelector(`[data-testid="${id}"]`)?.textContent ?? '').includes(n),
      [testId, needle],
      { timeout: 10000 }
    )
  const pick = async (testId, name) => {
    const input = page.locator(`[data-testid="${testId}"]`)
    await input.click()
    await input.fill(name)
    await page.locator('[role="option"]', { hasText: name }).first().waitFor({ timeout: 10000 })
    await input.press('Enter')
    await page.waitForFunction(([id, n]) => document.querySelector(`[data-testid="${id}"]`)?.value === n, [testId, name])
  }

  // ---------- create from the sidebar ----------
  await h.goto('manufacture')
  await page.waitForSelector('[data-testid="manufacture-form"]')
  assertEq(await page.locator('[data-testid="manufacture-raw-row"]').count(), 10, 'ten raw-material rows from the start')
  assert(await page.locator('[data-testid="btn-save-manufacture"]').isDisabled(), 'Save disabled on an empty form')
  await h.shot('01-empty')

  await pick('picker-manufacture-item', 'E2E Chair')
  await h.fill('input-manufacture-qty', '2')
  await h.fill('input-manufacture-sale-rate', '1000')
  await waitText('manufacture-left-total', '2,000.00')

  await pick('picker-manufacture-raw-0', 'E2E Steel')
  await h.fill('input-manufacture-raw-qty-0', '4')
  await waitText('manufacture-raw-amount-0', '600.00')
  assertEq((await text('manufacture-raw-cost-0')).trim(), '150.00', 'steel average cost as of the voucher date')
  await waitText('manufacture-profit', '1,400.00')

  await pick('picker-manufacture-raw-1', 'E2E Paint')
  await h.fill('input-manufacture-raw-qty-1', '0.5')
  await waitText('manufacture-profit', '1,200.00')
  await h.fill('input-manufacture-labour', '300')
  await waitText('manufacture-profit', '900.00')
  assert((await text('manufacture-production-cost')).includes('1,100.00'), 'production cost = materials + labour')
  assert((await text('manufacture-right-total')).includes('2,000.00'), 'right total = production cost + profit')
  assertEq(await page.locator('[data-testid="manufacture-match"]').getAttribute('data-match'), 'true', 'both sides match')
  assert(!(await page.locator('[data-testid="btn-save-manufacture"]').isDisabled()), 'Save enabled once valid')
  await h.shot('02-filled')

  await h.click('btn-save-manufacture')
  await page.waitForFunction(() => document.querySelector('[data-testid="input-manufacture-qty"]')?.value === '', null, { timeout: 10000 })
  const today = new Date().toISOString().slice(0, 10)
  const reg = await h.invoke('manufacture:register', { from: '2000-01-01', to: '2100-12-31' })
  assertEq(reg.length, 1, 'one manufacture in the register')
  const voucherId = reg[0].voucherId
  assertEq(reg[0].productionCost, 110000, 'register production cost')
  assertEq(reg[0].profitPaise, 90000, 'register profit')
  const v = await h.invoke('voucher:get', { id: voucherId })
  assertEq(v.date, reg[0].date, 'voucher dated as entered')
  assertEq(JSON.stringify(v.inventory.map((l) => [l.stockItemId, l.direction, l.qtyMilli, l.amount])),
    JSON.stringify([[steel.id, 'out', 4000, 60000], [paint.id, 'out', 500, 20000], [chair.id, 'in', 2000, 110000]]), 'posting')
  assertEq(v.lines.length, 2, 'labour Dr/Cr lines posted')

  // ---------- posted immediately, with a date, in stock items ----------
  await h.goto('stock-summary')
  const row = (id) => page.locator(`[data-testid="rows-stock-summary"] [data-row-id="${id}"]`)
  await row(chair.id).waitFor({ timeout: 10000 })
  assert((await row(chair.id).textContent()).includes('1,100.00'), 'finished goods valued at production cost')
  await row(chair.id).click()
  await page.waitForSelector('[data-testid="stock-item-movements"] [data-testid="stock-movement-row"]', { timeout: 10000 })
  const chairMove = page.locator('[data-testid="stock-movement-row"]').first()
  assertEq(await chairMove.getAttribute('data-date'), v.date, 'finished item inward on the voucher date')
  assert((await chairMove.locator('[data-testid="stock-movement-in"]').textContent()).includes('+2'), 'chair +2 inward')
  await h.shot('03-stock-chair-in')
  await row(steel.id).click()
  await page.waitForFunction(
    () => [...document.querySelectorAll('[data-testid="stock-movement-out"]')].some((e) => e.textContent?.includes('4')),
    null,
    { timeout: 10000 }
  )
  const steelMove = page.locator('[data-testid="stock-movement-row"]').first()
  assertEq(await steelMove.getAttribute('data-date'), v.date, 'raw material outward on the voucher date')
  const steelRow = (await h.invoke('stock:summary', { asOn: today })).find((r) => r.stockItemId === steel.id)
  assertEq(steelRow.outwardQtyMilli, 4000, 'steel outward 4')
  assertEq(steelRow.closingQtyMilli, 6000, 'steel deducted from stock')
  await h.shot('04-stock-steel-out')

  // ---------- alter the quantity ----------
  const openFromDaybook = async () => {
    await h.goto('gateway')
    await h.goto('daybook')
    await page.click(`[data-testid="rows-daybook"] [data-row-id="${voucherId}"]`, { timeout: 10000 })
    await h.waitScreen('voucher-entry')
    const el = await page.waitForSelector('[data-testid="voucher-entry-mode"]', { timeout: 10000 })
    assertEq(await el.getAttribute('data-mode'), 'manufacture', 'a saved manufacture reopens in the Manufacture form')
  }
  await openFromDaybook()
  await waitText('manufacture-profit', '900.00')
  await h.fill('input-manufacture-qty', '3')
  await waitText('manufacture-left-total', '3,000.00')
  await waitText('manufacture-profit', '1,900.00')
  await h.click('btn-save-manufacture')
  await h.waitScreen('daybook')
  const md = await h.invoke('manufacture:get', { id: voucherId })
  assertEq(md.details.qtyMilli, 3000, 'altered quantity')
  assertEq(md.details.profitPaise, 190000, 'altered profit')
  assertEq(md.voucher.number, v.number, 'alteration keeps the number')

  // ---------- delete ----------
  await openFromDaybook()
  await h.click('btn-delete-manufacture')
  await h.click('confirm-ok')
  await h.waitScreen('daybook')
  const bin = await h.invoke('voucher:bin')
  assert(bin.some((b) => b.id === voucherId), 'manufacture moved to the bin')
  const after = await h.invoke('stock:summary', { asOn: today })
  assertEq(after.find((r) => r.stockItemId === chair.id).closingQtyMilli, 0, 'finished goods leave stock on delete')
  assertEq(after.find((r) => r.stockItemId === steel.id).closingQtyMilli, 10000, 'raw materials return on delete')
  assertEq((await h.invoke('manufacture:register', { from: '2000-01-01', to: '2100-12-31' })).length, 0, 'register excludes binned')
})
