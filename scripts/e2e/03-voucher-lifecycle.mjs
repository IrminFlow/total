// Scenario 03 — voucher lifecycle with trial-balance tie-outs: save → TB ties → visible in
// Day Book (testid rows) → delete → bin → restore → TB ties again.
//
// Voucher creation goes through voucher:save (the same zod+posting path the UI uses);
// the UI-typed entry flow lands with lane S1's VoucherEntry split.
// RECONCILE: after merge, consider driving one voucher through the invoice form itself
// (picker-party / rows-invoice-lines / btn-save-voucher).
import { scenario, assert, assertEq } from '../lib/harness.mjs'

await scenario('03-voucher-lifecycle', async (h) => {
  await h.createCompanyUI('Lifecycle Books')

  const ledgers = await h.invoke('master:ledgers:list')
  const cash = ledgers.find((l) => l.name === 'Cash')
  assert(cash, "seeded 'Cash' ledger")
  const groups = await h.invoke('master:groups:list')
  const sales = groups.find((g) => g.name === 'Sales Accounts')
  await h.invoke('master:ledgers:create', {
    name: 'E2E Sales', groupId: sales.id, openingBalance: 0,
    gstin: null, stateCode: null, address: null, taxType: null, gstRate: null, hsn: null
  })
  const salesLedger = (await h.invoke('master:ledgers:list')).find((l) => l.name === 'E2E Sales')

  const types = await h.invoke('master:voucherTypes:list')
  const receipt = types.find((t) => t.kind === 'receipt')
  const today = new Date().toISOString().slice(0, 10)

  const saved = await h.invoke('voucher:save', {
    data: {
      voucherTypeId: receipt.id, date: today, partyLedgerId: null,
      narration: 'E2E lifecycle receipt', reference: null, instrumentNo: null, instrumentDate: null,
      transporterId: null, vehicleNo: null, transportDistanceKm: null, currencyCode: null, exchangeRate: null,
      lines: [
        { ledgerId: cash.id, drCr: 'dr', amount: 123400 },
        { ledgerId: salesLedger.id, drCr: 'cr', amount: 123400 }
      ],
      inventory: []
    }
  })
  assert(typeof saved.id === 'number', 'voucher:save returned an id')

  // TB tie-out #1.
  const tb1 = await h.invoke('report:trialBalance', { asOn: today })
  assertEq(tb1.totalDebit, 123400, 'TB totalDebit after save')
  assertEq(tb1.totalCredit, 123400, 'TB totalCredit after save')

  // Visible in Day Book, addressable by its data-row-id.
  await h.goto('daybook')
  await h.page.waitForSelector(`[data-testid="rows-daybook"] [data-row-id="${saved.id}"]`, { timeout: 10000 })
  await h.shot('01-daybook-row')

  // Delete → lands in the bin, TB back to zero.
  await h.invoke('voucher:delete', { id: saved.id })
  const bin = await h.invoke('voucher:bin')
  assertEq(bin.length, 1, 'bin holds the deleted voucher')
  const tb2 = await h.invoke('report:trialBalance', { asOn: today })
  assertEq(tb2.totalDebit, 0, 'TB totalDebit after delete')

  // The Day Book no longer shows it (re-navigate so the scoped invalidation refetches; the
  // refetch may start a beat after data-loading flips, so wait for the row to detach).
  await h.goto('gateway')
  await h.goto('daybook')
  await h.page.waitForSelector(`[data-testid="rows-daybook"] [data-row-id="${saved.id}"]`, {
    state: 'detached',
    timeout: 10000
  })

  // Restore → TB ties again.
  await h.invoke('voucher:restore', { id: saved.id })
  const tb3 = await h.invoke('report:trialBalance', { asOn: today })
  assertEq(tb3.totalDebit, 123400, 'TB totalDebit after restore')
  assertEq(tb3.totalCredit, 123400, 'TB totalCredit after restore')
  await h.goto('gateway')
  await h.goto('daybook')
  await h.page.waitForSelector(`[data-testid="rows-daybook"] [data-row-id="${saved.id}"]`, { timeout: 10000 })

  // ---- the voucher's own audit trail, next to the voucher ----
  // The audit log has always held before/after snapshots, but only Settings could list them, and
  // only across the whole book — so "who changed this invoice" meant scrolling a global feed.
  await h.invoke('voucher:save', {
    id: saved.id,
    data: {
      voucherTypeId: receipt.id, date: today, partyLedgerId: null,
      narration: 'E2E lifecycle receipt — altered', reference: null, instrumentNo: null, instrumentDate: null,
      transporterId: null, vehicleNo: null, transportDistanceKm: null, currencyCode: null, exchangeRate: null,
      lines: [
        { ledgerId: cash.id, drCr: 'dr', amount: 200000 },
        { ledgerId: salesLedger.id, drCr: 'cr', amount: 200000 }
      ],
      inventory: []
    }
  })

  const trail = await h.invoke('audit:list', { entity: 'voucher', entityId: saved.id, page: 0, pageSize: 50 })
  assert(trail.rows.length >= 2, `the voucher has a create and an alter (${trail.rows.length} rows)`)
  assert(
    trail.rows.every((r) => r.entityId === saved.id),
    'and the filter returns only this voucher, not every voucher'
  )
  // An id filter without an entity would mix voucher 7 with ledger 7.
  const unfiltered = await h.invoke('audit:list', { entityId: saved.id, page: 0, pageSize: 200 })
  assert(
    unfiltered.total >= trail.total,
    'the id alone does not narrow anything, since ids are per-entity'
  )

  await h.goto('daybook')
  await h.page.click(`[data-testid="rows-daybook"] [data-row-id="${saved.id}"]`)
  await h.waitScreen('voucher-entry')
  await h.click('btn-voucher-history')
  await h.page.waitForSelector('[data-testid="voucher-history"]', { timeout: 15000 })
  // The list loads on first expand, so wait for it rather than reading the loading state.
  await h.page.waitForFunction(
    () => !/Loading/.test(document.querySelector('[data-testid="voucher-history"]')?.textContent ?? 'Loading'),
    null,
    { timeout: 15000 }
  )
  const historyText = await h.page.textContent('[data-testid="voucher-history"]')
  assert(/Altered/.test(historyText), 'the trail names the alteration')
  assert(/Narration/.test(historyText), 'and which field changed')
  assert(/Lines: 2 lines, 1,234\.00 → 2 lines, 2,000\.00/.test(historyText),
    `the line total is the voucher's value, not both sides added (got ${JSON.stringify(historyText.slice(0, 200))})`)
  assert(/Created/.test(historyText), 'the create is in the trail')
  // A create or delete lists no field changes: one side is absent, so every field would read
  // "— → value" and restate what the action label already said.
  const createSection = historyText.slice(historyText.lastIndexOf('Created'))
  assert(!/→/.test(createSection), 'a create lists no field-by-field noise')
  await h.shot('05-voucher-history')
})
