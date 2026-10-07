// Scenario 27 — payroll statutory (WP 3.7), driven through the UI: an employee is set up with PF,
// ESI (IP number), professional tax (Maharashtra) and the new tax regime in the employee form, a
// second (higher-paid) one with tax declarations; the month is posted from Pay runs (preview shows
// TDS and the employer share, the TDS workings open); the Statutory tab lists PF / ESI / PT / TDS
// payable with due dates; the PF ECR export is checked line by line; PF is paid through Pay… (a
// Payment voucher) and flips to Paid; the TDS screen's Returns tab shows the salary TDS in Form 24Q
// and not in 26Q; the rates tab shows the citations. Every view is shot in both themes. Set
// WP37_SHOTS=/tmp/wp37 to also copy the screenshots there.
import fs from 'node:fs'
import path from 'node:path'
import { scenario, assert, assertEq } from '../lib/harness.mjs'

await scenario('27-payroll-statutory', async (h) => {
  await h.createCompanyUI('Statutory Works')
  const page = h.page
  await h.stubDialogs({})
  const extraShots = process.env.WP37_SHOTS
  const shot = async (name) => {
    await page.mouse.move(0, 0)
    await page.waitForTimeout(200)
    await h.shot(name)
    if (extraShots) {
      fs.mkdirSync(extraShots, { recursive: true })
      fs.copyFileSync(path.join(h.outDir, `${name}.png`), path.join(extraShots, `${name}.png`))
    }
  }
  const setTheme = async (theme) => {
    const now = await page.evaluate(() => document.documentElement.dataset.theme ?? 'light')
    // A DOM click: the toggle sits under an open modal's scrim for the dialog shots.
    if (now !== theme) await page.evaluate(() => document.querySelector('[data-testid="btn-theme"]').click())
    await page.waitForFunction((t) => (document.documentElement.dataset.theme ?? 'light') === t, theme)
    await page.waitForTimeout(400)
  }
  const bothThemes = async (name) => {
    await setTheme('light')
    await shot(`${name}-light`)
    await setTheme('dark')
    await shot(`${name}-dark`)
    await setTheme('light')
  }
  const tab = async (id) => {
    await h.click(`tab-payroll-${id}`)
    await h.waitIdle()
    await page.evaluate(() => document.querySelectorAll('main').forEach((el) => el.scrollTo(0, 0)))
    await page.waitForTimeout(250)
  }
  const dialog = () => page.locator('[role="dialog"]').last()

  // A bank account to pay the dues from.
  const groups = await h.invoke('master:groups:list')
  const gid = (name) => groups.find((g) => g.name === name).id
  await h.invoke('master:ledgers:create', {
    name: 'HDFC Current', groupId: gid('Bank Accounts'), openingBalance: 0, gstin: null, stateCode: null, address: null, taxType: null, gstRate: null, hsn: null
  })

  // ---------- employee 1 (via IPC; declarations through the UI below): TDS territory ----------
  await h.invoke('payroll:employees:save', {
    data: {
      name: 'Anil Mehta', code: 'E001', designation: 'Finance manager', joined: null, pan: 'ABCPM1234K', uan: '100100100100', esicNo: null,
      basic: 15_000_000, hra: 6_000_000, special: 9_000_000, pfEnabled: true, esiEnabled: true, ptEnabled: true, ptState: 'MH', active: true,
      taxRegime: 'old', metro: true, gender: 'male'
    }
  })
  // ---------- employee 2 through the form: PF + ESI + PT (MH) ----------
  await h.goto('payroll')
  await h.click('btn-payroll-add-employee')
  const d = dialog()
  await d.getByLabel('Name', { exact: true }).fill('Bina Rao')
  await d.getByLabel('Designation').fill('Accounts clerk')
  await d.getByLabel('Employee code').fill('E002')
  await d.getByLabel('PAN').fill('ABCPR5678L')
  await d.getByLabel('UAN').fill('100100100200')
  await d.getByLabel('Basic / month').fill('12000')
  await d.getByLabel('HRA / month').fill('4000')
  await d.getByLabel('Special / month').fill('2000')
  await h.fill('input-employee-esic', '3100123456')
  await page.selectOption('[data-testid="input-employee-pt-state"]', 'MH')
  await page.selectOption('[data-testid="input-employee-gender"]', 'female')
  await shot('27-01-employee-form')
  await h.click('btn-payroll-save-employee')
  
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="rows-payroll-employees"] tr.dt-row').length === 2)
  await bothThemes('27-02-employees')
  const anilRow = page.locator('[data-testid="rows-payroll-employees"] tr.dt-row', { hasText: 'Anil Mehta' })
  await anilRow.locator('[data-testid="btn-payroll-declarations"]').click()
  await h.fill('input-decl-80C', '150000')
  await h.fill('input-decl-RENT', '480000')
  await h.fill('input-decl-80D', '25000')
  await bothThemes('27-03-declarations')
  await h.click('btn-payroll-save-declarations')
  await page.waitForSelector('[data-testid="payroll-declarations"]', { state: 'detached' })

  // ---------- post the month from Pay runs ----------
  await tab('runs')
  const month = await page.$eval('[data-testid="payroll-month"]', (el) => el.value)
  await page.waitForSelector('[data-testid="btn-payroll-tds-workings"]', { timeout: 10000 })
  const preview = await h.invoke('payroll:preview', { month, days: [] })
  const anil = preview.find((l) => l.employeeName === 'Anil Mehta')
  const bina = preview.find((l) => l.employeeName === 'Bina Rao')
  assert(anil.tds > 0, `Anil has salary TDS in the preview (${anil.tds})`)
  assert(bina.esiEmp > 0 && bina.esiCovered, 'Bina is ESI-covered')
  assert(bina.pt === 0, 'Bina: Maharashtra women up to ₹25,000 pay no PT')
  assert(anil.pt > 0, 'Anil pays Maharashtra PT')
  await bothThemes('27-04-run-preview')
  await page.locator('[data-testid="btn-payroll-tds-workings"]').first().click()
  await page.waitForSelector('[data-testid="payroll-tds-workings"]')
  await bothThemes('27-05-tds-workings')
  await page.keyboard.press('Escape')
  await h.click('btn-payroll-post-run')
  await page.waitForSelector('[data-testid="rows-payroll-runs"] tr.dt-row', { timeout: 15000 })
  const runs = await h.invoke('payroll:runs')
  const run = runs.find((r) => r.month === month)
  assert(run?.voucherId, 'the run posted a voucher')
  const lastDay = `${month}-${String(new Date(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0).getDate()).padStart(2, '0')}`
  const tb = await h.invoke('report:trialBalance', { asOn: lastDay })
  assertEq(tb.totalDebit, tb.totalCredit, 'TB ties after the statutory pay run')

  // ---------- the Statutory tab: dues by month ----------
  await tab('statutory')
  await page.waitForSelector(`[data-testid="due-status-pf:${month}"]`, { timeout: 10000 })
  for (const k of [`pf:${month}`, `esi:${month}`, `pt:${month}:MH`, `tds:${month}`]) {
    assert(await page.$(`[data-row-id="${k}"]`), `dues row ${k}`)
  }
  const dues = await h.invoke('payroll:dues', { fyStartYear: Number(month.slice(5, 7)) >= 4 ? Number(month.slice(0, 4)) : Number(month.slice(0, 4)) - 1 })
  await page.evaluate(() => document.querySelectorAll('main, [data-screen]').forEach((el) => el.scrollTo(0, 0)))
  const pfDue = dues.find((x) => x.key === `pf:${month}`)
  assertEq(pfDue.payablePaise, preview.reduce((s, l) => s + l.pfEmp + l.vpf + l.pfEr + l.pfAdmin + l.edli, 0) + run.pfAdminTopUp, 'PF due = employee + employer + charges')
  await bothThemes('27-06-statutory')

  // ECR export: one line per member, whole rupees, #~# separated.
  const ecr = await h.invoke('payroll:ecr', { runId: run.id })
  const ecrText = fs.readFileSync(ecr.path, 'utf8').split('\n')
  assertEq(ecrText.length, 2, 'ECR has a line per PF member')
  const binaLine = ecrText.find((l) => l.startsWith('100100100200#~#BINA RAO#~#'))
  assert(binaLine, `ECR line for Bina: ${ecrText.join(' | ')}`)
  const f = binaLine.split('#~#')
  assertEq(f.length, 11, 'ECR line has the 11 ECR 2.0 fields')
  assertEq(Number(f[6]), Math.round(bina.pfEmp / 100), 'EPF contribution remitted')
  assertEq(Number(f[7]), Math.round(bina.epsEr / 100), 'EPS contribution remitted')
  await h.click(`btn-due-export-pf:${month}`)
  await page.waitForTimeout(300)

  // Pay the PF through the UI.
  await h.click(`btn-due-pay-pf:${month}`)
  await h.fill('input-due-reference', 'TRRN 2610071234')
  await bothThemes('27-07-pay-pf')
  await h.click('btn-due-save')
  await page.waitForFunction((k) => document.querySelector(`[data-testid="due-status-${k}"]`)?.textContent === 'Paid', `pf:${month}`, { timeout: 10000 })
  await page.waitForSelector('[data-testid="rows-payroll-payments"] tr.dt-row')
  await page.evaluate(() => document.querySelectorAll('main').forEach((el) => el.scrollTo(0, el.scrollHeight)))
  await bothThemes('27-08-statutory-paid')

  // ---------- rates with citations ----------
  await tab('rates')
  await page.waitForSelector('[data-testid="rows-payroll-rates"] tr.dt-row')
  const rateCount = await page.$$eval('[data-testid="rows-payroll-rates"] tr.dt-row', (r) => r.length)
  assert(rateCount > 30, `seeded statutory rates listed (${rateCount})`)
  await bothThemes('27-09-rates')

  // ---------- TDS screen: salary TDS on Deducted and in 24Q (not 26Q) ----------
  await h.goto('tds')
  await h.click('tab-tds-returns')
  await h.waitIdle()
  const q = (() => { const m = Number(month.slice(5, 7)); return m >= 4 && m <= 6 ? 1 : m <= 9 && m >= 7 ? 2 : m >= 10 ? 3 : 4 })()
  await h.click(`tds-returns-q-${q}`)
  await page.waitForSelector('[data-testid="rows-tds-24q"] tr.dt-row', { timeout: 10000 })
  const rows24 = await page.$$eval('[data-testid="rows-tds-24q"] tr.dt-row', (r) => r.map((x) => x.textContent))
  assert(rows24.some((t) => t.includes('Anil Mehta')), '24Q lists Anil')
  const rows26 = await page.$$('[data-testid="rows-tds-26q"] tr.dt-row')
  assertEq(rows26.length, 0, 'salary TDS is not in 26Q')
  await page.locator('[data-testid="rows-tds-24q"]').scrollIntoViewIfNeeded()
  await bothThemes('27-10-tds-24q')

  // Payslip and Form 16 data PDFs render.
  const slip = await h.invoke('payroll:payslip', { runId: run.id, employeeId: anil.employeeId })
  assert(fs.existsSync(slip.path), 'payslip PDF written')
  const fyStart = Number(month.slice(5, 7)) >= 4 ? Number(month.slice(0, 4)) : Number(month.slice(0, 4)) - 1
  const f16 = await h.invoke('payroll:form16Pdf', { fyStartYear: fyStart })
  assert(fs.existsSync(f16.path), 'Form 16 / 130 data PDF written')

  h.assertNoConsoleErrors()
})
