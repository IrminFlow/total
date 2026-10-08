// Scenario 31 — banking depth (WP 4.1). Demo Traders' HDFC Bank:
//   1. import a bank CSV whose header the detector can't read → map the columns in the UI →
//      the mapping is saved for the bank; the two lines are proposed against book entries,
//      pre-selected, and confirmed in bulk (bank dates set);
//   2. a second statement in the same layout opens with the saved mapping; its lines have no book
//      entries, so the rules learned from step 1 suggest the ledgers ("Suggested from 1 earlier
//      match") and the vouchers are created in bulk;
//   3. a cheque book is added and "Print cheque" on a payment voucher issues the next leaf;
//   4. beneficiary details are set and a bulk NEFT/RTGS file is exported in the Union Bank layout;
//   5. post-dated register + rules + cheque layout + every tab are shot in both themes.
// Set WP41_SHOTS=/tmp/wp41 to also copy the screenshots there.
import fs from 'node:fs'
import path from 'node:path'
import { scenario, assert, assertEq } from '../lib/harness.mjs'

await scenario('31-banking-depth', async (h) => {
  await h.createDemoCompany()
  const extraShots = process.env.WP41_SHOTS
  const shot = async (name) => {
    await h.page.mouse.move(0, 0)
    await h.page.waitForTimeout(300)
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
    await h.page.waitForTimeout(350)
  }
  const bothThemes = async (name) => {
    await setTheme('light')
    await shot(`${name}-light`)
    await setTheme('dark')
    await shot(`${name}-dark`)
    await setTheme('light')
  }
  const rows = (area) => h.page.$$eval(`[data-testid="rows-${area}"] tr.dt-row`, (trs) => trs.map((tr) => ({ id: tr.getAttribute('data-row-id'), status: tr.getAttribute('data-status'), text: tr.textContent })))
  const pick = async (selector, text) => {
    const input = h.page.locator(selector).first()
    await input.click()
    await input.fill(text)
    await h.page.waitForSelector('[role="option"]', { timeout: 10000 })
    await input.press('Enter')
  }

  // ---------- fixtures: a party, a rent ledger, two open bank entries ----------
  const banks = await h.invoke('bank:ledgers')
  const hdfc = banks.find((b) => b.name === 'HDFC Bank') ?? banks[0]
  assert(hdfc, 'demo company has a bank ledger')
  const groups = await h.invoke('master:groups:list')
  const gid = (name) => groups.find((g) => g.name === name).id
  const blank = { openingBalance: 0, gstin: null, stateCode: null, address: null, taxType: null, gstRate: null, hsn: null, tdsSectionId: null, pan: null, creditDays: null, exportType: null }
  const acme = await h.invoke('master:ledgers:create', { ...blank, name: 'Acme Wholesale', groupId: gid('Sundry Debtors') })
  const rent = await h.invoke('master:ledgers:create', { ...blank, name: 'Shop Rent', groupId: gid('Indirect Expenses') })
  const types = await h.invoke('master:voucherTypes:list')
  const vt = (kind) => types.find((t) => t.kind === kind && t.isSystem !== false).id
  const iso = (daysAgo) => new Date(Date.now() - daysAgo * 86400000).toISOString().slice(0, 10)
  const dmy = (d) => `${d.slice(8, 10)}/${d.slice(5, 7)}/${d.slice(0, 4)}`
  const voucher = (kind, date, party, lines, extra = {}) => ({
    voucherTypeId: vt(kind), date, partyLedgerId: party, narration: null, reference: null, instrumentNo: null, instrumentDate: null,
    transporterId: null, vehicleNo: null, transportDistanceKm: null, currencyCode: null, exchangeRate: null,
    lines: lines.map((l) => ({ ...l, costAllocations: [] })), inventory: [], billRefs: [], tds: null, ...extra
  })
  const d1 = iso(6)
  const d2 = iso(5)
  const receipt = await h.invoke('voucher:save', { data: voucher('receipt', d1, acme.id, [{ ledgerId: hdfc.id, drCr: 'dr', amount: 2500037 }, { ledgerId: acme.id, drCr: 'cr', amount: 2500037 }]) })
  const payment = await h.invoke('voucher:save', { data: voucher('payment', d2, null, [{ ledgerId: rent.id, drCr: 'dr', amount: 1800011 }, { ledgerId: hdfc.id, drCr: 'cr', amount: 1800011 }]) })

  // A bank layout the detector can't read: preamble, then 'On | Details | Out | In | Left'.
  const tmp = fs.mkdtempSync(path.join(h.dataDir, 'stmt-'))
  const csv1 = path.join(tmp, 'hdfc-august.csv')
  fs.writeFileSync(csv1, [
    'Demo Traders,,,,',
    'Account 50100012345678,,,,',
    'On,Details,Out,In,Left',
    `${dmy(d1)},NEFT CR-ICIC0000104-ACME WHOLESALE-N2142628,,"25,000.37","1,25,000.37"`,
    `${dmy(d2)},UPI-RAVI KUMAR-ravi@okhdfc-321456789012-SHOP RENT,"18,000.11",,"1,07,000.26"`
  ].join('\n'))

  // ---------- 1. import with a manual mapping, confirm matches ----------
  await h.stubDialogs({ openPaths: [csv1] })
  await h.goto('banking')
  await h.click('tab-banking-import')
  await h.page.waitForSelector('[data-testid="rows-banking-statement"]', { state: 'attached', timeout: 10000 })
  await h.click('btn-banking-pick-statement')
  await h.page.waitForSelector('[data-testid="banking-import-preview"]', { timeout: 10000 })
  assertEq((await rows('banking-import-lines')).length, 0, 'unreadable header: no lines until mapped')
  await h.page.selectOption('[data-testid="input-banking-map-headerRow"]', '3')
  await h.page.selectOption('[data-testid="input-banking-map-dateCol"]', '0')
  await h.page.selectOption('[data-testid="input-banking-map-descCol"]', '1')
  await h.page.selectOption('[data-testid="input-banking-map-debitCol"]', '2')
  await h.page.selectOption('[data-testid="input-banking-map-creditCol"]', '3')
  await h.page.selectOption('[data-testid="input-banking-map-balanceCol"]', '4')
  await h.click('btn-banking-apply-mapping')
  await h.page.waitForFunction(() => document.querySelectorAll('[data-testid="rows-banking-import-lines"] tr.dt-row').length === 2, null, { timeout: 10000 })
  await bothThemes('01-import-mapping')
  await h.click('btn-banking-commit-import')
  await h.page.waitForSelector('[data-testid="rows-banking-statement"] tr[data-has-proposal="1"]', { timeout: 10000 })
  const ws1 = await rows('banking-statement')
  assertEq(ws1.length, 2, 'two open statement lines')
  const picked = await h.page.$$eval('[data-testid="input-banking-line-pick"]', (xs) => xs.filter((x) => x.checked).length)
  assertEq(picked, 2, 'both exact proposals are pre-selected')
  await bothThemes('02-statement-proposals')
  await h.click('btn-banking-confirm-matches')
  await h.page.waitForFunction(() => document.querySelectorAll('[data-testid="rows-banking-statement"] tr.dt-row').length === 0, null, { timeout: 10000 })
  const savedProfile = await h.invoke('bankImport:profile', { bankLedgerId: hdfc.id, format: 'csv' })
  assertEq(savedProfile?.headerRow, 3, 'the mapping is remembered for the bank')
  const rec = await h.invoke('voucher:get', { id: receipt.id })
  assertEq(rec.lines.find((l) => l.ledgerId === hdfc.id).bankDate, d1, 'confirmed match set the bank date')
  const learned = await h.invoke('bankLearned:list')
  assert(learned.some((r) => r.ledgerId === rent.id && r.tokens.includes('RAVI')), 'a rule was learned from the rent match')

  // ---------- 2. second statement: saved mapping, learned suggestions, bulk create ----------
  const d3 = iso(2)
  const csv2 = path.join(tmp, 'hdfc-september.csv')
  fs.writeFileSync(csv2, [
    'Demo Traders,,,,',
    'Account 50100012345678,,,,',
    'On,Details,Out,In,Left',
    `${dmy(d3)},NEFT CR-ICIC0000104-ACME WHOLESALE-N9999999,,"12,000.00","1,19,000.26"`,
    `${dmy(d3)},UPI-RAVI KUMAR-ravi@okhdfc-999456789012-SHOP RENT,"18,000.11",,"1,00,999.15"`
  ].join('\n'))
  await h.stubDialogs({ openPaths: [csv2] })
  await h.click('btn-banking-pick-statement')
  await h.page.waitForSelector('[data-testid="chip-banking-profile-saved"]', { timeout: 10000 })
  assertEq((await rows('banking-import-lines')).length, 2, 'saved mapping reads the second statement')
  await h.click('btn-banking-commit-import')
  await h.page.waitForSelector('[data-testid="rows-banking-statement"] tr[data-has-suggestion="1"]', { timeout: 10000 })
  const evidence = await h.page.$$eval('[data-testid="text-banking-evidence"]', (xs) => xs.map((x) => x.textContent))
  assertEq(evidence.length, 2, 'both lines carry a learned suggestion')
  assert(evidence.every((t) => t === 'Suggested from 1 earlier match'), `evidence text shown (${evidence.join(' | ')})`)
  await bothThemes('03-learned-suggestions')
  for (const box of await h.page.$$('[data-testid="input-banking-line-pick"]')) if (!(await box.isChecked())) await box.click()
  await h.click('btn-banking-create-vouchers')
  await h.page.waitForFunction(() => document.querySelectorAll('[data-testid="rows-banking-statement"] tr.dt-row').length === 0, null, { timeout: 10000 })
  await h.click('input-banking-show-done')
  await h.page.waitForFunction(() => document.querySelectorAll('[data-testid="rows-banking-statement"] tr[data-status="matched"]').length === 4, null, { timeout: 10000 })
  await shot('04-statement-done-light')
  const imports = await h.invoke('bankImport:imports', { bankLedgerId: hdfc.id })
  assertEq(imports[0].created, 2, 'two vouchers created from the second statement')

  // ---------- 3. cheque book + Print cheque from the payment voucher ----------
  await h.click('tab-banking-cheques')
  await h.click('btn-banking-add-chequebook')
  await h.fill('input-banking-chequebook-name', 'Book 1')
  await h.fill('input-banking-chequebook-from', '000101')
  await h.fill('input-banking-chequebook-to', '000150')
  await h.click('btn-banking-chequebook-save')
  await h.page.waitForSelector('[data-testid="banking-chequebooks"]', { timeout: 10000 })
  await h.click('btn-banking-cheque-setup')
  await h.page.waitForSelector('[data-testid="banking-cheque-preview"]', { timeout: 10000 })
  await bothThemes('05-cheque-layout')
  await h.page.keyboard.press('Escape')
  await h.goto('gateway')
  await h.goto('daybook')
  await h.page.click(`[data-testid="rows-daybook"] [data-row-id="${payment.id}"]`, { timeout: 10000 })
  await h.waitScreen('voucher-entry')
  await h.click('btn-voucher-print-cheque')
  let reg = []
  for (let i = 0; i < 60 && reg.length === 0; i++) {
    await h.page.waitForTimeout(500)
    reg = await h.invoke('cheques:register', { bankLedgerId: hdfc.id, includeAvailable: false })
  }
  assertEq(JSON.stringify(reg.map((r) => [r.number, r.status, r.voucherId])), JSON.stringify([['000101', 'cleared', payment.id]]), 'cheque 000101 issued to the payment (cleared: already reconciled)')
  const pv = await h.invoke('voucher:get', { id: payment.id })
  assertEq(pv.instrumentNo, '000101', 'the voucher carries the cheque number')
  const exportsDir = path.join(h.dataDir, 'companies', 'demo-traders', 'exports')
  const chequePdfs = () => (fs.existsSync(exportsDir) ? fs.readdirSync(exportsDir).filter((f) => f.startsWith('cheque-')) : [])
  for (let i = 0; i < 60 && chequePdfs().length === 0; i++) await h.page.waitForTimeout(500)
  const pdfs = chequePdfs()
  assert(pdfs.length >= 1, 'the cheque PDF was written')
  await h.goto('banking')
  await h.click('tab-banking-cheques')
  await h.page.waitForSelector('[data-testid="rows-banking-cheques"] tr[data-status="cleared"]', { timeout: 10000 })
  await bothThemes('06-cheque-register')

  // ---------- 4. bulk payment file ----------
  await h.invoke('bulkPay:setBankDetails', { ledgerId: hdfc.id, data: { accountNo: '50100012345678', ifsc: 'HDFC0001234', accountName: null, email: null } })
  await h.click('tab-banking-bulk')
  await h.click('bulk-section-beneficiaries')
  await h.page.waitForSelector(`[data-testid="rows-banking-beneficiaries"] tr[data-row-id="${acme.id}"]`, { timeout: 10000 })
  await bothThemes('07a-beneficiaries')
  // Rent is an expense ledger, not a party — its details are set from the payment row.
  await h.click('bulk-section-payments')
  await h.page.waitForSelector(`[data-testid="rows-banking-bulk"] tr[data-row-id="${payment.id}:${rent.id}"]`, { timeout: 10000 })
  await h.page.click(`[data-testid="rows-banking-bulk"] tr[data-row-id="${payment.id}:${rent.id}"] [data-testid="btn-bulk-fix"]`)
  await h.fill('input-bulk-ben-name', 'Ravi Kumar')
  await h.fill('input-bulk-ben-account', '1234567890123')
  await h.fill('input-bulk-ben-ifsc', 'SBIN0001234')
  await h.click('btn-bulk-ben-save')
  await h.page.waitForSelector(`[data-testid="rows-banking-bulk"] tr[data-row-id="${payment.id}:${rent.id}"][data-ready="1"]`, { timeout: 10000 })
  await h.page.selectOption('[data-testid="input-bulk-template"]', 'builtin:unionbank-neft-rtgs')
  await h.fill('input-bulk-corporate', 'DEMOTRADERS')
  await h.page.click(`[data-testid="rows-banking-bulk"] tr[data-row-id="${payment.id}:${rent.id}"] [data-testid="input-bulk-pick"]`)
  await bothThemes('07-bulk-payments')
  await h.click('btn-bulk-export')
  // The payment already has a cheque — confirm the double-payment warning.
  await h.clickText('Export anyway')
  await h.page.waitForFunction(() => document.querySelector('[data-testid="banking-bulk-batches"]') !== null, null, { timeout: 10000 })
  const batches = await h.invoke('bulkPay:batches', { bankLedgerId: hdfc.id })
  assertEq(batches.length, 1, 'one payment file recorded')
  const file = path.join(h.dataDir, 'companies', 'demo-traders', 'exports', batches[0].fileName)
  const text = fs.readFileSync(file, 'utf8').split('\r\n')
  assertEq(text[0], 'FILEHDR|DEMOTRADERS|1|N|', 'Union Bank FILEHDR line')
  assertEq(text[1], 'NEFT|HDFC0001234|50100012345678|SBIN0001234|1234567890123|INR|18000.11|' + `Payment ${payment.number}|Ravi Kumar||`, 'payment record in the published field order')

  // ---------- 5. the other tabs, both themes ----------
  await h.click('tab-banking-rules')
  await h.page.waitForSelector('[data-testid="rows-banking-learned"] tr.dt-row', { timeout: 10000 })
  await bothThemes('08-learned-rules')
  await h.invoke('voucher:save', { data: voucher('receipt', iso(-3), acme.id, [{ ledgerId: hdfc.id, drCr: 'dr', amount: 4500000 }, { ledgerId: acme.id, drCr: 'cr', amount: 4500000 }], { postDated: true, instrumentNo: '445566' }) })
  await h.click('tab-banking-pdc')
  await h.page.waitForSelector('[data-testid="rows-banking-pdc"] tr[data-status="pending"]', { timeout: 10000 })
  await bothThemes('09-pdc-register')
  await h.goto('gateway')
  await h.page.waitForSelector('[data-testid="dash-pdc"]', { timeout: 15000 })
  await bothThemes('10-gateway-pdc')

  h.assertNoConsoleErrors()
})
