// Scenario 62 — WP 9.10 Accountant-view hand-off for every simple screen (plan §0.1 / §2.1; the
// plan's "59-handoff" — 59 is People, 60 is reserved for the no-ledger-knowledge journey, 61 is WP 9.9's Reports and Taxes).
//   1. A trader made through the setup wizard (regular GST, stock): Make a bill half-filled (a
//      customer, a product, a quantity, on credit) → "Accountant view" → the full sales editor shows
//      the same customer, line and total (the hand-off banner says nothing is saved yet) → saved
//      there → "Back to simple" lands on THAT bill's simple view.
//   2. From the full app's sidebar (Day book) a receipt opens in its editor → "Back to simple" →
//      the Money view of that entry.
//   3. ⌘K in a simple company lists the simple screens: "Make a bill" + ↵ opens it.
//   4. "Always open the full app for this" remembers the choice: Make a bill then opens the full
//      sales editor; "Back to simple" clears it.
//   5. Back the other way, unsaved: a half-filled bill → Accountant view → the quantity, the note
//      and the entry number changed in the full editor → "Back to simple" (no discard question)
//      → Make a bill shows the new quantity, note and total, and a note names the entry number as
//      what could not come back; nothing saved until Save there, which saves the bill as carried.
// Light + dark screenshots; WP910_SHOTS=<dir> copies them for the visual review.
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

await scenario('62-handoff', async (h) => {
  const { page } = h
  const shoot = async (name, themes = ['light', 'dark']) => {
    for (const want of themes) {
      if ((await page.evaluate(() => document.documentElement.dataset.theme)) !== want) {
        await h.click('btn-theme')
        await page.waitForFunction((w) => document.documentElement.dataset.theme === w, want)
      }
      await page.waitForTimeout(400)
      const file = await h.shot(`${name}-${want}`)
      const dir = process.env.WP910_SHOTS
      if (dir) {
        fs.mkdirSync(dir, { recursive: true })
        fs.copyFileSync(file, path.join(dir, `${name}-${want}.png`))
      }
    }
    if ((await page.evaluate(() => document.documentElement.dataset.theme)) !== 'light') {
      await h.click('btn-theme')
      await page.waitForFunction(() => document.documentElement.dataset.theme === 'light')
    }
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
  const text = async (testId) => ((await page.textContent(`[data-testid="${testId}"]`)) ?? '').replace(/\s+/g, ' ').trim()
  const noBanned = async (where) => {
    const visible = await page.evaluate(() => document.querySelector('main')?.innerText ?? '')
    const found = bannedWordsIn(visible)
    assert(found.length === 0, `no accounting words on ${where} (${found.join(', ')})`)
  }
  const overrides = () => page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith('total-view:')))

  // ---------- 1. the wizard: a trader, regular GST, with stock ----------
  await h.waitScreen('company-select')
  await attached(h, '[data-testid="setup-wizard"]')
  await h.fill('setup-name', 'Gupta Traders')
  await h.click('setup-next')
  await h.click('setup-type-trader')
  await h.click('setup-next')
  await h.click('setup-gst-regular')
  await h.fill('setup-gstin', '27AAPFU0939F1ZV')
  await h.click('setup-filing-monthly')
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
  assertEq((await h.invoke('company:current')).ui.mode, 'simple', 'the wizard made a simple company')

  const groups = await h.invoke('master:groups:list')
  const customer = await h.invoke('master:ledgers:create', {
    name: 'Mehta & Sons', groupId: groups.find((g) => g.name === 'Sundry Debtors').id, openingBalance: 0, gstin: null, stateCode: '27', address: null,
    taxType: null, gstRate: null, hsn: null, tdsSectionId: null, pan: null, creditDays: 30, exportType: null
  })
  const units = await h.invoke('master:units:list')
  await h.invoke('master:stockItems:quickCreate', {
    item: { name: 'Steel bolt', groupId: null, unitId: units[0].id, hsn: null, gstRate: 18, cessRate: null, openingQtyMilli: 50_000, openingValue: 500_000, barcode: null, reorderLevelMilli: null },
    sellingPricePaise: 25_000,
    purchasePricePaise: null
  })

  // Make a bill, half-filled: customer, a product, a quantity, on credit — not saved.
  await h.click('simple-task-sale')
  await h.waitScreen('simple-sell')
  await pick('picker-sell-customer', 'Mehta')
  await pick('picker-sell-item-0', 'Steel bolt')
  await fill('input-sell-qty-0', '3')
  await h.click('sell-paid-credit')
  await page.waitForFunction(() => document.querySelector('[data-testid="sell-total"]')?.getAttribute('data-paise') === '88500', null, { timeout: 10000 })
  await noBanned('the half-filled bill')
  await shoot('01-bill-half-filled', ['light'])

  // Accountant view → the full sales editor WITH those answers (nothing saved yet).
  await h.click('btn-sell-accountant-view')
  await h.waitScreen('voucher-entry')
  await attached(h, '[data-testid="handoff-banner"]')
  await attached(h, '[data-testid="rows-invoice-lines"]')
  assertEq((await h.invoke('simple:sales', { from: '2000-01-01', to: '2100-12-31' })).length, 0, 'the hand-off saved nothing')
  assertEq(await page.getAttribute('[data-testid="voucher-entry-mode"]', 'data-mode'), 'invoice', 'the sales editor, invoice form')
  const partyValue = await page.inputValue('[data-testid="picker-party"]')
  assert(partyValue.includes('Mehta & Sons'), `the same customer (${partyValue})`)
  const lineValues = await page.$$eval('[data-testid="rows-invoice-lines"] input', (els) => els.map((e) => e.value))
  assert(lineValues[0] === 'Steel bolt' && lineValues.includes('3'), `the same product line (${lineValues.join(' | ')})`)
  await page.keyboard.press('Escape') // the party picker's list (it opens with focus) — closed for the screenshot
  const editorTotal = await page.evaluate(() => {
    const label = [...document.querySelectorAll('span')].find((s) => s.textContent === 'Total' && s.nextElementSibling)
    return label?.nextElementSibling?.textContent ?? ''
  })
  assert(editorTotal.replace(/\s/g, '').includes('885.00'), `the same total, ₹885.00 (${editorTotal})`)
  assert((await text('handoff-banner')).includes('Nothing is saved until you do'), 'the banner says nothing is saved yet')
  await shoot('02-editor-handoff')

  // Saved in the full editor → Back to simple lands on THAT bill's simple view.
  await h.click('btn-save-voucher')
  await attached(h, '[data-testid="save-card"]')
  const sales = await h.invoke('simple:sales', { from: '2000-01-01', to: '2100-12-31' })
  assertEq(sales.length, 1, 'one bill saved, from the full editor')
  assertEq(sales[0].total, 88_500, 'the bill as the simple form had it')
  await h.click('btn-back-to-simple')
  await attached(h, `[data-testid="simple-sale"][data-bill="${sales[0].voucherId}"]`)
  await attached(h, '[data-testid="simple-nav"]')
  assertEq(Number(await page.getAttribute('[data-testid="simple-sale-total"]', 'data-paise')), 88_500, 'the bill view shows the same total')
  await noBanned('the bill view')
  await shoot('03-bill-view', ['light'])

  // ---------- 2. a receipt opened from the full app's sidebar → Money view ----------
  const receipt = await h.invoke('simple:post', { intent: { clientId: 'e2e-62-receipt-1', kind: 'money_in', customerId: customer.id, amount: '300', into: { how: 'cash' } } })
  const receiptId = receipt.voucherIds[0]
  await h.click('simple-nav-money')
  await h.click('simple-entry-all-entries')
  await h.waitScreen('daybook')
  await attached(h, 'nav[aria-label="Main"]')
  await h.click('nav-daybook')
  await page.click(`[data-testid="rows-daybook"] [data-row-id="${receiptId}"]`, { timeout: 10000 })
  await h.waitScreen('voucher-entry')
  await attached(h, '[data-testid="voucher-entry-mode"][data-mode="accounting"]')
  await h.click('btn-back-to-simple')
  await attached(h, `[data-testid="simple-money-entry"][data-entry="${receiptId}"]`)
  await noBanned('the money view')
  await shoot('04-money-view', ['dark'])

  // ---------- 3. ⌘K: the simple screens ----------
  await page.keyboard.press('Meta+k')
  await attached(h, '[data-testid="palette"]')
  await attached(h, '[data-testid="palette-simple-make-bill"]')
  await page.fill('[data-testid="input-palette"]', 'Make a bill')
  await attached(h, '[data-testid="palette-simple-make-bill"][data-active="true"]')
  await shoot('05-palette', ['light'])
  await page.keyboard.press('Enter')
  await h.waitScreen('simple-sell')

  // ---------- 4. "Always open the full app for this" ----------
  assertEq((await overrides()).length, 0, 'a one-off Accountant view remembered nothing')
  // The menu, in the dark look (the theme switch would close it, so it is set first).
  await h.click('btn-theme')
  await page.waitForFunction(() => document.documentElement.dataset.theme === 'dark')
  await h.click('btn-sell-accountant-view-more')
  await attached(h, '[data-testid="btn-sell-accountant-view-always"]')
  await page.waitForTimeout(400)
  const menuShot = await h.shot('06-always-menu-dark')
  if (process.env.WP910_SHOTS) fs.copyFileSync(menuShot, path.join(process.env.WP910_SHOTS, '06-always-menu-dark.png'))
  await h.click('btn-sell-accountant-view-always')
  await h.click('btn-theme')
  await page.waitForFunction(() => document.documentElement.dataset.theme === 'light')
  await h.waitScreen('voucher-entry')
  assertEq((await overrides()).filter((k) => k.endsWith(':simple-sell')).length, 1, 'the choice is remembered for Make a bill')
  // Home → + Sale now opens the full sales editor straight away.
  await h.click('btn-back-to-simple')
  await h.waitScreen('simple-sell')
  assertEq((await overrides()).length, 0, 'Back to simple cleared it')
  await h.click('btn-sell-accountant-view-more')
  await h.click('btn-sell-accountant-view-always')
  await h.waitScreen('voucher-entry')
  await h.click('nav-gateway')
  await attached(h, '[data-testid="simple-home"]')
  await h.click('simple-task-sale')
  await h.waitScreen('voucher-entry')
  await attached(h, '[data-testid="voucher-entry-mode"][data-mode="invoice"]')
  await h.click('btn-back-to-simple')
  await h.waitScreen('simple-sell')
  assertEq((await overrides()).length, 0, 'and Back to simple clears it again')

  // ---------- 5. the editor's changes carried back ----------
  await pick('picker-sell-customer', 'Mehta')
  await pick('picker-sell-item-0', 'Steel bolt')
  await fill('input-sell-qty-0', '3')
  await h.click('sell-paid-credit')
  await page.waitForFunction(() => document.querySelector('[data-testid="sell-total"]')?.getAttribute('data-paise') === '88500', null, { timeout: 10000 })
  // Review: an editor NOT touched goes back exactly as before — the same answers, no note.
  await h.click('btn-sell-accountant-view')
  await h.waitScreen('voucher-entry')
  await attached(h, '[data-testid="rows-invoice-lines"]')
  await page.keyboard.press('Escape') // the party picker's list
  await h.click('btn-back-to-simple')
  await page.waitForFunction(() => !!document.querySelector('[data-testid="confirm-ok"]') || !!document.querySelector('[data-testid="simple-sell"]'), null, { timeout: 10000 })
  if (await page.$('[data-testid="confirm-ok"]')) await h.click('confirm-ok')
  await h.waitScreen('simple-sell')
  assertEq(await page.inputValue('[data-testid="input-sell-qty-0"]'), '3', 'an untouched editor: the same quantity')
  await page.waitForFunction(() => document.querySelector('[data-testid="sell-total"]')?.getAttribute('data-paise') === '88500', null, { timeout: 10000 })
  assert((await page.$('[data-testid="carried-back-note"]')) == null, `an untouched editor: no note (${(await page.$('[data-testid="carried-back-note"]')) ? await text('carried-back-note') : ''})`)
  await h.click('btn-sell-accountant-view')
  await h.waitScreen('voucher-entry')
  await attached(h, '[data-testid="handoff-banner"]')
  await attached(h, '[data-testid="rows-invoice-lines"]')
  await page.keyboard.press('Escape') // the party picker's list
  const inputs = page.locator('[data-testid="rows-invoice-lines"] input')
  const values = await inputs.evaluateAll((els) => els.map((e) => e.value))
  const qtyAt = values.indexOf('3')
  assert(qtyAt >= 0, `the quantity is in the editor (${values.join(' | ')})`)
  await inputs.nth(qtyAt).fill('5')
  await inputs.nth(qtyAt).blur()
  await fill('input-invoice-narration', 'Carried back from the full app')
  await fill('invoice-number', 'GT-777')
  await shoot('07-editor-changed', ['light'])
  await h.click('btn-back-to-simple')
  await h.waitScreen('simple-sell')
  assertEq(await page.inputValue('[data-testid="input-sell-qty-0"]'), '5', 'the quantity changed in the full editor came back')
  assertEq(await page.inputValue('[data-testid="input-sell-note"]'), 'Carried back from the full app', 'and the note')
  assert((await page.inputValue('[data-testid="picker-sell-customer"]')).includes('Mehta'), 'the customer is still there')
  await page.waitForFunction(() => document.querySelector('[data-testid="sell-total"]')?.getAttribute('data-paise') === '147500', null, { timeout: 10000 })
  await attached(h, '[data-testid="carried-back-note"]')
  assert((await text('carried-back-note')).includes('the entry number'), `the note names what could not come (${await text('carried-back-note')})`)
  assertEq(await page.getAttribute('[data-testid="carried-back-note"]', 'role'), 'alert', 'the note is a warning that stays (no timer)')
  await noBanned('the bill carried back')
  assertEq((await h.invoke('simple:sales', { from: '2000-01-01', to: '2100-12-31' })).length, 1, 'nothing more was saved')
  await shoot('08-carried-back')
  // Saved from the simple form: the bill as carried back (₹1,475.00, with the note).
  await h.click('btn-sell-save')
  await attached(h, '[data-testid="save-card"]')
  assertEq(await page.$('[data-testid="carried-back-note"]'), null, 'the note goes once the bill is saved')
  const after = await h.invoke('simple:sales', { from: '2000-01-01', to: '2100-12-31' })
  assertEq(after.length, 2, 'the carried-back bill saved from the simple form')
  assertEq(after.map((b) => b.total).sort((a, b) => a - b).join(), '88500,147500', 'at the quantity changed in the full editor')

  h.assertNoConsoleErrors()
})
