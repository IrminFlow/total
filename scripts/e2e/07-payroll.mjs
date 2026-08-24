// Scenario 07 — payroll preview-parity: payroll:preview for a month must agree line-for-line
// with what payroll:commit then writes (same employees, same net pay), and the committed run
// posts a balanced voucher.
//
// RECONCILE: lane S4 moves the renderer preview to the server (payroll:preview) — once merged,
// assert the Payroll screen's preview table shows these same figures.
import { scenario, assert, assertEq } from '../lib/harness.mjs'

await scenario('07-payroll', async (h) => {
  await h.createDemoCompany()

  const asha = await h.invoke('payroll:employees:save', {
    data: {
      name: 'Asha Kulkarni', code: 'E001', designation: 'Accountant', joined: null,
      pan: 'ABCPK1234F', uan: '100200300400', esicNo: null,
      bankAccount: '5011223344', bankIfsc: 'HDFC0001234', department: 'Operations', exitDate: null,
      basic: 3000000, hra: 1200000, special: 600000,
      pfEnabled: true, esiEnabled: true, ptEnabled: true, active: true
    }
  })
  const ravi = await h.invoke('payroll:employees:save', {
    data: {
      name: 'Ravi Iyer', code: 'E002', designation: 'Sales', joined: null,
      pan: null, uan: null, esicNo: null,
      bankAccount: '5011223355', bankIfsc: 'HDFC0001234', department: 'Sales', exitDate: null,
      basic: 1200000, hra: 400000, special: 200000,
      pfEnabled: true, esiEnabled: true, ptEnabled: true, active: true
    }
  })

  const month = new Date().toISOString().slice(0, 7)
  const shift = await h.invoke('payroll:shifts:save', { data: { name: 'General 8h', workMinutes: 480, weeklyOffDay: 0, overtimeAfterMinutes: 480, overtimeRateBps: 15000, active: true } })
  await h.invoke('payroll:shifts:assign', { employeeId: asha.id, shiftRuleId: shift.id, effectiveFrom: `${month}-01` })
  await h.invoke('payroll:holidays:save', { date: `${month}-15`, name: 'Independence Day', department: '' })
  for (const employee of [asha, ravi]) {
    await h.invoke('payroll:attendance:save', {
      employeeId: employee.id, month, payableDays: 30, presentDays: 29,
      leaveDays: 1, unpaidDays: 0, overtimeMinutes: employee.id === asha.id ? 120 : 0,
      status: 'review', note: null
    })
  }
  await h.invoke('payroll:attendance:approveMonth', { month })
  const attendance = await h.invoke('payroll:attendance:list', { month })
  assertEq(attendance.filter((row) => row.status === 'approved').length, 2, 'attendance approved for both employees')
  const preview = await h.invoke('payroll:preview', { month, days: [] })
  assertEq(preview.length, 2, 'preview covers both employees')
  for (const line of preview) {
    assert(Number.isInteger(line.net) && line.net > 0, `${line.employeeName ?? line.name}: net pay is positive integer paise`)
  }
  const previewNet = preview.reduce((s, l) => s + l.net, 0)
  const previewGross = preview.reduce((s, l) => s + l.gross, 0)

  const run = await h.invoke('payroll:commit', { month, days: [] })
  assert(typeof run.voucherId === 'number', 'commit posted a voucher')
  assertEq(run.lines.length, preview.length, 'commit wrote one line per previewed employee')
  const commitNet = run.lines.reduce((s, l) => s + l.net, 0)
  const commitGross = run.lines.reduce((s, l) => s + l.gross, 0)
  assertEq(commitNet, previewNet, 'preview/commit net parity')
  assertEq(commitGross, previewGross, 'preview/commit gross parity')

  // The books still tie with the salary voucher in.
  const today = new Date().toISOString().slice(0, 10)
  const tb = await h.invoke('report:trialBalance', { asOn: today })
  assertEq(tb.totalDebit, tb.totalCredit, 'TB ties after payroll commit')

  const runs = await h.invoke('payroll:runs')
  assert(runs.some((r) => r.month === month), 'run listed for the month')
  await h.invoke('payroll:lockRun', { id: run.id })
  const pack = await h.invoke('payroll:payslipPack', { runId: run.id })
  assertEq(pack.files.length, 3, 'delivery pack contains two PDFs and a manifest')
  const statutory = await h.invoke('payroll:statutory:workspace', { month })
  const pfDue = statutory.find((row) => row.kind === 'pf')
  await h.invoke('payroll:statutory:save', { month, kind: 'pf', amount: pfDue.booksAmount, paidDate: today, reference: 'CP-2026-0815', status: 'filed', filedReference: 'ECR-ACK-0815' })
  const joinersCsv = `employee_code,name,effective_date,department,designation,basic,hra,special,pt_state\nE900,Meera Rao,${month}-20,Support,Associate,25000,10000,2500,MH`
  const provisioningPreview = await h.invoke('payroll:provisioning:preview', { kind: 'joiners', sourceName: 'joiners.csv', csvText: joinersCsv })
  assertEq(provisioningPreview.validCount, 1, 'joiner batch previews one valid employee')

  const leaveType = await h.invoke('payroll:leaveTypes:save', { data: { name: 'Earned leave', annualAccrualMilli: 18000, carryForwardLimitMilli: 45000, encashable: true, paid: true, active: true } })
  await h.invoke('payroll:leave:record', { employeeId: asha.id, leaveTypeId: leaveType.id, date: today, qtyMilli: 18000, kind: 'accrual', status: 'approved', note: 'Opening entitlement' })
  await h.invoke('payroll:leave:record', { employeeId: asha.id, leaveTypeId: leaveType.id, date: today, qtyMilli: 1000, kind: 'taken', status: 'requested', note: 'Family appointment' })
  await h.invoke('payroll:salaryRevisions:save', { employeeId: ravi.id, effectiveFrom: today, reason: 'Annual compensation review', status: 'approved', heads: [
    { name: 'Basic', kind: 'earning', calc: 'flat', value: 1400000 },
    { name: 'HRA', kind: 'earning', calc: 'flat', value: 500000 },
    { name: 'Special Allowance', kind: 'earning', calc: 'flat', value: 200000 }
  ] })
  await h.invoke('payroll:loans:create', { employeeId: asha.id, disbursedDate: today, principal: 1000000, annualInterestBps: 900, installmentAmount: 110000, firstDeductionMonth: month, note: 'Relocation advance' })
  const claim = await h.invoke('payroll:reimbursements:submit', { employeeId: ravi.id, claimDate: today, category: 'Travel', amount: 125000, taxable: false, description: 'Client-site taxi', attachmentPath: '/evidence/taxi.pdf' })
  await h.invoke('payroll:reimbursements:decide', { id: claim.id, decision: 'approved' })
  const sections = await h.invoke('tds:sections')
  const contractor = await h.invoke('payroll:contractors:save', { data: { name: 'Build Right Services', pan: 'ABCDE1234F', bankAccount: '50123456789', bankIfsc: 'HDFC0001234', tdsSectionId: sections.find((row) => row.code === '194C').id, active: true } })
  const bankLedgers = await h.invoke('bank:ledgers')
  await h.invoke('payroll:contractors:postPayment', { contractorId: contractor.id, periodFrom: `${month}-01`, periodTo: today, date: today, gross: 4000000, bankLedgerId: bankLedgers[0].id, note: 'Site supervision' })

  await h.goto('payroll')
  await h.page.getByRole('button', { name: 'Attendance' }).click()
  await h.page.getByText('READY', { exact: true }).waitFor()
  await h.shot('01-payroll-attendance')
  await h.page.getByRole('button', { name: 'Leave & salary' }).click()
  await h.page.getByText('WORKFORCE LEDGER', { exact: true }).waitFor()
  await h.shot('02-payroll-workforce')
  await h.page.getByRole('button', { name: 'Final settlement' }).click()
  await h.page.getByText('NET SETTLEMENT', { exact: true }).waitFor()
  await h.shot('02b-payroll-final-settlement')
  await h.page.keyboard.press('Escape')
  await h.page.getByRole('button', { name: 'Claims' }).click()
  await h.page.getByText('CLAIM CONTROL', { exact: true }).waitFor()
  await h.page.getByText('Client-site taxi', { exact: false }).waitFor()
  await h.shot('03-payroll-claims')
  await h.page.getByRole('button', { name: 'Contractors' }).click()
  await h.page.getByText('NON-PAYROLL PAYEES', { exact: true }).waitFor()
  await h.page.getByText('Build Right Services', { exact: true }).first().waitFor()
  await h.shot('04-payroll-contractors')
  await h.page.getByRole('button', { name: 'Controls' }).click()
  await h.page.getByText('PAYROLL CONTROL ROOM', { exact: true }).waitFor()
  await h.page.getByText('ECR-ACK-0815', { exact: false }).waitFor()
  await h.shot('05-payroll-statutory')
  await h.page.getByRole('button', { name: 'Shifts & calendar' }).click()
  await h.page.getByText('General 8h', { exact: true }).first().waitFor()
  await h.shot('06-payroll-shifts')
  await h.page.getByRole('button', { name: 'Departments' }).click()
  await h.page.getByText('Operations', { exact: true }).first().waitFor()
  await h.shot('07-payroll-departments')
  await h.page.getByRole('button', { name: 'Provisioning' }).click()
  await h.page.getByText('Import new employees', { exact: true }).waitFor()
  await h.shot('08-payroll-provisioning')
  await h.invoke('payroll:provisioning:apply', { kind: 'joiners', sourceName: 'joiners.csv', csvText: joinersCsv })
  await h.page.getByRole('button', { name: 'Pay runs' }).click()
  await h.shot('01-payroll')
})
