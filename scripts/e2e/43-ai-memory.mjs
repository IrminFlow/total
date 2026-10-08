// Scenario 43 — per-company AI memory (WP 5.6), offline: TOTAL_AI_MOCK=1 swaps the network
// provider for the scripted demo assistant (honoured only with the harness's scratch data dir).
//
// Books with rent paid from HDFC Bank → Settings → AI → Memory offers "Payments are usually made
// from HDFC Bank." as a suggestion from the books (not active). Add a memory by hand; one with a
// GSTIN is refused. Filter to Suggestions. In the panel, "Remember that we pay from HDFC Bank"
// makes the assistant PROPOSE it (Remember this? card) — accept it; then "Pay 1500 for Shop Rent"
// drafts the payment from HDFC Bank and shows the memory as a chip. The outbound log records the
// memory block; the table counts the use. Forget everything clears it.
// Every view is shot in both themes; set WP56_SHOTS=/tmp/wp56 to also copy the screenshots there.
import fs from 'node:fs'
import path from 'node:path'
import { scenario, assert, assertEq } from '../lib/harness.mjs'

process.env.TOTAL_AI_MOCK = '1'

await scenario('43-ai-memory', async (h) => {
  await h.createCompanyUI('AI Memory Co')
  const extraShots = process.env.WP56_SHOTS
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
  const bothThemes = async (name, prepare = async () => {}) => {
    await setTheme('light')
    await prepare()
    await shot(`${name}-light`)
    await setTheme('dark')
    await prepare()
    await shot(`${name}-dark`)
    await setTheme('light')
  }
  const memoryRows = () => h.page.$$eval('[data-testid="rows-ai-memory"] tr[data-status]', (els) => els.map((e) => ({ status: e.getAttribute('data-status'), source: e.getAttribute('data-source'), text: e.textContent })))
  const showMemory = async () => {
    await h.page.evaluate(() => document.querySelector('[data-testid="ai-memory"]')?.scrollIntoView({ block: 'start' }))
    await h.page.waitForTimeout(200)
  }
  const waitAnswers = (n) =>
    h.page.waitForFunction(
      (k) => document.querySelectorAll('[data-testid="ai-panel"] [data-testid="ai-msg-answer"]').length >= k && document.querySelector('[data-testid="btn-ai-send"]'),
      n,
      { timeout: 20000 }
    )

  // ---------- books: rent paid from HDFC Bank three times, power once in cash ----------
  const groups = await h.invoke('master:groups:list')
  const gid = (name) => groups.find((g) => g.name === name).id
  const ledger = (name, group) =>
    h.invoke('master:ledgers:create', { name, groupId: gid(group), openingBalance: 0, gstin: null, stateCode: null, address: null, taxType: null, gstRate: null, hsn: null, tdsSectionId: null, pan: null, creditDays: null, exportType: null })
  const hdfc = await ledger('HDFC Bank', 'Bank Accounts')
  const rent = await ledger('Shop Rent', 'Indirect Expenses')
  const power = await ledger('Electricity', 'Indirect Expenses')
  const cash = (await h.invoke('master:ledgers:list')).find((l) => l.name === 'Cash').id
  const paymentType = (await h.invoke('master:voucherTypes:list')).find((t) => t.kind === 'payment').id
  const fy = await h.page.evaluate(() => (new Date().getMonth() >= 3 ? new Date().getFullYear() : new Date().getFullYear() - 1))
  const today = await h.page.evaluate(() => {
    const d = new Date()
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  })
  const day = (iso) => (iso <= today ? iso : today)
  const pay = (date, dr, cr, amount, narration) =>
    h.invoke('voucher:save', {
      data: {
        voucherTypeId: paymentType, date, partyLedgerId: null, narration, reference: null, instrumentNo: null, instrumentDate: null,
        transporterId: null, vehicleNo: null, transportDistanceKm: null, currencyCode: null, exchangeRate: null,
        lines: [
          { ledgerId: dr, drCr: 'dr', amount, costAllocations: [] },
          { ledgerId: cr, drCr: 'cr', amount, costAllocations: [] }
        ],
        inventory: [], billRefs: [], tds: null
      }
    })
  for (const m of ['04', '05', '06']) await pay(day(`${fy}-${m}-05`), rent.id, hdfc.id, 2_500_000, `Being rent paid for ${m}`)
  await pay(day(`${fy}-04-20`), power.id, cash, 300_000, 'Being power bill')

  // ---------- AI on (the mock provider needs no key) ----------
  await h.invoke('ai:notice:accept')
  await h.invoke('ai:settings:set', { enabled: true })
  assertEq((await h.invoke('ai:settings:get')).ready, true, 'assistant ready on the mock')

  // ---------- Settings → AI → Memory: a suggestion from the books, never active ----------
  await h.goto('settings')
  await h.click('tab-settings-ai')
  await h.page.waitForSelector('[data-testid="ai-memory"]', { timeout: 10000 })
  await h.page.waitForFunction(() => [...document.querySelectorAll('[data-testid="rows-ai-memory"] tr[data-source="derived"]')].some((r) => r.textContent.includes('Payments are usually made from HDFC Bank.')), null, { timeout: 10000 })
  const list = await h.invoke('ai:memory:list')
  assertEq(list.entries.length, 0, 'nothing is remembered until accepted')
  assert(list.suggestions.some((s) => s.text === 'Payments are usually made from HDFC Bank.' && s.reason === 'on 3 of 4 payments'), `derived suggestion: ${JSON.stringify(list.suggestions)}`)
  await showMemory()
  await bothThemes('01-memory-suggestions', showMemory)

  // ---------- add by hand; an identifier is refused ----------
  await h.fill('input-ai-memory-text', 'We close the books on the 5th of each month')
  await h.click('btn-ai-memory-add')
  await h.page.waitForFunction(() => [...document.querySelectorAll('[data-testid="rows-ai-memory"] tr[data-source="user"]')].some((r) => r.textContent.includes('close the books on the 5th')), null, { timeout: 10000 })
  await h.fill('input-ai-memory-text', 'Our GSTIN is 27AAPFU0939F1ZV')
  await h.click('btn-ai-memory-add')
  await h.page.waitForFunction(() => document.body.textContent.includes('cannot hold a GSTIN'), null, { timeout: 10000 })
  assertEq((await h.invoke('ai:memory:list')).entries.length, 1, 'the GSTIN memory was refused')
  await h.click('ai-memory-filter-suggested')
  await h.page.waitForFunction(() => {
    const rows = [...document.querySelectorAll('[data-testid="rows-ai-memory"] tr[data-status]')]
    return rows.length > 0 && rows.every((r) => r.getAttribute('data-status') === 'suggested')
  }, null, { timeout: 5000 })
  await bothThemes('02-memory-filter', showMemory)
  await h.click('ai-memory-filter-all')

  // ---------- the assistant proposes; the user accepts in the panel ----------
  await h.click('btn-assistant')
  await h.page.waitForSelector('[data-testid="ai-panel"]', { timeout: 10000 })
  await h.fill('ai-input', 'Remember that we pay from HDFC Bank')
  await h.page.press('[data-testid="ai-input"]', 'Enter')
  await h.page.waitForSelector('[data-testid="ai-tool-chip"][data-tool="remember"][data-status="ok"]', { timeout: 20000 })
  await waitAnswers(1)
  await h.page.waitForSelector('[data-testid="ai-memory-card"][data-status="suggested"]', { timeout: 10000 })
  const proposed = (await h.invoke('ai:memory:list')).entries.find((e) => e.source === 'assistant')
  assert(proposed && proposed.status === 'suggested' && !proposed.unrequested && proposed.data?.purpose === 'payment' && proposed.data.ledgerId === hdfc.id, `proposal: ${JSON.stringify(proposed)}`)
  await h.page.mouse.move(0, 0)
  await bothThemes('03-remember-card')
  await h.click('btn-ai-memory-card-accept')
  await h.page.waitForSelector('[data-testid="ai-memory-card"][data-status="active"]', { timeout: 10000 })

  // ---------- a draft uses the remembered bank; the answer shows the memory chip ----------
  await h.fill('ai-input', 'Pay 1500 for Shop Rent')
  await h.page.press('[data-testid="ai-input"]', 'Enter')
  await h.page.waitForSelector('[data-testid="ai-draft-card"]', { timeout: 20000 })
  await waitAnswers(2)
  await h.page.waitForSelector('[data-testid="ai-msg-answer"] [data-testid="ai-memory-chip"]', { timeout: 10000 })
  const chip = await h.page.$$eval('[data-testid="ai-memory-chip"]', (els) => els.at(-1).textContent)
  assertEq(chip, 'We pay from HDFC Bank', 'the chip names the memory used')
  const answer = await h.page.$$eval('[data-testid="ai-msg-answer"]', (els) => els.at(-1).textContent)
  assert(!/\[M\d+\]/.test(answer), `citation tags are not shown: ${answer}`)
  const draft = (await h.invoke('ai:drafts', { status: 'open' }))[0]
  assertEq(JSON.stringify(draft.payload.lines.map((l) => [l.ledgerId, l.drCr, l.amount])), JSON.stringify([[rent.id, 'dr', 150000], [hdfc.id, 'cr', 150000]]), 'drafted from HDFC Bank')
  await bothThemes('04-memory-chip')

  // ---------- the outbound log carries the memory block; the table counts the use ----------
  const outbound = await h.invoke('ai:outbound')
  assertEq(outbound[0].memoryCount, 2, 'the last request carried the two active memories')
  assert(outbound[0].memoryBytes > 40, 'and logged their size')
  assert(outbound.every((o) => o.masked), 'masked')
  const used = (await h.invoke('ai:memory:list')).entries.find((e) => e.id === proposed.id)
  assertEq(used.useCount, 1, 'use counted')
  await h.page.keyboard.press('Escape')
  await h.goto('settings')
  await h.click('tab-settings-ai')
  await h.page.waitForSelector('[data-testid="rows-ai-memory"] tr[data-status="active"]', { timeout: 10000 })
  const rows = await memoryRows()
  assert(!rows.some((r) => r.source === 'derived' && r.text.includes('Payments are usually made from HDFC Bank')), 'the derived pay-from suggestion is gone once a pay-from preference is active')
  await showMemory()
  await bothThemes('05-memory-used', showMemory)

  // ---------- edit an entry from its row menu ----------
  const fact = (await h.invoke('ai:memory:list')).entries.find((e) => e.source === 'user')
  await h.click(`btn-ai-memory-more-${fact.id}`)
  await h.click('btn-ai-memory-edit')
  await h.page.waitForSelector('[data-testid="ai-memory-edit"]', { timeout: 5000 })
  await h.fill('input-ai-memory-edit-text', 'We close the books on the 5th of every month')
  await bothThemes('06-memory-edit')
  await h.click('btn-ai-memory-save')
  await h.page.waitForFunction(() => document.querySelector('[data-testid="rows-ai-memory"]')?.textContent.includes('5th of every month'), null, { timeout: 10000 })
  assertEq((await h.invoke('ai:memory:list')).entries.find((e) => e.id === fact.id).text, 'We close the books on the 5th of every month', 'edited')

  // ---------- forget everything (owner, audited) ----------
  await h.click('btn-ai-memory-forget-all')
  await h.click('confirm-ok')
  await h.page.waitForFunction(() => !document.querySelector('[data-testid="rows-ai-memory"] tr[data-source="user"], [data-testid="rows-ai-memory"] tr[data-source="assistant"]'), null, { timeout: 10000 })
  assertEq((await h.invoke('ai:memory:list')).entries.length, 0, 'every entry is gone')
  const trail = await h.invoke('audit:list', { entity: 'ai_memory', page: 0 })
  assert(trail.rows.some((r) => r.action === 'delete'), 'forget everything is in the audit trail')
})
