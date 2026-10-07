// Scenario 22 — fixed assets (WP 3.6), driven through the UI: a purchase that debits a Fixed
// Assets ledger becomes a register entry ("From a purchase…"), a depreciation run posts ONE
// journal that shows in the Day book, the schedule agrees with the ledgers, re-running the
// period is refused, the asset is sold through the disposal wizard, and every tab is shot in
// both themes. Set WP36_SHOTS=/tmp/wp36 to also copy the screenshots there.
import fs from 'node:fs'
import path from 'node:path'
import { scenario, assert, assertEq } from '../lib/harness.mjs'

await scenario('22-fixed-assets', async (h) => {
  await h.createCompanyUI('Asset Works')
  const page = h.page
  const extraShots = process.env.WP36_SHOTS
  const shot = async (name) => {
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
    await page.waitForTimeout(400) // let the theme transition settle before a screenshot
  }
  const tab = async (id) => {
    await h.click(`tab-fixed-assets-${id}`)
    await h.waitIdle()
    await page.mouse.move(0, 0) // no hover highlight in the shots
    await page.evaluate(() => document.querySelectorAll('main').forEach((el) => el.scrollTo(0, 0)))
    await page.waitForTimeout(250)
  }

  // ---------- books: a ₹90,000 laptop bought on credit on 1 Apr of this FY ----------
  const groups = await h.invoke('master:groups:list')
  const gid = (name) => groups.find((g) => g.name === name).id
  const mkLedger = (name, group) =>
    h.invoke('master:ledgers:create', {
      name, groupId: gid(group), openingBalance: 0, gstin: null, stateCode: null, address: null, taxType: null, gstRate: null, hsn: null
    })
  const computers = await mkLedger('Computers', 'Fixed Assets')
  const vendor = await mkLedger('Laptop World', 'Sundry Creditors')
  const bank = await mkLedger('HDFC Bank', 'Bank Accounts')
  const types = await h.invoke('master:voucherTypes:list')
  const today = await page.evaluate(() => {
    const d = new Date()
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  })
  const [y, m] = today.split('-').map(Number)
  const fyStart = m >= 4 ? y : y - 1
  const fyFrom = `${fyStart}-04-01`
  const halfYearEnd = `${fyStart}-09-30`
  const purchase = await h.invoke('voucher:save', {
    data: {
      voucherTypeId: types.find((t) => t.kind === 'purchase').id, date: fyFrom, partyLedgerId: vendor.id, narration: 'Laptop for accounts',
      reference: null, instrumentNo: null, instrumentDate: null, transporterId: null, vehicleNo: null, transportDistanceKm: null,
      currencyCode: null, exchangeRate: null,
      lines: [
        { ledgerId: computers.id, drCr: 'dr', amount: 9_000_000, costAllocations: [] },
        { ledgerId: vendor.id, drCr: 'cr', amount: 9_000_000, costAllocations: [] }
      ],
      inventory: [], billRefs: [], tds: null
    }
  })

  // ---------- create the asset from the purchase ----------
  await h.goto('fixed-assets')
  await page.waitForSelector('[data-testid="rows-fixed-assets-register"]')
  await shot('01-register-empty-light')
  await h.click('btn-fixed-assets-from-purchase')
  const candidate = page.locator(`[data-testid="rows-fixed-assets-candidates"] [data-row-id="${purchase.id}"]`)
  await candidate.waitFor({ timeout: 10000 })
  await shot('02-from-purchase-light')
  await candidate.click()
  await page.waitForSelector('[data-testid="fixed-assets-form"]')
  assertEq(await page.inputValue('[data-testid="input-fixed-assets-cost"]'), '90,000.00', 'cost pre-filled from the voucher line')
  await page.selectOption('[data-testid="input-fixed-assets-group"]', { label: 'Computers' })
  assertEq(await page.inputValue('[data-testid="input-fixed-assets-life"]'), '36', 'Schedule II end-user computers: 3 years')
  await h.fill('input-fixed-assets-name', 'Accounts laptop')
  await h.fill('input-fixed-assets-identifier', 'LT-0001')
  await shot('03-asset-form-light')
  await h.click('btn-fixed-assets-save')
  await page.waitForSelector('[data-testid="fixed-assets-form"]', { state: 'detached', timeout: 10000 })
  const assets = await h.invoke('fa:list', { asOn: today })
  assertEq(assets.length, 1, 'one asset on the register')
  const asset = assets[0]
  assertEq(asset.purchaseVoucherId, purchase.id, 'linked to its purchase voucher')
  assertEq(asset.costPaise, 9_000_000, 'cost from the voucher')
  await page.locator(`[data-testid="rows-fixed-assets-register"] [data-row-id="${asset.id}"]`).waitFor()

  // ---------- run depreciation for the first half-year ----------
  await tab('depreciation')
  await h.fill('input-fixed-assets-run-to', `30-09-${fyStart}`)
  await page.locator('[data-testid="input-fixed-assets-run-to"]').press('Enter')
  const row = page.locator(`[data-testid="rows-fixed-assets-run-preview"] [data-row-id="${asset.id}"]`)
  await row.waitFor({ timeout: 10000 })
  // (90,000 − 5%) ÷ 3 = 28,500 a year; 183 of 365 days ⇒ 14,289.04.
  const preview = await h.invoke('fa:runPreview', { from: fyFrom, to: halfYearEnd })
  assertEq(preview.rows[0].depreciation, 1_428_904, 'half-year SLM charge')
  assert((await row.textContent()).includes('14,289.04'), 'preview row shows the charge')
  await shot('04-run-preview-light')
  await h.click('btn-fixed-assets-post-run')
  await page.waitForSelector('[data-testid="fixed-assets-run-blocked"]', { timeout: 10000 })
  const runs = await h.invoke('fa:runs')
  assertEq(runs.length, 1, 'one run')
  const run = runs[0]
  const journal = await h.invoke('voucher:get', { id: run.voucherId })
  assertEq(journal.date, halfYearEnd, 'journal dated the period end')
  assertEq(journal.lines.length, 2, 'Dr depreciation / Cr accumulated depreciation')
  assert((await page.textContent('[data-testid="fixed-assets-run-blocked"]')).includes('already posted'), 're-running the period is refused')
  await shot('05-run-posted-light')

  // ---------- the journal in the Day book ----------
  await h.goto('daybook')
  const dayRow = page.locator(`[data-testid="rows-daybook"] [data-row-id="${run.voucherId}"]`)
  await dayRow.waitFor({ timeout: 10000 })
  assert((await dayRow.textContent()).includes('14,289.04'), 'depreciation journal in the Day book')
  await shot('06-daybook-light')

  // ---------- schedule: reconciles to the ledgers ----------
  await h.goto('fixed-assets')
  await tab('schedule')
  await page.waitForSelector('[data-testid="rows-fixed-assets-schedule"] tr')
  const schedule = await h.invoke('fa:schedule', { from: fyFrom, to: `${fyStart + 1}-03-31` })
  assertEq(schedule.totals.accCharge, 1_428_904, 'schedule: depreciation for the period')
  assertEq(schedule.totals.grossClosing, 9_000_000, 'schedule: gross block')
  assert(schedule.reconciliation.every((r) => r.difference === 0), 'register agrees with the ledgers')
  assertEq(await page.locator('[data-testid="fixed-assets-recon-mismatch"]').count(), 0, 'no mismatch banner')
  await shot('07-schedule-light')
  await tab('income-tax')
  await page.waitForSelector('[data-testid="rows-fixed-assets-it"] tr')
  await shot('08-income-tax-light')
  await tab('setup')
  await page.waitForSelector('[data-testid="rows-fixed-assets-groups"] tr')
  await shot('09-setup-light')

  // ---------- dispose: sell it for ₹60,000 into the bank ----------
  await tab('register')
  await h.click(`btn-fixed-assets-dispose-${asset.id}`)
  await page.waitForSelector('[data-testid="fixed-assets-disposal"]')
  await h.fill('input-fixed-assets-proceeds', '60000')
  const cons = page.locator('[data-testid="picker-fixed-assets-consideration"]')
  await cons.click()
  await cons.fill('HDFC Bank')
  await page.locator('[role="option"]', { hasText: 'HDFC Bank' }).first().waitFor({ timeout: 10000 })
  await cons.press('Enter')
  await page.waitForFunction(() => !document.querySelector('[data-testid="btn-fixed-assets-disposal-next"]')?.hasAttribute('disabled'), null, { timeout: 10000 })
  await shot('10-disposal-light')
  await h.click('btn-fixed-assets-disposal-next')
  await page.waitForSelector('[data-testid="rows-fixed-assets-disposal-journal"] tr')
  await shot('11-disposal-journal-light')
  await h.click('btn-fixed-assets-dispose')
  await page.waitForSelector('[data-testid="fixed-assets-disposal"]', { state: 'detached', timeout: 10000 })
  const after = (await h.invoke('fa:list', { asOn: today }))[0]
  assertEq(after.status, 'disposed', 'asset disposed')
  assertEq(after.disposalProceedsPaise, 6_000_000, 'proceeds recorded')
  const sale = await h.invoke('voucher:get', { id: after.disposalVoucherId })
  const dr = sale.lines.filter((l) => l.drCr === 'dr').reduce((s, l) => s + l.amount, 0)
  const cr = sale.lines.filter((l) => l.drCr === 'cr').reduce((s, l) => s + l.amount, 0)
  assertEq(dr, cr, 'disposal journal balances')
  assert(sale.lines.some((l) => l.ledgerId === computers.id && l.drCr === 'cr' && l.amount === 9_000_000), 'asset cost credited out')
  assert(sale.lines.some((l) => l.ledgerId === bank.id && l.drCr === 'dr' && l.amount === 6_000_000), 'bank debited with the proceeds')
  await page.locator(`[data-testid="rows-fixed-assets-register"] [data-row-id="${asset.id}"][data-status="disposed"]`).waitFor({ timeout: 10000 })
  const end = await h.invoke('fa:schedule', { from: fyFrom, to: `${fyStart + 1}-03-31` })
  assert(end.reconciliation.every((r) => r.difference === 0), 'still agrees after the disposal')
  await shot('12-register-disposed-light')

  // ---------- dark theme pass ----------
  await setTheme('dark')
  for (const [id, name] of [['register', '13-register-dark'], ['depreciation', '14-run-dark'], ['schedule', '15-schedule-dark'], ['income-tax', '16-income-tax-dark'], ['setup', '17-setup-dark']]) {
    await tab(id)
    await shot(name)
  }
  await tab('register')
  await h.click('btn-fixed-assets-new')
  await page.waitForSelector('[data-testid="fixed-assets-form"]')
  await shot('18-asset-form-dark')
  await page.keyboard.press('Escape')
  await page.waitForSelector('[data-testid="fixed-assets-form"]', { state: 'detached' })
  await setTheme('light')
})
