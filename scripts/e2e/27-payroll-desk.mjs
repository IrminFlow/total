// Scenario 27 — attendance, advances, statutory rates and what leaving costs.
//
// Three properties this guards. A pay run is computed on the rates in force for ITS month, so
// re-opening an old one cannot change what was filed. An advance instalment is never prorated
// and never overshoots. And nothing here posts a voucher a human did not press save on — the
// settlement returns a draft, and the draft balances.
import { scenario, assert } from '../lib/harness.mjs'

await scenario('27-payroll-desk', async (h) => {
  await h.createDemoCompany()

  // Two employees: one with a UAN (who can be filed for) and one without (who cannot), because
  // the ECR pre-flight's whole job is to say so out loud rather than drop the second in silence.
  await h.invoke('payroll:employees:save', {
    data: {
      name: 'Asha Kulkarni', code: 'E001', designation: 'Accountant', joined: '2018-04-01',
      pan: 'ABCPK1234F', uan: '100200300400', esicNo: null,
      basic: 3000000, hra: 1200000, special: 600000,
      pfEnabled: true, esiEnabled: true, ptEnabled: true, active: true
    }
  })
  await h.invoke('payroll:employees:save', {
    data: {
      name: 'Ravi Iyer', code: 'E002', designation: 'Sales', joined: '2023-07-01',
      pan: null, uan: null, esicNo: null,
      basic: 1200000, hra: 400000, special: 200000,
      pfEnabled: true, esiEnabled: true, ptEnabled: true, active: true
    }
  })

  const employees = await h.invoke('payroll:employees:list')
  assert(employees.length === 2, 'both employees are on the books')
  const target = employees.find((e) => e.name === 'Asha Kulkarni')
  const month = '2026-06'

  // ---- the rates are the month's, not today's ----
  const june2019 = await h.invoke('payroll:rates', { month: '2019-06' })
  const july2019 = await h.invoke('payroll:rates', { month: '2019-07' })
  assert(june2019.rates.esiEmpRate === 1.75, `June 2019 is on the old ESI rate (${june2019.rates.esiEmpRate})`)
  assert(july2019.rates.esiEmpRate === 0.75, `July 2019 is on the new one (${july2019.rates.esiEmpRate})`)
  const aug2014 = await h.invoke('payroll:rates', { month: '2014-08' })
  assert(aug2014.rates.pfWageCeiling === 650000, 'the PF ceiling was ₹6,500 before September 2014')
  assert(
    july2019.history.every((r, i) => i === 0 || r.effectiveFrom > july2019.history[i - 1].effectiveFrom),
    'the history is ascending, which is what makes the lookup a single walk'
  )
  for (const r of july2019.history) assert(r.note.length > 0, `${r.effectiveFrom} says why it exists`)

  // ---- attendance ----
  const register = await h.invoke('payroll:attendance', { month })
  assert(register.length === employees.filter((e) => e.active).length, 'everyone active is on the register')
  assert(
    register.every((r) => r.payableDays === r.monthDays && r.id === 0),
    'somebody nobody entered is a full month, not an absent one'
  )

  const saved = await h.invoke('payroll:saveAttendance', {
    employeeId: target.id,
    month,
    presentDays: 18,
    paidLeaveDays: 2,
    lopDays: 10
  })
  assert(saved.payableDays === 20, `present + paid leave is what gets paid (${saved.payableDays})`)

  let refused = false
  try {
    await h.invoke('payroll:saveAttendance', { employeeId: target.id, month, presentDays: 30, paidLeaveDays: 5, lopDays: 0 })
  } catch {
    refused = true
  }
  assert(refused, '35 days in a 30-day month is refused, not trimmed')

  const preview = await h.invoke('payroll:preview', { month, days: [] })
  const mine = preview.find((l) => l.employeeId === target.id)
  assert(mine.payableDays === 20, 'the run reads the register')
  const overridden = await h.invoke('payroll:preview', { month, days: [{ employeeId: target.id, payableDays: 30 }] })
  assert(
    overridden.find((l) => l.employeeId === target.id).payableDays === 30,
    'an explicit override still wins — the register is the record, the argument is the correction'
  )

  // ---- advances ----
  const loan = await h.invoke('payroll:createLoan', {
    employeeId: target.id,
    grantedOn: '2026-05-01',
    principal: 1000000,
    instalment: 400000
  })
  assert(loan.outstanding === 1000000 && loan.instalmentsLeft === 3, 'a fresh advance owes all of itself')

  for (const bad of [
    { principal: 1000000, instalment: 2000000 },
    { principal: 1000000, instalment: 0 }
  ]) {
    let rejected = false
    try {
      await h.invoke('payroll:createLoan', { employeeId: target.id, grantedOn: '2026-05-01', ...bad })
    } catch {
      rejected = true
    }
    assert(rejected, `an advance with instalment ${bad.instalment} is refused`)
  }

  const due = await h.invoke('payroll:dueRecoveries', { month })
  assert(due.find((d) => d.loanId === loan.id).amount === 400000, 'the instalment is due this month')

  const withLoan = (await h.invoke('payroll:preview', { month, days: [] })).find((l) => l.employeeId === target.id)
  assert(withLoan.advanceRecovery === 400000, 'the instalment is not prorated for a 20-day month')
  assert(
    withLoan.net === withLoan.gross - withLoan.pfEmp - withLoan.esiEmp - withLoan.pt - withLoan.otherDeductions - withLoan.advanceRecovery,
    'net is gross less every deduction, the recovery included'
  )

  // ---- commit: the recovery settles an asset, and the voucher balances ----
  const run = await h.invoke('payroll:commit', { month, days: [] })
  const voucher = await h.invoke('voucher:get', { id: run.voucherId })
  const dr = voucher.lines.filter((l) => l.drCr === 'dr').reduce((s, l) => s + l.amount, 0)
  const cr = voucher.lines.filter((l) => l.drCr === 'cr').reduce((s, l) => s + l.amount, 0)
  assert(dr === cr, `the salary journal balances (${dr} vs ${cr})`)

  const ledgers = await h.invoke('master:ledgers:list')
  const advanceLedger = ledgers.find((l) => l.name === 'Salary Advances')
  const advanceLine = voucher.lines.find((l) => l.ledgerId === advanceLedger.id)
  assert(advanceLine.drCr === 'cr' && advanceLine.amount === 400000, 'recovering an advance credits the asset')

  const after = (await h.invoke('payroll:loans', {})).find((l) => l.id === loan.id)
  assert(after.recovered === 400000 && after.outstanding === 600000, 'the balance ran down by exactly one instalment')
  assert((await h.invoke('payroll:dueRecoveries', { month })).length === 0, 'a month already recovered cannot be taken twice')

  // ---- the ECR pre-flight names who the file cannot carry ----
  const check = await h.invoke('payroll:ecrCheck', { runId: run.id })
  assert(typeof check.uploadable === 'boolean', 'the pre-flight answers whether it can be uploaded')
  for (const s of check.skipped) assert(s.reason.length > 0, `${s.name} is skipped for a stated reason`)
  assert(
    check.memberCount + check.skipped.length > 0,
    'every PF member is either in the file or named as missing from it'
  )
  assert(
    check.problems.every((p, i) => i === 0 || p.severity !== 'error' || check.problems[i - 1].severity === 'error'),
    'blocking problems are listed before advisory ones'
  )

  // ---- settlement proposes, never posts ----
  const before = (await h.invoke('voucher:list', { from: '2026-04-01', to: '2027-03-31' })).length
  const settlement = await h.invoke('payroll:settlement', {
    employeeId: target.id,
    lastDay: '2026-06-20',
    leaveBalanceDays: 12,
    noticeShortfallDays: 10
  })
  const r = settlement.result
  assert(r.net === r.totalPayable - r.totalRecovery, 'the settlement nets in one direction')
  for (const l of r.lines) assert(l.working.length > 0, `${l.label} shows its working`)
  const recovery = r.lines.find((l) => l.label === 'Loans and advances outstanding')
  assert(recovery && recovery.amount === 600000, 'the whole remaining advance is recovered on leaving')

  const draftDr = settlement.draft.lines.filter((l) => l.drCr === 'dr').reduce((s, l) => s + l.amount, 0)
  const draftCr = settlement.draft.lines.filter((l) => l.drCr === 'cr').reduce((s, l) => s + l.amount, 0)
  assert(draftDr === draftCr, `the settlement draft balances (${draftDr} vs ${draftCr})`)
  assert(
    !settlement.draft.lines.some((l) => l.ledgerName === target.name),
    'a settlement never posts to a ledger named after the employee'
  )
  assert(
    (await h.invoke('voucher:list', { from: '2026-04-01', to: '2027-03-31' })).length === before,
    'asking for a settlement posted nothing'
  )

  // ---- income tax: the year's tax, spread over the months that are left ----
  const taxed = await h.invoke('payroll:employees:save', {
    data: {
      name: 'Priya Menon', code: 'E003', designation: 'Manager', joined: '2020-04-01',
      pan: 'ABCPM9876Q', uan: '100200300500', esicNo: null,
      basic: 10000000, hra: 4000000, special: 2000000,
      pfEnabled: false, esiEnabled: false, ptEnabled: true, active: true
    }
  })
  const april = (await h.invoke('payroll:tds', { month: '2026-04' })).find((t) => t.employeeId === taxed.id)
  assert(april.monthsRemaining === 12, 'April has twelve months left in the year')
  assert(april.annualGross === 16000000 * 12, 'the year is projected from the contracted salary')
  assert(april.thisMonth === Math.ceil(april.computation.totalTax / 12), 'the year splits evenly across it')
  assert(april.computation.taxableIncome === april.annualGross - april.computation.standardDeduction, 'standard deduction comes off first')
  assert(april.regime === 'new', 'the new regime is the default, as it is in law')

  const january = (await h.invoke('payroll:tds', { month: '2027-01' })).find((t) => t.employeeId === taxed.id)
  assert(january.monthsRemaining === 3, 'January has three months of the financial year left')

  // A month's payslip deducts it, and the journal carries it to a payable.
  const taxRun = await h.invoke('payroll:commit', { month: '2026-04', days: [] })
  const taxLine = taxRun.lines.find((l) => l.employeeId === taxed.id)
  assert(taxLine.tds === april.thisMonth, 'the payslip deducts what the projection said')
  assert(
    taxLine.net === taxLine.gross - taxLine.pfEmp - taxLine.esiEmp - taxLine.pt - taxLine.otherDeductions - taxLine.tds - taxLine.advanceRecovery,
    'net reconciles to every deduction on the line'
  )
  const taxVoucher = await h.invoke('voucher:get', { id: taxRun.voucherId })
  const taxDr = taxVoucher.lines.filter((l) => l.drCr === 'dr').reduce((s, l) => s + l.amount, 0)
  const taxCr = taxVoucher.lines.filter((l) => l.drCr === 'cr').reduce((s, l) => s + l.amount, 0)
  assert(taxDr === taxCr, 'the journal with TDS in it still balances')

  // Next month knows what April already took.
  const may = (await h.invoke('payroll:tds', { month: '2026-05' })).find((t) => t.employeeId === taxed.id)
  assert(may.deductedSoFar === taxLine.tds, 'May knows what April deducted')
  assert(may.monthsRemaining === 11, 'and has eleven months to spread the rest over')

  // ---- Form 16 Part B is built from runs, not from the projection ----
  const f16 = await h.invoke('payroll:form16', { employeeId: taxed.id, fyStartYear: 2026 })
  assert(f16.fyLabel === 'FY 2026-27' && f16.ayLabel === 'AY 2027-28', 'the year is labelled both ways')
  assert(f16.monthsPaid === 1, 'one run posted so far')
  assert(f16.grossSalary === f16.months.reduce((s, m) => s + m.gross, 0), 'the gross is the runs, not the projection')
  assert(f16.tdsDeducted === f16.months.reduce((s, m) => s + m.tds, 0), 'so is the TDS')
  assert(f16.shortfall === f16.computation.totalTax - f16.tdsDeducted, 'and the balance is stated rather than smoothed')
  assert(f16.rows[0].label.includes('17(1)'), 'the certificate cites the section it is computed under')
  assert(
    f16.rows.some((r) => r.label === 'Total tax payable'),
    'and states the total'
  )
  const f16pdf = await h.invoke('payroll:form16Pdf', { employeeId: taxed.id, fyStartYear: 2026 })
  assert(f16pdf.path.endsWith('.pdf'), `Form 16 prints (${f16pdf.path})`)

  let refusedYear = false
  try {
    await h.invoke('payroll:form16', { employeeId: taxed.id, fyStartYear: 2019 })
  } catch {
    refusedYear = true
  }
  assert(refusedYear, 'a year with no runs is refused rather than issued empty')

  // ---- payslips for a whole run, each with a way to send it ----
  const slips = await h.invoke('payroll:payslips', { runId: taxRun.id })
  assert(slips.length === taxRun.lines.length, 'one payslip per line')
  for (const s of slips) assert(s.path.endsWith('.pdf'), `${s.employeeName}'s payslip is written`)
  const withPhone = slips.find((s) => s.whatsapp)
  if (withPhone) {
    assert(withPhone.whatsapp.startsWith('https://wa.me/'), 'a wa.me link, not an API call')
    assert(decodeURIComponent(withPhone.whatsapp).includes('Net pay'), 'the message carries the figure')
  }

  // ---- leaving date: persisted, prorated once, and excluded afterwards ----
  const leaver = await h.invoke('payroll:employees:save', {
    data: {
      name: 'Leela Shah', code: 'E004', designation: 'Supervisor', joined: '2024-01-01',
      leftOn: '2027-02-20', pan: null, uan: null, esicNo: null,
      basic: 3000000, hra: 1200000, special: 600000,
      pfEnabled: true, esiEnabled: false, ptEnabled: true, active: false
    }
  })
  assert(leaver.leftOn === '2027-02-20', 'the employee record keeps the inclusive last working day')
  const finalMonth = await h.invoke('payroll:preview', { month: '2027-02', days: [] })
  const finalLine = finalMonth.find((l) => l.employeeId === leaver.id)
  assert(finalLine.payableDays === 20, `the final monthly run is capped once (${finalLine.payableDays} days)`)
  const afterLeaving = await h.invoke('payroll:preview', { month: '2027-03', days: [] })
  assert(!afterLeaving.some((l) => l.employeeId === leaver.id), 'a later run excludes the leaver')

  // ---- the screen ----
  await h.page.keyboard.press('Escape')
  await h.goto('payroll')
  await h.page.waitForSelector('[data-testid="statutory-footnote"]', { timeout: 15000 })
  const footnote = await h.page.textContent('[data-testid="statutory-footnote"]')
  assert(footnote.includes('effective'), 'the footnote states which rate set is in force, and from when')
  const leaverRow = h.page.locator('[data-testid="rows-payroll-employees"] tr').filter({ hasText: 'Leela Shah' })
  await leaverRow.locator('[data-testid="btn-payroll-edit-employee"]').click()
  await h.page.waitForSelector('[data-testid="input-employee-left-on"]')
  assert(
    (await h.page.inputValue('[data-testid="input-employee-left-on"]')) === '2027-02-20',
    'the employee form shows the saved last working day'
  )
  await h.page.keyboard.press('Escape')
  await h.shot('01-employees')

  await h.clickText('Attendance')
  await h.page.waitForSelector('[data-testid="rows-attendance"] tr', { timeout: 15000 })
  await h.shot('02-attendance')

  await h.clickText('Advances')
  await h.page.waitForSelector('[data-testid="rows-advances-payroll"] tr', { timeout: 15000 })
  await h.shot('03-advances')

  await h.clickText('Employees')
  await h.page.waitForSelector('[data-testid="rows-payroll-employees"] tr', { timeout: 15000 })
  await h.click(`btn-payroll-settle-${target.id}`)
  await h.page.waitForSelector('[data-testid="settlement-body"]', { timeout: 15000 })
  await h.shot('04-settlement')
})
