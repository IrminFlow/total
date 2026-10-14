// Scenario 55 — WP 9.4 Money in / Money out / Move money (simple mode).
//   1. A kirana with a customer who has two open bills (₹1,000 and ₹600): Home "+ Money in" opens
//      the simple Money in; an empty Save puts the problems under their questions; the customer's
//      bills show oldest first; ₹1,300 by UPI ticks both (₹1,000 + ₹300), the preview says where
//      the customer then stands; Save → the save card; the books' allocation (simple:money:bills)
//      agrees; Undo bins it and the bills are back.
//   2. Money out for an expense (Rent, a category tile added on the click) out of cash.
//   3. Move money: cash → bank.
//   4. The money list shows both (the undone one gone); a row opens its simple view.
// Screenshots (light + dark for two of them) — WP94_SHOTS=<dir> copies them for the visual review.
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
const isoDaysAgo = (n) => {
  const d = new Date()
  d.setDate(d.getDate() - n)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

await scenario('55-money', async (h) => {
  const { page } = h
  const shoot = async (name, themes = ['light']) => {
    for (const want of themes) {
      if ((await page.evaluate(() => document.documentElement.dataset.theme)) !== want) {
        await h.click('btn-theme')
        await page.waitForFunction((w) => document.documentElement.dataset.theme === w, want)
      }
      await page.waitForTimeout(400)
      const file = await h.shot(`${name}-${want}`)
      const dir = process.env.WP94_SHOTS
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
  const fill = async (testId, value) => {
    const input = page.locator(`[data-testid="${testId}"]`).first()
    await input.click()
    await input.fill(value)
    await input.blur()
  }
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
  const waitPreview = (needle) =>
    page.waitForFunction((n) => (document.querySelector('[data-testid="money-preview"]')?.textContent ?? '').includes(n), needle, { timeout: 15000 })
  const billsOf = async (partyId) => (await h.invoke('simple:money:bills', { partyId, date: isoDaysAgo(0) })).map((b) => [b.name, b.pending])

  // ================= setup: a customer with two open bills =================
  await h.createCompanyUI('Sharma Money', { mode: 'simple' })
  await h.stubDialogs()
  await ledger('HDFC Bank', 'Bank Accounts')
  const ramesh = (await ledger('Ramesh', 'Sundry Debtors', { creditDays: 7 })).id
  await ledger('Sales', 'Sales Accounts', { simpleCategory: 'sales' })
  const sale = (n, amount, date) => h.invoke('simple:post', { intent: { clientId: `e2e-55-sale-${n}`, kind: 'sale', date, customerId: ramesh, amount: { amount }, payment: { how: 'credit' } } })
  const s1 = await sale(1, 100_000, isoDaysAgo(6))
  const s2 = await sale(2, 60_000, isoDaysAgo(2))
  const [b1, b2] = [s1.entries[0].number, s2.entries[0].number]
  assertEq(JSON.stringify(await billsOf(ramesh)), JSON.stringify([[b1, 100_000], [b2, 60_000]]), 'two open bills, oldest first')

  // ================= 1. Money in by UPI covering one and a half bills =================
  await h.click('simple-task-money-in')
  await h.waitScreen('simple-money-in')
  await attached(h, '[data-testid="simple-nav"]')
  await page.waitForFunction(() => !document.querySelector('[data-testid="btn-money-save"]')?.hasAttribute('disabled'), null, { timeout: 10000 })
  await noBanned('the empty Money in')
  await shoot('01-money-in-empty')

  // An empty Save: each problem under its question.
  await h.click('btn-money-save')
  await attached(h, '[data-testid="field-error-party"]')
  await attached(h, '[data-testid="field-error-amount"]')
  assertEq(await text('field-error-party'), 'Pick the customer who paid.', 'who paid is asked under its question')

  await pick('picker-money-customer', 'Ramesh')
  await attached(h, '[data-testid="money-bill-list"]')
  await fill('input-money-amount', '1300')
  await h.click('money-how-upi')
  await page.waitForFunction(() => (document.querySelector('[data-testid="money-bill-gets-1"]')?.getAttribute('data-paise') ?? '') === '30000', null, { timeout: 10000 })
  assert(await page.$eval('[data-testid="money-bill-0"]', (e) => e.checked), 'the older bill is ticked')
  assert(await page.$eval('[data-testid="money-bill-1"]', (e) => e.checked), 'the newer bill is ticked (in part)')
  assertEq(await page.$eval('[data-testid="money-bill-0"]', (e) => e.dataset.bill), b1, 'oldest first')
  await waitPreview('still owes')
  const preview = await text('money-preview')
  assert(preview.includes('₹1,300.00 from Ramesh into HDFC Bank.') && preview.includes(`Pays bill ${b1}: ₹1,000.00.`) && preview.includes(`Pays bill ${b2}: ₹300.00.`) && preview.includes('Ramesh still owes ₹300.00.'), `the preview says it all (${preview})`)
  assertEq(await page.$eval('[data-testid="select-money-account"]', (s) => s.selectedOptions[0]?.textContent), 'HDFC Bank', 'UPI goes into the bank')
  await noBanned('the filled Money in')
  await shoot('02-money-in-filled', ['light', 'dark'])

  // Save (⌘↵) → the save card; the books' allocation agrees.
  await page.keyboard.press('Meta+Enter')
  await attached(h, '[data-testid="save-card"]')
  await page.waitForFunction(() => (document.querySelector('[data-testid="save-card-text"]')?.textContent ?? '').includes('saved.'), null, { timeout: 10000 })
  const card = await text('save-card-text')
  assert(card.includes('Money in ₹1,300.00 saved.') && card.includes('Ramesh still owes ₹300.00.'), `the card says what was saved (${card})`)
  await noBanned('the save card')
  await shoot('03-save-card')
  assertEq(JSON.stringify(await billsOf(ramesh)), JSON.stringify([[b2, 30_000]]), 'the Outstandings allocation: bill 1 paid, ₹300 left on bill 2')

  // Undo bins it; the bills are back.
  await h.click('btn-save-card-undo')
  await attached(h, '[data-testid="save-card"][data-state="undone"]')
  assertEq(JSON.stringify(await billsOf(ramesh)), JSON.stringify([[b1, 100_000], [b2, 60_000]]), 'Undo put both bills back')

  // ================= 2. Money out for an expense, out of cash =================
  await h.click('simple-nav-money')
  await h.click('simple-entry-money-out')
  await h.waitScreen('simple-money-out')
  await h.click('money-out-who-expense')
  assertEq(await page.$('[data-testid="money-gst-bill"]'), null, 'an unregistered business is not asked about a GST bill')
  await h.click('picker-money-expense')
  await h.click('category-rent')
  await page.waitForFunction(() => (document.querySelector('[data-testid="picker-money-expense"]')?.textContent ?? '').includes('Rent'), null, { timeout: 10000 })
  await fill('input-money-amount', '250')
  await waitPreview('₹250.00 to Rent from Cash.')
  await noBanned('Money out')
  await shoot('04-money-out')
  await h.click('btn-money-save')
  await attached(h, '[data-testid="save-card"]')
  assert((await h.invoke('master:ledgers:list')).some((l) => l.name === 'Rent' && l.simpleCategory === 'rent'), 'the Rent tile added its account')

  // ================= 3. Move money: cash → bank =================
  await h.click('simple-nav-money')
  await h.click('simple-entry-move-money')
  await h.waitScreen('simple-move-money')
  const accounts = (await h.invoke('simple:money:setup')).moneyAccounts
  await page.selectOption('[data-testid="select-move-from"]', String(accounts.find((a) => a.name === 'Cash').id))
  await page.selectOption('[data-testid="select-move-to"]', String(accounts.find((a) => a.name === 'HDFC Bank').id))
  await fill('input-money-amount', '2000')
  await waitPreview('₹2,000.00 moved from Cash to HDFC Bank.')
  await noBanned('Move money')
  await shoot('05-move-money')
  await h.click('btn-money-save')
  await attached(h, '[data-testid="save-card"]')

  // ================= 4. The money list → an entry =================
  await h.click('simple-nav-money')
  await h.click('simple-entry-money-list')
  await h.waitScreen('simple-money')
  await attached(h, '[data-testid="rows-simple-money"] tr')
  const dirs = await page.$$eval('[data-testid="money-row-direction"]', (els) => els.map((e) => e.dataset.value))
  assertEq(JSON.stringify(dirs.sort()), JSON.stringify(['move', 'out']), 'the list: the move and the expense (the undone money in is gone)')
  const listText = await text('rows-simple-money')
  assert(listText.includes('Rent') && listText.includes('250.00') && listText.includes('2,000.00') && listText.includes('Expense'), `the list says who / how much / what (${listText})`)
  await noBanned('the money list')
  await shoot('06-money-list', ['light', 'dark'])
  await page.click('[data-testid="rows-simple-money"] tr >> text=Rent')
  await attached(h, '[data-testid="simple-money-entry"][data-entry]')
  assert((await text('simple-money-entry')).includes('To Rent · From Cash'), 'the entry view says who and from where')
  await noBanned('an entry')
  await attached(h, '[data-testid="btn-money-entry-edit"]')

  h.assertNoConsoleErrors()
})
