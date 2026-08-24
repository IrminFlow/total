// Scenario 07 — payroll preview-parity: payroll:preview for a month must agree line-for-line
// with what payroll:commit then writes (same employees, same net pay), and the committed run
// posts a balanced voucher.
//
// RECONCILE: lane S4 moves the renderer preview to the server (payroll:preview) — once merged,
// assert the Payroll screen's preview table shows these same figures.
import { scenario, assert, assertEq } from '../lib/harness.mjs'

await scenario('07-payroll', async (h) => {
  await h.createDemoCompany()

  await h.invoke('payroll:employees:save', {
    data: {
      name: 'Asha Kulkarni', code: 'E001', designation: 'Accountant', joined: null,
      pan: 'ABCPK1234F', uan: '100200300400', esicNo: null,
      basic: 3000000, hra: 1200000, special: 600000,
      pfEnabled: true, esiEnabled: true, ptEnabled: true, active: true
    }
  })
  await h.invoke('payroll:employees:save', {
    data: {
      name: 'Ravi Iyer', code: 'E002', designation: 'Sales', joined: null,
      pan: null, uan: null, esicNo: null,
      basic: 1200000, hra: 400000, special: 200000,
      pfEnabled: true, esiEnabled: true, ptEnabled: true, active: true
    }
  })

  const month = new Date().toISOString().slice(0, 7)
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

  await h.goto('payroll')
  await h.shot('01-payroll')

  // ---- what payroll cost over time ----
  // Payroll is usually the largest single expense a small business has and the one it looks at
  // least. Employer cost, not gross, is the figure: gross understates what actually left the
  // business by roughly a seventh once the employer's own PF and ESI are counted.
  const trend = await h.invoke('payroll:trend', {})
  assert(trend.length > 0, 'the committed run appears in the trend')
  for (const point of trend) {
    assert(
      point.employerCost === point.gross + point.employerContributions,
      `${point.month}: employer cost is gross plus the employer's own contributions`
    )
    assert(
      point.net === point.gross - point.employeeDeductions,
      `${point.month}: net is gross less what was withheld from the employee`
    )
    assert(point.employerCost > point.gross, `${point.month}: and it exceeds gross`)
    assert(point.headcount > 0, `${point.month}: someone was paid`)
    assert(
      point.costPerHead === Math.round(point.employerCost / point.headcount),
      `${point.month}: per-head is the cost divided by the people`
    )
  }

  await h.goto('payroll')
  await h.page.click('[data-testid="tab-payroll-trend"]')
  await h.page.waitForSelector('[data-testid="rows-payroll-trend"] tr', { timeout: 15000 })
  const shown = await h.page.$$eval('[data-testid="rows-payroll-trend"] tr', (els) => els.length)
  assert(shown === trend.length, `every month is on screen (${shown} of ${trend.length})`)
  await h.shot('04-payroll-trend')

  // ---- the bulk salary transfer file ----
  // Paying salaries one transfer at a time is how a business with fifteen people spends an hour
  // a month typing account numbers, and how one of them eventually goes to the wrong account.
  const employees = await h.invoke('payroll:employees:list')
  assert(employees.length > 0, 'the run has employees')

  // Before any bank details exist, nobody can be in the file — and everyone is NAMED rather than
  // silently dropped, because a file that omits someone is how a person does not get paid.
  const allRuns = await h.invoke('payroll:runs')
  const runId = allRuns[0].id
  const empty = await h.invoke('payroll:transferFile', { runId })
  assert(empty.count === 0, 'nobody is in the file without bank details')
  assert(empty.skipped.length > 0, 'and everyone left out is named')
  assert(/bank account|IFSC|nothing payable/.test(empty.skipped[0].reason), 'with a reason')

  // Give one employee bank details and the file picks exactly them up.
  const first = employees[0]
  await h.invoke('payroll:employees:save', {
    data: { ...first, bankAccount: '12345678901', ifsc: 'HDFC0001234' },
    id: first.id
  })
  const filled = await h.invoke('payroll:transferFile', { runId })
  assert(filled.count === 1, `one payable employee is in the file (got ${filled.count})`)
  assert(filled.totalPaise > 0, 'and the total is what will move')
  assert(filled.skipped.length === empty.skipped.length - 1, 'one fewer skipped')

  // A malformed IFSC is refused at save rather than written into a file the bank rejects.
  let rejected = false
  try {
    await h.invoke('payroll:employees:save', {
      data: { ...first, bankAccount: '12345678901', ifsc: 'NOTANIFSC' },
      id: first.id
    })
  } catch {
    rejected = true
  }
  assert(rejected, 'a malformed IFSC is refused')
})
