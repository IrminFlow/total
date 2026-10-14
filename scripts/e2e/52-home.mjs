// Scenario 52 — WP 8.6 simple Home. Demo Traders in simple mode: Home loads from one
// `simple:home` call; its figures equal the accountant Dashboard tiles (receivables, payables,
// cash and bank, FY profit) and the Outstandings screen's totals as on today; "Why?" opens the
// computed sentence and each link opens THAT figure (Outstandings on its side, the Day book on
// today, the cash / bank balances as on today, GSTR-3B on the tile's month); + Sale opens Make a bill, another task the editor in the
// full app; "Needs attention" shows when the close checklist / anomalies find something (the demo
// has bills past their due date). Home is captured light and dark, and for an empty company.
// WP86_SHOTS=<dir> also copies the screenshots there for the visual review.
import * as fs from 'node:fs'
import * as path from 'node:path'
import { scenario, assert, assertEq } from '../lib/harness.mjs'

const attached = (h, sel, timeout = 15000) => h.page.waitForSelector(sel, { state: 'attached', timeout })

/** money.ts formatPaise (Indian grouping, 2 decimals) — what the accountant screens print. */
function formatPaise(paise) {
  const neg = paise < 0
  const abs = Math.abs(paise)
  const whole = String(Math.floor(abs / 100))
  const frac = String(abs % 100).padStart(2, '0')
  const grouped = whole.length <= 3 ? whole : `${whole.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ',')},${whole.slice(-3)}`
  return `${neg ? '-' : ''}${grouped}.${frac}`
}

const paiseOf = async (h, testId) => Number(await h.page.getAttribute(`[data-testid="${testId}"]`, 'data-paise'))
const textOf = async (h, sel) => ((await h.page.textContent(sel)) ?? '').replace(/\s+/g, ' ').trim()

/** "Back to simple" returns to the screen's simple section; Home is one click from there. */
async function backHome(h) {
  await h.click('btn-back-to-simple')
  await attached(h, '[data-testid="simple-nav"]')
  await h.click('simple-nav-home')
  await attached(h, '[data-testid="simple-home"]')
  await attached(h, '[data-testid="simple-tile-receivables"]')
}

/** Open a tile's "Why?" and follow its link. */
async function openLink(h, id) {
  await h.click(`simple-why-${id}`)
  await h.click(`simple-why-${id}-link`)
}

async function shoot(h, name) {
  const file = await h.shot(name)
  const dir = process.env.WP86_SHOTS
  if (dir) {
    fs.mkdirSync(dir, { recursive: true })
    fs.copyFileSync(file, path.join(dir, `${name}.png`))
  }
}

await scenario('52-home', async (h) => {
  const { page } = h
  await h.createDemoCompany(60000, { mode: 'simple' })
  await attached(h, '[data-testid="simple-home"]')
  await attached(h, '[data-testid="simple-tile-receivables"]')
  await h.waitIdle()

  // ---------- one round trip, fast ----------
  const today = await page.evaluate(() => {
    const d = new Date()
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  })
  const timings = []
  for (let i = 0; i < 3; i++) {
    const t0 = Date.now()
    await h.invoke('simple:home', { today })
    timings.push(Date.now() - t0)
  }
  console.log(`simple:home round trip (warm): ${timings.join(' / ')} ms`)
  assert(Math.min(...timings) < 300, `simple:home answers in < 300 ms warm (got ${timings.join(' / ')})`)
  const home = await h.invoke('simple:home', { today })

  // ---------- the tiles show the service's figures ----------
  assertEq(await paiseOf(h, 'simple-tile-receivables'), home.receivables.total, 'Customers owe you = simple:home')
  assertEq(await paiseOf(h, 'simple-tile-payables'), home.payables.total, 'You owe suppliers = simple:home')
  assertEq(await paiseOf(h, 'simple-tile-cash'), home.cash.total, 'Cash and bank = simple:home')
  assertEq(await paiseOf(h, 'simple-tile-profit'), home.profit.year.netProfit, 'FY profit = simple:home')
  assert(home.receivables.total > 0, 'the demo has customers who owe money')
  assert((await textOf(h, '[data-testid="simple-tile-receivables-value"]')).includes(formatPaise(home.receivables.total)), 'the receivables tile prints the amount')
  assert(home.gst?.kind === 'regular', 'the demo is a regular registration, so the GST tile shows')
  await attached(h, '[data-testid="simple-tile-gst"]')
  await shoot(h, '01-home-demo-light')

  // ---------- "Why?" ----------
  await h.click('simple-why-receivables')
  const sentence = await textOf(h, '[data-testid="simple-why-receivables-sentence"]')
  assert(sentence.includes(`₹${formatPaise(home.receivables.total)}`), `the sentence quotes the figure: ${sentence}`)
  assert(sentence.includes(home.receivables.oldest.name), 'the sentence names the oldest bill’s customer')
  await shoot(h, '02-home-why')
  // Each link opens THAT figure in the accountant view.
  await h.click('simple-why-receivables-link')
  await h.waitScreen('outstandings')
  await attached(h, '[data-testid="btn-back-to-simple"]')
  await attached(h, '[data-testid="outstandings-table-totals"]')
  assert((await textOf(h, '[data-testid="outstandings-table-totals"]')).includes(formatPaise(home.receivables.total)), 'Outstandings (receivables) total = Customers owe you')
  await backHome(h)

  await openLink(h, 'payables')
  await h.waitScreen('outstandings')
  await attached(h, '[data-testid="outstandings-table-totals"]')
  assert((await textOf(h, '[data-testid="outstandings-table-totals"]')).includes(formatPaise(home.payables.total)), 'Outstandings opens on the payables side: total = You owe suppliers')
  await backHome(h)

  await openLink(h, 'money-in')
  await h.waitScreen('daybook')
  await attached(h, '[data-testid="daybook-date-chip"]')
  const [y, m, d] = today.split('-')
  const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][Number(m) - 1]
  assertEq(await textOf(h, '[data-testid="daybook-date-chip"]'), `${d}-${MON}-${y.slice(2)}`, 'the Day book opens on today')
  await backHome(h)

  await openLink(h, 'cash')
  await h.waitScreen('trial-balance')
  await attached(h, '[data-testid="trial-balance-table-totals"]')
  const tbRows = await page.$$eval('[data-testid="rows-trial-balance"] tr.dt-row', (rows) => rows.length)
  assertEq(tbRows, home.cash.accounts.filter((a) => a.balance !== 0).length, 'the trial balance lists just the cash and bank accounts')
  if (home.cash.accounts.every((a) => a.balance >= 0)) {
    assert((await textOf(h, '[data-testid="trial-balance-table-totals"]')).includes(formatPaise(home.cash.total)), 'its total = Cash and bank')
  }
  await backHome(h)

  await openLink(h, 'gst')
  await h.waitScreen('gstr3b')
  await page.waitForFunction((v) => document.querySelector('[data-testid="input-gstr3b-month"]')?.value === v, home.gst.row.period)
  await backHome(h)

  // ---------- the accountant Dashboard shows the same figures ----------
  await attached(h, '[data-testid="btn-accountant-view"]')
  await h.click('btn-accountant-view')
  await attached(h, '[data-testid="gateway-dashboard"]')
  await attached(h, '[data-testid="tile-receivables"] .num')
  const tileText = async (id) => textOf(h, `[data-testid="${id}"]`)
  await page.waitForFunction(() => ['tile-receivables', 'tile-payables', 'tile-cash', 'tile-profit'].every((id) => /\d/.test(document.querySelector(`[data-testid="${id}"]`)?.textContent ?? '')))
  assert((await tileText('tile-receivables')).includes(formatPaise(home.receivables.total)), 'Dashboard receivables = Home')
  assert((await tileText('tile-payables')).includes(formatPaise(home.payables.total)), 'Dashboard payables = Home')
  assert((await tileText('tile-cash')).includes(formatPaise(home.cash.total)), 'Dashboard cash & bank = Home')
  assert((await tileText('tile-profit')).includes(formatPaise(home.profit.year.netProfit)), 'Dashboard net profit = Home FY profit')
  await backHome(h)

  // ---------- needs attention ----------
  // The overdue rows come from the tiles' own figures (by side, as on today); the rest from
  // simple:homeAttention, which fills in after Home shows.
  const attention = await h.invoke('simple:homeAttention', { today })
  const owedRows = [home.receivables.overdueBills > 0 ? 'receivable' : null, home.payables.overdueBills > 0 ? 'payable' : null].filter(Boolean)
  const total = owedRows.length + attention.items.length
  if (total > 0) {
    await attached(h, '[data-testid="simple-home-attention"][data-loading="false"]')
    assert((await textOf(h, '[data-testid="simple-home-attention-count"]')).startsWith(String(total)), 'the card counts every item')
    assert(!attention.items.some((i) => i.key === 'overdue_bills'), 'overdue bills never come from the month-end checklist')
    const high = attention.items.filter((i) => i.level === 'high').length
    if (home.receivables.overdueBills > 0 && high < 3) {
      const row = await textOf(h, '[data-testid="simple-attention-owed-receivable"]')
      assert(row.includes(`${home.receivables.overdueBills} customer bill`) && row.includes(formatPaise(home.receivables.overdue)), `the overdue row matches the tile: ${row}`)
      await h.click('simple-attention-owed-receivable')
      await h.waitScreen('outstandings')
      await backHome(h)
      await attached(h, '[data-testid="simple-home-attention"][data-loading="false"]')
    }
    const first = await page.getAttribute('[data-testid^="simple-attention-"]', 'data-testid')
    await h.click(first)
    await page.waitForSelector('[data-screen="assistants"][data-loading="false"], [data-screen="outstandings"][data-loading="false"]', { state: 'attached', timeout: 15000 })
    await backHome(h)
  } else {
    assertEq(await page.$('[data-testid="simple-home-attention"]'), null, 'no "Needs attention" card when nothing needs it')
  }

  // ---------- a task button opens its flow (WP 9.2: + Sale = the simple Make a bill) ----------
  await h.click('simple-task-sale')
  await h.waitScreen('simple-sell')
  await attached(h, '[data-testid="simple-nav"]')
  await h.click('simple-nav-home')
  await attached(h, '[data-testid="simple-home"]')
  await h.click('simple-task-purchase')
  await h.waitScreen('voucher-entry')
  await attached(h, '[data-testid="btn-back-to-simple"]')
  await backHome(h)
  await attached(h, '[data-testid="simple-tile-receivables"]')

  // ---------- dark ----------
  await h.click('btn-theme')
  await page.waitForFunction(() => document.documentElement.dataset.theme === 'dark')
  await h.waitIdle()
  await page.waitForTimeout(400) // let the theme transition settle before the capture
  await shoot(h, '03-home-demo-dark')
  await h.click('simple-why-profit')
  await attached(h, '[data-testid="simple-why-profit-sentence"]')
  await shoot(h, '04-home-why-profit-dark')
  await page.keyboard.press('Escape')
  await h.click('btn-theme')
  await page.waitForFunction(() => document.documentElement.dataset.theme !== 'dark')

  // ---------- an empty company ----------
  await h.click('btn-switch-company')
  await h.createCompanyUI('Empty Home Co', { mode: 'simple' })
  await attached(h, '[data-testid="simple-home-empty"]')
  await h.waitIdle()
  const empty = await h.invoke('simple:home', { today })
  assertEq(empty.receivables.total, 0, 'an empty company owes nothing')
  assertEq(empty.gst, null, 'an unregistered company has no GST tile')
  assertEq(await page.$('[data-testid="simple-tile-receivables"]'), null, 'no row of ₹0 tiles — one "Nothing recorded yet" card')
  assertEq(await page.$('[data-testid="simple-tile-gst"]'), null, 'no GST tile for an unregistered company')
  assertEq(await page.$('[data-testid="simple-home-attention"]'), null, 'nothing needs attention in an empty company')
  assertEq(await page.$('[data-testid="simple-setup-gstin"]'), null, 'the GST number step is not shown as done for an unregistered company')
  assert((await textOf(h, '[data-testid="simple-home-empty-next"]')).length > 0, 'the next setup step is the way in')
  await shoot(h, '05-home-empty')
})
