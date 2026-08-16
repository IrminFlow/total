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
})
