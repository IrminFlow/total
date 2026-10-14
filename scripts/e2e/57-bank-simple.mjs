// Scenario 57 — WP 9.6 Bank, simple, with AI OFF (no key anywhere).
//   1. A wizard company (trader, no GST, no stock) → Money → Bank: no bank yet → "Add a bank
//      account" (the plain dialog) → two credit bills for Ramesh Traders.
//   2. A statement in the HDFC layout of the parser fixture (src/shared/bankFormats/fixtures/
//      hdfc-style.csv — its header block, dates made relative to today) is dropped on the screen:
//      Ramesh's ₹4,000 receipt, a ₹450 stationery expense and ₹59 SMS charges. The receipt is
//      suggested ("the bank's description names Ramesh Traders") and accepted; the expense is
//      answered "An expense" → Office expenses; the charges "Bank charges".
//   3. The one sentence says "Books and bank agree as on …"; the lines show as Done; Ramesh still
//      owes ₹1,000 (oldest bill first); the accountant BRS has nothing outstanding.
//   4. A payment entered in the books but not on the statement → "1 entry differs: see them" →
//      the full Banking → BRS on this account lists it.
// Screenshots light + dark of the empty screen, the lines with their suggestions and the done
// state; WP96_SHOTS=<dir> copies them for the visual review.
import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { scenario, assert, assertEq, fixedToday, relativeDate } from '../lib/harness.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const FIXTURE = path.resolve(here, '../../src/shared/bankFormats/fixtures/hdfc-style.csv')

// The plan §1 banned list (shared/simple/bannedWords.ts), as its patterns match it.
const BANNED = [
  /\bvouchers?\b/i, /\bledgers?\b/i, /\bjournals?\b/i, /\bcontras?\b/i, /\b(?:Dr|Cr)\b/, /\bparticulars?\b/i, /\bnarrations?\b/i, /\bsundry\b/i,
  /\bgroups?\b/i, /\bITC\b/i, /\bset[- ]?offs?\b/i, /\bag(?:e)?ing\b/i, /\bBRS\b/i, /\bgodowns?\b/i, /\bBOMs?\b/i, /\bSOA\b/i, /\breconcil/i
]
const bannedWordsIn = (text) => BANNED.filter((re) => re.test(text)).map((re) => re.source)
const attached = (h, sel, timeout = 15000) => h.page.waitForSelector(sel, { state: 'attached', timeout })

const dmy = (s) => `${s.slice(8, 10)}/${s.slice(5, 7)}/${s.slice(2, 4)}`

/** The fixture's own layout (bank header block + column row), with our three lines. Dates are
 *  `daysAgo` before today; the books begin early enough to hold them (WP 7.4 `pickSetupStart`). */
function statementCsv(today, rows) {
  const fixture = fs.readFileSync(FIXTURE, 'utf8').split('\n')
  const head = fixture.slice(0, fixture.findIndex((l) => l.startsWith('Date,')) + 1)
  return [...head, ...rows.map((r) => `${dmy(r.date)},${r.text},${r.ref},${dmy(r.date)},${r.out ?? ''},${r.in ?? ''},`), ',,,,,,'].join('\n')
}

await scenario('57-bank-simple', async (h) => {
  const { page } = h
  const shoot = async (name) => {
    for (const want of ['light', 'dark']) {
      if ((await page.evaluate(() => document.documentElement.dataset.theme)) !== want) {
        await h.click('btn-theme')
        await page.waitForFunction((w) => document.documentElement.dataset.theme === w, want)
      }
      await page.waitForTimeout(400)
      const file = await h.shot(`${name}-${want}`)
      const dir = process.env.WP96_SHOTS
      if (dir) {
        fs.mkdirSync(dir, { recursive: true })
        fs.copyFileSync(file, path.join(dir, `${name}-${want}.png`))
      }
    }
    await h.click('btn-theme')
    await page.waitForFunction(() => document.documentElement.dataset.theme === 'light')
  }
  const text = async (testId) => ((await page.textContent(`[data-testid="${testId}"]`)) ?? '').replace(/\s+/g, ' ').trim()
  const noBanned = async (where) => {
    const visible = await page.evaluate(() => document.querySelector('main')?.innerText ?? '')
    const found = bannedWordsIn(visible)
    assert(found.length === 0, `no accounting words on ${where} (${found.join(', ')})`)
  }
  const card = (needle) => page.locator('[data-testid="bank-line"]', { hasText: needle }).first()

  // ================= 1. a wizard company, then a bank =================
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
  // WP 7.4: the oldest bill is 12 days old — the books begin early enough to hold it.
  await h.pickSetupStart(12)
  await h.click('setup-fresh-new')
  await h.click('setup-next')
  await h.click('setup-finish')
  await h.waitScreen('gateway', 30000)
  await attached(h, '[data-testid="simple-home"]', 20000)
  await h.stubDialogs()
  assertEq((await h.invoke('ai:settings:get')).settings?.enabled ?? false, false, 'AI is off')

  // Money → Bank (the simple screen, not the full app).
  await h.click('simple-nav-money')
  await h.click('simple-entry-bank')
  await h.waitScreen('simple-bank')
  await attached(h, '[data-testid="simple-nav"]')
  await attached(h, '[data-testid="bank-no-bank"]')
  await noBanned('the Bank screen without a bank')
  await h.click('btn-bank-add-bank')
  await attached(h, '[data-testid="dialog-new-account"]')
  await h.fill('input-account-name', 'HDFC Bank')
  await h.click('btn-account-create')
  await attached(h, '[data-testid="bank-statement"]')
  const banks = await h.invoke('bank:ledgers')
  const bank = banks.find((b) => b.name === 'HDFC Bank')
  assert(bank, 'the bank account was added as a bank')
  await attached(h, '[data-testid="bank-sentence"][data-tone="none"]')
  await shoot('01-bank-empty')

  // Two credit bills for Ramesh Traders (₹3,000 then ₹2,000).
  const groups = await h.invoke('master:groups:list')
  const ramesh = await h.invoke('master:ledgers:create', {
    name: 'Ramesh Traders', groupId: groups.find((g) => g.name === 'Sundry Debtors').id, openingBalance: 0, gstin: null, stateCode: null, address: null,
    taxType: null, gstRate: null, hsn: null, tdsSectionId: null, pan: null, creditDays: 15, exportType: null
  })
  const today = fixedToday
  const ago = (n) => relativeDate(-n)
  for (const [i, amount, days] of [[1, 300_000, 12], [2, 200_000, 10]]) {
    await h.invoke('simple:post', { intent: { kind: 'sale', clientId: `e2e-bill-${i}-xxxxxxxx`, date: ago(days), customerId: ramesh.id, amount: { amount }, payment: { how: 'credit' } }, today })
  }

  // ================= 2. drop the statement =================
  const csv = statementCsv(today, [
    { date: ago(6), text: 'NEFT CR-ICIC0000104-RAMESH TRADERS-NETBANK', ref: 'N214262871234567', in: '"4,000.00"' },
    { date: ago(5), text: 'UPI-STATIONERY MART-stationery@okhdfc-HDFC0001234-321456789012-PAPER', ref: '0000321456789012', out: '450.00' },
    { date: ago(3), text: 'SMS ALERT CHARGES QTR', ref: '', out: '59.00' }
  ])
  await page.setInputFiles('[data-testid="input-bank-file"]', { name: 'hdfc-oct.csv', mimeType: 'text/csv', buffer: Buffer.from(csv, 'utf8') })
  await attached(h, '[data-testid="bank-preview-found"][data-count="3"]')
  assert((await text('bank-preview-found')).startsWith('hdfc-oct.csv: 3 new lines'), 'the preview says what it found')
  await h.click('btn-bank-add-lines')
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="bank-line"]').length === 3, null, { timeout: 15000 })
  assertEq(await text('bank-note'), 'Added 3 lines from hdfc-oct.csv.', 'the lines were added')

  // The receipt is suggested from the name in the bank's description — no key involved.
  const receipt = card('RAMESH TRADERS')
  assertEq(await receipt.getAttribute('data-choice'), 'customer', 'the receipt is pre-selected as "A customer paid"')
  assertEq(
    ((await receipt.locator('[data-testid="bank-line-because"]').textContent()) ?? '').trim(),
    'Suggested because the bank’s description names Ramesh Traders',
    'the plain because'
  )
  await receipt.locator('[data-testid="bank-line-preview"]').waitFor({ timeout: 10000 })
  assert(((await receipt.locator('[data-testid="bank-line-preview"]').textContent()) ?? '').includes('₹4,000.00'), 'what it will record, from simple:preview')
  assertEq(await page.$('[data-testid="bank-ask"]'), null, 'AI off: the assistant is never offered')
  await attached(h, '[data-testid="bank-sentence"][data-tone="open"]')

  // The stationery: "An expense" → Office expenses (a category tile).
  const stationery = card('STATIONERY')
  await stationery.locator('[data-testid="bank-choice-expense"]').click()
  assert(await stationery.locator('[data-testid="btn-bank-line-save"]').isDisabled(), 'an expense needs its category first')
  await stationery.locator('[data-testid^="picker-bank-category-"]').first().click()
  await stationery.locator('[data-testid="category-office"]').click()
  // The SMS charges: "Bank charges".
  const charges = card('SMS ALERT')
  await charges.locator('[data-testid="bank-choice-charges"]').click()
  await noBanned('the lines to answer')
  await shoot('02-bank-lines')

  // Accept all: every answered line in one go (one entry each).
  assertEq(await text('btn-bank-accept-all'), 'Save all 3 answered lines', 'three lines are ready')
  await h.click('btn-bank-accept-all')
  await attached(h, '[data-testid="bank-sentence"][data-tone="agree"]')

  // ================= 3. the sentence, Done, the books =================
  const sentence = await text('bank-sentence')
  assert(/^Books and bank agree as on \d{1,2} \w{3} \d{4}\.$/.test(sentence), `the sentence (${sentence})`)
  assertEq(await page.$('[data-testid="bank-open"]'), null, 'nothing left to answer')
  const done = await page.$$eval('[data-testid="bank-done-status"]', (els) => els.map((e) => [e.getAttribute('data-status'), e.textContent.trim()]))
  assertEq(done.length, 3, 'the three lines stay listed')
  assert(done.every(([s]) => s === 'done'), 'every line is Done')
  assert(done.some(([, t]) => t === 'Done · Ramesh Traders') && done.some(([, t]) => t === 'Done · Office expenses') && done.some(([, t]) => t === 'Done · Bank charges'), `done names (${JSON.stringify(done)})`)
  const owes = await h.invoke('analysis:outstandings', { side: 'receivable', asOn: today })
  const row = owes.find((r) => r.ledgerId === ramesh.id)
  assertEq(row?.pending, 100_000, 'Ramesh still owes ₹1,000 (his oldest bill was settled first)')
  assertEq(row?.bills.filter((b) => b.pending > 0).length, 1, 'one bill still open')
  const lastDate = ago(3)
  const brs = await h.invoke('banking:brs', { ledgerId: bank.id, asOn: lastDate })
  assertEq(brs.uncredited.length + brs.unpresented.length, 0, 'the accountant BRS has nothing outstanding')
  assertEq(brs.bookBalance, brs.bankBalance, 'book balance = bank balance')
  await noBanned('the done state')
  await shoot('03-bank-done')

  // ================= 4. an entry the bank has not shown → see them =================
  await h.invoke('simple:post', { intent: { kind: 'move_money', clientId: 'e2e-cash-wdl-xxxxxxxx', date: ago(3), amount: 150_000, fromId: bank.id, toId: (await h.invoke('master:ledgers:list')).find((l) => l.name === 'Cash').id }, today })
  await h.click('simple-nav-home')
  await h.click('simple-nav-money')
  await h.click('simple-entry-bank')
  await attached(h, '[data-testid="bank-sentence"][data-tone="differ"]')
  assertEq(await text('btn-bank-see-them'), '1 entry differs: see them', 'the sentence counts the BRS entries')
  await noBanned('the differ sentence')
  await shoot('04-bank-differ')
  await h.click('btn-bank-see-them')
  await h.waitScreen('banking')
  assertEq(Number(await page.inputValue('[data-testid="banking-ledger"]')), bank.id, 'the full BRS opens on this bank account')
  await attached(h, '[data-testid="banking-brs-unpresented-table"]')
  const rows = await page.$$('[data-testid="banking-brs-unpresented-table"] [data-row-id]')
  assertEq(rows.length, 1, 'the BRS lists the one entry the bank has not shown')
  assert(await page.$('[data-testid="btn-back-to-simple"]'), '"Back to simple" is offered')
})
