// Scenario 33 — payables (WP 4.3), driven through the UI: three bills from a supplier land on the
// Payables plan → the supplier is marked MSME (micro, Udyam, no written agreement) from its name
// link → the plan shows the MSMED Act s.15 deadlines (15 days) and the overdue bills → Plan
// payments: tick the overdue bill, pick the bank, Create payments → the preview → Post → the run
// summary; the payment voucher is balanced and bill-wise → the MSME report ages what is left
// against the deadline with indicative s.16 interest → MSME Form 1 CSV → the dashboard shows "MSME
// due this week" → batch payments and supplier reconciliation. Every view is shot in both themes.
// Set WP43_SHOTS=/tmp/wp43 to also copy the screenshots there.
import fs from 'node:fs'
import path from 'node:path'
import { scenario, assert, assertEq } from '../lib/harness.mjs'

await scenario('33-payables', async (h) => {
  await h.createCompanyUI('MSME Works')
  await h.stubDialogs()
  const page = h.page
  const extraShots = process.env.WP43_SHOTS
  const shot = async (name) => {
    await h.page.mouse.move(0, 0)
    await h.page.waitForTimeout(250)
    await h.shot(name)
    if (extraShots) {
      fs.mkdirSync(extraShots, { recursive: true })
      fs.copyFileSync(path.join(h.outDir, `${name}.png`), path.join(extraShots, `${name}.png`))
    }
  }
  const setTheme = async (theme) => {
    const now = await h.page.evaluate(() => document.documentElement.dataset.theme ?? 'light')
    if (now !== theme) await h.page.evaluate(() => document.querySelector('[data-testid="btn-theme"]').click())
    await h.page.waitForFunction((t) => (document.documentElement.dataset.theme ?? 'light') === t, theme)
    await h.page.waitForTimeout(400)
  }
  const bothThemes = async (name) => {
    await setTheme('light')
    await shot(`${name}-light`)
    await setTheme('dark')
    await shot(`${name}-dark`)
    await setTheme('light')
  }
  const waitText = (selector, needle, timeout = 10000) =>
    page.waitForFunction(([s, n]) => (document.querySelector(s)?.textContent ?? '').includes(n), [selector, needle], { timeout })
  const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  const daysAgo = (n) => page.evaluate((k) => {
    const d = new Date()
    d.setDate(d.getDate() - k)
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  }, n)
  const today = iso(new Date())
  void today

  // ---------- books: a supplier, a bank, three bills ----------
  const groups = await h.invoke('master:groups:list')
  const gid = (name) => groups.find((g) => g.name === name).id
  const types = await h.invoke('master:voucherTypes:list')
  const typeOf = (kind) => types.find((t) => t.kind === kind)
  const supplier = await h.invoke('master:ledgers:create', { name: 'Kiran Micro Castings', groupId: gid('Sundry Creditors'), creditDays: 60, pan: 'AAAPK1234C' })
  const bank = await h.invoke('master:ledgers:create', { name: 'HDFC Current', groupId: gid('Bank Accounts'), openingBalance: 50000000 })
  const purchases = await h.invoke('master:ledgers:create', { name: 'Castings Purchased', groupId: gid('Purchase Accounts') })
  const mkBill = async (date, name, amount, ref) =>
    h.invoke('voucher:save', {
      data: {
        voucherTypeId: typeOf('purchase').id, date, partyLedgerId: supplier.id, reference: ref,
        lines: [{ ledgerId: purchases.id, drCr: 'dr', amount }, { ledgerId: supplier.id, drCr: 'cr', amount }],
        billRefs: [{ kind: 'new', name, amount, dueDate: null }]
      }
    })
  const dA = await daysAgo(40)
  const dB = await daysAgo(20)
  const dC = await daysAgo(3)
  await mkBill(dA, 'KMC-101', 1180000, 'INV-101')
  await mkBill(dB, 'KMC-102', 590000, 'INV-102')
  await mkBill(dC, 'KMC-103', 236000, 'INV-103')

  // ---------- the plan before the supplier is marked MSME: 60-day terms, nothing overdue ----------
  await h.goto('payables')
  await page.waitForSelector('[data-testid="rows-payables-plan"] tr.dt-row', { timeout: 15000 })
  assertEq(await page.locator('[data-testid="rows-payables-plan"] tr.dt-row').count(), 3, 'three open bills on the plan')
  assert(!(await page.locator('[data-testid="rows-payables-plan"] [data-testid="payables-msme-badge"]').count()), 'no MSME badge yet')
  assert(/0\.00/.test(await page.textContent('[data-testid="payables-tile-msme"]')), 'nothing past s.15 yet')

  // ---------- mark the supplier MSME from its name link ----------
  await page.locator('[data-testid="rows-payables-plan"] [data-testid="ledger-link"]').first().click()
  await page.waitForSelector('[data-testid="ledger-supplier-terms"]', { timeout: 10000 })
  await h.click('ledger-msme-registered')
  await page.selectOption('[data-testid="ledger-msme-category"]', 'micro')
  await h.fill('ledger-udyam-no', 'udyam-mh-33-0012345')
  await bothThemes('01-ledger-msme')
  await h.click('btn-ledger-save')
  await page.waitForSelector('[data-testid="ledger-supplier-terms"]', { state: 'detached', timeout: 10000 })
  const saved = (await h.invoke('master:ledgers:list')).find((l) => l.id === supplier.id)
  assert(saved.msmeRegistered && saved.msmeCategory === 'micro' && saved.udyamNo === 'UDYAM-MH-33-0012345', `ledger saved MSME (got ${JSON.stringify(saved)})`)

  // ---------- the plan now carries the s.15 deadline ----------
  await page.waitForSelector('[data-testid="rows-payables-plan"] [data-testid="payables-msme-badge"]', { timeout: 15000 })
  const plan = await h.invoke('payables:plan', { asOn: today })
  const byNo = (n) => plan.rows.find((r) => r.number === n)
  assertEq(byNo('KMC-101').s15.basis, 'no_agreement', 'no written agreement → 15 days')
  assertEq(byNo('KMC-101').bucket, 'overdue', 'the 40-day-old bill is overdue under s.15 (not its 60-day terms)')
  assertEq(byNo('KMC-102').bucket, 'overdue', 'the 20-day-old bill too')
  assert(byNo('KMC-103').bucket !== 'overdue', 'the 3-day-old bill is still within 15 days')
  assert(byNo('KMC-101').interestIndicative > 0, 'indicative s.16 interest is running')
  const outstandingTotal = (await h.invoke('analysis:outstandings', { side: 'payable', asOn: today })).reduce((s, p) => s + p.pending, 0)
  assertEq(plan.totals.pending, outstandingTotal, 'plan total = Outstandings payables')
  await waitText('[data-testid="payables-tile-msme"]', '17,700.00')
  await bothThemes('02-plan')

  // ---------- plan → tick → bank → create payments ----------
  await h.click('btn-payables-plan-mode')
  await h.click(`pick-payables-${supplier.id}-KMC-101`)
  await waitText('[data-testid="payables-selected-total"]', '11,800.00')
  await page.selectOption('[data-testid="input-payables-bank"]', String(bank.id))
  await bothThemes('03-plan-mode')
  await h.click('btn-payables-create')
  await page.waitForSelector('[data-testid="rows-payables-run-preview"]', { timeout: 15000 })
  await page.waitForFunction(() => !document.querySelector('[data-testid="btn-payables-post-run"]')?.disabled, null, { timeout: 15000 })
  await bothThemes('04-run-preview')
  await h.click('btn-payables-post-run')
  await page.waitForSelector('[data-testid="payables-run-summary"]', { timeout: 15000 })
  assertEq((await page.textContent('[data-testid="payables-run-no"]')).trim(), 'PR-0001', 'run number')
  await bothThemes('05-run-summary')
  const runs = await h.invoke('payables:runs')
  assertEq(runs.length, 1, 'one run')
  const v = await h.invoke('voucher:get', { id: runs[0].lines[0].voucherId })
  const dr = v.lines.filter((l) => l.drCr === 'dr').reduce((s, l) => s + l.amount, 0)
  const cr = v.lines.filter((l) => l.drCr === 'cr').reduce((s, l) => s + l.amount, 0)
  assert(dr === cr && dr === 1180000, 'payment voucher balanced at ₹11,800')
  assertEq(JSON.stringify(v.billRefs), JSON.stringify([{ kind: 'against', name: 'KMC-101', amount: 1180000, dueDate: null }]), 'bill-wise against KMC-101')
  await page.keyboard.press('Escape')
  await page.waitForSelector('[data-testid="payables-run-summary"]', { state: 'detached', timeout: 10000 })
  const after = await h.invoke('payables:plan', { asOn: today })
  assertEq(after.rows.map((r) => r.number).sort().join(), 'KMC-102,KMC-103', 'KMC-101 is paid')
  const audit = await h.invoke('audit:list', { page: 0 })
  assert(audit.rows.some((r) => r.entity === 'payment_run' && r.action === 'create'), 'the run is in the edit log')

  // ---------- MSME report ----------
  await h.click('tab-payables-msme')
  await page.waitForSelector('[data-testid="rows-msme-dues"] tr.dt-row', { timeout: 15000 })
  assertEq(await page.locator('[data-testid="rows-msme-dues"] tr.dt-row').count(), 2, 'two MSME bills open')
  const lateRow = await page.textContent('[data-testid="rows-msme-dues"] tr.dt-row[data-bucket="late_1_30"]')
  assert(/KMC-102/.test(lateRow), `KMC-102 is 1–30 days late (got ${lateRow})`)
  assert(/17\.25 %/.test(await page.textContent('[data-testid="msme-tile-interest"]')), 's.16 at 3 × 5.75 %')
  await bothThemes('06-msme-dues')
  await h.click('msme-view-disallowance')
  await page.waitForSelector('[data-testid="rows-msme-disallowance"]', { state: 'attached', timeout: 10000 })
  await bothThemes('07-msme-43bh')
  await h.click('msme-view-form1')
  await page.waitForSelector('[data-testid="rows-msme-form1"]', { state: 'attached', timeout: 10000 })
  await bothThemes('08-msme-form1')
  await h.click('btn-msme-form1-csv')
  await page.waitForFunction(() => /MSME Form 1 data saved/.test(document.body.textContent ?? ''), null, { timeout: 10000 })
  const exportsDir = path.join(h.dataDir, 'companies', 'msme-works', 'exports')
  const csv = fs.readdirSync(exportsDir).find((f) => f.startsWith('msme-form-1-'))
  assert(csv, 'MSME Form 1 CSV written')
  assert(/Name of MSE supplier/.test(fs.readFileSync(path.join(exportsDir, csv), 'utf8')), 'Form 1 columns')

  // ---------- dashboard: MSME due this week ----------
  await h.goto('gateway')
  await page.waitForSelector('[data-testid="dash-msme-due"]', { timeout: 15000 })
  assert(/late/.test(await page.textContent('[data-testid="dash-msme-due"]')), 'the dashboard shows MSME dues past the period')
  await bothThemes('09-dashboard')

  // ---------- batch payments ----------
  await h.goto('payables')
  await h.click('tab-payables-batch')
  await page.waitForSelector('[data-testid="rows-payables-batch"]', { timeout: 10000 })
  const picker = page.locator('[data-testid="picker-payables-batch-supplier-0"]')
  await picker.click()
  await picker.fill('Kiran')
  await page.waitForSelector('[role="option"]', { timeout: 5000 })
  await page.keyboard.press('Enter')
  await h.click('btn-payables-batch-bills-0')
  await h.click('pick-batch-bill-KMC-102')
  await h.click('btn-payables-batch-bills-ok')
  await waitText('[data-testid="payables-batch-total"]', '5,900.00')
  await h.fill('input-payables-batch-instrument-0', 'UTR998877')
  await bothThemes('10-batch')
  await h.click('btn-payables-batch-preview')
  await page.waitForSelector('[data-testid="rows-payables-run-preview"]', { timeout: 15000 })
  await page.waitForFunction(() => !document.querySelector('[data-testid="btn-payables-post-run"]')?.disabled, null, { timeout: 15000 })
  await h.click('btn-payables-post-run')
  await page.waitForSelector('[data-testid="payables-run-summary"]', { timeout: 15000 })
  assertEq((await page.textContent('[data-testid="payables-run-no"]')).trim(), 'PR-0002', 'batch run number')
  await page.keyboard.press('Escape')
  const run2 = (await h.invoke('payables:runs'))[0]
  assertEq(run2.lines[0].instrumentNo, 'UTR998877', 'UTR on the voucher')

  // ---------- supplier statement + reconciliation ----------
  await h.click('tab-payables-suppliers')
  const sp = page.locator('[data-testid="picker-payables-supplier"]')
  await sp.click()
  await sp.fill('Kiran')
  await page.waitForSelector('[role="option"]', { timeout: 5000 })
  await page.keyboard.press('Enter')
  await page.waitForSelector('[data-testid="rows-payables-statement"] tr.dt-row', { timeout: 15000 })
  const dmy = (isoDate) => isoDate.split('-').reverse().join('/')
  const theirCsv = [
    'Date,Invoice No,Particulars,Debit,Credit',
    `${dmy(dA)},INV-101,Sales,11800.00,`,
    `${dmy(dB)},INV/26-27/102,Sales,5900.00,`,
    `${dmy(dC)},INV-103,Sales,2400.00,`,
    `${dmy(dC)},INV-104,Sales,1000.00,`
  ].join('\n')
  await h.fill('input-recon-csv', theirCsv)
  await h.click('btn-payables-reconcile')
  await page.waitForSelector('[data-testid="rows-payables-recon"] tr.dt-row', { timeout: 15000 })
  const statuses = await page.$$eval('[data-testid="rows-payables-recon"] tr.dt-row', (trs) => trs.map((t) => t.getAttribute('data-status')))
  assert(statuses.filter((s) => s === 'matched').length === 2, `two bills match (got ${statuses})`)
  assert(statuses.includes('amount_diff'), 'INV-103 differs by ₹40')
  assert(statuses.includes('only_supplier'), 'INV-104 is only in their books')
  assert(statuses.filter((s) => s === 'only_books').length === 2, 'our two payments are not in their extract')
  await page.locator('[data-testid="rows-payables-recon"]').scrollIntoViewIfNeeded()
  await bothThemes('11-supplier-recon')

  h.assertNoConsoleErrors()
})
