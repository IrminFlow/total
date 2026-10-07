// Scenario 30 — audit trail / edit log (WP 3.8). A few changes by three different writers (the OS
// login before any user exists, an accountant, the owner), then the edit log: every change is
// listed with its user, a voucher edit expands to its field-level changes, the user filter
// narrows the list, CSV + PDF exports carry the auditor header (company, period, generation
// time, chain verification), Settings → Audit trail shows the chain banner and the owner-only
// retention. Finally the company file is tampered with outside the app (sqlite3 CLI, when the
// machine has it) and the edit log reports the break at that row. Every view is shot in both
// themes. Set WP38_SHOTS=/tmp/wp38 to also copy the screenshots there.
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { scenario, assert, assertEq } from '../lib/harness.mjs'

await scenario('30-audit-trail', async (h) => {
  await h.createCompanyUI('Audit Trail Co')
  const slug = 'audit-trail-co'
  const companyDir = path.join(h.dataDir, 'companies', slug)
  // h.page changes on every relaunch — always go through h.
  const extraShots = process.env.WP38_SHOTS
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
  const signIn = async (name, pin) => {
    await h.page.waitForSelector('[data-screen="lock"]', { state: 'attached', timeout: 15000 })
    await h.clickText(name)
    await h.fill('input-pin', pin)
    await h.click('btn-unlock')
    await h.waitScreen('gateway')
  }
  const rowTexts = () =>
    h.page.$$eval('[data-testid="rows-edit-log"] tr[data-row-id]', (trs) =>
      trs.map((tr) => ({ id: Number(tr.getAttribute('data-row-id')), entity: tr.getAttribute('data-entity'), action: tr.getAttribute('data-action'), text: tr.textContent }))
    )

  // ---------- 1. before any user exists: attributed to the OS login ----------
  const groups = await h.invoke('master:groups:list')
  const gid = (name) => groups.find((g) => g.name === name).id
  const rent = await h.invoke('master:ledgers:create', { name: 'Shop Rent', groupId: gid('Indirect Expenses') })
  const owner = await h.invoke('users:save', { data: { name: 'Priya Owner', role: 'owner', pin: '1234', active: true } })
  await h.invoke('users:save', { data: { name: 'Arun Accountant', role: 'accountant', pin: '2222', active: true } })

  // ---------- 2. the accountant posts and edits a voucher ----------
  await h.relaunch()
  await h.stubDialogs({})
  assertEq(await h.openCompany('Audit Trail Co'), 'lock', 'a company with users asks for sign-in')
  await signIn('Arun Accountant', '2222')
  const ledgers = await h.invoke('master:ledgers:list')
  const cash = ledgers.find((l) => l.name === 'Cash').id
  const types = await h.invoke('master:voucherTypes:list')
  const payment = types.find((t) => t.kind === 'payment').id
  const fy = await h.page.evaluate(() => new Date().getMonth() >= 3 ? new Date().getFullYear() : new Date().getFullYear() - 1)
  const voucher = (amount) => ({
    voucherTypeId: payment, date: `${fy}-05-10`, partyLedgerId: null, narration: 'May rent', reference: null, instrumentNo: null, instrumentDate: null,
    transporterId: null, vehicleNo: null, transportDistanceKm: null, currencyCode: null, exchangeRate: null,
    lines: [
      { ledgerId: rent.id, drCr: 'dr', amount, costAllocations: [] },
      { ledgerId: cash, drCr: 'cr', amount, costAllocations: [] }
    ],
    inventory: [], billRefs: [], tds: null
  })
  const saved = await h.invoke('voucher:save', { data: voucher(2500000) })
  await h.invoke('voucher:save', { id: saved.id, data: voucher(2750000) })

  // ---------- 3. the owner bins it and keeps the trail-required flag on through the UI ----------
  await h.click('btn-lock')
  await signIn('Priya Owner', '1234')
  await h.invoke('voucher:delete', { id: saved.id })
  await h.invoke('company:lock:set', { date: `${fy}-04-30` })

  // Settings → Audit trail: banner + retention (owner may change it).
  await h.goto('settings')
  await h.click('tab-settings-audit')
  await h.page.waitForSelector('[data-testid="audit-chain-banner"]', { timeout: 15000 })
  assertEq(await h.page.getAttribute('[data-testid="audit-chain-status"]', 'data-ok'), 'true', 'settings banner: chain verified')
  const required = h.page.locator('[data-testid="input-audit-required"]')
  assert(await required.isChecked(), 'audit trail required is ON by default')
  assert(await required.isEnabled(), 'the owner may change it')
  await required.uncheck()
  await h.page.waitForSelector('[data-testid="input-audit-keep-years"]', { timeout: 10000 })
  await bothThemes('30-01-settings-audit-off')
  await required.check()
  await h.page.waitForFunction(() => document.querySelector('[data-testid="audit-retention-status"]')?.textContent === 'Keep every entry forever.')
  await bothThemes('30-02-settings-audit')

  // ---------- 4. the edit log ----------
  await h.click('btn-open-edit-log')
  await h.waitScreen('audit-trail')
  await h.page.waitForSelector('[data-testid="rows-edit-log"] tr[data-row-id]', { timeout: 15000 })
  await h.page.waitForSelector('[data-testid="audit-chain-banner"][data-tone="success"]', { timeout: 15000 })
  const rows = await rowTexts()
  const has = (pred, label) => assert(rows.some(pred), label)
  has((r) => r.entity === 'ledger' && r.action === 'create' && /Shop Rent/.test(r.text) && /\(OS login\)/.test(r.text), 'ledger create by the OS login')
  has((r) => r.entity === 'user' && r.action === 'create' && /Arun Accountant|Priya Owner/.test(r.text), 'user creation logged')
  has((r) => r.entity === 'voucher' && r.action === 'create' && /Arun Accountant/.test(r.text), 'voucher create by the accountant')
  has((r) => r.entity === 'voucher' && r.action === 'update' && /Arun Accountant/.test(r.text), 'voucher edit by the accountant')
  has((r) => r.entity === 'voucher' && r.action === 'delete' && /Priya Owner/.test(r.text), 'voucher bin by the owner')
  has((r) => r.entity === 'company' && /Priya Owner/.test(r.text), 'settings change by the owner')
  has((r) => r.entity === 'user' && r.action === 'login' && /Arun Accountant/.test(r.text), 'sign-in logged')
  assert(rows.every((r) => /Verified/.test(r.text)), 'every row verifies')
  await bothThemes('30-03-edit-log')

  // Expand the voucher edit: field-level changes.
  const edit = rows.find((r) => r.entity === 'voucher' && r.action === 'update')
  await h.page.click(`[data-testid="rows-edit-log"] tr[data-row-id="${edit.id}"]`)
  const detail = h.page.locator(`[data-testid="audit-detail-${edit.id}"]`)
  await detail.waitFor({ timeout: 10000 })
  const detailText = await detail.textContent()
  assert(/lines\[0\]\.amount/.test(detailText) && /2500000/.test(detailText) && /2750000/.test(detailText), `voucher edit diff shows the amount change: ${detailText}`)
  await bothThemes('30-04-edit-log-diff')

  // User filter.
  await h.page.selectOption('[data-testid="input-edit-log-user"]', 'Arun Accountant')
  await h.page.waitForFunction(() => {
    const trs = [...document.querySelectorAll('[data-testid="rows-edit-log"] tr[data-row-id]')]
    return trs.length > 0 && trs.every((tr) => tr.textContent.includes('Arun Accountant'))
  }, null, { timeout: 10000 })
  await shot('30-05-edit-log-user-filter-light')
  await h.page.selectOption('[data-testid="input-edit-log-user"]', '')

  // Options drawer.
  await h.page.keyboard.press('F12')
  await h.page.waitForSelector('[data-testid="options-period"]', { timeout: 10000 })
  await bothThemes('30-06-edit-log-options')
  await h.page.keyboard.press('Escape')

  // ---------- 5. exports with the auditor header ----------
  const exportsDir = path.join(companyDir, 'exports')
  const before = new Set(fs.existsSync(exportsDir) ? fs.readdirSync(exportsDir) : [])
  await h.click('edit-log-csv')
  await h.page.waitForFunction(() => /entries saved to exports/.test(document.body.innerText), null, { timeout: 20000 })
  await h.click('edit-log-pdf')
  await h.page.waitForFunction(() => (document.body.innerText.match(/entries saved to exports/g) ?? []).length >= 1 && /\.pdf/.test(document.body.innerText), null, { timeout: 30000 })
  const fresh = fs.readdirSync(exportsDir).filter((f) => !before.has(f))
  const csvFile = fresh.find((f) => /^edit-log-.*\.csv$/.test(f))
  assert(csvFile, `edit-log CSV written (${fresh.join(', ')})`)
  assert(fresh.some((f) => /^edit-log-.*\.pdf$/.test(f)), 'edit-log PDF written')
  const csv = fs.readFileSync(path.join(exportsDir, csvFile), 'utf8')
  assert(/Company: Audit Trail Co/.test(csv), 'CSV header: company')
  assert(/Period: \d{4}-\d{2}-\d{2} to \d{4}-\d{2}-\d{2}/.test(csv), 'CSV header: period')
  assert(/Generated: \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/.test(csv), 'CSV header: generation time')
  assert(/Chain verified: \d+ entries/.test(csv), 'CSV header: chain verification')
  assert(/Arun Accountant/.test(csv) && /lines\[0\]\.amount: 2500000 → 2750000/.test(csv), 'CSV rows: user + field-level change')

  const v = await h.invoke('audit:verify')
  assert(v.ok && v.rows > 10, `chain verifies over IPC (${v.rows} rows)`)
  assertEq(owner.name, 'Priya Owner', 'owner')

  // ---------- 6. tamper with the file outside the app → the break is reported ----------
  let sqlite = null
  try {
    execFileSync('sqlite3', ['-version'], { stdio: 'ignore' })
    sqlite = 'sqlite3'
  } catch {
    console.log('[30-audit-trail] sqlite3 CLI not found — skipping the tamper check')
  }
  if (sqlite) {
    await h.close()
    const dbPath = path.join(companyDir, 'company.db')
    execFileSync(sqlite, [dbPath, `DROP TRIGGER audit_log_append_only; UPDATE audit_log SET after_json = replace(after_json, '2750000', '2700000') WHERE id = ${edit.id};`])
    await h.launch()
    await h.stubDialogs({})
    await h.openCompany('Audit Trail Co')
    await signIn('Priya Owner', '1234')
    await h.goto('audit-trail')
    await h.page.waitForSelector('[data-testid="audit-chain-banner"][data-tone="danger"]', { timeout: 15000 })
    const banner = await h.page.textContent('[data-testid="audit-chain-banner"]')
    assert(banner.includes(`Chain broken at row ${edit.id}`), `banner names the tampered row: ${banner}`)
    await h.page.waitForSelector(`[data-testid="audit-hash-${edit.id}"]`, { timeout: 10000 })
    assertEq(await h.page.textContent(`[data-testid="audit-hash-${edit.id}"]`), 'Altered', 'tampered row marked Altered')
    await bothThemes('30-07-edit-log-broken')
  }
})
