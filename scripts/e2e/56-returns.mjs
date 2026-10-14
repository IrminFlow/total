// Scenario 56 — WP 9.5 Returns (Sell → Return a sale).
//   1. A regular GST trader in simple mode: a bill of two products to Ramesh via Make a bill, paid
//      by UPI → its view in the Sales list → "Return items" → one unit back with the money paid
//      back by UPI → the preview → Save → the save card → Undo (the return and its refund go to
//      the bin together, stock and the bill as before) → the same return with the credit KEPT →
//      Ramesh holds it as an advance (Home / Outstandings agree), the Sales list shows the chip.
//   2. An unregistered kirana: a walk-in bill of just an amount, then Sell → Sale returns → that
//      bill → an amount back in cash (no GST anywhere).
// Screenshots (light + dark) of the bill list, the filled return with its preview, the save card
// and the amount-only return; WP95_SHOTS=<dir> copies them for the visual review.
import * as fs from 'node:fs'
import * as path from 'node:path'
import { scenario, assert, assertEq, PICKER_OPTION } from '../lib/harness.mjs'

// The plan §1 banned list (shared/simple/bannedWords.ts), as its patterns match it.
const BANNED = [
  /\bvouchers?\b/i, /\bledgers?\b/i, /\bjournals?\b/i, /\bcontras?\b/i, /\b(?:Dr|Cr)\b/, /\bparticulars?\b/i, /\bnarrations?\b/i, /\bsundry\b/i,
  /\bgroups?\b/i, /\bITC\b/i, /\bset[- ]?offs?\b/i, /\bag(?:e)?ing\b/i, /\bBRS\b/i, /\bgodowns?\b/i, /\bBOMs?\b/i, /\bSOA\b/i,
  // WP 9.5: a return is a return to the user, never a "credit note" / "debit note".
  /\bcredit notes?\b/i, /\bdebit notes?\b/i
]
const bannedWordsIn = (text) => BANNED.filter((re) => re.test(text)).map((re) => re.source)
const attached = (h, sel, timeout = 15000) => h.page.waitForSelector(sel, { state: 'attached', timeout })

await scenario('56-returns', async (h) => {
  const { page } = h
  const SHOTS = new Set(['01-bill-list', '02-return-refund', '03-save-card', '04-amount-return'])
  const shoot = async (name) => {
    for (const want of ['light', 'dark']) {
      if ((await page.evaluate(() => document.documentElement.dataset.theme)) !== want) {
        await h.click('btn-theme')
        await page.waitForFunction((w) => document.documentElement.dataset.theme === w, want)
      }
      await page.waitForTimeout(400)
      const file = await h.shot(`${name}-${want}`)
      const dir = process.env.WP95_SHOTS
      if (dir && SHOTS.has(name)) {
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
  const fill = async (testId, value) => {
    const input = page.locator(`[data-testid="${testId}"]`).first()
    await input.click()
    await input.fill(value)
    await input.blur()
  }
  const paise = async (testId) => Number(await page.getAttribute(`[data-testid="${testId}"]`, 'data-paise'))
  const text = async (testId) => ((await page.textContent(`[data-testid="${testId}"]`)) ?? '').replace(/\s+/g, ' ').trim()
  const waitText = (testId, part) =>
    page.waitForFunction(([id, p]) => (document.querySelector(`[data-testid="${id}"]`)?.textContent ?? '').includes(p), [testId, part], { timeout: 10000 })
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
  const product = async (name, sellingPaise, gstRate = null) => {
    const units = await h.invoke('master:units:list')
    return (
      await h.invoke('master:stockItems:quickCreate', {
        item: { name, groupId: null, unitId: units.find((u) => u.symbol === 'Pcs').id, hsn: null, gstRate, cessRate: null, openingQtyMilli: 20_000, openingValue: 20 * sellingPaise / 2, barcode: null, reorderLevelMilli: null },
        sellingPricePaise: sellingPaise,
        purchasePricePaise: null
      })
    ).item
  }
  const stockOf = async (name) => {
    const rows = await h.invoke('stock:summary', { asOn: '2100-12-31' })
    return rows.find((r) => r.name === name)?.closingQtyMilli
  }

  // ================= 1. a regular GST trader =================
  await h.createCompanyUI('Mehta Returns', { mode: 'simple', gstin: '27AAPFU0939F1ZV' })
  await h.stubDialogs()
  await ledger('Sales', 'Sales Accounts', { simpleCategory: 'sales' })
  await ledger('HDFC Bank', 'Bank Accounts')
  await ledger('Ramesh', 'Sundry Debtors', { stateCode: '27', creditDays: 15 })
  await product('Steel bolt', 50_000, 18)
  await product('Rice 5kg', 40_000, 5)

  // The bill: 2 Steel bolt @ ₹500 (18%) + 1 Rice 5kg @ ₹400 (5%) to Ramesh, paid by UPI.
  await h.click('simple-nav-sell')
  await h.click('simple-entry-make-bill')
  await h.waitScreen('simple-sell')
  await pick('picker-sell-customer', 'Ramesh')
  await pick('picker-sell-item-0', 'Steel bolt')
  await fill('input-sell-qty-0', '2')
  await h.click('btn-sell-add-line')
  await pick('picker-sell-item-1', 'Rice')
  await page.waitForFunction(() => document.querySelector('[data-testid="sell-total"]')?.getAttribute('data-paise') === '160000', null, { timeout: 10000 })
  await h.click('sell-paid-upi')
  await waitText('sell-preview', 'by UPI now')
  await h.click('btn-sell-save')
  await attached(h, '[data-testid="save-card"]')
  const bolts = await stockOf('Steel bolt')

  // Sales list → the bill's view → Return items.
  await h.click('simple-nav-sell')
  await h.click('simple-entry-sales-list')
  await h.waitScreen('simple-sales')
  await attached(h, '[data-testid="rows-simple-sales"] tr')
  await page.click('[data-testid="rows-simple-sales"] tr')
  await attached(h, '[data-testid="simple-sale"][data-bill]')
  await h.click('btn-bill-return')
  await h.waitScreen('simple-return-sale')
  await attached(h, '[data-testid="return-bill"]')
  assert((await text('return-bill-head')).startsWith('Bill 1 · Ramesh'), `the bill it came from (${await text('return-bill-head')})`)
  assertEq(await text('return-bill-facts'), 'Bill total ₹1,600.00 · Paid in full', 'a paid bill')

  // One bolt back, money back by UPI.
  await fill('input-return-qty-0', '1')
  await page.waitForFunction(() => document.querySelector('[data-testid="return-total"]')?.getAttribute('data-paise') === '59000', null, { timeout: 10000 })
  assertEq(await paise('return-tax'), 9_000, 'GST of the bill: 18% of ₹500')
  await h.click('return-settle-refund')
  await h.click('return-how-upi')
  assertEq(await page.$eval('[data-testid="select-return-account"]', (s) => s.selectedOptions[0]?.textContent), 'HDFC Bank', 'UPI money goes back from the bank')
  await waitText('return-preview', 'paid back by UPI')
  assertEq(await text('return-preview'), 'Sale return ₹590.00 from Ramesh. Includes GST ₹90.00. ₹590.00 paid back by UPI. Ramesh has paid everything.', 'the plain preview (simple:preview)')
  await fill('input-return-reason', 'Damaged')
  await noBanned('the return')
  await shoot('02-return-refund')

  await page.keyboard.press('Meta+Enter')
  await attached(h, '[data-testid="save-card"]')
  await waitText('save-card-text', 'saved.')
  const card = await text('save-card-text')
  assert(card.startsWith('Sale return ₹590.00 saved.') && card.includes('Paid ₹590.00 from HDFC Bank.'), `the card says what was saved (${card})`)
  await noBanned('the save card')
  await shoot('03-save-card')
  assertEq(await stockOf('Steel bolt'), bolts + 1000, 'the bolt is back in stock')

  // Undo: the return and its refund go to the bin together.
  await h.click('btn-save-card-undo')
  await attached(h, '[data-testid="save-card"][data-state="undone"]')
  assertEq(await stockOf('Steel bolt'), bolts, 'stock as before the return')
  const bills = await h.invoke('simple:returns:bills', { side: 'sale' })
  assertEq(JSON.stringify(bills.map((b) => [b.returns, b.left])), JSON.stringify([[0, 'all']]), 'nothing returned on the bill any more')

  // The same return with the credit kept.
  await h.click('btn-save-card-new')
  await attached(h, '[data-testid="return-bill-picker"]')
  await attached(h, '[data-testid="rows-return-bills"] tr')
  await noBanned('the bill list')
  await shoot('01-bill-list')
  await page.click('[data-testid="rows-return-bills"] tr')
  await attached(h, '[data-testid="return-bill"]')
  await fill('input-return-qty-0', '1')
  await h.click('return-settle-credit')
  await waitText('return-preview', 'keeps')
  assertEq(await text('return-preview'), 'Sale return ₹590.00 from Ramesh. Includes GST ₹90.00. Ramesh keeps ₹590.00 to use on a later bill. Ramesh has paid ₹590.00 in advance.', 'credit kept')
  await h.click('btn-return-save')
  await attached(h, '[data-testid="save-card"]')
  await waitText('save-card-text', 'saved.')

  // Outstandings agrees: nothing owed, ₹590 held for Ramesh.
  const home = await h.invoke('simple:home', {})
  assertEq(home.receivables.advances, 59_000, 'Home: ₹590 of customer advances')
  const out = await h.invoke('analysis:outstandings', { side: 'receivable', asOn: '2100-12-31' })
  assertEq(out.filter((p) => p.name === 'Ramesh').reduce((s, p) => s + p.pending, 0), 0, 'Ramesh owes nothing')
  await h.click('simple-nav-sell')
  await h.click('simple-entry-sales-list')
  await h.waitScreen('simple-sales')
  await attached(h, '[data-testid="sale-returned"]')
  assertEq(await text('sale-returned'), 'Returned ₹590.00', 'the Sales list shows the return')
  assert((await text('rows-simple-sales')).includes('Paid'), 'the bill is still paid')
  await h.click('simple-nav-people')
  await h.click('simple-entry-who-owes')
  await h.waitScreen('outstandings')

  // ================= 2. an unregistered kirana: just an amount =================
  await h.click('btn-switch-company')
  await h.createCompanyUI('Gupta Kirana', { mode: 'simple' })
  await ledger('Sales', 'Sales Accounts', { simpleCategory: 'sales' })
  await h.click('simple-nav-sell')
  await h.click('simple-entry-make-bill')
  await h.waitScreen('simple-sell')
  await h.click('btn-sell-toggle-mode')
  await fill('input-sell-amount', '450')
  await fill('input-sell-note', 'Loose sweets')
  await waitText('sell-preview', 'in cash now')
  await h.click('btn-sell-save')
  await attached(h, '[data-testid="save-card"]')

  await h.click('simple-nav-sell')
  await h.click('simple-entry-sale-returns')
  await h.waitScreen('simple-return-sale')
  await attached(h, '[data-testid="rows-return-bills"] tr')
  await page.click('[data-testid="rows-return-bills"] tr')
  await attached(h, '[data-testid="input-return-amount"]')
  assert((await text('return-bill-head')).includes('Cash customer'), 'a walk-in bill')
  assert(await page.$eval('[data-testid="return-settle-credit"]', (b) => b.disabled).catch(() => true), 'a cash customer gets the money back')
  await fill('input-return-amount', '50')
  await page.waitForFunction(() => document.querySelector('[data-testid="return-total"]')?.getAttribute('data-paise') === '5000', null, { timeout: 10000 })
  await waitText('return-preview', 'paid back in cash')
  assertEq(await text('return-preview'), 'Sale return ₹50.00 from a cash customer. ₹50.00 paid back in cash.', 'amount back in cash')
  const visible = await page.evaluate(() => document.querySelector('main')?.innerText ?? '')
  assert(!/GST/.test(visible), 'no GST anywhere for an unregistered shop')
  await noBanned('the amount return')
  await shoot('04-amount-return')
  await h.click('btn-return-save')
  await attached(h, '[data-testid="save-card"]')
  const ret = await h.invoke('simple:returns:bills', { side: 'sale' })
  assertEq(JSON.stringify(ret.map((b) => [b.mode, b.returned, b.left])), JSON.stringify([['amount', 5_000, 'part']]), 'the bill shows its return')

  h.assertNoConsoleErrors()
})
