// Scenario 69 — cost centres, cash flow, exceptions and the CA pack on the demo company (full app):
//   1. Cost centres screen: a new centre "Pune Branch" is created through its form.
//   2. A payment typed in the accounting editor (Dr a new rent ledger ₹10,000 / Cr Cash) gives
//      ₹6,000 of the rent line to the centre through the line's CC allocation dialog; the stored
//      line carries exactly that allocation, the P&L-by-centre table shows ₹6,000 expense (its
//      drill-down lists the voucher) and the rent ledger itself still carries the full ₹10,000.
//   3. Cash flow statement: net change, opening and closing cash & bank equal the cash / bank
//      ledgers' balances from report:trialBalance (day before the FY start → FY end). The
//      statement has no drill-down (plain rows), so none is exercised.
//   4. Exceptions: a journal saved without a narration is listed under "Missing narration";
//      opened from that row and given a narration in its editor, it drops off the list.
//   5. Registers → CA pack: the export folder holds every part (Tally XML, day book, TB, P&L,
//      BS, registers, outstandings, ledger statements, GSTR-1 JSON, audit trail + a VERIFIED
//      chain summary) with the figures of this run inside.
import * as fs from 'node:fs'
import * as path from 'node:path'
import { scenario, assert, assertEq, PICKER_OPTION, localToday, fyStartOf, fyStartYearOf, relativeDate } from '../lib/harness.mjs'

/** formatPaise (src/shared/money.ts): Indian grouping, 2 decimals, leading minus. */
function rupees(paise) {
  const abs = Math.abs(paise)
  const whole = Math.floor(abs / 100).toString()
  const grouped = whole.length <= 3 ? whole : whole.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ',') + ',' + whole.slice(-3)
  return `${paise < 0 ? '-' : ''}${grouped}.${String(abs % 100).padStart(2, '0')}`
}

await scenario('69-cost-centres-cashflow', async (h) => {
  await h.createDemoCompany()
  const page = h.page
  const today = localToday()
  const fyStart = fyStartOf()
  const fyEnd = `${fyStartYearOf() + 1}-03-31`

  const groups = await h.invoke('master:groups:list')
  const groupId = (name) => groups.find((g) => g.name === name).id
  const rent = await h.invoke('master:ledgers:create', {
    name: 'E2E Office Rent', groupId: groupId('Indirect Expenses'), openingBalance: 0,
    gstin: null, stateCode: null, address: null, taxType: null, gstRate: null, hsn: null
  })
  const ledgers = await h.invoke('master:ledgers:list')
  const cash = ledgers.find((l) => l.name === 'Cash')
  assert(cash, "seeded 'Cash' ledger")
  const types = await h.invoke('master:voucherTypes:list')
  const typeOf = (kind) => types.find((t) => t.kind === kind)

  // ---------- 1. a cost centre through its screen ----------
  await h.goto('cost-centres')
  await h.click('btn-cost-centres-new')
  const dialog = page.locator('[role="dialog"]')
  await dialog.locator('input').first().fill('Pune Branch')
  await dialog.getByRole('button', { name: 'Save cost centre' }).click()
  await page.waitForFunction(() => document.querySelector('[data-testid="rows-cost-centres"]')?.textContent?.includes('Pune Branch'), null, { timeout: 10000 })
  const centre = (await h.invoke('cc:list')).find((c) => c.name === 'Pune Branch')
  assert(centre && centre.parentId === null && centre.active, 'Pune Branch saved as an active top-level centre')
  await h.shot('01-cost-centre-created')

  // ---------- 2. a payment line allocated to it in the accounting editor ----------
  await h.goto('voucher-entry')
  await h.click('tab-voucher-entry-payment')
  await page.waitForSelector('[data-testid="voucher-entry-mode"][data-mode="accounting"]', { timeout: 10000 })
  const lines = page.locator('[data-testid="rows-voucher-lines"] > tr')
  const pickLedger = async (row, name) => {
    const input = lines.nth(row).locator('[data-testid="picker-ledger"]')
    await input.click()
    await input.fill(name)
    await page.waitForSelector(PICKER_OPTION, { timeout: 5000 })
    await input.press('Enter')
  }
  await pickLedger(0, 'E2E Office Rent')
  await lines.nth(0).locator('[data-testid="input-amount"]').fill('10000')
  await pickLedger(1, 'Cash')
  await lines.nth(1).locator('[data-testid="input-amount"]').fill('10000')
  assertEq(await lines.nth(1).locator('[data-testid="picker-ledger"]').inputValue(), 'Cash', 'credit line on Cash')
  // The CC button sits on every line with a ledger once the company has a cost centre.
  await lines.nth(0).getByRole('button', { name: 'CC', exact: true }).click()
  const alloc = page.locator('[role="dialog"]').filter({ hasText: 'Cost centre allocation' })
  await alloc.waitFor({ timeout: 10000 })
  await alloc.locator('select').first().selectOption({ label: 'Pune Branch' })
  await alloc.locator('[data-testid="input-amount"]').first().fill('6000')
  await page.waitForFunction(() => document.querySelector('[role="dialog"]')?.textContent?.includes('Allocated 6,000.00 of 10,000.00 — 4,000.00 remaining'), null, { timeout: 5000 })
  await h.shot('02-cc-allocation')
  await alloc.getByRole('button', { name: 'Save allocation' }).click()
  await alloc.waitFor({ state: 'detached', timeout: 5000 })
  await lines.nth(0).getByRole('button', { name: 'CC (1)' }).waitFor({ timeout: 5000 })
  await page.fill('input[placeholder="Being amount paid…"]', 'E2E rent, part Pune Branch')
  await h.click('btn-save-voucher')
  await page.waitForFunction(() => /\S+ saved/.test(document.body.innerText), null, { timeout: 10000 })

  const payments = (await h.invoke('voucher:list', { from: today, to: today, voucherTypeId: typeOf('payment').id }))
  const listed = []
  for (const p of payments) listed.push(await h.invoke('voucher:get', { id: p.id }))
  const payment = listed.find((v) => v.narration === 'E2E rent, part Pune Branch')
  assert(payment, 'the payment was saved')
  const rentLine = payment.lines.find((l) => l.ledgerId === rent.id)
  assertEq(rentLine.drCr, 'dr', 'rent is debited')
  assertEq(rentLine.amount, 1_000_000, 'rent line ₹10,000')
  assertEq(JSON.stringify(rentLine.costAllocations), JSON.stringify([{ costCentreId: centre.id, amount: 600_000 }]), 'one ₹6,000 allocation to Pune Branch')
  assertEq(payment.lines.find((l) => l.ledgerId === cash.id).amount, 1_000_000, 'cash credited ₹10,000')

  const report = (await h.invoke('cc:report', { from: fyStart, to: fyEnd })).find((r) => r.costCentreId === centre.id)
  assertEq(report.expense, 600_000, 'cc:report expense = the allocation')
  assertEq(report.income, 0, 'no income on the centre')
  assertEq(report.net, -600_000, 'net = income − expense')
  // The ledger is untouched by the split: its whole ₹10,000 is still there.
  const tb = await h.invoke('report:trialBalance', { asOn: today })
  const rentTb = tb.rows.find((r) => r.ledgerId === rent.id)
  assertEq(rentTb.debit, 1_000_000, 'trial balance: rent ₹10,000 Dr')
  assertEq(tb.totalDebit, tb.totalCredit, 'trial balance ties')
  assertEq((await h.invoke('report:ledger', { ledgerId: rent.id, from: fyStart, to: fyEnd })).closing, 1_000_000, 'rent statement closes at ₹10,000')

  await h.goto('cost-centres')
  const plRow = `[data-testid="rows-cost-centre-pl"] [data-row-id="${centre.id}"]`
  await page.waitForSelector(plRow, { timeout: 10000 })
  const plText = await page.textContent(plRow)
  assert(plText.includes('Pune Branch') && plText.includes('6,000.00'), `P&L by centre: Pune Branch ₹6,000 (row: ${plText})`)
  assert(!plText.includes('10,000.00'), 'only the allocated part counts for the centre')
  await page.click(plRow)
  await page.waitForSelector('[data-testid="cc-drill"]', { timeout: 10000 })
  const drill = await page.textContent('[data-testid="cc-drill"]')
  assert(drill.includes(payment.number) && drill.includes('E2E Office Rent') && drill.includes('6,000.00 Dr'), `drill-down lists the payment (got: ${drill})`)
  await h.shot('03-cost-centre-pl')

  // ---------- 3. cash flow = cash / bank movement in the trial balance ----------
  const byId = new Map(groups.map((g) => [g.id, g]))
  const isCashBank = (gid) => {
    for (let g = byId.get(gid); g; g = g.parentId ? byId.get(g.parentId) : undefined) {
      if (['Cash-in-Hand', 'Bank Accounts', 'Bank OD A/c'].includes(g.name)) return true
    }
    return false
  }
  const cashBankIds = new Set(ledgers.filter((l) => isCashBank(l.groupId)).map((l) => l.id))
  assert(cashBankIds.has(cash.id) && cashBankIds.size >= 2, 'demo has Cash and a bank')
  const cashBankOf = (t) => t.rows.filter((r) => cashBankIds.has(r.ledgerId)).reduce((s, r) => s + r.debit - r.credit, 0)
  const openingCash = cashBankOf(await h.invoke('report:trialBalance', { asOn: relativeDate(-1, fyStart) }))
  const closingCash = cashBankOf(await h.invoke('report:trialBalance', { asOn: fyEnd }))
  assert(closingCash !== openingCash, 'the year moved cash')
  await h.goto('cash-flow')
  await page.waitForSelector('[data-testid="cash-flow-table"]', { timeout: 10000 })
  const cfRow = (label) =>
    page.evaluate((l) => {
      const tr = [...document.querySelectorAll('[data-testid="cash-flow-table"] tr')].find((r) => r.children[0]?.textContent?.trim() === l)
      return tr ? (tr.children[1]?.textContent ?? '').trim() : null
    }, label)
  const asShown = (p) => (p === 0 ? '–' : rupees(p))
  assertEq(await cfRow('Net change in cash'), asShown(closingCash - openingCash), 'net change = closing − opening cash & bank (TB)')
  assertEq(await cfRow('Opening cash & bank'), asShown(openingCash), 'opening cash & bank = TB before the FY')
  assertEq(await cfRow('Closing cash & bank'), asShown(closingCash), 'closing cash & bank = TB at the FY end')
  const cf = await h.invoke('report:cashFlow', { from: fyStart, to: fyEnd })
  assertEq(cf.operatingTotal + cf.investingTotal + cf.financingTotal, cf.netChange, 'the three sections add up to the net change')
  await h.shot('04-cash-flow')

  // ---------- 4. exceptions: a journal without a narration ----------
  const journal = await h.invoke('voucher:save', {
    data: {
      voucherTypeId: typeOf('journal').id, date: today, partyLedgerId: null, narration: null, reference: null,
      instrumentNo: null, instrumentDate: null, transporterId: null, vehicleNo: null, transportDistanceKm: null,
      currencyCode: null, exchangeRate: null,
      lines: [
        { ledgerId: rent.id, drCr: 'dr', amount: 50_000 },
        { ledgerId: cash.id, drCr: 'cr', amount: 50_000 }
      ],
      inventory: []
    }
  })
  await h.goto('exceptions')
  const toggle = '[data-testid="exceptions-toggle-missingNarration"]'
  await page.waitForSelector(toggle, { timeout: 10000 })
  if ((await page.getAttribute(toggle, 'aria-expanded')) !== 'true') await page.click(toggle)
  const excRow = `[data-testid="rows-exceptions-missingNarration"] [data-row-id="${journal.id}"]`
  await page.waitForSelector(excRow, { timeout: 10000 })
  const excText = await page.textContent(excRow)
  assert(excText.includes('no narration') && excText.includes('500.00'), `listed as missing a narration (row: ${excText})`)
  const before = (await h.invoke('report:exceptions', { from: fyStart, to: fyEnd })).sections.find((s) => s.key === 'missingNarration')
  assert(before.rows.some((r) => r.voucherId === journal.id), 'report:exceptions lists the journal')
  await h.shot('05-exception-listed')
  await page.click(excRow)
  await h.waitScreen('voucher-entry')
  await page.waitForSelector('[data-testid="voucher-entry-mode"][data-mode="accounting"]', { timeout: 10000 })
  await page.fill('input[placeholder="Being amount paid…"]', 'E2E rent adjustment')
  await h.click('btn-save-voucher')
  await h.waitScreen('exceptions')
  await page.waitForSelector(excRow, { state: 'detached', timeout: 10000 })
  assertEq((await h.invoke('voucher:get', { id: journal.id })).narration, 'E2E rent adjustment', 'narration saved')
  const after = (await h.invoke('report:exceptions', { from: fyStart, to: fyEnd })).sections.find((s) => s.key === 'missingNarration')
  assert(!after.rows.some((r) => r.voucherId === journal.id), 'no longer an exception')
  assertEq(after.count, before.count - 1, 'one finding fewer')

  // ---------- 5. CA pack from the Registers screen ----------
  await h.stubDialogs()
  await h.goto('registers')
  await h.click('btn-registers-ca-pack')
  await page.waitForFunction(() => /Saved to .*ca-pack-/.test(document.body.innerText), null, { timeout: 30000 })
  const shown = await page.evaluate(() => document.body.innerText.match(/Saved to (\S*ca-pack-\S+)/)?.[1] ?? null)
  assertEq(path.basename(shown), `ca-pack-${fyStart}_${fyEnd}`, 'the pack is named after the working period')
  assert(shown.startsWith(h.dataDir) && fs.statSync(shown).isDirectory(), `the pack folder exists in the scratch data dir (${shown})`)
  const files = fs.readdirSync(shown)
  for (const part of [
    'tally-masters.xml', 'tally-vouchers.xml', 'daybook.csv', 'trial-balance.csv', 'profit-and-loss.csv',
    'balance-sheet.csv', 'sales-register.csv', 'purchase-register.csv', 'outstandings.csv', 'ledger-statements',
    'audit-trail.csv', 'audit-trail-verification.txt'
  ]) assert(files.includes(part), `CA pack has ${part} (has: ${files.join(', ')})`)
  const gstr1 = files.filter((f) => /^gstr1-.+\.json$/.test(f))
  assertEq(gstr1.length, 1, 'one GSTR-1 JSON')
  const g1 = JSON.parse(fs.readFileSync(path.join(shown, gstr1[0]), 'utf8'))
  assertEq(g1.gstin, '27AAPFU0939F1ZV', 'GSTR-1 JSON is the company’s')
  assert(!files.includes('tds-26q.csv') && !files.includes('tcs-27eq.csv'), 'no TDS / TCS parts without deductions')
  const read = (f) => fs.readFileSync(path.join(shown, f), 'utf8')
  assert(read('daybook.csv').includes('E2E rent, part Pune Branch') && read('daybook.csv').includes('E2E rent adjustment'), 'day book CSV carries this run’s entries')
  const tbTotal = read('trial-balance.csv').trim().split('\n').pop()
  const [, , dr, cr] = tbTotal.split(',').map((c) => c.replace(/"/g, ''))
  assert(tbTotal.startsWith('Total') && dr === cr, `trial balance CSV ties (${tbTotal})`)
  const rentCsv = fs.readFileSync(path.join(shown, 'ledger-statements', 'E2E Office Rent.csv'), 'utf8').trim().split('\n')
  assert(rentCsv.pop().endsWith('10500.00'), 'rent statement closes at ₹10,500 (payment + journal)')
  assert(read('audit-trail-verification.txt').includes('Result: VERIFIED'), 'the audit chain verifies')
  assert(read('tally-vouchers.xml').includes('<ENVELOPE'), 'Tally vouchers XML')
  await page.waitForTimeout(300)
  await h.shot('06-ca-pack')
  await h.goto('gateway')
})
