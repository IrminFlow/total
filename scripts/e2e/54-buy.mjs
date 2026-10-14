// Scenario 54 — WP 9.3 Record a purchase (Buy).
//   1. A regular company in simple mode: Home "+ Purchase" opens Record a purchase; the empty
//      Save puts each problem under its question; a company made with the full form gets the
//      one-click "Add “Purchases”"; a GST bill (products, prices before GST) part paid by UPI →
//      the GST it can claim back + the plain preview line → Save → the save card → Undo bins the
//      bill and its payment together; the bill again → the purchase list (part paid) → its simple
//      view; the same supplier bill a third time is refused under the bill number with a link to
//      the bill already recorded; GSTR-3B counts the input tax.
//   2. An unregistered kirana: never asked about GST (it is part of the cost); an expense by
//      category (a tile creates the account), paid in cash.
//   3. A services company with stock off: just an amount, no products anywhere.
// Screenshots (light + dark) of each step; WP93_SHOTS=<dir> copies the review set there.
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
// The review set copied to WP93_SHOTS (≤ 8 files: four scenes, light + dark).
const REVIEW = new Set(['02-gst-bill-preview', '04-purchase-list', '05-duplicate', '06-kirana-expense'])

await scenario('54-buy', async (h) => {
  const { page } = h

  const shoot = async (name) => {
    for (const want of ['light', 'dark']) {
      if ((await page.evaluate(() => document.documentElement.dataset.theme)) !== want) {
        await h.click('btn-theme')
        await page.waitForFunction((w) => document.documentElement.dataset.theme === w, want)
      }
      await page.waitForTimeout(400)
      const file = await h.shot(`${name}-${want}`)
      const dir = process.env.WP93_SHOTS
      if (dir && REVIEW.has(name)) {
        fs.mkdirSync(dir, { recursive: true })
        fs.copyFileSync(file, path.join(dir, `${name}-${want}.png`))
      }
    }
    await h.click('btn-theme')
    await page.waitForFunction(() => document.documentElement.dataset.theme === 'light')
  }
  const pick = async (testId, text) => {
    const input = page.locator(`[data-testid="${testId}"]`).first()
    await input.click()
    await input.fill(text)
    const opt = page.locator(PICKER_OPTION, { hasText: text }).first()
    await opt.waitFor({ timeout: 5000 })
    await opt.click()
  }
  const fill = async (testId, text) => {
    const input = page.locator(`[data-testid="${testId}"]`).first()
    await input.click()
    await input.fill(text)
    await input.blur()
  }
  const paise = async (testId) => Number(await page.getAttribute(`[data-testid="${testId}"]`, 'data-paise'))
  const text = async (testId) => ((await page.textContent(`[data-testid="${testId}"]`)) ?? '').replace(/\s+/g, ' ').trim()
  const noBanned = async (where) => {
    const visible = await page.evaluate(() => document.querySelector('main')?.innerText ?? '')
    const found = bannedWordsIn(visible)
    assert(found.length === 0, `no accounting words on ${where} (${found.join(', ')})`)
  }
  const ledger = async (name, group, extra = {}) => {
    const groups = await h.invoke('master:groups:list')
    return h.invoke('master:ledgers:create', {
      name, groupId: groups.find((g) => g.name === group).id, openingBalance: 0, gstin: null, stateCode: null, address: null, taxType: null, gstRate: null, hsn: null,
      tdsSectionId: null, pan: null, creditDays: null, exportType: null, ...extra
    })
  }
  const product = async (name, gstRate) => {
    const units = await h.invoke('master:units:list')
    return (
      await h.invoke('master:stockItems:quickCreate', {
        item: { name, groupId: null, unitId: units.find((u) => u.symbol === 'Pcs').id, hsn: null, gstRate, cessRate: null, openingQtyMilli: 0, openingValue: 0, barcode: null, reorderLevelMilli: null },
        sellingPricePaise: 20_000,
        purchasePricePaise: null
      })
    ).item
  }
  const purchases = () => h.invoke('simple:purchases', { from: '2000-01-01', to: '2100-12-31' })

  // ================= 1. a regular company =================
  await h.createCompanyUI('Mehta GST Traders', { mode: 'simple', gstin: '27AAPFU0939F1ZV' })
  await h.stubDialogs()
  await ledger('HDFC Bank', 'Bank Accounts')
  await ledger('Bharat Steel', 'Sundry Creditors', { stateCode: '27', gstin: '27AABCG3456H1ZN', creditDays: 30 })
  await product('Steel bolt', 18)

  // Home → + Purchase → Record a purchase (a simple screen, no "Full app" hand-off).
  await h.click('simple-task-purchase')
  await h.waitScreen('simple-buy')
  await attached(h, '[data-testid="simple-nav"]')
  // A company made with the full form has no purchase account yet: one click adds "Purchases".
  await attached(h, '[data-testid="buy-no-purchase-account"]')
  await h.click('btn-buy-add-purchase-account')
  await page.waitForSelector('[data-testid="buy-no-purchase-account"]', { state: 'detached', timeout: 10000 })
  assert((await h.invoke('master:ledgers:list')).some((l) => l.name === 'Purchases' && l.simpleCategory === 'purchases'), 'the plain Purchases account was added')
  await attached(h, '[data-testid="buy-gst-question"]')
  assertEq(await page.$('[data-testid="btn-buy-snap"]'), null, 'no "Snap a bill" while AI is off')
  await noBanned('the empty purchase')
  await shoot('01-empty')

  // An empty Save: each problem sits under its question.
  await h.click('btn-buy-save')
  await attached(h, '[data-testid="field-error-party"]')
  await attached(h, '[data-testid="field-error-items"]')

  // A GST bill: 10 bolts at ₹100 before GST, part paid ₹500 by UPI.
  const fillGstBill = async () => {
    await pick('picker-buy-supplier', 'Bharat')
    await fill('input-buy-bill-no', 'BS/101')
    await pick('picker-buy-item-0', 'Steel bolt')
    await fill('input-buy-qty-0', '10')
    await fill('input-buy-rate-0', '100')
    await page.waitForFunction(() => document.querySelector('[data-testid="buy-total"]')?.getAttribute('data-paise') === '118000', null, { timeout: 10000 })
    await h.click('buy-paid-part')
    await fill('input-buy-part-amount', '500')
    await h.click('buy-part-how-upi')
    await page.waitForFunction(() => (document.querySelector('[data-testid="buy-preview"]')?.textContent ?? '').includes('still to pay'), null, { timeout: 10000 })
  }
  await fillGstBill()
  assertEq(await paise('buy-taxable'), 100_000, 'before GST')
  assertEq(await paise('buy-tax'), 18_000, 'GST it can claim back')
  assertEq(await text('buy-line-gst-0'), '18% GST', 'the product’s rate')
  assert((await text('buy-preview')).startsWith('Bill ₹1,180.00 from Bharat Steel. ₹500.00 paid by UPI now, ₹680.00 still to pay by'), `the plain preview line (${await text('buy-preview')})`)
  assertEq(await page.$eval('[data-testid="select-buy-account"]', (s) => s.selectedOptions[0]?.textContent), 'HDFC Bank', 'UPI comes out of the bank')
  await noBanned('the GST bill')
  await shoot('02-gst-bill-preview')

  // Save (⌘↵) → the save card; Undo bins the bill and its payment together.
  await page.keyboard.press('Meta+Enter')
  await attached(h, '[data-testid="save-card"]')
  await page.waitForFunction(() => (document.querySelector('[data-testid="save-card-text"]')?.textContent ?? '').length > 0, null, { timeout: 10000 })
  await noBanned('the save card')
  await shoot('03-save-card')
  const p1 = await purchases()
  assertEq(p1.length, 1, 'one bill in the books')
  assertEq(JSON.stringify([p1[0].total, p1[0].paid, p1[0].due, p1[0].billNo]), JSON.stringify([118_000, 50_000, 68_000, 'BS/101']), 'part paid, the rest due')
  await h.click('btn-save-card-undo')
  await attached(h, '[data-testid="save-card"][data-state="undone"]')
  assertEq((await purchases()).length, 0, 'Undo took the bill (and its payment) out')

  // The bill again → the purchase list → its simple view.
  await h.click('btn-save-card-new')
  await fillGstBill()
  await h.click('btn-buy-save')
  await attached(h, '[data-testid="save-card"]')
  const month = p1[0].date.slice(0, 7)
  const [y, m] = month.split('-')
  const g3b = await h.invoke('gst:gstr3b', { from: `${month}-01`, to: `${month}-${String(new Date(Number(y), Number(m), 0).getDate()).padStart(2, '0')}`, period: `${m}${y}` })
  assertEq(JSON.stringify([g3b.itc.cgst, g3b.itc.sgst, g3b.itc.igst]), JSON.stringify([9_000, 9_000, 0]), 'GSTR-3B counts the input tax')
  await h.click('simple-nav-buy')
  await h.click('simple-entry-purchase-list')
  await h.waitScreen('simple-purchases')
  await attached(h, '[data-testid="rows-simple-purchases"] tr')
  const rowText = await text('rows-simple-purchases')
  assert(rowText.includes('Bharat Steel') && rowText.includes('BS/101') && rowText.includes('1,180.00') && rowText.includes('Part paid'), `the list shows the bill, part paid (${rowText})`)
  await noBanned('the purchase list')
  await shoot('04-purchase-list')
  await page.click('[data-testid="rows-simple-purchases"] tr')
  await attached(h, '[data-testid="simple-purchase"][data-bill]')
  assert((await text('simple-purchase-due')).startsWith('₹680.00 still to pay by'), 'the bill view says what is still to pay')
  await attached(h, '[data-testid="btn-purchase-record-payment"]')
  await noBanned('the bill view')

  // The same supplier bill a third time: refused under the bill number, with a link to it.
  await h.click('simple-nav-buy')
  await h.click('simple-entry-record-purchase')
  await h.waitScreen('simple-buy')
  await pick('picker-buy-supplier', 'Bharat')
  await fill('input-buy-bill-no', 'bs-101')
  await pick('picker-buy-item-0', 'Steel bolt')
  await fill('input-buy-rate-0', '100')
  await h.click('btn-buy-save')
  await attached(h, '[data-testid="field-error-billNo"]')
  assert((await text('field-error-billNo')).includes('already recorded'), 'the refusal says the bill is already recorded')
  await attached(h, '[data-testid="btn-buy-open-duplicate"]')
  assertEq((await purchases()).length, 1, 'nothing saved')
  await noBanned('the duplicate refusal')
  await shoot('05-duplicate')
  await h.click('btn-buy-open-duplicate')
  // What was typed would be lost: the app asks first.
  await h.click('confirm-ok')
  await attached(h, '[data-testid="simple-purchase"][data-bill]')

  // ================= 2. an unregistered kirana: an expense by category =================
  await h.click('btn-switch-company')
  await h.createCompanyUI('Sharma Kirana', { mode: 'simple' })
  await ledger('Gupta Wholesale', 'Sundry Creditors')
  await h.click('simple-task-purchase')
  await h.waitScreen('simple-buy')
  assertEq(await page.$('[data-testid="buy-gst-question"]'), null, 'an unregistered business is never asked about GST')
  await attached(h, '[data-testid="buy-cant-claim"]')
  await h.click('buy-mode-expense')
  assertEq(await page.$('[data-testid="buy-no-purchase-account"]'), null, 'an expense needs no purchase account')
  await pick('picker-buy-supplier', 'Gupta')
  await h.click('picker-buy-category')
  await h.click('category-electricity')
  await page.waitForFunction(() => (document.querySelector('[data-testid="picker-buy-category"]')?.textContent ?? '').includes('Electricity'), null, { timeout: 10000 })
  await fill('input-buy-amount', '1180')
  await h.click('buy-paid-cash')
  await page.waitForFunction(() => (document.querySelector('[data-testid="buy-preview"]')?.textContent ?? '').includes('paid in cash now'), null, { timeout: 10000 })
  assertEq(await paise('buy-total'), 118_000, 'what was paid is the cost')
  assertEq(await page.$('[data-testid="buy-tax"]'), null, 'no GST to claim')
  await noBanned('the kirana expense')
  await shoot('06-kirana-expense')
  await h.click('btn-buy-save')
  await attached(h, '[data-testid="save-card"]')
  const k = await purchases()
  assertEq(JSON.stringify(k.map((r) => [r.total, r.tax, r.due])), JSON.stringify([[118_000, 0, 0]]), 'one expense bill, no GST, paid')
  const v = await h.invoke('voucher:get', { id: k[0].voucherId })
  const elec = (await h.invoke('master:ledgers:list')).find((l) => l.name === 'Electricity')
  assert(elec && v.lines.some((l) => l.ledgerId === elec.id && l.drCr === 'dr' && l.amount === 118_000), 'the whole bill is the electricity cost')

  // ================= 3. a services company, stock off: just an amount =================
  await h.click('btn-switch-company')
  await h.createCompanyUI('Rao Repairs', { mode: 'simple' })
  await ledger('City Hardware', 'Sundry Creditors')
  await h.click('simple-nav-settings')
  await h.click('simple-entry-features')
  await attached(h, '[data-testid="feature-card-inventory"][data-on="true"]')
  await h.click('btn-feature-inventory')
  await attached(h, '[data-testid="feature-card-inventory"][data-on="false"]')
  await h.click('simple-nav-buy')
  await h.click('simple-entry-record-purchase')
  await h.waitScreen('simple-buy')
  await attached(h, '[data-testid="input-buy-amount"]')
  assertEq(await page.$('[data-testid="buy-mode-items"]'), null, 'no products with stock off')
  assertEq(await page.$('[data-testid^="picker-buy-item"]'), null, 'no product picker with stock off')
  await h.click('btn-buy-add-purchase-account')
  await page.waitForSelector('[data-testid="buy-no-purchase-account"]', { state: 'detached', timeout: 10000 })
  await pick('picker-buy-supplier', 'City')
  await fill('input-buy-amount', '2500')
  await fill('input-buy-note', 'Spare parts')
  await h.click('buy-paid-cash')
  await page.waitForFunction(() => (document.querySelector('[data-testid="buy-preview"]')?.textContent ?? '').includes('paid in cash now'), null, { timeout: 10000 })
  assertEq(await paise('buy-total'), 250_000, 'just an amount')
  await noBanned('the amount-only bill')
  await shoot('07-amount-only')
  await h.click('btn-buy-save')
  await attached(h, '[data-testid="save-card"]')
  assertEq(JSON.stringify((await purchases()).map((r) => [r.total, r.due])), JSON.stringify([[250_000, 0]]), 'one amount-only bill, paid in cash')

  h.assertNoConsoleErrors()
})
