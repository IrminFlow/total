// Scenario 37 — report builder, ratios, comparatives and scheduled packs (WP 6.1 / 6.2). On the
// demo company: build "sales by party by month" (party × month, taxable value, sales vouchers,
// months pivoted), check it equals the sales register, save it, pin it, open it from the sidebar,
// export it, then put it in a report pack and run the pack. Screenshots of every new view in both
// themes (also copied to /tmp/wp61 when that folder exists).
import { scenario, assert, assertEq } from '../lib/harness.mjs'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'

const SHOTS = '/tmp/wp61'

await scenario('37-report-builder', async (h) => {
  await h.stubDialogs()
  await h.createDemoCompany()
  const shot = async (name) => {
    const file = await h.shot(name)
    if (fs.existsSync(SHOTS)) fs.copyFileSync(file, path.join(SHOTS, `${name}.png`))
  }
  const waitResult = async () => {
    await h.page.waitForFunction(() => document.querySelector('[data-testid="rb-result"]')?.getAttribute('data-state') === 'ready', null, { timeout: 30000 })
    await h.waitIdle(30000)
  }
  const bothThemes = async (name) => {
    await shot(`${name}-light`)
    await h.click('btn-theme')
    await h.page.waitForTimeout(250)
    await shot(`${name}-dark`)
    await h.click('btn-theme')
    await h.page.waitForTimeout(150)
  }

  // ---------------- build the report
  await h.goto('report-builder', 30000)
  await waitResult()
  await h.page.selectOption('[data-testid="rb-dim-0"]', 'party')
  await h.page.selectOption('[data-testid="rb-add-dimension"]', 'month')
  for (const k of ['debit', 'credit', 'net']) await h.click(`rb-measure-${k}`)
  await h.click('rb-measure-taxable')
  await h.click('rb-kind-sales')
  await h.page.selectOption('[data-testid="rb-pivot"]', 'month')
  await h.page.waitForTimeout(600)
  await waitResult()
  const rows = await h.page.$$('[data-testid="rows-report-builder"] tr.dt-row')
  assert(rows.length >= 2, `builder shows the customers (got ${rows.length} rows)`)

  // The grand total equals the sales register's taxable value for the same period.
  const period = await h.page.evaluate(() => {
    const d = new Date()
    const today = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    return { today }
  })
  const session = await h.invoke('rb:run', {
    model: { source: 'accounts', dimensions: [{ key: 'party' }, { key: 'month' }], measures: ['taxable'], filters: { voucherKinds: ['sales'] }, pivot: 'month' },
    working: { from: '2000-04-01', to: period.today }
  })
  const reg = await h.invoke('analysis:register', { kind: 'sales', from: '2000-04-01', to: period.today })
  assertEq(session.totals[0], reg.reduce((s, m) => s + m.taxable, 0), 'builder total = sales register taxable')
  await bothThemes('01-builder-sales-by-party-by-month')

  // ---------------- save + pin
  await h.click('rb-save')
  await h.fill('prompt-input', 'Sales by party by month')
  await h.click('prompt-ok')
  await h.page.waitForFunction(() => document.querySelector('[data-testid="page-title"]')?.textContent?.includes('Sales by party by month'), null, { timeout: 20000 })
  const saved = (await h.invoke('rb:list')).find((r) => r.name === 'Sales by party by month')
  assert(saved && saved.model.pivot === 'month', 'the report is saved with its pivot')
  await h.click('rb-menu')
  await h.click('rb-menu-pin')
  await h.page.waitForSelector(`[data-testid="nav-report-${saved.id}"]`, { state: 'attached', timeout: 20000 })

  // ---------------- open from the sidebar
  await h.goto('gateway', 20000)
  await h.page.evaluate((id) => {
    const list = document.querySelector(`[data-testid="nav-report-${id}"]`)?.closest('[hidden]')
    if (list?.id) document.querySelector(`[aria-controls="${list.id}"]`)?.click()
  }, saved.id)
  await h.click(`nav-report-${saved.id}`)
  await h.waitScreen('report-builder', 30000)
  await waitResult()
  const title = await h.page.textContent('[data-testid="page-title"]')
  assertEq(title?.trim(), 'Sales by party by month', 'pinned entry opens the saved report')
  const current = await h.page.getAttribute(`[data-testid="nav-report-${saved.id}"]`, 'aria-current')
  assertEq(current, 'page', 'the pinned entry is highlighted')

  // ---------------- export (CSV + PDF of the current view)
  const exportsDir = path.join(h.dataDir, 'companies', 'demo-traders', 'exports')
  const before = new Set(fs.existsSync(exportsDir) ? fs.readdirSync(exportsDir) : [])
  await h.click('rb-export-csv')
  await h.click('rb-export-pdf')
  await h.page.waitForFunction(() => document.body.textContent?.includes('Saved to exports'), null, { timeout: 30000 })
  let added = []
  for (let i = 0; i < 60; i++) {
    added = fs.readdirSync(exportsDir).filter((f) => !before.has(f))
    if (added.some((f) => f.endsWith('.pdf')) && added.some((f) => f.endsWith('.csv'))) break
    await h.page.waitForTimeout(500)
  }
  assert(added.some((f) => f.endsWith('.csv')), `CSV export written (${added.join(', ')})`)
  assert(added.some((f) => f.endsWith('.pdf')), `PDF export written (${added.join(', ')})`)
  const csv = fs.readFileSync(path.join(exportsDir, added.find((f) => f.endsWith('.csv'))), 'utf8')
  assert(/Party/.test(csv) && /Total/.test(csv), 'CSV has the pivot header and totals')

  // ---------------- ratios + comparative statements
  await h.page.waitForFunction(() => !document.body.textContent?.includes('Saved to exports'), null, { timeout: 20000 }).catch(() => {})
  await h.goto('ratios', 30000)
  await h.page.waitForSelector('[data-testid="rows-ratios"] tr[data-ratio="currentRatio"]', { timeout: 30000 })
  await bothThemes('02-ratios')
  await h.goto('profit-loss', 30000)
  await h.click('btn-profit-loss-options')
  await h.click('input-statement-comparative')
  await h.page.keyboard.press('Escape')
  await h.page.waitForSelector('[data-testid="comparative-pnl"]', { timeout: 30000 })
  await h.waitIdle(30000)
  await bothThemes('03-pnl-comparative')
  await h.goto('balance-sheet', 30000)
  await h.click('btn-balance-sheet-options')
  await h.click('input-statement-comparative')
  await h.page.keyboard.press('Escape')
  await h.page.waitForSelector('[data-testid="comparative-bs"]', { timeout: 30000 })
  await h.waitIdle(30000)
  await bothThemes('04-bs-comparative')

  // ---------------- scheduled pack: create in Settings, run now
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'total-e2e-pack-'))
  await h.goto('settings', 20000)
  await h.click('tab-settings-packs')
  await h.page.waitForSelector('[data-testid="btn-packs-new"]', { timeout: 20000 })
  await h.click('btn-packs-new')
  await h.fill('input-pack-name', 'Month end')
  await h.click(`input-pack-saved-${saved.id}`)
  await h.fill('input-pack-folder', out)
  await h.click('btn-pack-save')
  await h.page.waitForSelector('[data-testid="rows-packs"] li', { timeout: 20000 })
  const pack = (await h.invoke('pack:list')).find((p) => p.name === 'Month end')
  assert(pack && pack.reports.length === 4, 'pack saved with the three default statements + the saved report')
  await h.click(`btn-pack-run-${pack.id}`)
  await h.page.waitForSelector('[data-testid="rows-pack-runs"] tr.dt-row', { timeout: 90000 })
  const runs = await h.invoke('pack:runs', { packId: pack.id })
  assertEq(runs[0].status, 'ok', `pack run ok (${runs[0].error ?? ''})`)
  assertEq(runs[0].files.length, 8, 'four reports × PDF + CSV')
  for (const f of runs[0].files) assert(fs.existsSync(f) && fs.statSync(f).size > 0, `pack file written: ${f}`)
  assert(runs[0].files.some((f) => /sales-by-party-by-month\.pdf$/.test(f)), 'the saved report is in the pack')
  await bothThemes('05-scheduled-packs')
  fs.rmSync(out, { recursive: true, force: true })
})
