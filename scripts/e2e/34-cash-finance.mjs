// Scenario 34 — cash and finance (WP 4.4), driven through the UI: create a loan (live schedule
// preview), post its first EMI (balanced principal / interest split), see the next EMI in the
// cash-flow forecast, revalue a USD customer at a closing rate entered on the Forex screen
// (journal + next-day reversal), and read a cost-centre budget's variance with drill-down.
// Every screen is shot in both themes. Set WP44_SHOTS=/tmp/wp44 to copy the shots there.
import fs from 'node:fs'
import path from 'node:path'
import { scenario, assert, assertEq } from '../lib/harness.mjs'

await scenario('34-cash-finance', async (h) => {
  await h.createCompanyUI('Cash Finance Co')
  const page = h.page
  const extraShots = process.env.WP44_SHOTS
  const shot = async (name) => {
    await page.mouse.move(0, 0)
    await page.waitForTimeout(250)
    await h.shot(name)
    if (extraShots) {
      fs.mkdirSync(extraShots, { recursive: true })
      fs.copyFileSync(path.join(h.outDir, `${name}.png`), path.join(extraShots, `${name}.png`))
    }
  }
  const setTheme = async (theme) => {
    const now = await page.evaluate(() => document.documentElement.dataset.theme ?? 'light')
    if (now !== theme) await h.click('btn-theme')
    await page.waitForFunction((t) => (document.documentElement.dataset.theme ?? 'light') === t, theme)
    await page.waitForTimeout(400)
  }
  const pick = async (testId, text) => {
    const input = page.locator(`[data-testid="${testId}"]`)
    await input.click()
    await input.fill(text)
    await page.locator('[role="option"]', { hasText: text }).first().waitFor({ timeout: 10000 })
    await input.press('Enter')
  }
  const typeDate = async (testId, iso) => {
    const [y, m, d] = iso.split('-')
    await h.fill(testId, `${d}-${m}-${y}`)
    await page.locator(`[data-testid="${testId}"]`).press('Enter')
  }

  const today = await page.evaluate(() => {
    const d = new Date()
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  })
  const addDays = (iso, n) => {
    const x = new Date(`${iso}T00:00:00Z`)
    x.setUTCDate(x.getUTCDate() + n)
    return x.toISOString().slice(0, 10)
  }
  const [y, m] = today.split('-').map(Number)
  const fyStart = m >= 4 ? y : y - 1

  // ---------- masters and opening entries ----------
  const groups = await h.invoke('master:groups:list')
  const gid = (name) => groups.find((g) => g.name === name).id
  const mkLedger = (name, group, openingBalance = 0) =>
    h.invoke('master:ledgers:create', { name, groupId: gid(group), openingBalance, gstin: null, stateCode: null, address: null, taxType: null, gstRate: null, hsn: null })
  const bank = await mkLedger('HDFC Current', 'Bank Accounts')
  const loanLedger = await mkLedger('HDFC Term Loan', 'Secured Loans')
  const capital = await mkLedger('Owner Capital', 'Capital Account')
  const globex = await mkLedger('Globex Inc', 'Sundry Debtors')
  const sales = await mkLedger('Export Sales', 'Sales Accounts')
  const rent = await mkLedger('Office Rent', 'Indirect Expenses')
  const mumbai = await h.invoke('cc:save', { data: { name: 'Mumbai', parentId: null, active: true } })
  const types = await h.invoke('master:voucherTypes:list')
  const vt = (kind) => types.find((t) => t.kind === kind).id
  const save = (kind, date, lines, extra = {}) =>
    h.invoke('voucher:save', {
      data: {
        voucherTypeId: vt(kind), date, partyLedgerId: null, narration: null, reference: null, instrumentNo: null, instrumentDate: null,
        transporterId: null, vehicleNo: null, transportDistanceKm: null, currencyCode: null, exchangeRate: null, lines, inventory: [], billRefs: [], tds: null, ...extra
      }
    })
  const L = (ledgerId, drCr, amount, costAllocations = []) => ({ ledgerId, drCr, amount, costAllocations })
  const disbursed = addDays(today, -40)
  await save('receipt', addDays(today, -60), [L(bank.id, 'dr', 2_00_000_00), L(capital.id, 'cr', 2_00_000_00)])
  await save('receipt', disbursed, [L(bank.id, 'dr', 5_00_000_00), L(loanLedger.id, 'cr', 5_00_000_00)])

  // ---------- 1. create a loan through the form ----------
  await h.goto('loans')
  await shot('01-loans-empty-light')
  await h.click('btn-loans-new')
  await page.waitForSelector('[data-testid="loan-form"]')
  await h.fill('input-loan-name', 'HDFC term loan')
  await pick('picker-loan-ledger', 'HDFC Term Loan')
  await pick('picker-loan-bank', 'HDFC Current')
  await h.fill('input-loan-principal', '500000')
  await h.fill('input-loan-rate', '10.5')
  await h.fill('input-loan-tenure', '36')
  await typeDate('input-loan-disbursed', disbursed)
  const firstDue = addDays(today, -5)
  await typeDate('input-loan-first-due', firstDue)
  await page.waitForFunction(() => /₹/.test(document.querySelector('[data-testid="loan-preview-emi"]')?.textContent ?? ''), null, { timeout: 10000 })
  // ₹5,00,000 at 10.5 % over 36 months: EMI = P·r·(1+r)^n / ((1+r)^n − 1) = ₹16,251.22.
  assert((await page.textContent('[data-testid="loan-preview-emi"]')).includes('16,251.22'), 'preview EMI from the formula')
  await shot('02-loan-form-light')
  await h.click('btn-loan-save')
  await page.waitForSelector('[data-testid="loan-form"]', { state: 'detached', timeout: 10000 })
  const [loan] = await h.invoke('loan:list', {})
  assertEq(loan.emi, 16_251_22, 'saved EMI')
  await page.waitForSelector('[data-testid="rows-loan-schedule"] [data-seq="36"]', { state: 'attached', timeout: 10000 })
  await shot('03-loan-schedule-light')

  // ---------- 2. post the first EMI ----------
  await h.click('btn-loan-post-next')
  await page.waitForSelector('[data-testid="loan-post-modal"]')
  await shot('04-loan-post-light')
  await h.click('btn-loan-post-confirm')
  await page.waitForSelector('[data-testid="loan-post-modal"]', { state: 'detached', timeout: 10000 })
  const detail = await h.invoke('loan:get', { id: loan.id })
  const first = detail.schedule[0]
  assert(first.posted && first.voucherId, 'first instalment posted')
  const v = await h.invoke('voucher:get', { id: first.voucherId })
  const sum = (side) => v.lines.filter((l) => l.drCr === side).reduce((s, l) => s + l.amount, 0)
  assertEq(sum('dr'), sum('cr'), 'EMI voucher balances')
  assertEq(v.lines.find((l) => l.ledgerId === loanLedger.id).amount, first.principal, 'principal to the loan ledger')
  assertEq(v.lines.find((l) => l.ledgerId === bank.id).amount, 16_251_22, 'EMI from the bank')
  assertEq(first.interest, 4_375_00, 'first month interest = 5,00,000 × 10.5 % ÷ 12')
  await page.waitForSelector('[data-testid="rows-loan-schedule"] [data-seq="1"][data-posted="true"]', { state: 'attached', timeout: 10000 })
  await shot('05-loan-posted-light')

  // ---------- 3. the forecast shows the next EMI ----------
  await h.goto('cash-forecast')
  await page.waitForSelector('[data-testid="rows-cash-forecast"] tr', { timeout: 15000 })
  const base = await h.invoke('forecast:base', { asOn: today, to: addDays(today, 90) })
  const emiFlow = base.flows.find((f) => f.source === 'emi')
  assert(emiFlow && emiFlow.amount === 16_251_22 && emiFlow.date === detail.schedule[1].dueDate, 'forecast carries the next unposted EMI')
  const tb = await h.invoke('report:trialBalance', { asOn: today })
  const tbBank = tb.rows.filter((r) => r.ledgerId === bank.id).reduce((s, r) => s + r.debit - r.credit, 0)
  assertEq(base.openingCash, tbBank, 'forecast opening = trial balance cash & bank')
  const emiCol = await page.evaluate(() => [...document.querySelectorAll('[data-testid="rows-cash-forecast"] tr')].some((tr) => tr.textContent.includes('16,251.22')))
  assert(emiCol, 'an EMI shows in the forecast table')
  await shot('06-forecast-light')
  await h.click('btn-cash-forecast-options')
  await page.waitForSelector('[data-testid="input-forecast-collection"]')
  await shot('07-forecast-options-light')
  await h.click('options-cash-forecast-done')
  await h.click('tab-cash-forecast-items')
  await h.click('btn-forecast-item-new')
  await h.fill('input-forecast-item-name', 'Office rent')
  await h.fill('input-forecast-item-amount', '45000')
  await h.click('btn-forecast-item-save')
  await page.waitForSelector('[data-testid="rows-forecast-items"] tr', { timeout: 10000 })
  await shot('08-forecast-items-light')
  await h.click('tab-cash-forecast-assumptions')
  await page.waitForSelector('[data-testid="forecast-assumptions"]')
  await h.click('tab-cash-forecast-forecast')

  // ---------- 4. revalue a USD customer ----------
  await save('journal', addDays(today, -10), [L(globex.id, 'dr', 82_000_00), L(sales.id, 'cr', 82_000_00)], { partyLedgerId: globex.id, currencyCode: 'USD', exchangeRate: 82 })
  await h.goto('forex')
  await page.waitForSelector('[data-testid="rows-forex-exposures"] [data-currency="USD"]', { timeout: 15000 })
  await page.waitForSelector('[data-testid="forex-blocked"]')
  await h.fill('input-fx-rate-currency', 'USD')
  await h.fill('input-fx-rate-value', '83.25')
  await h.click('btn-fx-rate-save')
  await page.waitForFunction(() => document.querySelector('[data-testid="rows-forex-exposures"]')?.textContent?.includes('+1,250.00'), null, { timeout: 10000 })
  await shot('09-forex-light')
  await h.click('btn-forex-revalue')
  await page.waitForSelector('[data-testid="forex-revalue-modal"]')
  await shot('10-forex-revalue-light')
  await h.click('btn-forex-revalue-post')
  await page.waitForSelector('[data-testid="forex-revalue-modal"]', { state: 'detached', timeout: 10000 })
  const revals = await h.invoke('fx:revaluations')
  assertEq(revals.length, 1, 'one revaluation')
  assert(revals[0].reversalVoucherId, 'reversed the next day')
  const rj = await h.invoke('voucher:get', { id: revals[0].voucherId })
  assert(rj.lines.some((l) => l.ledgerId === globex.id && l.drCr === 'dr' && l.amount === 1_250_00), 'Dr Globex 1,250')
  const rev = await h.invoke('voucher:get', { id: revals[0].reversalVoucherId })
  assertEq(rev.date, addDays(today, 1), 'reversal dated the next day')
  await page.waitForSelector('[data-testid="rows-fx-revaluations"] tr', { timeout: 10000 })
  await shot('11-forex-revalued-light')

  // ---------- 5. budget variance by cost centre ----------
  await save('payment', today, [L(rent.id, 'dr', 15_000_00, [{ costCentreId: mumbai.id, amount: 15_000_00 }]), L(bank.id, 'cr', 15_000_00)])
  await h.goto('budgets')
  await h.click('btn-budgets-new')
  await h.fill('input-budget-name', 'Opex')
  await h.click('btn-budget-create')
  await page.waitForSelector('[data-testid="budget-lines"]')
  await pick('picker-budget-ledger', 'Office Rent')
  await page.selectOption('[data-testid="select-budget-cc"]', { label: 'Mumbai' })
  await page.selectOption('[data-testid="select-budget-spread"]', 'even')
  await h.fill('input-budget-amount', '120000')
  await h.click('btn-budgets-save')
  const lineRow = page.locator('[data-testid="rows-budget-variance"] [data-line-id]')
  await lineRow.first().waitFor({ timeout: 10000 })
  const text = await lineRow.first().textContent()
  assert(text.includes('Mumbai') && text.includes('15,000.00') && text.includes('10,000.00'), 'month budget 10,000 vs actual 15,000 for Mumbai')
  assertEq(await lineRow.first().locator('[data-favourable="false"]').count() > 0, true, 'the month is adverse')
  const [budget] = await h.invoke('budget:list')
  const report = await h.invoke('budget:monthly', { budgetId: budget.id, upToMonth: today.slice(0, 7) })
  const cc = await h.invoke('cc:report', { from: `${fyStart}-04-01`, to: today })
  assertEq(report.rows[0].ytd.actual, cc.find((r) => r.costCentreId === mumbai.id).expense, 'budget actual = cost-centre P&L')
  await shot('12-budget-light')
  await lineRow.first().click()
  await page.waitForSelector('[data-testid="rows-budget-drill"] tr', { timeout: 10000 })
  await shot('13-budget-drill-light')
  await page.keyboard.press('Escape')
  await h.click('seg-budget-view-months')
  await shot('14-budget-months-light')
  await h.click('seg-budget-view-summary')

  // ---------- dashboard chip + year-end ----------
  await h.goto('gateway')
  await page.waitForSelector('[data-testid="dash-over-budget"]', { timeout: 15000 })
  await shot('15-gateway-light')

  // ---------- dark theme pass ----------
  await setTheme('dark')
  await h.goto('cash-forecast')
  await page.waitForSelector('[data-testid="rows-cash-forecast"] tr')
  await shot('16-forecast-dark')
  await h.click('btn-cash-forecast-options')
  await page.waitForSelector('[data-testid="input-forecast-collection"]')
  await shot('17-forecast-options-dark')
  await h.click('options-cash-forecast-done')
  await h.goto('loans')
  await page.waitForSelector('[data-testid="rows-loan-schedule"] tr')
  await shot('18-loans-dark')
  await h.click('btn-loan-post-next')
  await page.waitForSelector('[data-testid="loan-post-modal"]')
  await shot('19-loan-post-dark')
  await page.keyboard.press('Escape')
  await h.goto('forex')
  await page.waitForSelector('[data-testid="rows-forex-exposures"] tr')
  await shot('20-forex-dark')
  await h.goto('budgets')
  await lineRow.first().waitFor()
  await shot('21-budget-dark')
  await h.goto('gateway')
  await page.waitForSelector('[data-testid="dash-over-budget"]')
  await shot('22-gateway-dark')
  await setTheme('light')
})
