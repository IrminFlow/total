// Scenario 44 — the assistants (WP 5.5), offline: TOTAL_AI_MOCK=1 swaps the network provider for
// the scripted demo assistant (honoured only with the scratch TOTAL_DATA_DIR the harness sets, in
// an unpackaged build).
//
// With AI OFF, Analysis → Assistants works on its own: the month-end close checklist (statuses,
// rows behind a check, Mark done with a note), GST 2B (paste a 2B JSON → mismatches by category →
// "Draft the purchase" opens the voucher editor in accounting mode on a DRAFT → save → the
// mismatch is gone), anomalies (a duplicate payment, dismissed with a note) and a report from a
// question (opens the report builder pre-filled; saved). Then AI ON: "Run with AI" opens the panel
// with close_checklist already run and an answer quoting it; "make a report of sales by month"
// calls build_report and its link opens the builder. Every view is shot in both themes; set
// WP55_SHOTS=/tmp/wp55 to also copy the screenshots there.
import fs from 'node:fs'
import path from 'node:path'
import { scenario, assert, assertEq } from '../lib/harness.mjs'

process.env.TOTAL_AI_MOCK = '1'

const GSTIN = '27AAPFU0939F1ZV'

await scenario('44-ai-assistants', async (h) => {
  await h.createCompanyUI('Assistants Co')
  const extraShots = process.env.WP55_SHOTS
  const shot = async (name) => {
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
    await h.page.waitForTimeout(300)
  }
  const bothThemes = async (name) => {
    await h.page.mouse.move(0, 0)
    await setTheme('light')
    await shot(`${name}-light`)
    await setTheme('dark')
    await shot(`${name}-dark`)
    await setTheme('light')
  }
  const tab = async (id) => {
    await h.click(`tab-assistants-${id}`)
    await h.waitScreen('assistants')
  }

  // ---------- the month the close tab opens on (the previous month) ----------
  await h.goto('assistants')
  await h.page.waitForSelector('[data-testid="rows-assistants-close"] tr[data-row-id="lock"]', { timeout: 15000 })
  const month = await h.page.$eval('[data-testid="input-assistants-close-month"]', (el) => el.value)
  const day = (d) => `${month}-${String(d).padStart(2, '0')}`
  assertEq(await h.page.$('[data-testid="btn-assistants-close-ai"]'), null, 'no Run with AI while the assistant is off')

  // ---------- books ----------
  const groups = await h.invoke('master:groups:list')
  const gid = (name) => groups.find((g) => g.name === name).id
  const ledger = (name, group, over = {}) =>
    h.invoke('master:ledgers:create', { name, groupId: gid(group), openingBalance: 0, gstin: null, stateCode: null, address: null, taxType: null, gstRate: null, hsn: null, tdsSectionId: null, pan: null, creditDays: null, exportType: null, ...over })
  const sales = await ledger('Sales', 'Sales Accounts')
  const purchases = await ledger('Purchases', 'Purchase Accounts')
  const rent = await ledger('Shop Rent', 'Indirect Expenses')
  const bank = await ledger('HDFC Current', 'Bank Accounts')
  const acme = await ledger('Acme Supplies', 'Sundry Creditors', { gstin: GSTIN, stateCode: '27' })
  const buyer = await ledger('Bharat Retail', 'Sundry Debtors')
  const cgst = await ledger('Input CGST', 'Duties & Taxes', { taxType: 'cgst' })
  const sgst = await ledger('Input SGST', 'Duties & Taxes', { taxType: 'sgst' })
  await ledger('Suspense', 'Suspense A/c', { openingBalance: 25_000_00 })
  const types = await h.invoke('master:voucherTypes:list')
  const typeOf = (kind) => types.find((t) => t.kind === kind).id
  const save = (kind, date, lines, extra = {}) =>
    h.invoke('voucher:save', {
      data: {
        voucherTypeId: typeOf(kind), date, partyLedgerId: extra.party ?? null, narration: extra.narration ?? 'entry', reference: extra.reference ?? null, instrumentNo: null, instrumentDate: null,
        transporterId: null, vehicleNo: null, transportDistanceKm: null, currencyCode: null, exchangeRate: null,
        lines: lines.map(([ledgerId, drCr, amount]) => ({ ledgerId, drCr, amount, costAllocations: [] })), inventory: [], billRefs: [], tds: null
      }
    })
  await save('payment', day(3), [[rent.id, 'dr', 30_000_00], [bank.id, 'cr', 30_000_00]], { narration: 'Shop rent' })
  await save('payment', day(5), [[acme.id, 'dr', 25_000_00], [bank.id, 'cr', 25_000_00]], { party: acme.id, narration: 'Advance to Acme' })
  await save('payment', day(6), [[acme.id, 'dr', 25_000_00], [bank.id, 'cr', 25_000_00]], { party: acme.id, narration: 'Advance to Acme again' })
  await save('sales', day(8), [[buyer.id, 'dr', 1_20_000_00], [sales.id, 'cr', 1_20_000_00]], { party: buyer.id, narration: 'Sales to Bharat' })
  await save('purchase', day(10), [[purchases.id, 'dr', 10_000_00], [cgst.id, 'dr', 900_00], [sgst.id, 'dr', 900_00], [acme.id, 'cr', 11_800_00]], { party: acme.id, reference: 'A-1' })

  // ---------- AI off: the close checklist ----------
  await h.goto('daybook')
  await h.goto('assistants')
  const status = (key) => h.page.$eval(`[data-testid="close-status-${key}"]`, (el) => el.textContent)
  await h.page.waitForSelector('[data-testid="close-status-suspense"]', { timeout: 15000 })
  assertEq(await status('suspense'), 'Action', 'a suspense balance must be cleared')
  assertEq(await status('bank_reconciliation'), 'Review', 'bank entries without a bank date')
  await bothThemes('01-close-checklist')
  // The rows behind a check.
  await h.page.click('[data-testid="rows-assistants-close"] tr[data-row-id="bank_reconciliation"] [aria-expanded]')
  await h.page.waitForSelector('[data-testid="rows-assistants-close-bank_reconciliation"] tr', { timeout: 10000 })
  await bothThemes('02-close-rows')
  // Mark done with a note.
  await h.click('btn-assistants-close-done-suspense')
  await h.fill('prompt-input', 'Opening difference cleared with the CA')
  await h.click('prompt-ok')
  await h.page.waitForFunction(() => document.querySelector('[data-testid="close-status-suspense"]')?.textContent === 'Done', null, { timeout: 10000 })
  const list = await h.invoke('assist:close', { period: month })
  assertEq(list.checks.find((c) => c.key === 'suspense').mark.note, 'Opening difference cleared with the CA', 'the mark is kept with its note')

  // ---------- GST 2B ----------
  await tab('gst2b')
  const [y, m] = month.split('-')
  const twoB = JSON.stringify({
    data: {
      rtnprd: `${m}${y}`,
      docdata: { b2b: [{ ctin: GSTIN, inv: [
        { inum: 'A-1', idt: `10-${m}-${y}`, val: 11800, items: [{ txval: 10000, camt: 900, samt: 900 }] },
        { inum: 'A-2', idt: `12-${m}-${y}`, val: 5900, items: [{ txval: 5000, camt: 450, samt: 450 }] }
      ] }] }
    }
  })
  await h.click('btn-assistants-2b-paste')
  await h.fill('input-assistants-2b-paste', twoB)
  await h.click('btn-assistants-2b-paste-apply')
  await h.page.waitForSelector('[data-testid="rows-assistants-2b"] tr[data-category="missing_in_books"]', { timeout: 15000 })
  assert((await h.page.$eval('[data-testid="assistants-2b-statement"]', (el) => el.textContent)).includes('1 matched'), 'A-1 matches the books')
  await bothThemes('03-gst2b-mismatches')
  await h.click('btn-assistants-2b-draft-missing_in_books')
  await h.waitScreen('voucher-entry')
  await h.page.waitForSelector('[data-testid="voucher-entry-mode"][data-mode="accounting"]', { timeout: 10000 })
  await h.page.waitForSelector('[data-testid="ai-draft-banner"]', { timeout: 10000 })
  const drafts = await h.invoke('ai:drafts', { status: 'open' })
  assertEq(drafts.length, 1, 'one open draft — nothing posted yet')
  assertEq(drafts[0].origin, 'GST 2B assistant', 'the draft says where it came from')
  await bothThemes('04-draft-purchase')
  await h.click('btn-save-voucher')
  await h.page.waitForFunction(() => document.querySelector('[data-screen]')?.getAttribute('data-screen') !== 'voucher-entry', null, { timeout: 15000 })
  assertEq((await h.invoke('ai:drafts', { status: 'consumed' })).length, 1, 'saving consumed the draft')
  const after = await h.invoke('assist:gst2b', { period: month })
  assertEq(after.matched, 2, 'the saved purchase now matches 2B')
  assertEq(after.rows.filter((r) => r.category === 'missing_in_books').length, 0, 'nothing missing in the books any more')

  // ---------- anomalies ----------
  await h.goto('assistants')
  await tab('anomalies')
  await h.page.waitForSelector('[data-testid="rows-assistants-anomalies"] tr[data-kind="duplicate_party_amount"]', { timeout: 15000 })
  await bothThemes('05-anomalies')
  await h.page.click('[data-testid="rows-assistants-anomalies"] tr[data-kind="duplicate_party_amount"] [data-testid="btn-assistants-anomaly-dismiss"]')
  await h.fill('prompt-input', 'Two separate advances, agreed with Acme')
  await h.click('prompt-ok')
  await h.page.waitForSelector('[data-testid="rows-assistants-anomalies"] tr[data-kind="duplicate_party_amount"]', { state: 'detached', timeout: 10000 })

  // ---------- report from a question (no AI) ----------
  await tab('report')
  await h.fill('input-assistants-report-question', 'sales by month')
  await h.click('btn-assistants-report-build')
  await h.page.waitForFunction(() => document.querySelector('[data-testid="rows-assistants-report"]')?.textContent?.includes('1,20,000.00'), null, { timeout: 15000 })
  await bothThemes('06-report-from-question')
  await h.click('btn-assistants-report-open')
  await h.waitScreen('report-builder')
  await h.page.waitForTimeout(800)
  await bothThemes('07-report-builder-prefilled')

  // ---------- AI on: Run with AI, build_report ----------
  await h.invoke('ai:notice:accept')
  await h.invoke('ai:settings:set', { enabled: true })
  await h.goto('settings')
  await h.goto('assistants')
  await h.page.waitForSelector('[data-testid="btn-assistants-close-ai"]', { timeout: 15000 })
  await h.click('btn-assistants-close-ai')
  await h.page.waitForSelector('[data-testid="ai-tool-chip"][data-tool="close_checklist"][data-status="ok"]', { timeout: 20000 })
  await h.page.waitForSelector('[data-testid="ai-panel"] [data-testid="ai-msg-answer"]', { timeout: 20000 })
  const answer = await h.page.$eval('[data-testid="ai-msg-answer"]', (el) => el.textContent)
  assert(answer.includes('Close checklist'), `the answer narrates the checklist: ${answer}`)
  assertEq(await h.page.$('[data-testid="ai-msg-answer"] [data-testid="ai-figure"][data-sourced="false"]'), null, 'every figure in the answer is sourced')
  await bothThemes('08-run-with-ai')

  await h.fill('ai-input', 'Make a report of sales by month')
  await h.click('btn-ai-send')
  await h.page.waitForSelector('[data-testid="ai-tool-chip"][data-tool="build_report"][data-status="ok"]', { timeout: 20000 })
  await h.page.waitForFunction(() => document.querySelectorAll('[data-testid="ai-panel"] [data-testid="ai-msg-answer"]').length >= 2, null, { timeout: 20000 })
  await bothThemes('09-build-report-answer')
  await h.page.click('[data-testid="ai-source-screen"][data-screen-target="report-builder"]')
  await h.waitScreen('report-builder')
  assertEq((await h.invoke('ai:outbound')).length >= 2, true, 'the AI calls are in the outbound log')
  h.assertNoConsoleErrors()
})
