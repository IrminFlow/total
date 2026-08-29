// Scenario 23 — the Day Book's two extra views.
//
// The list is paged, so the by-type summary has to count the WHOLE period rather than the page on
// screen — that is the property worth testing, because a summary of an arbitrary slice is worse
// than no summary. The reconciliation column has to distinguish "not cleared" from "not a bank
// voucher", which is the difference between a real to-do and a permanent false one.
import { scenario, assert } from '../lib/harness.mjs'

await scenario('23-daybook-views', async (h) => {
  await h.createDemoCompany()
  await h.goto('daybook')

  // ---- by type ----
  await h.click('btn-daybook-by-type')
  await h.page.waitForSelector('[data-testid="rows-daybook-by-type"] tr', { timeout: 15000 })
  const typeRows = await h.page.$$eval('[data-testid="rows-daybook-by-type"] tr', (els) =>
    els.map((tr) => [...tr.querySelectorAll('td')].map((td) => td.textContent.trim()))
  )
  assert(typeRows.length > 1, 'the demo books have more than one voucher type')

  // The summary counts the whole period, which the paged list does not.
  const summed = typeRows.slice(0, -1).reduce((s, cells) => s + Number(cells[1]), 0)
  const total = Number(typeRows[typeRows.length - 1][1])
  assert(summed === total, `the type counts add to the total (${summed} vs ${total})`)

  const { total: periodTotal } = await h.invoke('report:dayBook', {
    from: '1900-01-01',
    to: '2999-12-31',
    limit: 1
  })
  const byType = await h.invoke('report:dayBookByType', { from: '1900-01-01', to: '2999-12-31' })
  const byTypeTotal = byType.reduce((s, r) => s + r.count, 0)
  assert(
    byTypeTotal === periodTotal,
    `the by-type counts cover every voucher in the period, not a page (${byTypeTotal} vs ${periodTotal})`
  )
  await h.shot('01-by-type')

  // ---- reconciliation column ----
  await h.click('btn-daybook-by-type') // back to the entries
  await h.page.waitForSelector('[data-testid="rows-daybook"] tr', { timeout: 15000 })

  const rowsBefore = await h.page.$$eval('[data-testid="rows-daybook"] tr', (els) => els.length)
  await h.click('btn-report-config')
  await h.page.waitForSelector('[data-testid="report-config-reconciled"]', { timeout: 10000 })
  await h.page.click('[data-testid="report-config-reconciled"]')
  await h.page.keyboard.press('Escape')
  await h.page.waitForSelector('[data-testid="daybook-bank-status"]', { timeout: 15000 })

  const statuses = await h.page.$$eval('[data-testid="daybook-bank-status"]', (els) =>
    els.map((e) => e.textContent.trim())
  )
  assert(statuses.length > 0, 'the reconciliation column renders')
  assert(
    statuses.every((t) => ['–', 'Cleared', 'Part-cleared', 'Not cleared'].includes(t)),
    `every value is one of the four states (got ${JSON.stringify([...new Set(statuses)])})`
  )
  // A cash-only book would be all dashes; the demo has bank vouchers, so both must appear.
  assert(statuses.includes('–'), 'non-bank vouchers show a dash, not a false to-do')
  assert(
    statuses.some((t) => t !== '–'),
    'and bank vouchers show a real state'
  )
  // Adding a column must not drop or duplicate rows.
  const rowsAfter = await h.page.$$eval('[data-testid="rows-daybook"] tr', (els) => els.length)
  assert(rowsAfter === rowsBefore, 'showing a column does not change the rows')
  await h.shot('02-reconciled-column')

  // ---- Trial balance: a balance on the wrong side is flagged ----
  // A bank account in credit and a customer in credit are both perfectly ordinary numbers on the
  // trial balance; what makes them worth seeing is which row they are on.
  const groups = await h.invoke('master:groups:list')
  const debtors = groups.find((g) => g.name === 'Sundry Debtors')
  const overpayer = await h.invoke('master:ledgers:create', {
    name: 'Paid Twice Ltd', groupId: debtors.id, openingBalance: -50000,
    gstin: null, stateCode: null, address: null, taxType: null, gstRate: null, hsn: null
  })
  assert(overpayer.id, 'created a debtor with a credit opening balance')

  await h.goto('gateway')
  await h.goto('trial-balance')
  await h.page.waitForSelector('[data-testid="rows-trial-balance"] tr', { timeout: 15000 })
  const flagged = await h.page.$$eval('[data-testid="tb-abnormal"]', (els) =>
    els.map((e) => ({ text: e.textContent.trim(), title: e.getAttribute('title') }))
  )
  assert(flagged.length >= 1, 'the debtor in credit is flagged')
  assert(
    flagged.some((f) => f.text === 'Cr?' && /asset in credit/.test(f.title ?? '')),
    `the flag says which way round the problem is (got ${JSON.stringify(flagged)})`
  )

  // Every other row must be unflagged — a flag on a normal balance would train the user to
  // ignore all of them.
  const rowCount = await h.page.$$eval('[data-testid="rows-trial-balance"] tr', (els) => els.length)
  assert(flagged.length < rowCount, 'normal balances are not flagged')
  await h.shot('03-abnormal-balance')

  // ---- Exceptions: a gap in the numbering series ----
  const receipts = (await h.invoke('master:voucherTypes:list')).find((t) => t.kind === 'receipt')
  const ledgers = await h.invoke('master:ledgers:list')
  const cash = ledgers.find((l) => l.name === 'Cash')
  const today = new Date().toISOString().slice(0, 10)
  const made = []
  for (let i = 0; i < 3; i++) {
    made.push(
      await h.invoke('voucher:save', {
        data: {
          voucherTypeId: receipts.id, date: today, partyLedgerId: null,
          narration: `gap test ${i}`, reference: null, instrumentNo: null, instrumentDate: null,
          transporterId: null, vehicleNo: null, transportDistanceKm: null,
          currencyCode: null, exchangeRate: null,
          lines: [
            { ledgerId: cash.id, drCr: 'dr', amount: 1000 },
            { ledgerId: overpayer.id, drCr: 'cr', amount: 1000 }
          ],
          inventory: []
        }
      })
    )
  }
  const gapSection = (report) => report.sections.find((x) => x.key === 'numberGaps')

  const before = gapSection(await h.invoke('report:exceptions', { from: `${today.slice(0, 4)}-01-01`, to: today }))
  await h.invoke('voucher:delete', { id: made[1].id })
  const after = gapSection(await h.invoke('report:exceptions', { from: `${today.slice(0, 4)}-01-01`, to: today }))
  assert(
    after.count === before.count + 1,
    `deleting a voucher leaves exactly one new gap (${before.count} → ${after.count})`
  )
  assert(/missing from the series/.test(after.rows[after.rows.length - 1].detail), 'and says what it is')

  // ---- bulk move to the bin ----
  // Every report is computed from vouchers, so a bulk delete moves real money out of every
  // figure at once. The confirm and the bin are what make that safe; the selection clearing when
  // the view changes is what stops it acting on rows the user can no longer see.
  await h.goto('daybook')
  await h.page.waitForSelector('[data-testid="rows-daybook"] tr', { timeout: 15000 })
  const tbBefore = await h.invoke('report:trialBalance', { asOn: today })

  const targets = made.filter((v) => v.id !== made[1].id) // one was already deleted above
  for (const v of targets) {
    await h.page.check(`[data-testid="check-daybook-${v.id}"]`)
  }
  await h.page.waitForSelector('[data-testid="daybook-selection-bar"]', { timeout: 10000 })
  const barText = await h.page.textContent('[data-testid="daybook-selection-bar"]')
  assert(new RegExp(`${targets.length} selected`).test(barText), `the bar counts the selection (${barText})`)
  await h.shot('04-selection')

  await h.stubDialogs()
  await h.click('btn-daybook-bulk-delete')
  await h.page.waitForSelector('[data-testid="confirm-ok"]', { timeout: 10000 })
  await h.page.click('[data-testid="confirm-ok"]')
  await h.page.waitForSelector('[data-testid="daybook-selection-bar"]', { state: 'detached', timeout: 15000 })

  const bin = await h.invoke('voucher:bin')
  for (const v of targets) {
    assert(bin.some((b) => b.id === v.id), `voucher ${v.id} is in the bin`)
  }

  // The books moved, and by exactly what those vouchers carried.
  const tbAfter = await h.invoke('report:trialBalance', { asOn: today })
  assert(
    tbAfter.totalDebit === tbBefore.totalDebit - targets.length * 1000,
    `the trial balance dropped by what was removed (${tbBefore.totalDebit} → ${tbAfter.totalDebit})`
  )
  // Both sides moved by the same amount. Not "the trial balance balances": this scenario
  // deliberately seeded a ledger with a one-sided opening balance earlier, so the book is
  // already out — what matters is that removing vouchers moves both sides equally.
  assert(
    tbBefore.totalDebit - tbAfter.totalDebit === tbBefore.totalCredit - tbAfter.totalCredit,
    'and both sides moved by the same amount'
  )
})
