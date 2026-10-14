// Scenario 60 — the "no ledger knowledge" beginner journey (plan §0.4; WP 10.1 started it with
// Ask Total, WP 10.8 grew it into the whole journey). A trader with udhaar customers, a regular GST
// registration and stock, in Hinglish, goes through the simple screens only (the IPC is used only
// to READ figures back and compare them with the accountant's own reports):
//   1. setup (the wizard: Hinglish, trader, regular monthly, stock, books from the FY start,
//      already running) → the first-run tour, read to the end
//   2. openings: cash, one customer bill (+ a second customer with an old bill, for the reminder),
//      one supplier bill, two products with their GST rate (WP 10.8: asked for a regular business)
//   3. a sale on udhaar (GST from the product) → 4. a purchase with a GST bill, part paid in cash
//   5. money in by UPI covering the opening bill and the sale (a bank added where the screen asks)
//   6. money out: transport from cash (no GST bill) → 7. bank: a statement with that receipt —
//      "Already recorded", Save all, books and bank agree
//   8. a return of one unit, the credit kept → 9. a stock count (one short)
//   10. the GST answer for this month: three figures = GSTR-3B → 11. the reminder text
//   12. a backup from Settings → Backups → every figure against Outstandings, the trial balance
//      and GSTR-3B → 13. Ask Total (English): who owes me, an entry offer → Money out, "open bank",
//      "5000 Verma" asks which way, something it can't answer.
// No accounting words on any simple screen. Dates are the working date (today), so the run stays
// inside the financial year on any day. Journey metrics (clicks, screens, errors, corrections per
// step) are printed at the end — a clicks regression is a warning, never a failure.
// WP108_SHOTS=<dir> copies the review screenshots there.
import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { scenario, assert, assertEq } from '../lib/harness.mjs'
import { journey, localIso, bannedWordsIn } from './lib/beginner-journey.mjs'
import { JourneyMetrics } from './lib/journey-metrics.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const FIXTURE = path.resolve(here, '../../src/shared/bankFormats/fixtures/hdfc-style.csv')
const csvHead = (() => {
  const lines = fs.readFileSync(FIXTURE, 'utf8').split('\n')
  return lines.slice(0, lines.findIndex((l) => l.startsWith('Date,')) + 1)
})()

/** Clicks per step on the reference run (journey-metrics warns when a step needs more). */
const BASELINE = { setup: 18, openings: 20, sale: 8, purchase: 12, 'money-in': 8, 'money-out': 10, bank: 4, return: 7, 'stock-count': 4, gst: 2, reminder: 5, backup: 3, 'ask-total': 13 }

/** Paise as the text a user types ("6863.00"), integer arithmetic only. */
const typed = (p) => `${Math.trunc(p / 100)}.${String(p % 100).padStart(2, '0')}`
/** Paise as money.ts prints it with the symbol (Indian grouping) — for reading answers. */
const rupees = (p) => {
  const whole = String(Math.trunc(Math.abs(p) / 100))
  const last3 = whole.slice(-3)
  const rest = whole.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ',')
  return `${p < 0 ? '-' : ''}₹${rest ? `${rest},${last3}` : last3}.${String(Math.abs(p) % 100).padStart(2, '0')}`
}
const sum4 = (a) => a.igst + a.cgst + a.sgst + a.cess

await scenario('60-ask-total', async (h) => {
  const { page } = h
  const j = journey(h)
  const m = await new JourneyMetrics(page).attach()
  const review = process.env.WP108_SHOTS
  const shoot = async (name) => {
    const file = await h.shot(name)
    if (review) {
      fs.mkdirSync(review, { recursive: true })
      fs.copyFileSync(file, path.join(review, `${name}.png`))
    }
  }
  const noBanned = async (where) => {
    const found = bannedWordsIn(await j.mainText())
    assert(found.length === 0, `no accounting words on ${where} (${found.join(', ')})`)
  }
  const today = localIso()
  const month = today.slice(0, 7)

  // ================= 1. setup =================
  await m.step('setup')
  const cur = await j.setup({ company: 'Agarwal Traders', type: 'trader', gst: 'regular', gstin: '27AAPFU0939F1ZV', filing: 'monthly', stock: true, continuing: true, language: 'hinglish' })
  assertEq(cur.ui.mode, 'simple', 'the wizard makes a simple-mode company')
  assertEq(cur.ui.language, 'hinglish', 'in Hinglish')
  assertEq(cur.info.gstRegistrationType, 'regular', 'a regular registration')
  await noBanned('Home after the wizard')
  await shoot('01-home-first')

  // ================= 2. openings =================
  await m.step('openings')
  const opened = await j.openings({
    cash: '8000',
    customers: [
      { name: 'Verma General Store', bills: [{ ref: 'AT-101', amount: '4500' }] },
      { name: 'Sharma Kirana', bills: [{ ref: 'SK-9', amount: '1500' }] }
    ],
    suppliers: [{ name: 'Bansal Distributors', bills: [{ ref: 'BD-77', amount: '12000' }] }],
    items: [
      { name: 'Atta 10 kg', qty: '20', rate: '380', gstRate: 5 },
      { name: 'Basmati rice 5 kg', qty: '15', rate: '520', gstRate: 5 }
    ]
  })
  // have = 8,000 + 4,500 + 1,500 + 7,600 + 7,800 = 29,400; owe 12,000 → 17,400 the owner's money.
  assert(opened.sentence.includes('₹17,400.00'), `the difference in one sentence (${opened.sentence})`)
  const items = await h.invoke('master:stockItems:list')
  const atta = items.find((i) => i.name === 'Atta 10 kg')
  assertEq(atta.gstRate, 5, 'WP 10.8: the opening product carries the GST rate asked on the stock step')
  const begin = (await h.invoke('company:current')).info.booksBeginDate
  const tb0 = await h.invoke('report:trialBalance', { asOn: begin })
  assertEq(tb0.totalDebit, tb0.totalCredit, 'the openings agree (Dr = Cr)')
  await noBanned('Home after the openings')

  // ================= 3. a sale on udhaar =================
  await m.step('sale')
  const sale = await j.sale({ customer: 'Verma General Store', items: [{ name: 'Atta 10 kg', qty: '5', rate: '450' }], paid: 'credit' })
  assertEq(sale.tax, 112_50, 'GST 5% of ₹2,250 from the product’s rate')
  assert(sale.preview.includes('Verma General Store'), `the plain preview (${sale.preview})`)
  await shoot('02-sale-card')

  // ================= 4. a purchase with a GST bill, part paid =================
  await m.step('purchase')
  const buy = await j.purchase({ supplier: 'Bansal Distributors', billNo: 'BD-90', gstOnBill: true, items: [{ name: 'Basmati rice 5 kg', qty: '10', rate: '500' }], part: '2000', how: 'cash' })
  assertEq(buy.tax, 250_00, 'the bill’s GST: 5% of ₹5,000')
  assertEq(buy.total, 5_250_00, 'the bill total')

  // ================= 5. money in: the opening bill and the sale =================
  await m.step('money-in')
  const inAmount = 4_500_00 + sale.total
  const got = await j.moneyIn({ customer: 'Verma General Store', amount: typed(inAmount), how: 'upi', bankName: 'HDFC Bank' })
  assert(got.preview.includes('AT-101'), `the opening bill is paid first (${got.preview})`)
  await shoot('03-money-in-card')

  // ================= 6. money out: an expense from cash =================
  await m.step('money-out')
  const out = await j.moneyOut({ category: 'transport', amount: '600', how: 'cash', gstBill: false })
  assert(out.preview.includes('₹600.00'), `the plain preview (${out.preview})`)

  // ================= 7. bank: the statement with the receipt =================
  await m.step('bank')
  const bank = await j.bank({ bankName: 'HDFC Bank', file: 'hdfc-oct.csv', lines: [{ date: today, text: 'UPI-VERMA GENERAL STORE-verma@okhdfc-HDFC0001234-321456789012-PAY', match: 'VERMA', in: `"${typed(inAmount)}"` }] }, csvHead)
  assertEq(JSON.stringify(bank.suggested), JSON.stringify(['existing']), 'the receipt is "Already recorded"')
  await noBanned('Bank')
  await shoot('04-bank-agree')

  // ================= 8. a return, the credit kept =================
  await m.step('return')
  const ret = await j.returnSale({ customer: 'Verma General Store', qty: '1', settle: 'credit' })
  assert(ret.total > 0, 'the return has a total')
  await shoot('05-return-card')

  // ================= 9. stock count =================
  await m.step('stock-count')
  // Atta: 20 opening − 5 sold + 1 returned = 16 on hand; one bag is missing.
  const count = await j.stockCount({ item: 'Atta 10 kg', counted: '15' })
  assert(count.diff.includes('1'), `the difference in words (${count.diff})`)

  // ================= 10. the GST answer for this month =================
  await m.step('gst')
  await j.open('taxes', 'gst-summary')
  await j.attached('[data-testid="taxes-figures"]')
  await h.waitIdle()
  if ((await page.inputValue('[data-testid="taxes-period"]')) !== month) {
    // The return due next is an earlier month: the running month so far is said beside it, and
    // one click shows it (WP 10.8).
    await j.attached('[data-testid="taxes-running"]')
    await h.click('btn-taxes-running')
  }
  await page.waitForFunction((mo) => document.querySelector('[data-testid="taxes-period"]')?.value === mo, month)
  const x = await h.invoke('simple:taxes', { period: month })
  const g3b = await h.invoke('gst:gstr3b', { from: x.period.from, to: x.period.to, period: `${month.slice(5, 7)}${month.slice(0, 4)}` })
  // Collected: 5% of the ₹2,250 sale − 5% of the ₹450 return = ₹90; on purchases 5% of ₹5,000 = ₹250.
  await page.waitForFunction((p) => document.querySelector('[data-testid="tile-gst-collected"]')?.getAttribute('data-paise') === String(p), 90_00, { timeout: 15000 })
  assertEq(Number(await page.getAttribute('[data-testid="tile-gst-collected"]', 'data-paise')), sum4(g3b.outward) + g3b.zeroRated.igst + g3b.zeroRated.cess, 'GST collected = GSTR-3B 3.1')
  assertEq(Number(await page.getAttribute('[data-testid="tile-gst-purchases"]', 'data-paise')), 250_00, 'GST on purchases = 5% of ₹5,000')
  assertEq(Number(await page.getAttribute('[data-testid="tile-gst-purchases"]', 'data-paise')), sum4(g3b.itc), 'GST on purchases = GSTR-3B 4')
  assertEq(Number(await page.getAttribute('[data-testid="tile-gst-to-pay"]', 'data-paise')), sum4(g3b.netPayable) + sum4(g3b.rcmPayable), 'to pay = GSTR-3B after the credit')
  await noBanned('Taxes')
  await shoot('06-gst-answer')

  // ================= 11. the reminder =================
  await m.step('reminder')
  const lateNow = today > begin
  const remind = await j.reminder({ customer: 'Sharma Kirana' })
  if (lateNow) {
    assert(remind.offered, 'a late opening bill can be reminded')
    assert(remind.message.includes('SK-9') && remind.message.includes('₹1,500.00'), `the message lists the late bill (${remind.message})`)
    assertEq(bannedWordsIn(remind.message).length, 0, 'no accounting words in the message')
  } else {
    // On the books-begin day itself nothing is late yet: the page says why there is no reminder.
    await j.attached('[data-testid="person-nothing-late"]')
  }
  await shoot('07-reminder')

  // ================= 12. a backup + the figures against the accountant screens =================
  await m.step('backup')
  const before = (await h.invoke('backup:list')).length
  await j.open('settings', 'backups')
  await h.waitScreen('simple-backups')
  await h.click('btn-simple-backup-now')
  await j.attached('[data-testid="simple-backups-saved"]', 30000)
  assert((await h.invoke('backup:list')).length > before, 'a new backup file')
  await noBanned('Backups')
  await shoot('08-backup')

  const rec = await h.invoke('analysis:outstandings', { side: 'receivable', asOn: today })
  const owed = (name) => rec.filter((p) => p.name === name).reduce((s, p) => s + p.pending, 0)
  assertEq(owed('Verma General Store'), 0, 'Outstandings: Verma has paid everything')
  assertEq(owed('Sharma Kirana'), 1_500_00, 'Outstandings: Sharma still owes the opening bill')
  const home = await h.invoke('simple:home', {})
  assertEq(home.receivables.advances, ret.total, 'the return’s credit is held for Verma (Home = the allocation)')
  const pay = await h.invoke('analysis:outstandings', { side: 'payable', asOn: today })
  // 12,000 opening + 5,250 bill − 2,000 paid.
  assertEq(pay.filter((p) => p.name === 'Bansal Distributors').reduce((s, p) => s + p.pending, 0), 15_250_00, 'Outstandings: what we owe Bansal')
  const tb = await h.invoke('report:trialBalance', { asOn: today })
  assertEq(tb.totalDebit, tb.totalCredit, 'the trial balance agrees')
  const cash = tb.rows.find((r) => r.ledgerName === 'Cash')
  // 8,000 opening − 2,000 to Bansal − 600 transport.
  assertEq(cash.debit - cash.credit, 5_400_00, 'cash in hand')
  const brs = await h.invoke('banking:brs', { ledgerId: (await h.invoke('bank:ledgers')).find((b) => b.name === 'HDFC Bank').id, asOn: today })
  assertEq(brs.uncredited.length + brs.unpresented.length, 0, 'the accountant BRS has nothing outstanding')

  // ================= 13. Ask Total (in English) =================
  await m.step('ask-total')
  await h.click('simple-nav-settings')
  await h.click('simple-entry-looks')
  await h.click('btn-language-en')
  await h.click('simple-nav-home')
  await j.attached('[data-testid="simple-home-ask"]')
  const answers = () => page.locator('[data-testid="ask-answer"]')
  const askPanel = async (q) => {
    if (!(await page.$('[data-testid="ask-panel"]'))) {
      await h.click('btn-assistant')
      await j.attached('[data-testid="ask-panel"]')
    }
    const n = await answers().count()
    await page.fill('[data-testid="ask-input"]', q)
    await h.click('ask-send')
    await page.waitForFunction((k) => document.querySelectorAll('[data-testid="ask-answer"]').length > k, n, { timeout: 15000 })
    return ((await answers().nth(n).innerText()) ?? '').replace(/\s+/g, ' ').trim()
  }
  await page.fill('[data-testid="simple-home-ask-input"]', 'who owes me')
  await h.click('simple-home-ask-send')
  await j.attached('[data-testid="ask-answer"]')
  const owes = ((await answers().first().innerText()) ?? '').replace(/\s+/g, ' ')
  assert(owes.includes(rupees(home.receivables.total)), `who owes me = Home's figure ${rupees(home.receivables.total)} (${owes})`)
  assert(owes.includes('Total answered this itself'), 'Total answered it itself')
  assertEq(await page.locator('[data-testid="ai-panel"]').count(), 0, 'AI off: no AI panel')

  const which = await askPanel('5000 Verma')
  assert(which.includes('did Verma pay you, or did you pay Verma'), `an amount and a name: which way? (${which})`)
  assertEq(await page.locator('[data-testid="ask-suggestions"]').last().locator('button').count(), 2, 'two answers to press')
  await shoot('09-ask-which-way')

  const tea = await askPanel('paid 500 for tea in cash')
  assert(tea.includes('Nothing is saved yet'), `asking saves nothing (${tea})`)
  await page.locator('[data-testid="ask-open-entry"]').last().click()
  await h.waitScreen('simple-money-out')
  await j.attached('[data-testid="money-gst-bill"]')
  assertEq(await page.inputValue('[data-testid="input-money-note"]'), 'tea', 'what it was for')
  await h.click('money-gst-bill-no')
  await h.click('btn-money-save')
  await j.attached('[data-testid="save-card"]')
  const ask = (await h.invoke('ai:drafts', {})).filter((d) => d.origin === 'ask-total')
  assertEq(ask.length, 1, 'one Ask Total draft')
  assertEq(ask[0].status, 'consumed', 'the flow’s save consumed it')

  const openBank = await askPanel('open bank')
  assert(openBank.includes('Opening Bank'), `the panel says where it goes (${openBank})`)
  await h.waitScreen('simple-bank')
  const joke = await askPanel('tell me a joke about vouchers')
  assert(joke.includes('can’t answer that yet'), `not understood (${joke})`)
  assert(await page.locator('[data-testid="ask-help"]').last().isVisible(), 'a help search result')

  // ================= the journey's figures =================
  const r = await m.report(BASELINE)
  assert(r.steps.length >= 13, 'every step was measured')
})
