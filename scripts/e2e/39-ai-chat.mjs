// Scenario 39 — the chat panel and "Explain this" (WP 5.2), offline: TOTAL_AI_MOCK=1 swaps the
// network provider for the scripted demo assistant (honoured only with the scratch TOTAL_DATA_DIR
// the harness sets, in an unpackaged build).
//
// AI off → no Explain-this affordances anywhere. Turn it on (notice + switch; the mock needs no
// key). Trial balance → hover Shop Rent's debit → AI → the docked panel opens beside the screen
// with a prefilled question, runs explain_figure and answers with a markdown table whose figures
// are chips; the closing balance chip opens the ledger statement (the panel stays docked).
// "What is on this screen?" reads current_screen_data. The palette offers "Ask AI" for a question
// and resolves "open the ledger for Acme" through search. Conversations: rename, pin. ⌘J toggles
// the panel; Esc closes it. The outbound log records the screen context that was sent.
// Every view is shot in both themes; set WP52_SHOTS=/tmp/wp52 to also copy the screenshots there.
import fs from 'node:fs'
import path from 'node:path'
import { scenario, assert, assertEq } from '../lib/harness.mjs'

process.env.TOTAL_AI_MOCK = '1'

await scenario('39-ai-chat', async (h) => {
  await h.createCompanyUI('AI Chat Co')
  const extraShots = process.env.WP52_SHOTS
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
  /** Both themes; `prepare` re-applies a hover (the theme toggle moves the mouse focus). */
  const bothThemes = async (name, prepare = async () => {}) => {
    await setTheme('light')
    await prepare()
    await shot(`${name}-light`)
    await setTheme('dark')
    await prepare()
    await shot(`${name}-dark`)
    await setTheme('light')
  }
  const panelAnswerCount = () => h.page.$$eval('[data-testid="ai-panel"] [data-testid="ai-msg-answer"]', (els) => els.length)
  const waitAnswers = (n) =>
    h.page.waitForFunction(
      (k) => document.querySelectorAll('[data-testid="ai-panel"] [data-testid="ai-msg-answer"]').length >= k && document.querySelector('[data-testid="btn-ai-send"]'),
      n,
      { timeout: 20000 }
    )

  // ---------- books: sales, rent paid in cash (one outsized month), a debtor ----------
  const groups = await h.invoke('master:groups:list')
  const gid = (name) => groups.find((g) => g.name === name).id
  const ledger = (name, group) =>
    h.invoke('master:ledgers:create', { name, groupId: gid(group), openingBalance: 0, gstin: null, stateCode: null, address: null, taxType: null, gstRate: null, hsn: null, tdsSectionId: null, pan: null, creditDays: null, exportType: null })
  const sales = await ledger('Sales', 'Sales Accounts')
  const rent = await ledger('Shop Rent', 'Indirect Expenses')
  const acme = await ledger('Acme Traders', 'Sundry Debtors')
  const cash = (await h.invoke('master:ledgers:list')).find((l) => l.name === 'Cash').id
  const journalType = (await h.invoke('master:voucherTypes:list')).find((t) => t.kind === 'journal').id
  const fy = await h.page.evaluate(() => (new Date().getMonth() >= 3 ? new Date().getFullYear() : new Date().getFullYear() - 1))
  const journal = (date, dr, cr, amount, narration) =>
    h.invoke('voucher:save', {
      data: {
        voucherTypeId: journalType, date, partyLedgerId: null, narration, reference: null, instrumentNo: null, instrumentDate: null,
        transporterId: null, vehicleNo: null, transportDistanceKm: null, currencyCode: null, exchangeRate: null,
        lines: [
          { ledgerId: dr, drCr: 'dr', amount, costAllocations: [] },
          { ledgerId: cr, drCr: 'cr', amount, costAllocations: [] }
        ],
        inventory: [], billRefs: [], tds: null
      }
    })
  await journal(`${fy}-04-10`, acme.id, sales.id, 50_000_000, 'April sales')
  await journal(`${fy}-04-20`, cash, acme.id, 30_000_000, 'Collection')
  for (const m of ['05', '06', '07']) await journal(`${fy}-${m}-01`, rent.id, cash, 1_000_000, `Rent ${m}`)
  await journal(`${fy}-08-01`, rent.id, cash, 9_000_000, 'Rent with arrears and deposit')

  // ---------- AI off: no affordances ----------
  await h.goto('trial-balance')
  await h.page.waitForSelector(`[data-testid="rows-trial-balance"] tr[data-row-id="${rent.id}"]`, { timeout: 10000 })
  assertEq(await h.page.$('[data-testid="trial-balance-explain-debit"]'), null, 'no Explain-this while the assistant is off')

  // ---------- turn it on (the mock provider needs no key) ----------
  await h.invoke('ai:notice:accept')
  await h.invoke('ai:settings:set', { enabled: true })
  assertEq((await h.invoke('ai:settings:get')).ready, true, 'assistant ready on the mock')
  await h.goto('settings') // the settings screen refreshes the cached AI settings
  await h.goto('trial-balance')
  const rentRow = `[data-testid="rows-trial-balance"] tr[data-row-id="${rent.id}"]`
  const rentDebit = `${rentRow} [data-testid="trial-balance-explain-debit"]`
  await h.page.waitForSelector(rentDebit, { state: 'attached', timeout: 15000 })
  const hoverRent = async () => {
    await h.page.hover(`${rentRow} td.dt-explainable`)
    await h.page.waitForTimeout(200)
  }
  await bothThemes('01-tb-explain-hover', hoverRent)

  // ---------- Explain this on a ledger figure ----------
  await hoverRent()
  await h.page.click(rentDebit)
  await h.page.waitForSelector('[data-testid="ai-panel"][data-docked]', { timeout: 10000 })
  const question = await h.page.waitForSelector('[data-testid="ai-panel"] [data-testid="ai-msg-user"]', { timeout: 10000 })
  const q = await question.textContent()
  assert(q.startsWith('Explain this figure: Shop Rent — Debit = ₹1,20,000.00 on Trial balance'), `prefilled question: ${q}`)
  await h.page.waitForSelector('[data-testid="ai-tool-chip"][data-tool="explain_figure"][data-status="ok"]', { timeout: 20000 })
  await waitAnswers(1)
  const answer = await h.page.$eval('[data-testid="ai-msg-answer"]', (el) => el.textContent)
  assert(answer.includes('Shop Rent closed at ₹1,20,000.00 Dr'), `answer quotes the tool: ${answer}`)
  assert(await h.page.$('[data-testid="ai-msg-answer"] [data-testid="ai-md-table"]'), 'the largest entries render as a table')
  assertEq(await h.page.$('[data-testid="ai-msg-answer"] [data-testid="ai-figure"][data-sourced="false"]'), null, 'every figure is sourced')
  assertEq(await h.page.$('[data-testid="ai-unsourced"]'), null, 'no numbers-rule warning')
  const chips = await h.page.$$eval('[data-testid="ai-msg-answer"] [data-testid="ai-figure"]', (els) => els.map((e) => e.getAttribute('data-source-kind')))
  assert(chips.includes('ledger') && chips.includes('voucher'), `figure chips link to the ledger and its vouchers: ${chips}`)
  // The screen stays usable beside the docked panel.
  assertEq(await h.page.getAttribute('[data-screen]', 'data-screen'), 'trial-balance', 'still on the trial balance')
  await h.page.mouse.move(0, 0)
  await bothThemes('02-explain-answer')
  await h.click('btn-ai-context')
  await h.page.waitForSelector('[data-testid="ai-context-detail"]', { timeout: 5000 })
  assert((await h.page.$eval('[data-testid="ai-context-detail"]', (el) => el.textContent)).includes('Screen: Trial balance (trial-balance)'), 'context strip shows what the model is told')
  await bothThemes('03-context-strip')
  await h.click('btn-ai-context')

  // ---------- the closing-balance chip opens the statement ----------
  await h.page.click(`[data-testid="ai-msg-answer"] [data-testid="ai-figure"][data-source-kind="ledger"][data-ledger-id="${rent.id}"]`)
  await h.waitScreen('ledger-statement')
  assert(await h.page.$('[data-testid="ai-panel"]'), 'the panel stays docked while navigating')
  await bothThemes('04-chip-to-statement')

  // ---------- a question about the screen: no restating ----------
  await h.fill('ai-input', 'What is on this screen?')
  await h.page.press('[data-testid="ai-input"]', 'Enter')
  await h.page.waitForSelector('[data-testid="ai-tool-chip"][data-tool="current_screen_data"][data-status="ok"]', { timeout: 20000 })
  await waitAnswers(2)
  const screenAnswer = await h.page.$$eval('[data-testid="ai-msg-answer"]', (els) => els.at(-1).textContent)
  assert(screenAnswer.includes('Shop Rent') && screenAnswer.includes('₹1,20,000.00'), `screen answer: ${screenAnswer}`)

  // ---------- Regenerate replaces the last answer ----------
  const before = await panelAnswerCount()
  await h.page.$$eval('[data-testid="btn-ai-regenerate"]', (els) => els.at(-1).click())
  await h.page.waitForSelector('[data-testid="ai-tool-chip"][data-tool="current_screen_data"][data-status="ok"]', { timeout: 20000 })
  await waitAnswers(before)
  assertEq(await panelAnswerCount(), before, 'regenerate replaced the answer instead of adding one')
  assertEq(await h.page.$$eval('[data-testid="ai-msg-user"]', (els) => els.length), 2, 'the question is not repeated')

  // ---------- the palette: Ask AI, and navigation by search ----------
  await h.page.keyboard.press('Control+k')
  await h.page.waitForSelector('[data-testid="palette"]', { timeout: 5000 })
  await h.fill('input-palette', 'why is rent so high?')
  await h.page.waitForSelector('[data-testid="palette-ask-ai"]', { timeout: 5000 })
  await bothThemes('05-palette-ask', async () => {
    if (!(await h.page.$('[data-testid="palette"]'))) {
      await h.page.keyboard.press('Control+k')
      await h.fill('input-palette', 'why is rent so high?')
      await h.page.waitForSelector('[data-testid="palette-ask-ai"]', { timeout: 5000 })
    }
  })
  if (!(await h.page.$('[data-testid="palette"]'))) {
    await h.page.keyboard.press('Control+k')
    await h.fill('input-palette', 'why is rent so high?')
    await h.page.waitForSelector('[data-testid="palette-ask-ai"]', { timeout: 5000 })
  }
  await h.page.press('[data-testid="input-palette"]', 'Enter')
  await h.page.waitForFunction(() => [...document.querySelectorAll('[data-testid="ai-msg-user"]')].some((e) => e.textContent === 'why is rent so high?'), null, { timeout: 10000 })
  await waitAnswers(1)
  await h.page.keyboard.press('Control+k')
  await h.fill('input-palette', 'open the ledger for Acme')
  await h.page.waitForSelector(`[data-testid="palette-hit-ledger-${acme.id}"]`, { timeout: 10000 })
  await h.page.press('[data-testid="input-palette"]', 'Enter')
  await h.page.waitForFunction((id) => document.querySelector('[data-screen="ledger-statement"]') && document.body.textContent.includes('Acme Traders'), acme.id, { timeout: 10000 })

  // ---------- conversations: list, pin, rename ----------
  await h.click('btn-ai-threads')
  await h.page.waitForSelector('[data-testid="ai-thread-list"] li', { timeout: 5000 })
  const threads = await h.invoke('ai:threads')
  assert(threads.length >= 2, `two conversations (${threads.length})`)
  const first = threads.at(-1)
  await h.click(`btn-ai-pin-${first.id}`)
  await h.page.waitForFunction((id) => document.querySelector(`[data-testid="btn-ai-pin-${id}"]`)?.textContent === '★', first.id, { timeout: 5000 })
  await h.click(`btn-ai-rename-${first.id}`)
  await h.fill('input-ai-thread-title', 'Rent explained')
  await h.page.press('[data-testid="input-ai-thread-title"]', 'Enter')
  await h.page.waitForFunction(() => document.querySelector('[data-testid="ai-thread-list"]')?.textContent.includes('Rent explained'), null, { timeout: 5000 })
  const pinned = (await h.invoke('ai:threads'))[0]
  assertEq(JSON.stringify([pinned.id, pinned.pinned, pinned.title]), JSON.stringify([first.id, true, 'Rent explained']), 'pinned first, renamed')
  await bothThemes('06-threads')
  await h.click(`btn-ai-open-thread-${first.id}`)
  await h.page.waitForSelector('[data-testid="ai-msg-answer"]', { timeout: 10000 })

  // ---------- Explain this on a tile and a statement line (shots), ⌘J and Esc ----------
  await h.goto('profit-loss')
  const line = await h.page.waitForSelector('[data-testid="statement-explain"]', { state: 'attached', timeout: 10000 })
  assert(line, 'statement lines carry Explain this')
  await bothThemes('07-pnl-explain', async () => {
    await h.page.hover('[data-testid="statement-ledger"]')
  })
  // A dashboard tile: Cash & bank explains over both groups.
  await h.goto('gateway')
  await h.page.waitForSelector('[data-testid="tile-cash-explain"]', { state: 'attached', timeout: 10000 })
  await bothThemes('08-tile-explain-hover', async () => {
    await h.page.hover('[data-testid="tile-cash"]')
  })
  await h.page.hover('[data-testid="tile-cash"]')
  await h.click('tile-cash-explain')
  await h.page.waitForFunction(() => [...document.querySelectorAll('[data-testid="ai-msg-user"]')].some((e) => e.textContent.startsWith('Explain this figure: Cash & bank')), null, { timeout: 10000 })
  await h.page.waitForSelector('[data-testid="ai-tool-chip"][data-tool="explain_figure"][data-status="ok"]', { timeout: 20000 })
  await waitAnswers(1)
  const tileAnswer = await h.page.$$eval('[data-testid="ai-msg-answer"]', (els) => els.at(-1).textContent)
  assert(tileAnswer.includes('Cash-in-Hand is ') && tileAnswer.includes('Cash: '), `tile answer covers the cash group: ${tileAnswer}`)
  await h.page.mouse.move(0, 0)
  await bothThemes('09-tile-explain-answer')

  await h.page.keyboard.press('Control+j')
  await h.page.waitForFunction(() => !document.querySelector('[data-testid="ai-panel"]'), null, { timeout: 5000 })
  await h.page.keyboard.press('Control+j')
  await h.page.waitForSelector('[data-testid="ai-panel"]', { timeout: 5000 })
  await h.page.click('[data-testid="ai-input"]')
  await h.page.keyboard.press('Escape')
  await h.page.waitForFunction(() => !document.querySelector('[data-testid="ai-panel"]'), null, { timeout: 5000 })
  assertEq(await h.page.getAttribute('[data-screen]', 'data-screen'), 'gateway', 'Esc in the panel closes it, not the screen')
  const prefs = await h.page.evaluate(() => JSON.parse(localStorage.getItem('total-ai-panel') ?? '{}'))
  assertEq(prefs.open, false, 'open state remembered')
  assert(prefs.width >= 340, 'width remembered')

  // ---------- the outbound log records the context sent ----------
  const outbound = await h.invoke('ai:outbound')
  assert(outbound.some((o) => o.context?.explain?.ledgerId === rent.id && o.context.screen === 'trial-balance'), 'the explain request logged its screen context')
  assert(outbound.some((o) => o.context?.screen === 'ledger-statement' && o.context.params?.ledgerId === rent.id), 'the screen question logged the statement context')
  assert(outbound.every((o) => o.masked), 'masked')
})
