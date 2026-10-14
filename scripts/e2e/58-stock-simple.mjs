// Scenario 58 — WP 9.7 Stock and Made goods (simple mode).
//   1. The setup wizard: a manufacturer that keeps stock (unregistered, starting fresh) — Stock and
//      Made goods are on.
//   2. Two materials and a product (the plain product dialog's service), a purchase of the
//      materials (simple:post — the WP 9.3 intent), bread's recipe set once (½ kg flour + 1 box).
//   3. Stock → Products: quantity, worth (= the Stock summary), selling price, "Running low" on
//      the boxes (below their level) — and Home's "Needs attention" row opens the list filtered.
//   4. Count your stock: the flour one kg short → the difference in words → Save → the save card
//      (no print buttons) → the list shows 99 kg, worth what the Stock summary says.
//   5. A product's view: history in words, Change price.
//   6. Made goods: bread, the recipe in plain words, "not enough" under How many, 10 made with
//      labour already recorded → the save card → the list (bread in, materials out).
// No accounting words on any simple screen. Screenshots light + dark; WP97_SHOTS=<dir> copies the
// review set there.
import * as fs from 'node:fs'
import * as path from 'node:path'
import { scenario, assert, assertEq, PICKER_OPTION } from '../lib/harness.mjs'

// The plan §1 banned list (shared/simple/bannedWords.ts), as its patterns match it.
const BANNED = [
  /\bvouchers?\b/i, /\bledgers?\b/i, /\bjournals?\b/i, /\bcontras?\b/i, /\b(?:Dr|Cr)\b/, /\bparticulars?\b/i, /\bnarrations?\b/i, /\bsundry\b/i,
  /\bgroups?\b/i, /\bITC\b/i, /\bset[- ]?offs?\b/i, /\bag(?:e)?ing\b/i, /\bBRS\b/i, /\bgodowns?\b/i, /\bBOMs?\b/i, /\bSOA\b/i
]
const bannedWordsIn = (text) => BANNED.filter((re) => re.test(text)).map((re) => re.source)
const attached = (h, sel, timeout = 15000) => h.page.waitForSelector(sel, { state: 'attached', timeout })
const REVIEW = new Set(['01-products', '02-count', '04-product', '05-made-goods'])

await scenario('58-stock-simple', async (h) => {
  const { page } = h

  const shoot = async (name) => {
    for (const want of ['light', 'dark']) {
      if ((await page.evaluate(() => document.documentElement.dataset.theme)) !== want) {
        await h.click('btn-theme')
        await page.waitForFunction((w) => document.documentElement.dataset.theme === w, want)
      }
      await page.waitForTimeout(400)
      const file = await h.shot(`${name}-${want}`)
      const dir = process.env.WP97_SHOTS
      if (dir && REVIEW.has(name)) {
        fs.mkdirSync(dir, { recursive: true })
        fs.copyFileSync(file, path.join(dir, `${name}-${want}.png`))
      }
    }
    await h.click('btn-theme')
    await page.waitForFunction(() => document.documentElement.dataset.theme === 'light')
  }
  const fill = async (testId, text) => {
    const input = page.locator(`[data-testid="${testId}"]`).first()
    await input.click()
    await input.fill(text)
    await input.blur()
  }
  const text = async (sel) => ((await page.textContent(sel)) ?? '').replace(/\s+/g, ' ').trim()
  const noBanned = async (where) => {
    const visible = await page.evaluate(() => document.querySelector('main')?.innerText ?? '')
    const found = bannedWordsIn(visible)
    assert(found.length === 0, `no accounting words on ${where} (${found.join(', ')})`)
  }
  const row = (itemId) => `[data-testid="rows-simple-stock"] [data-row-id="${itemId}"]`
  const summaryOf = async (itemId) => (await h.invoke('stock:summary', { asOn: today })).find((r) => r.stockItemId === itemId)
  const listed = async (itemId) => (await h.invoke('simple:stock:list', {})).rows.find((r) => r.itemId === itemId)

  // ================= 1. the wizard: a manufacturer with stock =================
  await h.waitScreen('company-select')
  await attached(h, '[data-testid="setup-wizard"]')
  await h.fill('setup-name', 'Ganesh Bakery')
  await h.click('setup-next')
  await h.click('setup-type-manufacturer')
  await h.click('setup-next')
  await h.click('setup-gst-no')
  await h.click('setup-next')
  await h.click('setup-stock-yes')
  await h.click('setup-next')
  await h.click('setup-start-fy')
  await h.click('setup-fresh-new')
  await h.click('setup-next')
  await h.click('setup-finish')
  await h.waitScreen('gateway', 30000)
  await attached(h, '[data-testid="simple-home"]', 20000)
  await h.stubDialogs()
  const features = await h.invoke('config:features:get')
  assert(features.inventory && features.manufacturing, 'a manufacturer with stock has stock and manufacturing on')
  const today = (await h.invoke('simple:stock:list', {})).asOn

  // ================= 2. products, a purchase, a recipe =================
  const units = await h.invoke('master:units:list')
  const unit = (sym) => units.find((u) => u.symbol === sym).id
  const quick = async (name, sym, sellingPricePaise, reorderLevelMilli = null) =>
    (
      await h.invoke('master:stockItems:quickCreate', {
        item: { name, groupId: null, unitId: unit(sym), hsn: null, gstRate: null, cessRate: null, openingQtyMilli: 0, openingValue: 0, barcode: null, reorderLevelMilli },
        sellingPricePaise,
        purchasePricePaise: null
      })
    ).item
  const flour = await quick('Flour', 'Kg', null)
  const box = await quick('Box', 'Nos', null, 60_000)
  const bread = await quick('Bread', 'Nos', 4000)
  const groups = await h.invoke('master:groups:list')
  const supplier = await h.invoke('master:ledgers:create', {
    name: 'Shiv Mills', groupId: groups.find((g) => g.name === 'Sundry Creditors').id, openingBalance: 0, gstin: null, stateCode: '27', address: null, taxType: null,
    gstRate: null, hsn: null, tdsSectionId: null, pan: null, creditDays: 30, exportType: null
  })
  // The materials come in on a supplier's bill (the Buy flow's intent): 100 kg at ₹40, 50 boxes at ₹10.
  await h.invoke('simple:post', {
    intent: { clientId: 'e2e58-purchase-1', kind: 'purchase', supplierId: supplier.id, billNo: 'SM/1', items: [{ itemId: flour.id, qty: '100', rate: 4000 }, { itemId: box.id, qty: '50', rate: 1000 }], payment: { how: 'credit' } }
  })
  await h.invoke('bom:set', { itemId: bread.id, lines: [{ componentId: flour.id, qtyMilliPerUnit: 500 }, { componentId: box.id, qtyMilliPerUnit: 1000 }] })
  // The setup above went straight to main: reload so every screen reads the books afresh.
  await page.reload()
  if ((await page.$('[data-screen="company-select"]')) || !(await page.$('[data-testid="simple-home"]'))) {
    await page.waitForSelector('[data-screen="company-select"], [data-testid="simple-home"]', { state: 'attached', timeout: 20000 })
    if (await page.$('[data-screen="company-select"]')) await h.openCompany('Ganesh Bakery')
  }
  await attached(h, '[data-testid="simple-home"]', 20000)
  await h.stubDialogs()

  // ================= 3. Stock → Products =================
  await h.click('simple-nav-stock')
  await attached(h, '[data-testid="simple-entry-products"]')
  await h.click('simple-entry-products')
  await h.waitScreen('simple-stock')
  await attached(h, '[data-testid="simple-nav"]')
  await attached(h, row(flour.id))
  assert((await text(row(flour.id))).includes('100 Kg'), 'flour: 100 kg on hand')
  assert((await text(row(flour.id))).includes('4,000.00'), 'flour: worth ₹4,000')
  const s0 = await summaryOf(flour.id)
  assertEq((await listed(flour.id)).value, s0.closingValue, 'the list’s worth is the Stock summary’s')
  assertEq(await page.getAttribute(row(box.id), 'data-level'), 'low', 'boxes: below their level → running low')
  assert((await text(row(bread.id))).includes('40.00'), 'bread: its selling price')
  await noBanned('the product list')
  await shoot('01-products')

  // Home's "Needs attention": the running-low row opens the list filtered.
  await h.click('simple-nav-home')
  await attached(h, '[data-testid="simple-attention-stock-low_stock"]', 20000)
  assert((await text('[data-testid="simple-attention-stock-low_stock"]')).includes('1 product is running low'), 'Home says what is running low')
  await h.click('simple-attention-stock-low_stock')
  await h.waitScreen('simple-stock')
  await attached(h, row(box.id))
  assertEq(await page.$(row(flour.id)), null, 'filtered: only what is running low')

  // ================= 4. Count your stock =================
  await h.click('btn-stock-count')
  await h.waitScreen('simple-stock-count')
  await attached(h, `[data-testid="input-count-${flour.id}"]`)
  await fill(`input-count-${flour.id}`, '99')
  assertEq(await text(`[data-testid="count-diff-${flour.id}"]`), '1 Kg short', 'the difference in words')
  await page.waitForFunction(() => (document.querySelector('[data-testid="count-preview-lines"]')?.textContent ?? '').includes('worth'), null, { timeout: 10000 })
  assert((await text('[data-testid="count-preview-lines"]')).includes('Your stock is now worth ₹40.00 less.'), 'the preview: the engine’s value of the shortage')
  await noBanned('the stock count')
  await shoot('02-count')
  await h.click('btn-count-save')
  await attached(h, '[data-testid="save-card"]')
  await page.waitForFunction(() => (document.querySelector('[data-testid="save-card-text"]')?.textContent ?? '').includes('Stock count'), null, { timeout: 10000 })
  assertEq(await page.$('[data-testid="btn-save-card-print"]'), null, 'no print buttons for a stock count')
  await noBanned('the count’s save card')
  await shoot('03-count-saved')

  // The list shows the new quantity, worth what the Stock summary says.
  await h.click('simple-nav-stock')
  await h.click('simple-entry-products')
  await h.waitScreen('simple-stock')
  await page.waitForFunction((sel) => (document.querySelector(sel)?.textContent ?? '').includes('99 Kg'), row(flour.id), { timeout: 10000 })
  const s1 = await summaryOf(flour.id)
  assertEq(s1.closingQtyMilli, 99_000, 'the Stock summary: 99 kg')
  assertEq((await listed(flour.id)).value, s1.closingValue, 'the list’s worth = the Stock summary’s after the count')

  // ================= 5. a product's view =================
  await page.click(`${row(flour.id)} td >> nth=0`)
  await attached(h, '[data-testid="simple-stock-product"]')
  await attached(h, '[data-testid="rows-stock-history"]')
  const hist = await text('[data-testid="rows-stock-history"]')
  assert(hist.includes('Bought') && hist.includes('Counted'), `history in words (${hist})`)
  await h.click('btn-stock-change-price')
  await fill('input-stock-price', '50')
  await h.click('btn-stock-price-save')
  await page.waitForFunction(() => document.querySelector('[data-testid="stock-product-price"]')?.getAttribute('data-paise') === '5000', null, { timeout: 10000 })
  await noBanned('the product view')
  await shoot('04-product')

  // ================= 6. Made goods =================
  await h.click('simple-nav-stock')
  await attached(h, '[data-testid="simple-entry-made-goods"]')
  await h.click('simple-entry-made-goods')
  await h.waitScreen('simple-made-goods')
  const picker = page.locator('[data-testid="picker-made-product"]').first()
  await picker.click()
  await picker.fill('Bread')
  await page.locator(PICKER_OPTION, { hasText: 'Bread' }).first().click()
  await attached(h, '[data-testid="made-recipe"]')
  assert((await text('[data-testid="made-recipe"]')).includes('To make 1 Bread you use 0.5 Kg Flour, 1 Nos Box.'), 'the recipe in plain words')
  // Too many: not enough boxes, said under How many.
  await fill('input-made-qty', '60')
  await attached(h, '[data-testid="field-error-qty"]', 10000)
  assert((await text('[data-testid="field-error-qty"]')).includes('Not enough Box'), 'not enough material under How many')
  await fill('input-made-qty', '10')
  await fill('input-made-labour', '50')
  await h.click('made-labour-yes')
  await page.waitForFunction(() => (document.querySelector('[data-testid="made-preview-lines"]')?.textContent ?? '').includes('Made 10'), null, { timeout: 10000 })
  assert((await text('[data-testid="made-preview-lines"]')).includes('worth ₹350.00: materials ₹300.00 + labour ₹50.00'), 'materials (5 kg × ₹40 + 10 × ₹10) + labour')
  await noBanned('Made goods')
  await shoot('05-made-goods')
  await page.keyboard.press('Meta+Enter')
  await attached(h, '[data-testid="save-card"]')
  await page.waitForFunction(() => (document.querySelector('[data-testid="save-card-text"]')?.textContent ?? '').includes('Made 10'), null, { timeout: 10000 })
  await shoot('06-made-saved')

  // The list: bread in at what it cost, the materials out.
  await h.click('simple-nav-stock')
  await h.click('simple-entry-products')
  await h.waitScreen('simple-stock')
  await page.waitForFunction((sel) => (document.querySelector(sel)?.textContent ?? '').includes('10 Nos'), row(bread.id), { timeout: 10000 })
  assertEq((await listed(bread.id)).value, 35_000, 'bread worth ₹350 (materials + labour)')
  assertEq((await listed(flour.id)).qtyMilli, 94_000, 'flour: 99 − 5 kg')
  assertEq((await listed(box.id)).qtyMilli, 40_000, 'boxes: 50 − 10')
  for (const id of [flour.id, box.id, bread.id]) assertEq((await listed(id)).value, (await summaryOf(id)).closingValue, `item ${id}: the list = the Stock summary`)
  await shoot('07-products-after')
})
