// Scenario 59 — WP 9.8 People (simple mode).
//   1. A wizard company (trader, no GST, no stock): two customers with credit bills — Ramesh with
//      one bill 40 days old (late, 15 days to pay) and one 2 days old; Sita with one 3 days old —
//      and a supplier, Bharat Steel, with a bill 20 days old.
//   2. People → Customers and suppliers: the list shows who owes what and who is late; its totals
//      are Home's "customers owe you" / "you owe suppliers"; the filters narrow it.
//   3. Ramesh's page: balance, the late part, the open bills oldest first in words; WhatsApp
//      number saved (audited); Send a reminder → the plain message; Copy puts exactly that text on
//      the clipboard and logs a reminder (reminder_log).
//   4. Record money in → the simple Money in, Ramesh picked, his bills listed; ₹3,000 in cash →
//      saved; back to the list: Ramesh owes ₹1,000, nothing late; the totals still equal Home's.
//   5. Bills to pay: Bharat Steel's bill with Pay → Money out for that bill.
// Screenshots light + dark of the list, a person and the reminder; WP98_SHOTS=<dir> copies them.
import * as fs from 'node:fs'
import * as path from 'node:path'
import { scenario, assert, assertEq } from '../lib/harness.mjs'

// The plan §1 banned list (shared/simple/bannedWords.ts), as its patterns match it.
const BANNED = [
  /\bvouchers?\b/i, /\bledgers?\b/i, /\bjournals?\b/i, /\bcontras?\b/i, /\b(?:Dr|Cr)\b/, /\bparticulars?\b/i, /\bnarrations?\b/i, /\bsundry\b/i,
  /\bgroups?\b/i, /\bITC\b/i, /\bset[- ]?offs?\b/i, /\bag(?:e)?ing\b/i, /\bBRS\b/i, /\bgodowns?\b/i, /\bBOMs?\b/i, /\bSOA\b/i
]
const bannedWordsIn = (text) => BANNED.filter((re) => re.test(text)).map((re) => re.source)
const attached = (h, sel, timeout = 15000) => h.page.waitForSelector(sel, { state: 'attached', timeout })
const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

await scenario('59-people', async (h) => {
  const { page } = h
  const shoot = async (name, themes = ['light', 'dark']) => {
    for (const want of themes) {
      if ((await page.evaluate(() => document.documentElement.dataset.theme)) !== want) {
        await h.click('btn-theme')
        await page.waitForFunction((w) => document.documentElement.dataset.theme === w, want)
      }
      await page.waitForTimeout(400)
      const file = await h.shot(`${name}-${want}`)
      const dir = process.env.WP98_SHOTS
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
  const text = async (testId) => ((await page.textContent(`[data-testid="${testId}"]`)) ?? '').replace(/\s+/g, ' ').trim()
  const noBanned = async (where) => {
    const visible = await page.evaluate(() => document.querySelector('main')?.innerText ?? '')
    const found = bannedWordsIn(visible)
    assert(found.length === 0, `no accounting words on ${where} (${found.join(', ')})`)
  }
  const row = (id) => page.locator(`[data-testid="rows-simple-people"] tr[data-row-id="${id}"]`)

  // ================= 1. a wizard trader with two customers and a supplier =================
  await h.waitScreen('company-select')
  await attached(h, '[data-testid="setup-wizard"]')
  await h.fill('setup-name', 'Sharma Traders')
  await h.click('setup-next')
  await h.click('setup-type-trader')
  await h.click('setup-next')
  await h.click('setup-gst-no')
  await h.click('setup-next')
  await h.click('setup-stock-no')
  await h.click('setup-next')
  await h.click('setup-start-fy')
  await h.click('setup-fresh-new')
  await h.click('setup-next')
  await h.click('setup-finish')
  await h.waitScreen('gateway', 30000)
  await attached(h, '[data-testid="simple-home"]', 20000)
  await h.stubDialogs()

  const now = new Date()
  const today = iso(now)
  const fyStart = `${now.getMonth() >= 3 ? now.getFullYear() : now.getFullYear() - 1}-04-01`
  const ago = (n) => {
    const d = new Date(now)
    d.setDate(d.getDate() - n)
    const s = iso(d)
    return s < fyStart ? fyStart : s
  }
  const groups = await h.invoke('master:groups:list')
  const gid = (name) => groups.find((g) => g.name === name).id
  const party = (name, group, extra = {}) =>
    h.invoke('master:ledgers:create', {
      name, groupId: gid(group), openingBalance: 0, gstin: null, stateCode: null, address: null, taxType: null, gstRate: null, hsn: null,
      tdsSectionId: null, pan: null, creditDays: null, exportType: null, ...extra
    })
  const ramesh = await party('Ramesh Traders', 'Sundry Debtors', { creditDays: 15, phone: '98765 43210' })
  const sita = await party('Sita Stores', 'Sundry Debtors', { creditDays: 15 })
  const bharat = await party('Bharat Steel', 'Sundry Creditors')
  let n = 0
  const sale = (customerId, amount, days) =>
    h.invoke('simple:post', { intent: { kind: 'sale', clientId: `e2e-59-${++n}-xxxxxxxx`, date: ago(days), customerId, amount: { amount }, payment: { how: 'credit' } }, today })
  const late = await sale(ramesh.id, 300_000, 40)
  await sale(ramesh.id, 100_000, 2)
  await sale(sita.id, 200_000, 3)
  const purchases = (await h.invoke('master:ledgers:list')).find((l) => l.simpleCategory === 'purchases')
  await h.invoke('simple:post', {
    intent: { kind: 'purchase', clientId: `e2e-59-${++n}-xxxxxxxx`, date: ago(20), supplierId: bharat.id, billNo: 'BS-7', amount: { amount: 150_000, ...(purchases ? { accountId: purchases.id } : {}) }, payment: { how: 'credit' } },
    today
  })
  const lateBill = late.entries[0].number

  // ================= 2. People → the list =================
  await h.click('simple-nav-people')
  await attached(h, '[data-testid="simple-entry-customers-suppliers"]')
  await h.click('simple-entry-customers-suppliers')
  await h.waitScreen('simple-people')
  await attached(h, '[data-testid="simple-nav"]')
  await attached(h, `[data-testid="rows-simple-people"] tr[data-row-id="${ramesh.id}"]`)
  assertEq(await row(ramesh.id).getAttribute('data-open'), '400000', 'Ramesh owes ₹4,000')
  assertEq(await row(ramesh.id).getAttribute('data-late'), '300000', '₹3,000 of it is late')
  assert((await row(ramesh.id).textContent()).includes('98765 43210'), 'his phone is listed')
  assert((await row(ramesh.id).locator('[data-testid="person-chip-late"]').textContent()).includes('₹3,000.00 late'), 'the late chip')
  assertEq(await row(sita.id).getAttribute('data-late'), '0', 'Sita is not late')
  assertEq(await row(bharat.id).getAttribute('data-open'), '150000', 'you owe Bharat Steel ₹1,500')
  const home = await h.invoke('simple:home', { today })
  assertEq(await page.getAttribute('[data-testid="people-totals"]', 'data-owes-you'), String(home.receivables.total), 'customers owe you = Home')
  assertEq(await page.getAttribute('[data-testid="people-totals"]', 'data-you-owe'), String(home.payables.total), 'you owe suppliers = Home')
  assertEq(await text('people-totals'), 'Customers owe you ₹6,000.00 · You owe suppliers ₹1,500.00', 'the totals in words')
  await noBanned('the People list')
  await shoot('01-people-list')
  // Filters.
  await h.click('people-filter-late')
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="rows-simple-people"] tr[data-row-id]').length === 2)
  assertEq(
    JSON.stringify(await page.$$eval('[data-testid="rows-simple-people"] tr[data-row-id]', (els) => els.map((e) => e.dataset.rowId).sort())),
    JSON.stringify([String(ramesh.id), String(bharat.id)].sort()),
    'late to pay: Ramesh and the supplier bill'
  )
  await h.click('people-filter-customers')
  await page.waitForFunction(() => [...document.querySelectorAll('[data-testid="rows-simple-people"] tr[data-row-id]')].every((e) => e.dataset.side === 'customer'))
  await h.click('people-filter-all')

  // ================= 3. Ramesh's page, his WhatsApp, a reminder =================
  await row(ramesh.id).locator('td').first().click()
  await h.waitScreen('simple-person')
  await attached(h, `[data-testid="simple-person"][data-person="${ramesh.id}"]`)
  assertEq(await text('person-balance'), 'Owes you ₹4,000.00', 'where Ramesh stands')
  assertEq(await text('person-late'), '₹3,000.00 of it is late.', 'the late part')
  const bills = await page.$$eval('[data-testid="rows-person-bills"] tr[data-bill]', (els) => els.map((e) => [e.dataset.bill, e.dataset.late]))
  assertEq(bills[0][0], lateBill, 'oldest bill first')
  assert(Number(bills[0][1]) === 25, `the old bill is 25 days late (${bills[0][1]})`)
  assert((await text('rows-person-bills')).includes('25 days overdue'), 'said in words')

  await page.fill('[data-testid="input-person-whatsapp"]', '98765 00000')
  await h.click('btn-person-save')
  await page.waitForFunction(() => document.querySelector('[data-testid="btn-person-save"]')?.hasAttribute('disabled'), null, { timeout: 10000 })
  assertEq((await h.invoke('simple:people:person', { id: ramesh.id, today })).whatsapp, '98765 00000', 'the WhatsApp number is saved')
  const audit = await h.invoke('audit:list', { entity: 'ledger', action: 'update' })
  assert(JSON.stringify(audit).includes('98765 00000'), 'the change is in the edit log')
  await noBanned('a person')
  await shoot('02-person')

  await h.click('btn-person-remind')
  await attached(h, '[data-testid="person-reminder"]')
  const message = await page.inputValue('[data-testid="reminder-text"]')
  assert(message.startsWith('Hello Ramesh Traders,'), `the message says hello (${message})`)
  assert(message.includes(`• Bill ${lateBill} of`) && message.includes('₹3,000.00'), 'it lists the late bill and what is due')
  assert(!message.includes('₹1,000.00'), 'only the late bill')
  assertEq(bannedWordsIn(message).length, 0, 'no accounting words in the message')
  await h.click('btn-reminder-copy')
  await attached(h, '[data-testid="reminder-note"]')
  const clip = await h.app.evaluate(({ clipboard }) => clipboard.readText())
  assertEq(clip, message, 'Copy puts exactly that message on the clipboard')
  const log = await h.invoke('receivables:reminderLog', { from: fyStart, to: today, ledgerId: ramesh.id })
  assertEq(log.length, 1, 'one reminder logged')
  assertEq(log[0].channel, 'other', 'a copied reminder is logged as other')
  await h.click('reminder-lang-hinglish')
  await page.waitForFunction(() => document.querySelector('[data-testid="reminder-text"]')?.value.startsWith('Namaste'))
  await h.click('reminder-lang-en')
  await noBanned('the reminder')
  await shoot('03-reminder')

  // ================= 4. Record money in from his page =================
  await h.click('btn-person-money-in')
  await h.waitScreen('simple-money-in')
  await attached(h, '[data-testid="money-bill-list"]')
  assert((await page.inputValue('[data-testid="picker-money-customer"]')).includes('Ramesh Traders'), 'Ramesh is picked')
  await page.fill('[data-testid="input-money-amount"]', '3000')
  await page.locator('[data-testid="input-money-amount"]').blur()
  await h.click('money-how-cash')
  await page.waitForFunction(() => !document.querySelector('[data-testid="btn-money-save"]')?.hasAttribute('disabled'), null, { timeout: 10000 })
  await page.waitForFunction(() => (document.querySelector('[data-testid="money-preview"]')?.textContent ?? '').includes('still owes'), null, { timeout: 15000 })
  await h.click('btn-money-save')
  await attached(h, '[data-testid="save-card"]')

  await h.click('simple-nav-people')
  await h.click('simple-entry-customers-suppliers')
  await h.waitScreen('simple-people')
  await attached(h, `[data-testid="rows-simple-people"] tr[data-row-id="${ramesh.id}"][data-open="100000"]`)
  assertEq(await row(ramesh.id).getAttribute('data-late'), '0', 'nothing of Ramesh’s is late now')
  const home2 = await h.invoke('simple:home', { today })
  assertEq(await page.getAttribute('[data-testid="people-totals"]', 'data-owes-you'), String(home2.receivables.total), 'still = Home')
  assertEq(home2.receivables.total, 300_000, 'customers owe ₹3,000 (₹1,000 + ₹2,000)')

  // ================= 5. Bills to pay =================
  await h.click('tab-simple-people-bills')
  await attached(h, '[data-testid="rows-simple-bills-to-pay"] tr[data-bill="BS-7"]')
  assertEq(await page.getAttribute('[data-testid="bills-late"]', 'data-paise'), '150000', 'the supplier bill is late')
  await noBanned('Bills to pay')
  await shoot('04-bills-to-pay', ['light'])
  await page.locator('[data-testid="rows-simple-bills-to-pay"] tr[data-bill="BS-7"] [data-testid="btn-bill-pay"]').click()
  await h.waitScreen('simple-money-out')
  await attached(h, '[data-testid="money-bill-list"]')
  assert(await page.$eval('[data-testid="money-bill-0"]', (e) => e.checked && e.dataset.bill === 'BS-7'), 'that bill is ticked')
  // Leave the prefilled form (it asks first) so the app closes clean.
  await h.click('simple-nav-people')
  const discard = await page.waitForSelector('[data-testid="confirm-ok"]', { timeout: 3000 }).catch(() => null)
  if (discard) await discard.click()
  await attached(h, '[data-testid="simple-section-people"]')

  h.assertNoConsoleErrors()
})
