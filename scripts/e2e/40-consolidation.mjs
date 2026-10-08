// Scenario 40 — group consolidation (WP 6.5). Two companies with an inter-company sale: Alpha
// Holdings sells 50,000 to Beta Traders (80 % owned, cost 45,000 for Beta's 50,000 capital).
// Define the group (Alpha parent, Beta subsidiary), accept the suggested pairs, set the
// investment ledger and equity at acquisition, then see the elimination and the consolidated
// P&L (sales 1,50,000 − 50,000; minority 20 % of Beta's profit) and the goodwill. Screenshots of every view in both
// themes (also copied to /tmp/wp65 when that folder exists).
import { scenario, assert, assertEq } from '../lib/harness.mjs'
import * as fs from 'node:fs'
import * as path from 'node:path'

const SHOTS = '/tmp/wp65'

await scenario('40-consolidation', async (h) => {
  const shot = async (name) => {
    const file = await h.shot(name)
    if (fs.existsSync(SHOTS)) fs.copyFileSync(file, path.join(SHOTS, `${name}.png`))
  }
  const bothThemes = async (name) => {
    await shot(`${name}-light`)
    await h.click('btn-theme')
    await h.page.waitForTimeout(250)
    await shot(`${name}-dark`)
    await h.click('btn-theme')
    await h.page.waitForTimeout(150)
  }
  const today = await h.page.evaluate(() => {
    const d = new Date()
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  })

  /** Ledgers by name → id, creating the missing ones. */
  const seed = async (ledgers, vouchers) => {
    const groups = await h.invoke('master:groups:list')
    for (const [name, group] of ledgers) {
      await h.invoke('master:ledgers:create', {
        name, groupId: groups.find((g) => g.name === group).id, openingBalance: 0,
        gstin: null, stateCode: null, address: null, taxType: null, gstRate: null, hsn: null
      })
    }
    const all = await h.invoke('master:ledgers:list')
    const id = (n) => all.find((l) => l.name === n).id
    const journal = (await h.invoke('master:voucherTypes:list')).find((t) => t.kind === 'journal')
    for (const [dr, cr, amount] of vouchers) {
      await h.invoke('voucher:save', {
        data: {
          voucherTypeId: journal.id, date: today, partyLedgerId: null, narration: null, reference: null, instrumentNo: null,
          instrumentDate: null, transporterId: null, vehicleNo: null, transportDistanceKm: null, currencyCode: null, exchangeRate: null,
          lines: [{ ledgerId: id(dr), drCr: 'dr', amount }, { ledgerId: id(cr), drCr: 'cr', amount }],
          inventory: []
        }
      })
    }
  }

  // ---------------- two companies, one inter-company sale
  await h.createCompanyUI('Beta Traders')
  await seed(
    [['Alpha Holdings', 'Sundry Creditors'], ['Purchases', 'Purchase Accounts'], ['Sales', 'Sales Accounts'], ['Share capital', 'Capital Account']],
    [['Cash', 'Share capital', 50000_00], ['Purchases', 'Alpha Holdings', 50000_00], ['Cash', 'Sales', 80000_00]]
  )
  await h.page.evaluate(() => document.querySelector('[data-testid="btn-switch-company"]')?.click())
  await h.createCompanyUI('Alpha Holdings')
  await seed(
    [['Beta Traders', 'Sundry Debtors'], ['Sales', 'Sales Accounts'], ['Investment in Beta', 'Investments'], ['Capital', 'Capital Account']],
    [['Cash', 'Capital', 100000_00], ['Investment in Beta', 'Cash', 45000_00], ['Beta Traders', 'Sales', 50000_00], ['Cash', 'Sales', 20000_00]]
  )

  // ---------------- define the group
  await h.goto('consolidation', 30000)
  await h.click('btn-consol-new-empty')
  await h.fill('input-consol-name', 'Alpha group')
  await h.page.waitForFunction(() => document.querySelectorAll('[data-testid="select-consol-add"] option').length >= 2, null, { timeout: 20000 })
  const betaSlug = (await h.invoke('company:list')).companies.find((c) => c.name === 'Beta Traders').slug
  await h.page.selectOption('[data-testid="select-consol-add"]', betaSlug)
  await h.fill(`input-consol-own-${betaSlug}`, '80')
  await h.click('btn-consol-save')
  await h.page.waitForSelector('[data-testid="btn-consol-suggest"]', { timeout: 30000 })
  await h.click('btn-consol-suggest')
  await h.page.waitForSelector('[data-testid="consol-suggestions"]', { timeout: 30000 })
  const suggestions = await h.page.$$eval('[data-testid="consol-suggestions"] li', (els) => els.map((e) => e.textContent))
  assertEq(suggestions.length, 2, 'two suggested pairs (balance + sales/purchases) by name')
  await h.click('btn-consol-accept-all')
  await h.page.waitForFunction(() => document.querySelectorAll('[data-testid="rows-consol-pairs"] tr.dt-row').length === 2, null, { timeout: 30000 })
  // The investment ledger (in the parent's books) and Beta's equity at acquisition → goodwill.
  const investId = (await h.invoke('master:ledgers:list')).find((l) => l.name === 'Investment in Beta').id
  await h.page.waitForSelector(`[data-testid="select-consol-invest-${betaSlug}"] option[value="${investId}"]`, { state: 'attached', timeout: 20000 })
  await h.page.selectOption(`[data-testid="select-consol-invest-${betaSlug}"]`, String(investId))
  await h.fill(`input-consol-equity-${betaSlug}`, '50000')
  await h.page.keyboard.press('Tab')
  await h.click('btn-consol-save')
  await h.page.waitForFunction(async () => {
    const r = await window.total.invoke('consolGroup:list')
    return r.ok && r.data[0]?.members.some((m) => m.investmentLedgerId != null && m.acquisitionEquity === 5000000)
  }, null, { timeout: 20000 })
  await bothThemes('01-group-setup')

  // ---------------- consolidated P&L with the elimination
  await h.click('tab-consolidation-statements')
  await h.page.waitForSelector('[data-testid="consol-net-profit"]', { timeout: 30000 })
  const net = await h.page.textContent('[data-testid="consol-net-profit"]')
  assertEq(net, '1,00,000.00', 'consolidated net profit = 70,000 + 30,000 (the inter-company sale nets out)')
  assertEq(await h.page.textContent('[data-testid="consol-minority"]'), '6,000.00', 'minority 20 % of Beta’s 30,000')
  const groups = await h.invoke('consolGroup:list')
  const fy = (() => { const [y, m] = today.split('-').map(Number); const s = m >= 4 ? y : y - 1; return { from: `${s}-04-01`, to: `${s + 1}-03-31` } })()
  const run = await h.invoke('consolGroup:run', { groupId: groups[0].id, from: fy.from, to: fy.to })
  const sales = run.pnl.lines.find((l) => l.key === 'income:sales accounts')
  assertEq(sales.elimination, 50000_00, 'the inter-company sale is eliminated from sales')
  assertEq(sales.consolidated, -100000_00, 'consolidated sales 1,00,000')
  assertEq(run.pnl.lines.find((l) => l.key === 'expense:purchase accounts')?.consolidated ?? 0, 0, 'inter-company purchases eliminated')
  assertEq(run.bs.balance.assets, run.bs.balance.liabilities, 'consolidated balance sheet balances')
  assertEq(run.tb.totals.consolidated, 0, 'consolidated trial balance balances')
  assertEq(run.bs.lines.find((l) => l.key === 'elim:goodwill')?.consolidated, 5000_00, 'goodwill = 45,000 − 80 % × 50,000')
  assertEq(run.bs.lines.find((l) => l.key === 'elim:minority_interest')?.consolidated, -16000_00, 'minority interest = 20 % × (50,000 + 30,000)')
  assertEq(run.warnings.length, 0, `no warnings: ${run.warnings.join('; ')}`)
  const row = await h.page.$('[data-testid="rows-consol-statement"] tr[data-line="income:sales accounts"]')
  assert(row, 'the consolidated sales line is on screen')
  const rowText = await row.textContent()
  assert(rowText.includes('50,000.00 Dr') && rowText.includes('1,00,000.00 Cr'), `sales line shows the elimination and the consolidated figure: ${rowText}`)
  await bothThemes('02-consolidated-pnl')
  await h.click('consol-statement-expand-income:sales accounts')
  await h.page.waitForSelector('[data-testid="drill-income:sales accounts"]', { timeout: 20000 })
  const drill = await h.page.textContent('[data-testid="drill-income:sales accounts"]')
  assert(drill.includes('Beta Traders') && drill.includes('Inter-company'), `drill-down lists member lines and the elimination: ${drill}`)
  await bothThemes('03-drilldown')

  await h.click('consol-kind-bs')
  await h.page.waitForSelector('[data-testid="consol-assets"]', { timeout: 30000 })
  await bothThemes('04-consolidated-bs')

  // ---------------- inter-company reconciliation + eliminations
  await h.click('tab-consolidation-intercompany')
  await h.page.waitForSelector('[data-testid="rows-consol-recon"] tr.dt-row', { timeout: 30000 })
  const statuses = await h.page.$$eval('[data-testid="rows-consol-recon"] tr.dt-row', (els) => els.map((e) => `${e.getAttribute('data-status')}/${e.getAttribute('data-flow-status')}`))
  assertEq(statuses.sort().join(','), 'n/a/reconciled,reconciled/n/a', 'both pairs reconcile')
  await bothThemes('05-intercompany')
  await h.click('tab-consolidation-eliminations')
  await h.click('consol-elim-kind-pnl')
  await h.page.waitForSelector('[data-testid="rows-consol-elims"] tr.dt-row', { timeout: 30000 })
  await bothThemes('06-eliminations')
})
