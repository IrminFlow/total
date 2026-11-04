// Scenario 34 — cash and finance (WP 4.4), driven through the UI: the cash-flow forecast (opening =
// the trial balance's cash and bank, a known item), and a USD entry that still reads with the Forex
// screen gone (1.0 cleanup). (The loans screen it also drove was removed in the feature cleanup.)
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
  const today = await page.evaluate(() => {
    const d = new Date()
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  })
  const addDays = (iso, n) => {
    const x = new Date(`${iso}T00:00:00Z`)
    x.setUTCDate(x.getUTCDate() + n)
    return x.toISOString().slice(0, 10)
  }

  // ---------- masters and opening entries ----------
  const groups = await h.invoke('master:groups:list')
  const gid = (name) => groups.find((g) => g.name === name).id
  const mkLedger = (name, group, openingBalance = 0) =>
    h.invoke('master:ledgers:create', { name, groupId: gid(group), openingBalance, gstin: null, stateCode: null, address: null, taxType: null, gstRate: null, hsn: null })
  const bank = await mkLedger('HDFC Current', 'Bank Accounts')
  const capital = await mkLedger('Owner Capital', 'Capital Account')
  const globex = await mkLedger('Globex Inc', 'Sundry Debtors')
  const sales = await mkLedger('Export Sales', 'Sales Accounts')
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
  await save('receipt', addDays(today, -60), [L(bank.id, 'dr', 2_00_000_00), L(capital.id, 'cr', 2_00_000_00)])

  // ---------- 1. the forecast ----------
  await h.goto('cash-forecast')
  await page.waitForSelector('[data-testid="rows-cash-forecast"] tr', { timeout: 15000 })
  const base = await h.invoke('forecast:base', { asOn: today, to: addDays(today, 90) })
  const tb = await h.invoke('report:trialBalance', { asOn: today })
  const tbBank = tb.rows.filter((r) => r.ledgerId === bank.id).reduce((s, r) => s + r.debit - r.credit, 0)
  assertEq(base.openingCash, tbBank, 'forecast opening = trial balance cash & bank')
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

  // ---------- 2. forex: the screen went in the 1.0 cleanup (owner's plan, PR #186) ----------
  // A USD entry saved by an older version still reads exactly as before; nothing offers to revalue it.
  const usd = await save('journal', addDays(today, -10), [L(globex.id, 'dr', 82_000_00), L(sales.id, 'cr', 82_000_00)], { partyLedgerId: globex.id, currencyCode: 'USD', exchangeRate: 82 })
  const usdV = await h.invoke('voucher:get', { id: usd.id })
  assertEq(usdV.currencyCode, 'USD', 'the USD entry keeps its currency')
  assertEq(await page.locator('[data-testid="nav-forex"]').count(), 0, 'no Forex entry in the sidebar')
  const noRevalue = await page.evaluate(() => window.total.invoke('fx:revalue', { asOf: '2026-03-31' }).then((r) => r.ok, () => false))
  assertEq(noRevalue, false, 'the revaluation channels are gone')
  const usdBal = (await h.invoke('report:trialBalance', { asOn: today })).rows.find((r) => r.ledgerId === globex.id)
  assertEq(usdBal.debit, 82_000_00, 'Globex stands at its booked ₹82,000')
  // Its journal offers no "Reverse…" (it is not a revaluation).
  assertEq(await h.invoke('fx:revaluationOf', { voucherId: usd.id }), null, 'an ordinary entry is not a revaluation')

  // ---------- dashboard ----------
  await h.goto('gateway')
  await h.waitIdle(15000)
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
  await h.goto('gateway')
  await h.waitIdle(15000)
  await shot('22-gateway-dark')
  await setTheme('light')
})
