// Scenario 34 — the bank desk: the post-dated calendar (#137), the bounced-cheque register
// (#138) and the reconciliation freeze (#142), driven through the Banking screen's own controls.
//
// Properties, not pixels: the calendar is six whole weeks starting on a Sunday with exactly the
// month's days marked in-month; the day a cheque falls due carries its count and its total; the
// freeze modal writes a lock that the header then states and that main then enforces.
import * as fs from 'node:fs'
import * as path from 'node:path'
import { scenario, assert, assertEq } from '../lib/harness.mjs'

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
/** toDisplayDate from src/shared/dates.ts, repeated here so the assertion reads the screen's format. */
const display = (iso) => `${iso.slice(8, 10)}-${MONTHS[Number(iso.slice(5, 7)) - 1]}-${iso.slice(2, 4)}`
const shiftMonth = (key, delta) => {
  const zero = Number(key.slice(0, 4)) * 12 + Number(key.slice(5, 7)) - 1 + delta
  return `${String(Math.floor(zero / 12)).padStart(4, '0')}-${String((zero % 12) + 1).padStart(2, '0')}`
}

await scenario('34-bank-desk', async (h) => {
  await h.createDemoCompany()

  const bankLedgers = await h.invoke('bank:ledgers')
  const bank = bankLedgers.find((l) => l.name === 'HDFC Bank') ?? bankLedgers[0]
  assert(bank, 'demo company has a bank ledger')

  // A post-dated receipt so the calendar and the register have something real in them: the demo
  // company ships none, and a grid asserted only against zero cheques cannot fail.
  const today = new Date().toISOString().slice(0, 10)
  const month = today.slice(0, 7)
  const types = await h.invoke('master:voucherTypes:list')
  const receipt = types.find((t) => t.kind === 'receipt')
  const ledgers = await h.invoke('master:ledgers:list')
  // Never a second bank: a voucher touching two banks makes "which one returned the cheque"
  // ambiguous, and main rightly refuses to guess.
  const bankIds = new Set(bankLedgers.map((l) => l.id))
  const other = ledgers.find((l) => !bankIds.has(l.id) && l.name !== 'Cash')
  assert(receipt && other, 'a receipt type and a second ledger to post against')

  const pdcVoucher = await h.invoke('voucher:save', {
    data: {
      voucherTypeId: receipt.id,
      date: today,
      partyLedgerId: null,
      narration: 'Post-dated cheque for the calendar',
      reference: null,
      instrumentNo: 'PDC0001',
      instrumentDate: today,
      transporterId: null,
      vehicleNo: null,
      transportDistanceKm: null,
      currencyCode: null,
      exchangeRate: null,
      postDated: true,
      lines: [
        { ledgerId: bank.id, drCr: 'dr', amount: 5000000 },
        { ledgerId: other.id, drCr: 'cr', amount: 5000000 }
      ],
      inventory: []
    }
  })
  assert(pdcVoucher?.id, 'the post-dated receipt saved')

  const pdc = await h.invoke('pdc:list')
  assert(
    pdc.some((r) => r.id === pdcVoucher.id),
    'it shows up in the post-dated register'
  )

  // ---- #137: the month grid ----
  await h.goto('banking')
  await h.page.click('[data-testid="tab-banking-pdc"]')
  await h.page.waitForSelector('[data-testid="pdc-calendar"]', { timeout: 15000 })
  await h.page.waitForSelector('[data-testid="rows-banking-pdc"] tr', { timeout: 15000 })

  assertEq(
    await h.page.getAttribute('[data-testid="pdc-calendar"]', 'data-month'),
    month,
    'the calendar opens on the current month'
  )

  const cells = await h.page.$$eval('[data-testid="pdc-day"]', (els) =>
    els.map((e) => ({
      date: e.getAttribute('data-date'),
      inMonth: e.getAttribute('data-in-month') === 'true',
      text: e.textContent.trim()
    }))
  )
  assertEq(cells.length, 42, 'six whole weeks of seven days')
  assertEq(new Date(`${cells[0].date}T00:00:00Z`).getUTCDay(), 0, 'the grid starts on a Sunday')
  const daysInMonth = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).getUTCDate()
  assertEq(cells.filter((c) => c.inMonth).length, daysInMonth, 'exactly this month’s days are marked in-month')
  assert(
    cells.every((c, i) => i === 0 || new Date(`${c.date}T00:00:00Z`) - new Date(`${cells[i - 1].date}T00:00:00Z`) === 86400000),
    'the cells are consecutive days'
  )

  const dueCell = cells.find((c) => c.date === today)
  assert(dueCell, "today's cell is on the grid")
  assert(/50,000\.00/.test(dueCell.text), `the due day carries the cheque total (got ${JSON.stringify(dueCell.text)})`)
  assert(/1 cheque\b/.test(dueCell.text), `and how many cheques make it up (got ${JSON.stringify(dueCell.text)})`)

  // Paging moves by exactly one month, in both directions.
  await h.click('btn-pdc-prev-month')
  await h.page.waitForSelector(`[data-testid="pdc-calendar"][data-month="${shiftMonth(month, -1)}"]`, { timeout: 10000 })
  await h.click('btn-pdc-next-month')
  await h.click('btn-pdc-next-month')
  await h.page.waitForSelector(`[data-testid="pdc-calendar"][data-month="${shiftMonth(month, 1)}"]`, { timeout: 10000 })
  await h.click('btn-pdc-this-month')
  await h.page.waitForSelector(`[data-testid="pdc-calendar"][data-month="${month}"]`, { timeout: 10000 })
  await h.shot('01-pdc-calendar')

  // ---- #138: the cheque comes back ----
  await h.click('btn-banking-pdc-bounce')
  await h.page.waitForSelector('[data-testid="input-bounce-reason"]', { timeout: 10000 })
  await h.fill('input-bounce-reason', 'Funds insufficient')
  await h.click('btn-bounce-save')
  await h.page.waitForSelector('[data-testid="rows-banking-bounces"] tr', { timeout: 15000 })

  const bounces = await h.invoke('bank:bounce:list', {})
  assertEq(bounces.length, 1, 'one bounce recorded')
  assertEq(bounces[0].voucherId, pdcVoucher.id, 'against the cheque that came back')
  assert(bounces[0].reversalVoucherId != null, 'and it posted a reversal journal')
  const register = await h.page.textContent('[data-testid="rows-banking-bounces"]')
  assert(register.includes('Funds insufficient'), 'the register states the return reason')
  await h.shot('02-bounced-register')

  // Undo puts the reversal in the bin and the receipt back on the books.
  await h.click('btn-banking-bounce-undo')
  await h.click('confirm-ok')
  await h.page.waitForSelector('[data-testid="rows-banking-bounces"]', { state: 'detached', timeout: 15000 })
  assertEq((await h.invoke('bank:bounce:list', {})).length, 0, 'the bounce is gone')

  // ---- #142: freezing a reconciled period ----
  await h.page.click('[data-testid="tab-banking-recon"]')
  await h.page.waitForSelector('[data-testid="banking-recon-lock"]', { timeout: 15000 })
  const frozenLedgerId = Number(await h.page.inputValue('[data-testid="banking-ledger"]'))
  assertEq(
    (await h.page.textContent('[data-testid="banking-recon-lock"]')).trim(),
    'Not frozen',
    'nothing is frozen to begin with'
  )

  await h.click('btn-recon-freeze')
  await h.page.waitForSelector('[data-testid="input-recon-freeze-date"]', { timeout: 10000 })
  await h.fill('input-recon-freeze-date', '31-12-2026')
  await h.page.press('[data-testid="input-recon-freeze-date"]', 'Enter')
  await h.click('btn-recon-freeze-save')
  await h.page.waitForFunction(
    () => document.querySelector('[data-testid="banking-recon-lock"]')?.textContent.includes('Frozen up to'),
    null,
    { timeout: 15000 }
  )
  assertEq(
    (await h.page.textContent('[data-testid="banking-recon-lock"]')).trim(),
    `Frozen up to ${display('2026-12-31')}`,
    'the header states the lock it just set'
  )

  const locks = await h.invoke('bank:reconLock:list')
  assertEq(
    locks.find((l) => l.ledgerId === frozenLedgerId)?.lockedTo,
    '2026-12-31',
    'and main agrees about the date'
  )
  await h.shot('03-recon-frozen')

  // The freeze is only worth stating if it actually refuses.
  const recon = await h.invoke('bank:recon', { ledgerId: frozenLedgerId, from: '1900-01-01', to: '2026-12-31' })
  const line = recon.rows[0]
  assert(line, 'the frozen account has a bank line to try to move')
  let refusal = null
  try {
    await h.invoke('bank:setBankDate', { lineId: line.lineId, bankDate: '2026-06-01' })
  } catch (err) {
    refusal = err.message
  }
  assert(refusal && /frozen/i.test(refusal), `a bank date inside the frozen window is refused (got ${refusal})`)

  // Unfreeze from the same modal, so the lift is as reachable as the freeze.
  await h.click('btn-recon-freeze')
  await h.page.waitForSelector('[data-testid="btn-recon-unfreeze"]', { timeout: 10000 })
  await h.click('btn-recon-unfreeze')
  await h.page.waitForFunction(
    () => document.querySelector('[data-testid="banking-recon-lock"]')?.textContent.trim() === 'Not frozen',
    null,
    { timeout: 15000 }
  )
  assertEq((await h.invoke('bank:reconLock:list')).find((l) => l.ledgerId === frozenLedgerId)?.lockedTo, null, 'the lock is lifted')

  // ---- #135: the bank's own charges have somewhere to go ----
  const before = await h.invoke('bank:charges:list')
  assert(before.length === 4, 'four charge/interest ledgers are recognised')
  const setup = await h.invoke('bank:charges:setup')
  assert(setup.created.length + setup.existing.length === 4, 'setup accounts for every one of them')
  const after = await h.invoke('bank:charges:list')
  assert(
    after.every((c) => c.ledgerId != null),
    'after setup every charge category has a ledger to post to'
  )

  // ---- #144: one credit settling several invoices ----
  // Built from the demo company's own open entries, so the group the service proposes is a real
  // settlement rather than a number picked to make the assertion pass.
  const openBook = await h.invoke('bank:recon', { ledgerId: bank.id, from: '1900-01-01', to: '2027-03-31' })
  const byParty = new Map()
  for (const r of openBook.rows.filter((r) => !r.bankDate && r.deposit > 0)) {
    byParty.set(r.particulars, [...(byParty.get(r.particulars) ?? []), r])
  }
  const pair = [...byParty.values()].find((g) => g.length >= 2)?.slice(0, 2)
  assert(pair, 'the demo company has two open deposits from one party')
  const total = pair.reduce((s, r) => s + r.deposit, 0)
  const csv = [
    'Date,Description,Withdrawal,Deposit',
    `${pair[1].date},NEFT settling two invoices,,${(total / 100).toFixed(2)}`
  ].join('\n')

  const proposed = (await h.invoke('banking:matchSuggestions', { ledgerId: bank.id, csvText: csv })).filter(
    (m) => m.kind === 'many_to_one'
  )
  assertEq(proposed.length, 1, 'the second pass proposes the group the exact matcher could not take')
  assertEq(proposed[0].lines.length, 2, 'two book entries make up the one credit')
  assertEq(
    proposed[0].lines.reduce((s, l) => s + l.amount, 0),
    total,
    'and they add up to the statement line'
  )

  // Through the screen's own import, because the panel only exists at the end of that flow.
  const csvPath = path.join(h.dataDir, 'group.csv')
  fs.writeFileSync(csvPath, csv)
  await h.stubDialogs({ openPaths: [csvPath] })
  await h.click('btn-banking-import')
  await h.page.waitForSelector('[data-testid="btn-banking-apply-import"]', { timeout: 20000 })
  await h.click('btn-banking-apply-import')
  await h.page.waitForSelector('[data-testid="banking-match-suggestion"]', { timeout: 20000 })

  assertEq(
    await h.page.getAttribute('[data-testid="banking-match-suggestion"]', 'data-match-kind'),
    'many_to_one',
    'the panel says this is a group, not a near miss'
  )
  const lineRows = await h.page.$$('[data-testid="rows-banking-match-lines"] tr')
  assertEq(lineRows.length, 3, 'each constituent voucher plus the total that justifies the group')
  const workings = await h.page.textContent('[data-testid="banking-match-suggestion"]')
  for (const line of proposed[0].lines) {
    assert(workings.includes(line.number), `voucher ${line.number} is named in the working`)
  }
  assert(workings.includes('adds up exactly'), `the sum is stated as exact (got ${JSON.stringify(workings.slice(0, 200))})`)
  await h.shot('04-grouped-match')

  // Accepting reconciles every line in the group, at the statement row's date — after which the
  // group has nothing left to propose and the panel goes away on its own.
  await h.click('btn-banking-accept-match')
  await h.page.waitForSelector('[data-testid="banking-match-suggestion"]', { state: 'detached', timeout: 20000 })
  const settled = await h.invoke('bank:recon', { ledgerId: bank.id, from: '1900-01-01', to: '2027-03-31' })
  for (const line of proposed[0].lines) {
    const now = settled.rows.find((x) => x.lineId === line.lineId)
    assertEq(now?.bankDate, pair[1].date, `${line.number} took the statement row's date`)
  }
})
