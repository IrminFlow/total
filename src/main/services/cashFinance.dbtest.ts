// WP 4.4 — cash and finance against a real (in-memory) company: the forecast's opening equals the
// trial balance's cash and bank, Post EMI books a balanced principal / interest split and marks
// the schedule, forex revaluation posts and reverses, settlement books the realised difference,
// and the budget variance by cost centre ties to the cost-centre P&L.
import { describe, expect, it } from 'vitest'
import { seededDb, TEST_INFO } from '../db/testdb'
import type { DB } from '../db/connection'
import type { VoucherInput } from '@shared/schemas'
import { createLedger } from './masters'
import { deleteVoucher, getVoucher, saveVoucher } from './vouchers'
import { closingBalances, trialBalance, pnlLedgerAmounts } from './reports'
import { ccReport } from './costCentres'
import { saveCostCentre } from './costCentres'
import { saveBudget } from './budgets'
import { budgetCsv, budgetDrill, budgetMonthlyReport, budgetRevisions, importBudgetCsv, overBudgetThisMonth } from './budgetVariance'
import { addPrepayment, getLoan, listLoans, postEmi, saveLoan, emiReminders } from './loans'
import { postRevaluation, revaluationPreview, saveRate, settle, exposure, listRevaluations, reverseRevaluation, setLedgerCurrency } from './forex'
import { forecastBase, saveForecastItem, listForecastItems } from './cashForecast'
import { closeWarnings, financeReminders } from './cashFinanceChecks'
import { buildForecast, SCENARIO_PRESETS } from '@shared/cashForecast'
import { emiFor } from '@shared/loanSchedule'

const gid = (db: DB, name: string): number => (db.prepare('SELECT id FROM groups WHERE name = ?').get(name) as { id: number }).id
const lid = (db: DB, name: string): number => (db.prepare('SELECT id FROM ledgers WHERE name = ?').get(name) as { id: number }).id
function ledger(db: DB, name: string, group: string, extra: { openingBalance?: number; creditDays?: number | null } = {}): number {
  return createLedger(db, {
    name, groupId: gid(db, group), openingBalance: extra.openingBalance ?? 0, gstin: null, stateCode: null, address: null,
    taxType: null, gstRate: null, hsn: null, tdsSectionId: null, pan: null, creditDays: extra.creditDays ?? null, exportType: null
  }).id
}
const vt = (db: DB, kind: string): number => (db.prepare('SELECT id FROM voucher_types WHERE kind = ? ORDER BY id LIMIT 1').get(kind) as { id: number }).id
function post(db: DB, kind: string, date: string, lines: VoucherInput['lines'], extra: Partial<VoucherInput> = {}): number {
  return saveVoucher(db, { voucherTypeId: vt(db, kind), date, partyLedgerId: null, narration: null, reference: null, lines, inventory: [], billRefs: [], tds: null, ...extra }).id
}
const dr = (ledgerId: number, amount: number, costAllocations: { costCentreId: number; amount: number }[] = []) => ({ ledgerId, drCr: 'dr' as const, amount, costAllocations })
const cr = (ledgerId: number, amount: number) => ({ ledgerId, drCr: 'cr' as const, amount, costAllocations: [] })

function company(): { db: DB; cash: number; bank: number; sales: number } {
  const db = seededDb()
  const cash = lid(db, 'Cash')
  const bank = ledger(db, 'HDFC Current', 'Bank Accounts', { openingBalance: 5_00_000_00 })
  const sales = ledger(db, 'Sales Account', 'Sales Accounts')
  return { db, cash, bank, sales }
}

describe('cash-flow forecast base', () => {
  it('opening cash and bank equal the trial balance’s cash and bank ledgers', () => {
    const { db, cash, bank, sales } = company()
    post(db, 'receipt', '2026-05-02', [dr(cash, 12_345_00), cr(sales, 12_345_00)])
    post(db, 'receipt', '2026-05-03', [dr(bank, 50_000_00), cr(sales, 50_000_00)])
    const od = ledger(db, 'SBI OD', 'Bank OD A/c', { openingBalance: -20_000_00 })
    const base = forecastBase(db, TEST_INFO, '2026-06-01', '2026-08-31')
    const tb = trialBalance(db, '2026-06-01')
    const tbCashBank = tb.rows.filter((r) => [cash, bank, od].includes(r.ledgerId)).reduce((s, r) => s + r.debit - r.credit, 0)
    expect(base.openingCash).toBe(tbCashBank)
    expect(base.openingCash).toBe(12_345_00 + 5_50_000_00 - 20_000_00)
    expect(base.cashLedgers.map((l) => l.name).sort()).toEqual(['Cash', 'HDFC Current', 'SBI OD'])
  })

  it('collects receivables, payables, known items and EMIs as dated flows', () => {
    const { db, bank, sales } = company()
    const cust = ledger(db, 'Acme Buyer', 'Sundry Debtors', { creditDays: 30 })
    const supp = ledger(db, 'Steel Supplier', 'Sundry Creditors')
    const purchases = ledger(db, 'Purchases', 'Purchase Accounts')
    post(db, 'journal', '2026-05-10', [dr(cust, 1_00_000_00), cr(sales, 1_00_000_00)], { partyLedgerId: cust })
    post(db, 'journal', '2026-05-12', [dr(purchases, 40_000_00), cr(supp, 40_000_00)], { partyLedgerId: supp })
    saveForecastItem(db, { name: 'Office rent', amount: 25_000_00, cadence: 'monthly', startDate: '2026-06-05', endDate: null, kind: 'outflow' })
    expect(listForecastItems(db)).toHaveLength(1)
    const loanLedger = ledger(db, 'HDFC Term Loan', 'Secured Loans')
    saveLoan(db, { name: 'Term loan', loanLedgerId: loanLedger, bankLedgerId: bank, principal: 1_00_000_00, annualRateMilli: 12_000, tenureMonths: 12, disbursedOn: '2026-05-01', firstDueDate: '2026-06-05' })

    const base = forecastBase(db, TEST_INFO, '2026-06-01', '2026-08-31')
    const rec = base.flows.find((f) => f.source === 'receivable')!
    expect(rec).toMatchObject({ direction: 'in', amount: 1_00_000_00, date: '2026-06-09' })
    expect(base.flows.find((f) => f.source === 'payable')).toMatchObject({ direction: 'out', amount: 40_000_00 })
    expect(base.flows.filter((f) => f.source === 'item').map((f) => f.date)).toEqual(['2026-06-05', '2026-07-05', '2026-08-05'])
    const emis = base.flows.filter((f) => f.source === 'emi')
    expect(emis[0]).toMatchObject({ date: '2026-06-05', amount: 8_884_88 })
    expect(base.warnings).toEqual([])

    const f = buildForecast({ asOn: base.asOn, unit: 'week', count: 13, openingCash: base.openingCash, flows: base.flows, scenario: SCENARIO_PRESETS.expected })
    expect(f.periods).toHaveLength(13)
    expect(f.periods[0]!.opening).toBe(base.openingCash)
    expect(f.periods[0]!.bySource.emi).toBe(8_884_88)
    expect(f.periods.at(-1)!.closing).toBe(f.totals.closing)
  })
})

describe('loans and EMI', () => {
  function withLoan() {
    const c = company()
    const loanLedger = ledger(c.db, 'HDFC Term Loan', 'Secured Loans')
    // Disbursement: Dr Bank / Cr Loan.
    post(c.db, 'receipt', '2026-04-01', [dr(c.bank, 1_00_000_00), cr(loanLedger, 1_00_000_00)])
    const detail = saveLoan(c.db, {
      name: 'HDFC term loan', loanLedgerId: loanLedger, bankLedgerId: c.bank, principal: 1_00_000_00, annualRateMilli: 12_000,
      tenureMonths: 12, disbursedOn: '2026-04-01', firstDueDate: '2026-05-05'
    })
    return { ...c, loanLedger, detail }
  }

  it('generates the schedule and Post EMI books a balanced principal / interest split', () => {
    const { db, bank, loanLedger, detail } = withLoan()
    expect(detail.schedule).toHaveLength(12)
    expect(detail.loan.emi).toBe(emiFor(1_00_000_00, 12_000, 12))
    const first = detail.schedule[0]!
    const posted = postEmi(db, { scheduleId: first.id })
    expect(posted.posted).toBe(true)
    const v = getVoucher(db, posted.voucherId!)!
    const sum = (side: 'dr' | 'cr') => v.lines.filter((l) => l.drCr === side).reduce((s, l) => s + l.amount, 0)
    expect(sum('dr')).toBe(sum('cr'))
    expect(v.lines.find((l) => l.ledgerId === loanLedger)).toMatchObject({ drCr: 'dr', amount: 7_884_88 })
    expect(v.lines.find((l) => l.ledgerId === bank)).toMatchObject({ drCr: 'cr', amount: 8_884_88 })
    const interestId = lid(db, 'Interest on Loans')
    expect(v.lines.find((l) => l.ledgerId === interestId)).toMatchObject({ drCr: 'dr', amount: 1_000_00 })
    expect(v.date).toBe('2026-05-05')

    const after = getLoan(db, detail.loan.id, '2026-05-10')
    expect(after.loan.postedCount).toBe(1)
    expect(after.loan.outstanding).toBe(first.closing)
    // the loan ledger now carries the outstanding principal
    expect(-(closingBalances(db, '2026-05-10').get(loanLedger) ?? 0)).toBe(first.closing)
    expect(after.loan.ledgerBalance).toBe(first.closing)
    // no double posting, and instalments post in order
    expect(() => postEmi(db, { scheduleId: first.id })).toThrow(/already posted/)
    expect(() => postEmi(db, { scheduleId: detail.schedule[2]!.id })).toThrow(/first/)
  })

  it('binning the EMI voucher re-opens the instalment; reminders and the forecast see it', () => {
    const { db, detail } = withLoan()
    const first = postEmi(db, { scheduleId: detail.schedule[0]!.id })
    expect(emiReminders(db, '2026-06-01', 7).map((r) => r.dueDate)).toEqual(['2026-06-05'])
    deleteVoucher(db, first.voucherId!)
    expect(getLoan(db, detail.loan.id).schedule[0]!.posted).toBe(false)
    expect(emiReminders(db, '2026-06-01', 7).map((r) => r.dueDate)).toEqual(['2026-05-05', '2026-06-05'])
    expect(financeReminders(db, '2026-06-01').emis[0]).toMatchObject({ overdue: true })
  })

  it('a prepayment regenerates the unposted rows but never a posted one', () => {
    const { db, detail } = withLoan()
    postEmi(db, { scheduleId: detail.schedule[0]!.id })
    expect(() => addPrepayment(db, { loanId: detail.loan.id, date: '2026-05-01', amount: 10_000_00, effect: 'reduce_tenure' })).toThrow(/posted/)
    const d = addPrepayment(db, { loanId: detail.loan.id, date: '2026-05-20', amount: 30_000_00, effect: 'reduce_tenure' })
    expect(d.schedule[0]!.posted).toBe(true)
    expect(d.schedule.find((r) => r.kind === 'prepayment')).toMatchObject({ dueDate: '2026-05-20', payment: 30_000_00 })
    expect(d.schedule.length).toBeLessThan(13)
    expect(d.schedule.reduce((s, r) => s + r.principal, 0)).toBe(1_00_000_00)
    // terms of a loan with a posted instalment that would change it are refused
    expect(() => saveLoan(db, { ...loanInput(d), annualRateMilli: 10_000 }, d.loan.id)).toThrow(/already posted/)
    expect(listLoans(db, '2026-05-21')[0]!.interestThisFy).toBeGreaterThan(0)
  })
})

function loanInput(d: ReturnType<typeof getLoan>) {
  const l = d.loan
  return {
    name: l.name, loanLedgerId: l.loanLedgerId, bankLedgerId: l.bankLedgerId, interestLedgerId: l.interestLedgerId, principal: l.principal,
    annualRateMilli: l.annualRateMilli, tenureMonths: l.tenureMonths, disbursedOn: l.disbursedOn, firstDueDate: l.firstDueDate
  }
}

describe('forex revaluation and settlement', () => {
  function withUsdCustomer() {
    const c = company()
    const cust = ledger(c.db, 'Globex Inc', 'Sundry Debtors')
    // $1,000 export invoice at ₹82.
    post(c.db, 'journal', '2026-03-10', [dr(cust, 82_000_00), cr(c.sales, 82_000_00)], { partyLedgerId: cust, currencyCode: 'USD', exchangeRate: 82 })
    return { ...c, cust }
  }

  it('revalues a USD receivable at the closing rate and reverses it the next day', () => {
    const { db, cust } = withUsdCustomer()
    expect(revaluationPreview(db, '2026-03-31').blocked).toMatch(/closing rate for USD/)
    saveRate(db, { date: '2026-03-31', currencyCode: 'USD', rateMicro: 83_250_000 })
    const p = revaluationPreview(db, '2026-03-31')
    expect(p.rows).toHaveLength(1)
    expect(p.rows[0]).toMatchObject({ ledgerId: cust, currencyCode: 'USD', fcBalance: 1000_00, inrBook: 82_000_00, target: 83_250_00, gainLoss: 1_250_00 })
    expect(p).toMatchObject({ gain: 1_250_00, loss: 0, blocked: null })

    const rev = postRevaluation(db, { asOf: '2026-03-31', autoReverse: true })
    expect(rev.live).toBe(true)
    expect(rev.reversalVoucherId).not.toBeNull()
    const j = getVoucher(db, rev.voucherId!)!
    expect(j.lines.find((l) => l.ledgerId === cust)).toMatchObject({ drCr: 'dr', amount: 1_250_00 })
    expect(j.lines.find((l) => l.ledgerId === lid(db, 'Unrealised Forex Gain'))).toMatchObject({ drCr: 'cr', amount: 1_250_00 })
    expect(closingBalances(db, '2026-03-31').get(cust)).toBe(83_250_00)
    expect(closingBalances(db, '2026-04-01').get(cust)).toBe(82_000_00)
    // both journals balance: the trial balance's difference is still just the bank's opening
    const tb = trialBalance(db, '2026-04-01')
    expect(tb.totalDebit - tb.totalCredit).toBe(5_00_000_00)
    // the gain is FY 2025-26 income; the reversal lands in FY 2026-27
    expect(pnlLedgerAmounts(db, '2025-04-01', '2026-03-31').amounts.get(lid(db, 'Unrealised Forex Gain'))).toBe(-1_250_00)
    // the revaluation moved rupees only — the foreign balance is still $1,000
    expect(exposure(db, cust, '2026-03-31').fcBalance).toBe(1000_00)
    expect(revaluationPreview(db, '2026-03-31').blocked).toMatch(/Already revalued/)
    expect(closeWarnings(db, 2025)).toMatchObject({ revaluedOnFyEnd: true, unrevalued: [] })
  })

  it('without auto-reversal it reverses on demand', () => {
    const { db, cust } = withUsdCustomer()
    saveRate(db, { date: '2026-03-31', currencyCode: 'USD', rateMicro: 81_000_000 })
    const rev = postRevaluation(db, { asOf: '2026-03-31', autoReverse: false })
    expect(closingBalances(db, '2026-04-02').get(cust)).toBe(81_000_00)
    const after = reverseRevaluation(db, rev.id, '2026-04-02')
    expect(after.reversalVoucherId).not.toBeNull()
    expect(closingBalances(db, '2026-04-02').get(cust)).toBe(82_000_00)
    expect(listRevaluations(db)).toHaveLength(1)
  })

  it('settling at an actual rate books the realised gain and clears both currencies', () => {
    const { db, cust, bank } = withUsdCustomer()
    const r = settle(db, { partyLedgerId: cust, bankLedgerId: bank, date: '2026-04-15', fcAmount: 1000_00, settleRateMicro: 84_000_000 })
    expect(r).toMatchObject({ bankInr: 84_000_00, partyInr: 82_000_00, gainLoss: 2_000_00 })
    expect(getVoucher(db, r.voucherId)!.lines.find((l) => l.ledgerId === bank)).toMatchObject({ drCr: 'dr', amount: 84_000_00 })
    expect(closingBalances(db, '2026-04-15').get(cust)).toBe(0)
    expect(closingBalances(db, '2026-04-15').get(lid(db, 'Realised Forex Gain'))).toBe(-2_000_00)
    expect(exposure(db, cust, '2026-04-15')).toMatchObject({ fcBalance: 0, inrBook: 0 })
  })

  it('a designated EEFC bank account is an exposure; unrevalued balances warn at year end', () => {
    const { db, bank } = withUsdCustomer()
    const eefc = ledger(db, 'EEFC USD', 'Bank Accounts')
    setLedgerCurrency(db, eefc, 'USD')
    post(db, 'contra', '2026-03-20', [dr(eefc, 8_300_00), cr(bank, 8_300_00)], { currencyCode: 'USD', exchangeRate: 83 })
    const w = closeWarnings(db, 2025)
    expect(w.revaluedOnFyEnd).toBe(false)
    expect(w.unrevalued).toEqual([{ currencyCode: 'USD', ledgers: 2, fcBalance: 1100_00 }])
  })
})

describe('budgets vs actuals by cost centre', () => {
  it('a cost-centre line’s actual equals the cost-centre P&L, month and YTD, with drill-down', () => {
    const { db, cash } = company()
    const mumbai = saveCostCentre(db, { name: 'Mumbai', parentId: null, active: true }).id
    const pune = saveCostCentre(db, { name: 'Pune', parentId: null, active: true }).id
    const rent = ledger(db, 'Rent', 'Indirect Expenses')
    const power = ledger(db, 'Electricity', 'Indirect Expenses')
    post(db, 'payment', '2026-04-05', [dr(rent, 30_000_00, [{ costCentreId: mumbai, amount: 20_000_00 }, { costCentreId: pune, amount: 10_000_00 }]), cr(cash, 30_000_00)])
    post(db, 'payment', '2026-05-05', [dr(power, 8_000_00, [{ costCentreId: mumbai, amount: 8_000_00 }]), cr(cash, 8_000_00)])
    post(db, 'payment', '2026-05-06', [dr(rent, 30_000_00, [{ costCentreId: mumbai, amount: 25_000_00 }]), cr(cash, 30_000_00)])
    const b = saveBudget(db, {
      name: 'Opex 26-27', fyStartYear: 2026,
      lines: [
        { ledgerId: null, groupId: gid(db, 'Indirect Expenses'), month: null, amount: 3_00_000_00, costCentreId: mumbai, phasing: 'even' },
        { ledgerId: rent, groupId: null, month: null, amount: 3_60_000_00, phasing: 'seasonal' },
        { ledgerId: null, groupId: gid(db, 'Indirect Expenses'), month: null, amount: 1_20_000_00, costCentreId: pune, phasing: 'annual' }
      ],
      seasonal: [2, 2, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0]
    })
    const rep = budgetMonthlyReport(db, b.id, '2026-05')
    const [mum, rentLine, pun] = rep.rows
    const cc = ccReport(db, '2026-04-01', '2026-05-31')
    expect(mum!.ytd.actual).toBe(cc.find((r) => r.costCentreId === mumbai)!.expense)
    expect(pun!.ytd.actual).toBe(cc.find((r) => r.costCentreId === pune)!.expense)
    expect(mum!.current).toMatchObject({ budget: 25_000_00, actual: 33_000_00, favourable: false })
    expect(mum!.ytd).toMatchObject({ budget: 50_000_00, actual: 53_000_00, pct: 106 })
    // whole-ledger line ties to the P&L ledger amount
    expect(rentLine!.ytd.actual).toBe(pnlLedgerAmounts(db, '2026-04-01', '2026-05-31').amounts.get(rent))
    expect(rentLine!.months[0]!.budget).toBe(60_000_00) // weight 2 of 12
    expect(pun!.current.budget).toBeNull()
    expect(pun!.ytd.budget).toBe(1_20_000_00)
    // drill-down adds up to the actual
    const drill = budgetDrill(db, b.id, mum!.lineId, null, '2026-05')
    expect(drill.reduce((s, r) => s + r.amount, 0)).toBe(mum!.ytd.actual)
    expect(budgetDrill(db, b.id, mum!.lineId, '2026-05', '2026-05').reduce((s, r) => s + r.amount, 0)).toBe(33_000_00)
    // dashboard chip: over budget in May
    expect(overBudgetThisMonth(db, '2026-05-20').rows.map((r) => r.targetName)).toContain('Indirect Expenses')
  })

  it('records revisions and round-trips through CSV', () => {
    const { db } = company()
    const rent = ledger(db, 'Rent', 'Indirect Expenses')
    const b = saveBudget(db, { name: 'B', fyStartYear: 2026, lines: [{ ledgerId: rent, groupId: null, month: null, amount: 1_20_000_00, phasing: 'even' }] })
    expect(budgetRevisions(db, b.id)).toEqual([])
    const monthly = [10_000_00, 10_000_00, 10_000_00, 10_000_00, 10_000_00, 10_000_00, 10_000_00, 10_000_00, 10_000_00, 10_000_00, 10_000_00, 20_000_00]
    saveBudget(db, { name: 'B', fyStartYear: 2026, lines: [{ ledgerId: rent, groupId: null, month: null, amount: 1_30_000_00, phasing: 'manual', monthly }], reason: 'Rent hike in March' }, b.id)
    const revs = budgetRevisions(db, b.id)
    expect(revs).toHaveLength(1)
    expect(revs[0]).toMatchObject({ revisionNo: 1, reason: 'Rent hike in March', totalBefore: 1_20_000_00, totalAfter: 1_30_000_00 })
    const csv = budgetCsv(db, b.id)
    expect(csv).toContain('Ledger,Rent,,manual,,130000.00,10000.00')
    const bad = importBudgetCsv(db, b.id, csv.replace('Rent', 'Nope'), null)
    expect(bad.errors[0]).toMatch(/no ledger named/)
    const ok = importBudgetCsv(db, b.id, csv, null)
    expect(ok).toEqual({ lines: 1, errors: [] })
    expect(budgetRevisions(db, b.id)[0]).toMatchObject({ revisionNo: 2, reason: 'CSV import' })
    const rep = budgetMonthlyReport(db, b.id, '2027-03')
    expect(rep.rows[0]!.current.budget).toBe(20_000_00)
  })
})
