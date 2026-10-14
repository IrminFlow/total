// Scenario 53 — WP 9.2 Make a bill (Sell), the first simple flow.
//   1. An unregistered kirana in simple mode: Home "+ Sale" opens Make a bill (no GST anywhere,
//      prints as an Invoice); a bill with two products paid by UPI → the plain preview line →
//      Save → the save card → Undo bins both entries; a second bill → the Sales list shows it
//      (paid) → its simple view → Print opens the PDF.
//   2. A regular company: GST shown per product, the total equals what the full sales editor
//      shows for the same bill ("Accountant view" opens it), on credit the bill stays due.
//   3. A services company with stock off: just an amount, no product picker anywhere.
// Screenshots (light + dark) of the empty, filled and previewed form, the save card, the sales
// list and the amount-only bill; WP92_SHOTS=<dir> copies them for the visual review.
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

await scenario('53-sell', async (h) => {
  const { page } = h
  const stubOpen = () =>
    h.app.evaluate(({ shell }) => {
      globalThis.__opened = []
      shell.openPath = async (p) => {
        globalThis.__opened.push(p)
        return ''
      }
    })
  const openedPaths = () => h.app.evaluate(() => globalThis.__opened ?? [])

  const shoot = async (name) => {
    for (const want of ['light', 'dark']) {
      if ((await page.evaluate(() => document.documentElement.dataset.theme)) !== want) {
        await h.click('btn-theme')
        await page.waitForFunction((w) => document.documentElement.dataset.theme === w, want)
      }
      await page.waitForTimeout(400)
      const file = await h.shot(`${name}-${want}`)
      const dir = process.env.WP92_SHOTS
      if (dir) {
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
  const groupsOf = async () => {
    const groups = await h.invoke('master:groups:list')
    return (name) => groups.find((g) => g.name === name).id
  }
  const ledger = async (name, group, extra = {}) => {
    const gid = await groupsOf()
    return h.invoke('master:ledgers:create', {
      name, groupId: gid(group), openingBalance: 0, gstin: null, stateCode: null, address: null, taxType: null, gstRate: null, hsn: null,
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

  // ================= 1. an unregistered kirana =================
  await h.createCompanyUI('Sharma Kirana', { mode: 'simple' })
  await h.stubDialogs()
  await stubOpen()
  assertEq((await h.invoke('company:current')).info.gstRegistrationType, 'unregistered', 'a company without a GSTIN is unregistered')
  await ledger('HDFC Bank', 'Bank Accounts')
  await ledger('Ramesh', 'Sundry Debtors', { creditDays: 7 })
  await product('Sugar 1kg', 4_500)
  await product('Tea 250g', 12_000)

  // Home → + Sale → Make a bill (a simple screen, no "Full app" hand-off).
  await h.click('simple-task-sale')
  await h.waitScreen('simple-sell')
  await attached(h, '[data-testid="simple-nav"]')
  // A company made with the full form has no sales account yet: one click adds "Sales".
  await attached(h, '[data-testid="sell-no-sales-account"]')
  await h.click('btn-sell-add-sales-account')
  await page.waitForSelector('[data-testid="sell-no-sales-account"]', { state: 'detached', timeout: 10000 })
  assert((await h.invoke('master:ledgers:list')).some((l) => l.name === 'Sales' && l.simpleCategory === 'sales'), 'the plain Sales account was added')
  assertEq(await text('sell-print-title'), 'Prints as: Invoice', 'an unregistered business prints an Invoice')
  assertEq(await page.$('[data-testid="sell-prices-incl"]'), null, 'no GST price toggle for an unregistered business')
  await noBanned('the empty bill')
  await shoot('01-bill-empty')

  // An empty Save: the problem sits under its question.
  await h.click('btn-sell-save')
  await attached(h, '[data-testid="field-error-items"]')

  // Two products, paid by UPI (a walk-in "cash customer").
  await pick('picker-sell-item-0', 'Sugar')
  await page.waitForFunction(() => Number(document.querySelector('[data-testid="sell-line-amount-0"]')?.getAttribute('data-paise')) > 0, null, { timeout: 10000 })
  assertEq(await paise('sell-line-amount-0'), 4_500, 'the saved selling price fills in (resolvePrice)')
  await fill('input-sell-qty-0', '2')
  await h.click('btn-sell-add-line')
  await pick('picker-sell-item-1', 'Tea')
  await fill('input-sell-qty-1', '1')
  await fill('input-sell-rate-1', '110')
  await page.waitForFunction(() => document.querySelector('[data-testid="sell-total"]')?.getAttribute('data-paise') === '20000', null, { timeout: 10000 })
  assertEq(await page.$('[data-testid="sell-line-gst-0"]'), null, 'no GST chip')
  assertEq(await page.$('[data-testid="sell-tax"]'), null, 'no GST in the totals')
  assert(await page.$eval('[data-testid="sell-paid-credit"]', (b) => b.disabled), 'a cash customer cannot buy on credit')
  await h.click('sell-paid-upi')
  await page.waitForFunction(() => (document.querySelector('[data-testid="sell-preview"]')?.textContent ?? '').includes('by UPI now'), null, { timeout: 10000 })
  assertEq(await text('sell-preview'), 'Bill ₹200.00 for a cash customer. ₹200.00 by UPI now.', 'the plain preview line (simple:preview)')
  assertEq(await page.$eval('[data-testid="select-sell-account"]', (s) => s.selectedOptions[0]?.textContent), 'HDFC Bank', 'UPI goes into the bank')
  await noBanned('the filled bill')
  await shoot('02-bill-preview')

  // Save (⌘↵) → the save card.
  await page.keyboard.press('Meta+Enter')
  await attached(h, '[data-testid="save-card"]')
  await page.waitForFunction(() => (document.querySelector('[data-testid="save-card-text"]')?.textContent ?? '').includes('saved.'), null, { timeout: 10000 })
  const card = await text('save-card-text')
  assert(card.includes('Bill ₹200.00 saved.'), `the card says what was saved (${card})`)
  await noBanned('the save card')
  await shoot('03-save-card')
  const sales1 = await h.invoke('simple:sales', { from: '2000-01-01', to: '2100-12-31' })
  assertEq(sales1.length, 1, 'one bill in the books')
  const firstBill = sales1[0].voucherId

  // Undo bins the bill and its receipt together.
  await h.click('btn-save-card-undo')
  await attached(h, '[data-testid="save-card"][data-state="undone"]')
  assertEq((await h.invoke('simple:sales', { from: '2000-01-01', to: '2100-12-31' })).length, 0, 'Undo took the bill out')
  const bin = await h.invoke('voucher:bin', {}).catch(() => null)
  if (Array.isArray(bin)) assert(bin.some((b) => b.id === firstBill), 'the bill is in the bin')

  // A second bill → Sales list → its simple view → Print.
  await h.click('btn-save-card-new')
  await pick('picker-sell-item-0', 'Tea')
  await fill('input-sell-rate-0', '120')
  await pick('picker-sell-customer', 'Ramesh')
  await h.click('sell-paid-cash')
  await page.waitForFunction(() => (document.querySelector('[data-testid="sell-preview"]')?.textContent ?? '').includes('in cash now'), null, { timeout: 10000 })
  await h.click('btn-sell-save')
  await attached(h, '[data-testid="save-card"]')
  await h.click('simple-nav-sell')
  await h.click('simple-entry-sales-list')
  await h.waitScreen('simple-sales')
  await attached(h, '[data-testid="rows-simple-sales"] tr')
  const rowText = await text('rows-simple-sales')
  assert(rowText.includes('Ramesh') && rowText.includes('120.00') && rowText.includes('Paid'), `the sales list shows the bill, paid (${rowText})`)
  await noBanned('the sales list')
  await shoot('04-sales-list')
  await page.click('[data-testid="rows-simple-sales"] tr')
  await attached(h, '[data-testid="simple-sale"][data-bill]')
  assertEq(await text('simple-sale-due'), 'Paid in full.', 'the bill view says it is paid')
  await h.click('btn-bill-print')
  let paths = []
  for (let i = 0; i < 40 && paths.length === 0; i++) {
    await page.waitForTimeout(250)
    paths = await openedPaths()
  }
  assert(paths.length === 1 && paths[0].endsWith('.pdf') && fs.statSync(paths[0]).size > 1000, `Print opened the bill PDF (${paths.join(', ')})`)

  // ================= 2. a regular company =================
  await h.click('btn-switch-company')
  await h.createCompanyUI('Mehta GST Traders', { mode: 'simple', gstin: '27AAPFU0939F1ZV' })
  await stubOpen()
  await ledger('Sales', 'Sales Accounts', { simpleCategory: 'sales' })
  await ledger('Mehta & Sons', 'Sundry Debtors', { stateCode: '27', creditDays: 30 })
  await product('Steel bolt', 25_000, 18)
  await product('Rice 5kg', 40_000, 5)
  await h.click('simple-nav-sell')
  await h.click('simple-entry-make-bill')
  await h.waitScreen('simple-sell')
  assertEq(await text('sell-print-title'), 'Prints as: Tax invoice', 'a regular registration prints a Tax invoice')
  await pick('picker-sell-customer', 'Mehta')
  await pick('picker-sell-item-0', 'Steel bolt')
  await fill('input-sell-qty-0', '3')
  await h.click('btn-sell-add-line')
  await pick('picker-sell-item-1', 'Rice')
  await fill('input-sell-qty-1', '2')
  await page.waitForFunction(() => Number(document.querySelector('[data-testid="sell-line-amount-1"]')?.getAttribute('data-paise')) === 80000, null, { timeout: 10000 })
  assertEq(await text('sell-line-gst-0'), '18% GST', 'the product’s GST rate')
  assertEq(await paise('sell-taxable'), 155_000, 'before GST')
  assertEq(await paise('sell-tax'), 17_500, 'GST 18% on 750 + 5% on 800')
  assertEq(await paise('sell-total'), 172_500, 'the bill total')
  await h.click('sell-paid-credit')
  await page.waitForFunction(() => (document.querySelector('[data-testid="sell-preview"]')?.textContent ?? '').includes('due by'), null, { timeout: 10000 })
  assert((await text('sell-preview')).startsWith('Bill ₹1,725.00 to Mehta & Sons. ₹1,725.00 due by'), 'on credit: due by the credit days')
  await noBanned('the GST bill')
  await shoot('06-bill-gst')
  await h.click('btn-sell-save')
  await attached(h, '[data-testid="save-card"]')
  // The full sales editor shows the same total for the same bill.
  await h.click('btn-sell-accountant-view')
  await h.waitScreen('voucher-entry')
  await attached(h, '[data-testid="rows-invoice-lines"]')
  const editorTotal = await page.evaluate(() => {
    const label = [...document.querySelectorAll('span')].find((s) => s.textContent === 'Total' && s.nextElementSibling)
    return label?.nextElementSibling?.textContent ?? ''
  })
  assert(editorTotal.replace(/\s/g, '').includes('1,725.00'), `the editor total equals the simple total (${editorTotal})`)
  await h.click('btn-back-to-simple')
  await attached(h, '[data-testid="simple-section-sell"]')

  // ================= 3. a services company, stock off =================
  await h.click('btn-switch-company')
  await h.createCompanyUI('Rao Repairs', { mode: 'simple' })
  await ledger('Service income', 'Sales Accounts', { simpleCategory: 'service_income' })
  // Stock off through Settings → Features, as the owner would.
  await h.click('simple-nav-settings')
  await h.click('simple-entry-features')
  await attached(h, '[data-testid="feature-card-inventory"][data-on="true"]')
  await h.click('btn-feature-inventory')
  await attached(h, '[data-testid="feature-card-inventory"][data-on="false"]')
  assertEq((await h.invoke('config:features:get')).inventory, false, 'stock is off')
  await h.click('simple-nav-sell')
  assertEq(await page.$('[data-testid="simple-entry-quick-bill"]'), null, 'no Quick bill without stock')
  await h.click('simple-entry-make-bill')
  await h.waitScreen('simple-sell')
  await attached(h, '[data-testid="input-sell-amount"]')
  assertEq(await page.$('[data-testid^="picker-sell-item"]'), null, 'no product picker with stock off')
  assertEq(await page.$('[data-testid="btn-sell-toggle-mode"]'), null, 'no way to products with stock off')
  await fill('input-sell-amount', '1500')
  await fill('input-sell-note', 'Fridge repair')
  await page.waitForFunction(() => (document.querySelector('[data-testid="sell-preview"]')?.textContent ?? '').includes('in cash now'), null, { timeout: 10000 })
  assertEq(await paise('sell-total'), 150_000, 'just an amount, no GST')
  await noBanned('the amount-only bill')
  await shoot('05-amount-only')
  await h.click('btn-sell-save')
  await attached(h, '[data-testid="save-card"]')
  const s3 = await h.invoke('simple:sales', { from: '2000-01-01', to: '2100-12-31' })
  assertEq(JSON.stringify(s3.map((r) => [r.total, r.due, r.walkIn])), JSON.stringify([[150_000, 0, true]]), 'one amount-only bill, paid in cash')

  h.assertNoConsoleErrors()
})
