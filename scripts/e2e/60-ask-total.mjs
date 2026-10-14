// Scenario 60 — WP 10.1 Ask Total (deterministic, no key). The plan's e2e 60 is the growing
// "no ledger knowledge" beginner journey (WP 10.8 extends this file); Phase 10 starts it with
// Ask Total.
//   1. The setup wizard: a regular, monthly-filing trader (no stock); a customer and a supplier,
//      one bill (₹10,000 + 18% GST, on credit) and one purchase (₹5,000 + 18% GST, on credit) today.
//   2. Home's "Ask Total" box: "who owes me" → the panel answers ₹11,800.00 (a chip that opens
//      Who owes you), "Total answered this itself"; "kitna profit hua is mahine" → ₹5,000.00.
//   3. "paid 500 for tea in cash" → "Open Money out" → the flow opens pre-filled (Office expenses,
//      ₹500, cash, "tea"); the GST-bill question answered No → Save → the save card; the Ask
//      Total draft is consumed.
//   4. "open bank" → the Bank screen.
//   5. Something Total can't answer → "try these" suggestions + help, and (AI off) nothing goes
//      to a model.
// No accounting words on any simple screen or in the panel. Screenshots light + dark;
// WP101_SHOTS=<dir> copies the review set there.
import * as fs from 'node:fs'
import * as path from 'node:path'
import { scenario, assert, assertEq } from '../lib/harness.mjs'

const BANNED = [
  /\bvouchers?\b/i, /\bledgers?\b/i, /\bjournals?\b/i, /\bcontras?\b/i, /\b(?:Dr|Cr)\b/, /\bparticulars?\b/i, /\bnarrations?\b/i, /\bsundry\b/i,
  /\bgroups?\b/i, /\bITC\b/i, /\bset[- ]?offs?\b/i, /\bag(?:e)?ing\b/i, /\bBRS\b/i, /\bgodowns?\b/i, /\bBOMs?\b/i, /\bSOA\b/i
]
const bannedWordsIn = (text) => BANNED.filter((re) => re.test(text)).map((re) => re.source)
const attached = (h, sel, timeout = 15000) => h.page.waitForSelector(sel, { state: 'attached', timeout })

await scenario('60-ask-total', async (h) => {
  const { page } = h

  const shoot = async (name) => {
    for (const want of ['light', 'dark']) {
      if ((await page.evaluate(() => document.documentElement.dataset.theme)) !== want) {
        await h.click('btn-theme')
        await page.waitForFunction((w) => document.documentElement.dataset.theme === w, want)
      }
      await page.waitForTimeout(400)
      const file = await h.shot(`${name}-${want}`)
      const dir = process.env.WP101_SHOTS
      if (dir) {
        fs.mkdirSync(dir, { recursive: true })
        fs.copyFileSync(file, path.join(dir, `${name}-${want}.png`))
      }
    }
    await h.click('btn-theme')
    await page.waitForFunction(() => document.documentElement.dataset.theme === 'light')
  }
  const noBanned = async (where, selector = 'main') => {
    const visible = await page.evaluate((s) => document.querySelector(s)?.innerText ?? '', selector)
    const found = bannedWordsIn(visible)
    assert(found.length === 0, `no accounting words on ${where} (${found.join(', ')})`)
  }
  const answers = () => page.locator('[data-testid="ask-answer"]')
  /** Ask in the panel and wait for its (n-th) answer. */
  const askPanel = async (q) => {
    const before = await answers().count()
    await page.fill('[data-testid="ask-input"]', q)
    await h.click('ask-send')
    await page.waitForFunction((n) => document.querySelectorAll('[data-testid="ask-answer"]').length > n, before, { timeout: 15000 })
    return ((await answers().nth(before).innerText()) ?? '').replace(/\s+/g, ' ').trim()
  }

  // ================= 1. the wizard + a bill and a purchase =================
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
  await h.click('setup-stock-no')
  await h.click('setup-next')
  await h.click('setup-start-fy')
  await h.click('setup-fresh-new')
  await h.click('setup-next')
  await h.click('setup-finish')
  await h.waitScreen('gateway', 30000)
  await attached(h, '[data-testid="simple-home"]', 20000)
  await h.stubDialogs()

  const groups = await h.invoke('master:groups:list')
  const party = (name, group) =>
    h.invoke('master:ledgers:create', {
      name, groupId: groups.find((g) => g.name === group).id, openingBalance: 0, gstin: null, stateCode: '27', address: null,
      taxType: null, gstRate: null, hsn: null, tdsSectionId: null, pan: null, creditDays: 15, exportType: null
    })
  const ramesh = await party('Ramesh Traders', 'Sundry Debtors')
  const mohan = await party('Mohan Supplies', 'Sundry Creditors')
  await h.invoke('simple:post', { intent: { clientId: 'e2e60-sale-0001', kind: 'sale', customerId: ramesh.id, amount: { amount: 10_000_00, gstRate: 18 }, payment: { how: 'credit' } } })
  await h.invoke('simple:post', { intent: { clientId: 'e2e60-buy-00001', kind: 'purchase', supplierId: mohan.id, billNo: 'MS/7', amount: { amount: 5_000_00, gstRate: 18 }, payment: { how: 'credit' } } })
  await page.reload()
  await page.waitForSelector('[data-screen="company-select"], [data-testid="simple-home"]', { state: 'attached', timeout: 20000 })
  if (await page.$('[data-screen="company-select"]')) await h.openCompany('Gupta Traders')
  await attached(h, '[data-testid="simple-home"]', 20000)
  await h.stubDialogs()

  // ================= 2. Home's Ask box =================
  await attached(h, '[data-testid="simple-home-ask"]')
  await noBanned('Home with the Ask box')
  await page.fill('[data-testid="simple-home-ask-input"]', 'who owes me')
  await shoot('01-home-ask')
  await h.click('simple-home-ask-send')
  await attached(h, '[data-testid="ask-panel"]')
  await attached(h, '[data-testid="ask-answer"]')
  const owes = ((await answers().first().innerText()) ?? '').replace(/\s+/g, ' ')
  assert(owes.includes('₹11,800.00'), `who owes me = the bill with GST (${owes})`)
  assert(owes.includes('Total answered this itself'), 'the panel says Total answered')
  assertEq(await page.locator('[data-testid="ask-figure"]').first().innerText(), '₹11,800.00', 'the figure is a chip')
  assertEq(await page.locator('[data-testid="ai-panel"]').count(), 0, 'AI off: no AI panel')

  const profit = await askPanel('kitna profit hua is mahine')
  assert(profit.includes('₹5,000.00'), `profit this month = ₹10,000 sold − ₹5,000 bought (${profit})`)
  await noBanned('the Ask Total panel', '[data-testid="ask-panel"]')
  await shoot('02-answers')

  // The chip opens Who owes you.
  await page.locator('[data-testid="ask-figure"]').first().click()
  await h.waitScreen('simple-people')

  // ================= 3. an entry request → Money out, pre-filled =================
  const tea = await askPanel('paid 500 for tea in cash')
  assert(tea.includes('Nothing is saved yet'), `the entry is not saved by asking (${tea})`)
  await shoot('03-entry-offer')
  await page.locator('[data-testid="ask-open-entry"]').last().click()
  await h.waitScreen('simple-money-out')
  await attached(h, '[data-testid="money-gst-bill"]')
  assertEq(await page.inputValue('[data-testid="input-money-note"]'), 'tea', 'what it was for')
  assert((await page.inputValue('[data-testid="input-money-amount"]')).replace(/[^\d.]/g, '').startsWith('500'), 'the amount is filled in')
  assert((await page.innerText('[data-testid="simple-money-out"]')).includes('Office expenses'), 'tea → Office expenses')
  await noBanned('Money out, pre-filled')
  await shoot('04-money-out-prefilled')
  await h.click('money-gst-bill-no')
  await h.click('btn-money-save')
  await attached(h, '[data-testid="save-card"]')
  const drafts = await h.invoke('ai:drafts', {})
  const ask = drafts.filter((d) => d.origin === 'ask-total')
  assertEq(ask.length, 1, 'one Ask Total draft')
  assertEq(ask[0].status, 'consumed', 'the flow’s save consumed it')
  assertEq(ask[0].source, 'assistant', 'stored as an assistant draft')

  // ================= 4. open bank =================
  const bank = await askPanel('open bank')
  assert(bank.includes('Opening Bank'), `the panel says where it goes (${bank})`)
  await h.waitScreen('simple-bank')

  // ================= 5. not understood =================
  const joke = await askPanel('tell me a joke about vouchers')
  assert(joke.includes('can’t answer that yet'), `not understood (${joke})`)
  assertEq(await page.locator('[data-testid="ask-suggestions"] button').last().count(), 1, 'suggestions offered')
  assert(await page.locator('[data-testid="ask-help"]').last().isVisible(), 'a help search result')
})
