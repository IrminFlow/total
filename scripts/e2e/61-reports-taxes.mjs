// Scenario 61 — WP 9.9 Plain reports and Taxes (simple mode). (The plan's e2e 60 is reserved for
// the growing "no-ledger-knowledge" beginner journey, so this one is 61.)
//   1. The setup wizard: a regular, monthly-filing trader (Maharashtra GSTIN) that keeps stock.
//   2. A GST purchase and a GST sale of a product last month (the Buy / Sell intents through
//      simple:post; item bills — an amount-only bill's GST is not in GSTR-1 / 3B yet, the queued
//      GSTR-1 amount-only rate fix).
//   3. Reports → How is my business doing: this year — sales / expenses / profit equal the P&L;
//      the "Why?" sentence; the Accountant view is the T-form P&L. By month: 12 bars, last month's
//      = the sales register.
//   4. Taxes → GST to pay: last month's three figures = gstr3b(); "not checked yet" (no GSTR-2B);
//      the dates; the steps; "I've filed" with an ARN (a bad one first → the error under ARN) →
//      the mark shows; prepare the GSTR-1 file (the existing export).
//   5. An unregistered kirana: Taxes says there is nothing to file.
// No accounting words on any simple screen. Screenshots light + dark; WP99_SHOTS=<dir> copies
// the review set there.
import * as fs from 'node:fs'
import * as path from 'node:path'
import { scenario, assert, assertEq } from '../lib/harness.mjs'

const BANNED = [
  /\bvouchers?\b/i, /\bledgers?\b/i, /\bjournals?\b/i, /\bcontras?\b/i, /\b(?:Dr|Cr)\b/, /\bparticulars?\b/i, /\bnarrations?\b/i, /\bsundry\b/i,
  /\bgroups?\b/i, /\bITC\b/i, /\bset[- ]?offs?\b/i, /\bag(?:e)?ing\b/i, /\bBRS\b/i, /\bgodowns?\b/i, /\bBOMs?\b/i, /\bSOA\b/i
]
const bannedWordsIn = (text) => BANNED.filter((re) => re.test(text)).map((re) => re.source)
const attached = (h, sel, timeout = 15000) => h.page.waitForSelector(sel, { state: 'attached', timeout })
const REVIEW = new Set(['01-doing', '02-by-month', '03-taxes', '04-steps', '05-cash', '06-unregistered'])
const sum4 = (a) => a.igst + a.cgst + a.sgst + a.cess

await scenario('61-reports-taxes', async (h) => {
  const { page } = h

  const shoot = async (name, selector) => {
    for (const want of ['light', 'dark']) {
      if ((await page.evaluate(() => document.documentElement.dataset.theme)) !== want) {
        await h.click('btn-theme')
        await page.waitForFunction((w) => document.documentElement.dataset.theme === w, want)
      }
      if (selector) await page.locator(selector).first().scrollIntoViewIfNeeded()
      await page.waitForTimeout(400)
      const file = await h.shot(`${name}-${want}`)
      const dir = process.env.WP99_SHOTS
      if (dir && REVIEW.has(name)) {
        fs.mkdirSync(dir, { recursive: true })
        fs.copyFileSync(file, path.join(dir, `${name}-${want}.png`))
      }
    }
    await h.click('btn-theme')
    await page.waitForFunction(() => document.documentElement.dataset.theme === 'light')
  }
  // WP 10.2: a "Why?" popover in both themes (opened after each theme switch — the switch closes it).
  const shootWhy = async (name, id) => {
    for (const want of ['light', 'dark']) {
      if ((await page.evaluate(() => document.documentElement.dataset.theme)) !== want) {
        await h.click('btn-theme')
        await page.waitForFunction((w) => document.documentElement.dataset.theme === w, want)
      }
      if (!(await page.$(`[data-testid="${id}-sentence"]`))) await h.click(id)
      await attached(h, `[data-testid="${id}-sentence"]`)
      await page.waitForTimeout(400)
      const file = await h.shot(`${name}-${want}`)
      const dir = process.env.WP102_SHOTS
      if (dir) {
        fs.mkdirSync(dir, { recursive: true })
        fs.copyFileSync(file, path.join(dir, `${name}-${want}.png`))
      }
    }
    await h.click('btn-theme')
    await page.waitForFunction(() => document.documentElement.dataset.theme === 'light')
  }
  const text = async (sel) => ((await page.textContent(sel)) ?? '').replace(/\s+/g, ' ').trim()
  const paise = async (testId) => Number(await page.getAttribute(`[data-testid="${testId}"]`, 'data-paise'))
  const noBanned = async (where) => {
    const visible = await page.evaluate(() => document.querySelector('main')?.innerText ?? '')
    const found = bannedWordsIn(visible)
    assert(found.length === 0, `no accounting words on ${where} (${found.join(', ')})`)
  }
  const openEntry = async (section, entry) => {
    await h.click(`simple-nav-${section}`)
    await attached(h, `[data-testid="simple-entry-${entry}"]`)
    await h.click(`simple-entry-${entry}`)
  }

  // ================= 1. the wizard: a regular, monthly-filing trader =================
  await h.waitScreen('company-select')
  await attached(h, '[data-testid="setup-wizard"]')
  await h.fill('setup-name', 'Sharma Traders')
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

  // ================= 2. a GST sale and a GST purchase, last month =================
  const first = await h.invoke('simple:taxes', {})
  assertEq(first.kind, 'regular', 'a regular registration gets the GST answer')
  const today = first.today
  const ym = today.slice(0, 7)
  const [y, m] = ym.split('-').map(Number)
  const prev = m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`
  const fyFrom = `${m >= 4 ? y : y - 1}-04-01`
  // In April last month is in the previous FY, before the books begin: use this month then.
  const month = `${prev}-10` >= fyFrom ? prev : ym
  const day = month === ym ? today : `${month}-10`
  const groups = await h.invoke('master:groups:list')
  const supplier = await h.invoke('master:ledgers:create', {
    name: 'Shiv Wholesale', groupId: groups.find((g) => g.name === 'Sundry Creditors').id, openingBalance: 0, gstin: '27AABCG3456H1ZN', stateCode: '27', address: null,
    taxType: null, gstRate: null, hsn: null, tdsSectionId: null, pan: null, creditDays: 30, exportType: null
  })
  const units = await h.invoke('master:units:list')
  const nos = units.find((u) => u.symbol === 'Nos') ?? units[0]
  const fan = (
    await h.invoke('master:stockItems:quickCreate', {
      item: { name: 'Table fan', groupId: null, unitId: nos.id, hsn: '8414', gstRate: 18, cessRate: null, openingQtyMilli: 0, openingValue: 0, barcode: null, reorderLevelMilli: null },
      sellingPricePaise: 1_000_00,
      purchasePricePaise: null
    })
  ).item
  // Purchase 10 fans at ₹600 + 18% GST on credit; sell all 10 at ₹1,000 + 18%, paid in cash.
  await h.invoke('simple:post', { intent: { clientId: 'e2e61-buy-0001', kind: 'purchase', date: day, supplierId: supplier.id, billNo: 'SW/101', items: [{ itemId: fan.id, qty: '10', rate: 600_00 }], payment: { how: 'credit' } } })
  await h.invoke('simple:post', { intent: { clientId: 'e2e61-sale-0001', kind: 'sale', date: day, items: [{ itemId: fan.id, qty: '10', rate: 1_000_00 }], payment: { how: 'cash' } } })
  await page.reload()
  await page.waitForSelector('[data-screen="company-select"], [data-testid="simple-home"]', { state: 'attached', timeout: 20000 })
  if (await page.$('[data-screen="company-select"]')) await h.openCompany('Sharma Traders')
  await attached(h, '[data-testid="simple-home"]', 20000)
  await h.stubDialogs()

  // ================= 3. Reports =================
  await openEntry('reports', 'how-am-i-doing')
  await attached(h, '[data-testid="doing-line-sales"]')
  await h.click('doing-period-this-year')
  await page.waitForFunction(() => document.querySelector('[data-testid="doing-subtitle"]')?.textContent?.includes('1 Apr'))
  const fyPl = await h.invoke('report:profitLoss', { from: fyFrom, to: today })
  await page.waitForFunction((p) => document.querySelector('[data-testid="doing-line-profit"]')?.getAttribute('data-paise') === String(p), fyPl.netProfit)
  assertEq(await paise('doing-line-sales'), 10_000_00, 'sales before GST')
  assertEq(await paise('doing-line-profit'), fyPl.netProfit, 'profit = the P&L net profit')
  assertEq(fyPl.netProfit, 4_000_00, 'profit ₹10,000 sold − ₹6,000 the fans cost (none left)')
  await h.click('why-doing-profit')
  assert((await text('[data-testid="why-doing-profit-sentence"]')).includes('You made a profit of ₹4,000.00'), 'the profit sentence')
  // WP 10.2: the comparison under it, and the link opens the P&L for exactly this period.
  assert((await text('[data-testid="why-doing-profit-extra"]')).includes('than the period before'), 'the comparison with the period before')
  await noBanned('How is my business doing — Why?')
  await shootWhy('why-doing-profit', 'why-doing-profit')
  if (!(await page.$('[data-testid="why-doing-profit-link"]'))) await h.click('why-doing-profit')
  await h.click('why-doing-profit-link')
  const disp = (iso) => {
    const [y, m, d] = iso.split('-').map(Number)
    return `${String(d).padStart(2, '0')}-${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][m - 1]}-${String(y % 100).padStart(2, '0')}`
  }
  await page.waitForFunction(([f, to]) => document.querySelector('[data-testid="input-pnl-from"]')?.value === f && document.querySelector('[data-testid="input-pnl-to"]')?.value === to, [disp(fyFrom), disp(today)], { timeout: 15000 })
  await h.click('btn-back-to-simple')
  await attached(h, '[data-testid="simple-nav"]')
  await openEntry('reports', 'how-am-i-doing')
  await attached(h, '[data-testid="doing-line-sales"]')
  await noBanned('How is my business doing')
  await shoot('01-doing')

  await openEntry('reports', 'by-month')
  await attached(h, '[data-testid="by-month-bars"]')
  assertEq(await page.locator('[data-testid="by-month-bars"] > li').count(), 12, '12 bars')
  assertEq(Number(await page.getAttribute(`[data-testid="by-month-bar-${month}"]`, 'data-sales')), 10_000_00, 'the month’s sales bar = the bill before GST')
  await noBanned('Sales and purchases by month')
  await shoot('02-by-month')

  await openEntry('reports', 'cash-next-30')
  await attached(h, '[data-testid="tile-cash-now"]')
  await noBanned('Cash in the next 30 days')
  await shoot('05-cash')

  // ================= 4. Taxes =================
  await openEntry('taxes', 'gst-summary')
  await attached(h, '[data-testid="taxes-figures"]')
  if ((await page.inputValue('[data-testid="taxes-period"]')) !== month) {
    await page.selectOption('[data-testid="taxes-period"]', month)
  }
  await page.waitForFunction((mo) => document.querySelector('[data-testid="taxes-period"]')?.value === mo, month)
  const x = await h.invoke('simple:taxes', { period: month })
  const v = await h.invoke('gst:gstr3b', { from: x.period.from, to: x.period.to, period: `${month.slice(5, 7)}${month.slice(0, 4)}` })
  await page.waitForFunction((p) => document.querySelector('[data-testid="tile-gst-collected"]')?.getAttribute('data-paise') === String(p), sum4(v.outward) + v.zeroRated.igst + v.zeroRated.cess)
  assertEq(await paise('tile-gst-collected'), 1_800_00, 'GST collected = 18% of ₹10,000')
  assertEq(await paise('tile-gst-purchases'), sum4(v.itc), 'GST on purchases = 3B’s credit')
  assertEq(await paise('tile-gst-purchases'), 1_080_00, 'GST on purchases = 18% of ₹6,000')
  assertEq(await paise('tile-gst-to-pay'), sum4(v.netPayable) + sum4(v.rcmPayable), 'to pay in cash = 3B after the credit')
  assertEq(await paise('tile-gst-to-pay'), 720_00, '₹1,800 − ₹1,080')
  assert((await text('[data-testid="tile-gst-purchases-sub"]')).includes('not checked against GSTR-2B yet'), 'no GSTR-2B imported: not checked yet')
  assert((await text('[data-testid="taxes-due-gstr3b"]')).includes('GSTR-3B'), 'the 3B date')
  await noBanned('Taxes')
  await shoot('03-taxes')

  if (!x.period.soFar) {
    // "I've filed": a bad ARN → its error under the field; then a good one → the mark.
    await h.fill('taxes-arn-gstr3b', '12')
    await h.click('taxes-filed-save-gstr3b')
    await attached(h, '[data-testid="taxes-filed-form-gstr3b"] [data-testid="field-error-arn"]')
    await h.fill('taxes-arn-gstr3b', 'AA2710261234567')
    await h.click('taxes-filed-save-gstr3b')
    await attached(h, '[data-testid="taxes-filed-gstr3b"]')
    assert((await text('[data-testid="taxes-filed-gstr3b"]')).includes('ARN AA2710261234567'), 'the filed mark shows its ARN')
    const marked = await h.invoke('simple:taxes', { period: month })
    assertEq(marked.filed.gstr3b.arn, 'AA2710261234567', 'the mark round-trips')
    // Prepare the GSTR-1 file: the existing export (the folder reveal is stubbed).
    await h.click('taxes-prepare-gstr1')
    await page.waitForFunction(() => !document.querySelector('[data-testid="taxes-prepared-gstr1"]')?.textContent?.includes('Not prepared'), null, { timeout: 15000 })
  }
  await noBanned('Taxes steps')
  await shoot('04-steps', '[data-testid="taxes-steps"]')

  // WP 10.2: the cash to pay in its parts (collected − what the purchases' GST covers), and a due
  // date's "Why?" whose link opens that return in the full app.
  await page.locator('[data-testid="tile-gst-to-pay"]').scrollIntoViewIfNeeded()
  await h.click('why-gst-to-pay')
  const toPayWhy = await text('[data-testid="why-gst-to-pay-sentence"]')
  if (x.figures.toPay > 0) assert(toPayWhy.includes('Of the ₹1,800.00 you collected, ₹1,080.00 is covered by the GST on your purchases, so ₹720.00 is left'), `the cash to pay in parts: ${toPayWhy}`)
  assertEq(bannedWordsIn(toPayWhy).length, 0, 'no accounting words in the Why')
  await page.keyboard.press('Escape')
  await shootWhy('why-gst-to-pay', 'why-gst-to-pay') // (the last theme switch closes it — no Esc: that would go back)
  await page.locator('[data-testid="taxes-dates"]').scrollIntoViewIfNeeded()
  await h.click('why-due-gstr3b')
  assert((await text('[data-testid="why-due-gstr3b-sentence"]')).includes('the 20th of the next month'), 'the 3B date explained')
  await h.click('why-due-gstr3b-link')
  await attached(h, '[data-testid="btn-back-to-simple"]')
  await page.waitForFunction(() => document.querySelector('main')?.textContent?.includes('GSTR-3B'))
  await h.click('btn-back-to-simple')
  await attached(h, '[data-testid="simple-nav"]')

  // ================= 5. an unregistered kirana =================
  await h.click('btn-switch-company')
  await h.createCompanyUI('Gupta Kirana', { mode: 'simple' })
  await attached(h, '[data-testid="simple-home"]', 20000)
  await h.click('simple-nav-taxes')
  await attached(h, '[data-testid="simple-taxes-unregistered"]')
  assertEq(await text('[data-testid="simple-taxes-unregistered"]'), 'You are not registered for GST, so there is nothing to file.', 'nothing to file')
  assertEq((await h.invoke('simple:taxes', {})).kind, 'unregistered', 'simple:taxes says unregistered')
  await noBanned('Taxes (unregistered)')
  await shoot('06-unregistered')
})
