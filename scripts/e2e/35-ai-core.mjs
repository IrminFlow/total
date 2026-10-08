// Scenario 35 — AI agent core (WP 5.1), offline: TOTAL_AI_MOCK=1 swaps the network provider for
// the scripted demo assistant (honoured only with the scratch TOTAL_DATA_DIR the harness sets, in
// an unpackaged build). Settings → AI: accept the data notice, turn it on, save a key, test the
// connection. Then the Assistant panel: "What were sales in July?" → a profit-and-loss tool chip
// and an answer quoting the figure with its source; "Pay … shop rent in cash" → a draft card →
// Review draft opens the real voucher editor pre-filled → save → the draft is consumed and the
// voucher is in the books. Usage, cost and the outbound log show up in Settings. Every view is
// shot in both themes; set WP51_SHOTS=/tmp/wp51 to also copy the screenshots there.
import fs from 'node:fs'
import path from 'node:path'
import { scenario, assert, assertEq } from '../lib/harness.mjs'

process.env.TOTAL_AI_MOCK = '1'

const KEY = 'sk-test-e2e-0123456789abcdefWXYZ'

await scenario('35-ai-core', async (h) => {
  await h.createCompanyUI('AI Core Co')
  const extraShots = process.env.WP51_SHOTS
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
    await h.page.waitForTimeout(300)
  }
  const bothThemes = async (name) => {
    await setTheme('light')
    await shot(`${name}-light`)
    await setTheme('dark')
    await shot(`${name}-dark`)
    await setTheme('light')
  }

  // ---------- books: a July sale, a rent ledger ----------
  const groups = await h.invoke('master:groups:list')
  const gid = (name) => groups.find((g) => g.name === name).id
  const ledger = (name, group) =>
    h.invoke('master:ledgers:create', { name, groupId: gid(group), openingBalance: 0, gstin: null, stateCode: null, address: null, taxType: null, gstRate: null, hsn: null, tdsSectionId: null, pan: null, creditDays: null, exportType: null })
  const sales = await ledger('Sales', 'Sales Accounts')
  const rent = await ledger('Shop Rent', 'Indirect Expenses')
  const acme = await ledger('Acme Traders', 'Sundry Debtors')
  const ledgers = await h.invoke('master:ledgers:list')
  const cash = ledgers.find((l) => l.name === 'Cash').id
  const types = await h.invoke('master:voucherTypes:list')
  const journalType = types.find((t) => t.kind === 'journal').id
  const fy = await h.page.evaluate(() => (new Date().getMonth() >= 3 ? new Date().getFullYear() : new Date().getFullYear() - 1))
  await h.invoke('voucher:save', {
    data: {
      voucherTypeId: journalType, date: `${fy}-07-12`, partyLedgerId: null, narration: 'July sale', reference: null, instrumentNo: null, instrumentDate: null,
      transporterId: null, vehicleNo: null, transportDistanceKm: null, currencyCode: null, exchangeRate: null,
      lines: [
        { ledgerId: acme.id, drCr: 'dr', amount: 10000000, costAllocations: [] },
        { ledgerId: sales.id, drCr: 'cr', amount: 10000000, costAllocations: [] }
      ],
      inventory: [], billRefs: [], tds: null
    }
  })

  // ---------- off by default: the panel says so and sends nothing ----------
  await h.click('btn-assistant')
  await h.page.waitForSelector('[data-testid="ai-panel"] [data-testid="ai-off-banner"]', { timeout: 10000 })
  assert(await h.page.$eval('[data-testid="ai-input"]', (el) => el.disabled), 'the question box is disabled while AI is off')
  await bothThemes('01-panel-off')
  await h.click('btn-ai-open-settings')
  await h.waitScreen('settings')
  await h.page.waitForSelector('[data-testid="settings-ai"]', { timeout: 10000 })
  assertEq((await h.invoke('ai:outbound')).length, 0, 'nothing was sent while off')

  // ---------- Settings → AI: notice, switch, key, test connection ----------
  assert(await h.page.$eval('[data-testid="input-ai-enabled"]', (el) => el.disabled), 'the switch waits for the notice')
  await bothThemes('02-settings-notice')
  await h.click('btn-ai-accept-notice')
  await h.page.waitForSelector('[data-testid="ai-notice-accepted"]', { timeout: 10000 })
  await h.click('input-ai-enabled')
  await h.page.waitForFunction(() => document.querySelector('[data-testid="input-ai-enabled"]')?.checked === true, null, { timeout: 10000 })
  await h.fill('input-ai-key', KEY)
  await h.click('btn-ai-save-key')
  // No company here has users: the shared key needs an explicit confirmation.
  await h.click('confirm-ok')
  await h.page.waitForFunction(() => document.body.textContent.includes('A key is saved (…WXYZ)'), null, { timeout: 10000 })
  const leaked = await h.page.evaluate((k) => document.documentElement.outerHTML.includes(k), KEY)
  assert(!leaked, 'the API key never appears in the page')
  await h.click('btn-ai-test')
  await h.page.waitForSelector('[data-testid="ai-test-result"][data-ok="true"]', { timeout: 10000 })
  const view = await h.invoke('ai:settings:get')
  assertEq(view.ready, true, 'assistant ready')
  assertEq(view.mock, true, 'the e2e runs on the mock provider')
  assert(!JSON.stringify(view).includes(KEY), 'ai:settings:get never returns the key')
  const companyDb = fs.readFileSync(path.join(h.dataDir, 'companies', 'ai-core-co', 'company.db')).toString('latin1')
  assert(!companyDb.includes(KEY), 'the key is not in the company database')
  await bothThemes('03-settings-on')

  // ---------- ask: sales in July → tool chip + sourced answer ----------
  await h.click('btn-assistant')
  await h.page.waitForSelector('[data-testid="ai-panel"]', { timeout: 10000 })
  await h.fill('ai-input', 'What were sales in July?')
  await h.page.press('[data-testid="ai-input"]', 'Enter')
  await h.page.waitForSelector('[data-testid="ai-tool-chip"][data-tool="profit_and_loss"][data-status="ok"]', { timeout: 20000 })
  const answer = await h.page.waitForSelector('[data-testid="ai-msg-answer"]', { timeout: 20000 })
  const text = await answer.textContent()
  assert(text.includes('Sales in July were ₹1,00,000.00'), `answer quotes the P&L figure: ${text}`)
  assert(!(await h.page.$('[data-testid="ai-unsourced"]')), 'every figure in the answer is sourced')
  const sources = await h.page.$eval('[data-testid="ai-msg-answer"] [data-testid="ai-sources"]', (el) => el.textContent)
  assert(sources.includes('Profit & loss'), `answer links its source: ${sources}`)
  assert((await h.page.$eval('[data-testid="ai-msg-answer"] [data-testid="ai-cost"]', (el) => el.textContent)).includes('tokens'), 'cost line shown')
  await h.click('ai-tool-chip-profit_and_loss')
  await h.page.waitForSelector('[data-testid="ai-tool-detail"]', { timeout: 5000 })
  await bothThemes('04-panel-answer')

  // ---------- draft a payment → review → save ----------
  await h.fill('ai-input', 'Pay 2,500 shop rent in cash')
  await h.page.press('[data-testid="ai-input"]', 'Enter')
  await h.page.waitForSelector('[data-testid="ai-draft-card"][data-status="open"]', { timeout: 20000 })
  await h.page.waitForFunction(() => document.querySelector('[data-testid="btn-ai-send"]'), null, { timeout: 20000 })
  const vouchersBefore = (await h.invoke('voucher:list', { from: `${fy}-04-01`, to: `${fy + 1}-03-31` })).length
  await bothThemes('05-panel-draft')
  const [draft] = await h.invoke('ai:drafts', { status: 'open' })
  assert(draft && draft.summary.includes('₹2,500.00') && draft.summary.includes('Shop Rent'), `draft summary: ${draft?.summary}`)
  assertEq((await h.invoke('voucher:list', { from: `${fy}-04-01`, to: `${fy + 1}-03-31` })).length, vouchersBefore, 'drafting wrote nothing to the books')

  await h.click('btn-ai-review-draft')
  await h.waitScreen('voucher-entry')
  await h.page.waitForSelector('[data-testid="ai-draft-banner"]', { timeout: 10000 })
  assertEq(await h.page.$('[data-testid="ai-panel"]'), null, 'the panel closed for the review')
  // The pre-filled first line is focused with its list open: the highlight must sit on its own
  // ledger, and ⌘↵ / Ctrl+↵ must save rather than pick another one.
  await bothThemes('06-review-draft')
  await h.page.keyboard.press('Control+Enter')
  await h.page.waitForFunction(() => document.querySelector('[data-screen]')?.getAttribute('data-screen') !== 'voucher-entry', null, { timeout: 15000 })

  const after = await h.invoke('ai:draft:get', { id: draft.id })
  assertEq(after.status, 'consumed', 'saving the reviewed draft consumes it')
  assert(after.voucherId > 0, 'the draft points at the saved voucher')
  const saved = await h.invoke('voucher:get', { id: after.voucherId })
  assertEq(saved.lines.find((l) => l.ledgerId === rent.id)?.amount, 250000, 'rent debited ₹2,500.00 (the save kept the drafted ledger)')
  assertEq(saved.lines.find((l) => l.ledgerId === cash)?.drCr, 'cr', 'cash credited')
  const audit = await h.invoke('audit:list', { entity: 'ai_draft' })
  assert(audit.rows.some((r) => r.action === 'update'), 'draft consumption is in the audit trail')

  // ---------- usage, cost and the outbound log ----------
  const usage = await h.invoke('ai:usage')
  assert(usage.length >= 5, `one usage row per model call (${usage.length})`)
  const outbound = await h.invoke('ai:outbound')
  assertEq(outbound.length, usage.length, 'one outbound row per call')
  assert(outbound.every((o) => o.masked && /^[0-9a-f]{64}$/.test(o.payloadSha256)), 'outbound rows: masked, fingerprinted')
  await h.goto('settings')
  await h.click('tab-settings-ai')
  await h.page.waitForSelector('[data-testid="rows-ai-usage"] tr', { timeout: 10000 })
  await h.page.waitForSelector('[data-testid="rows-ai-outbound"] tr', { timeout: 10000 })
  await h.page.evaluate(() => document.querySelector('[data-testid="ai-usage-total"]')?.scrollIntoView({ block: 'start' }))
  await bothThemes('07-settings-usage')
  await h.page.evaluate(() => document.querySelector('[data-testid="rows-ai-outbound"]')?.scrollIntoView({ block: 'center' }))
  await bothThemes('08-settings-outbound')
})
