// Scenario 31 - incomplete voucher work stays outside books, resumes exactly, and is consumed on posting.
import { scenario, assert, assertEq } from '../lib/harness.mjs'

await scenario('31-voucher-drafts', async (h) => {
  await h.createDemoCompany()
  const before = await h.invoke('voucher:list', { from: '1900-01-01', to: '2999-12-31' })

  await h.goto('voucher-entry')
  await h.page.getByTestId('input-amount').first().fill('123.45')
  await h.page.getByPlaceholder('Being amount paid…').fill('Bank charge awaiting the correct ledger')
  await h.click('btn-save-voucher-draft')
  await h.waitScreen('voucher-drafts')
  await h.page.getByText('Bank charge awaiting the correct ledger', { exact: true }).waitFor()
  await h.shot('00-draft-queue')
  const afterDraft = await h.invoke('voucher:list', { from: '1900-01-01', to: '2999-12-31' })
  assertEq(afterDraft.length, before.length, 'saving an incomplete draft does not create a voucher')

  const [draft] = await h.invoke('voucherDraft:list')
  assertEq(draft.payload.rows[0].amount, 12_345, 'raw incomplete amount survives storage')
  await h.click(`resume-draft-${draft.id}`)
  await h.waitScreen('voucher-entry')
  assertEq(await h.page.getByTestId('input-amount').first().inputValue(), '123.45', 'resume restores the amount exactly')
  assertEq(await h.page.getByPlaceholder('Being amount paid…').inputValue(), 'Bank charge awaiting the correct ledger', 'resume restores narration')
  await h.shot('01-resumed-incomplete-draft')

  const groups = await h.invoke('master:groups:list')
  const expense = await h.invoke('master:ledgers:create', { name: 'Draft Expense', groupId: groups.find((group) => group.name === 'Indirect Expenses').id, openingBalance: 0, gstin: null, stateCode: null, address: null, taxType: null, gstRate: null, hsn: null })
  const income = await h.invoke('master:ledgers:create', { name: 'Draft Income', groupId: groups.find((group) => group.name === 'Indirect Incomes').id, openingBalance: 0, gstin: null, stateCode: null, address: null, taxType: null, gstRate: null, hsn: null })
  const input = {
    voucherTypeId: draft.voucherTypeId, date: '2026-08-24', partyLedgerId: null, narration: 'Completed from durable draft', reference: null,
    instrumentNo: null, instrumentDate: null, transporterId: null, vehicleNo: null, transportDistanceKm: null, currencyCode: null, exchangeRate: null,
    lines: [{ ledgerId: expense.id, drCr: 'dr', amount: 12_345 }, { ledgerId: income.id, drCr: 'cr', amount: 12_345 }], inventory: [], billRefs: [], tds: null
  }
  await h.invoke('voucher:save', { data: input, draftId: draft.id })
  assertEq(await h.invoke('voucherDraft:get', { id: draft.id }), null, 'posting atomically consumes the source draft')
  const afterPost = await h.invoke('voucher:list', { from: '1900-01-01', to: '2999-12-31' })
  assertEq(afterPost.length, before.length + 1, 'completed draft posts exactly one voucher')
  assert(afterPost.some((voucher) => voucher.narration === 'Completed from durable draft'), 'posted voucher is visible in books')
})
