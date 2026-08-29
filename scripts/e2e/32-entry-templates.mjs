// Scenario 32 - a reusable one-off pattern opens as an editable draft and posts only on confirmation.
import { scenario, assert, assertEq } from '../lib/harness.mjs'

await scenario('32-entry-templates', async (h) => {
  await h.createCompanyUI('Template Books')
  const groups = await h.invoke('master:groups:list')
  const expense = await h.invoke('master:ledgers:create', { name: 'Office Rent', groupId: groups.find((group) => group.name === 'Indirect Expenses').id, openingBalance: 0, gstin: null, stateCode: null, address: null, taxType: null, gstRate: null, hsn: null })
  const cash = (await h.invoke('master:ledgers:list')).find((ledger) => ledger.name === 'Cash')
  const journal = (await h.invoke('master:voucherTypes:list')).find((type) => type.kind === 'journal')
  const today = '2026-08-24'
  const template = await h.invoke('entryTemplate:save', {
    name: 'Monthly Office Rent', voucherTypeId: journal.id, mode: 'accounting', title: 'Template', payloadVersion: 1,
    payload: { date: today, number: '', rows: [{ drCr: 'dr', ledgerId: expense.id, amount: 250_000, costAllocations: [] }, { drCr: 'cr', ledgerId: cash.id, amount: 250_000, costAllocations: [] }], narration: 'Office rent for the month', instrumentNo: '', billRefs: [], advanceReceipt: false, optionalVoucher: false, tds: null }
  })

  await h.goto('entry-templates')
  await h.page.getByText('Monthly Office Rent', { exact: true }).waitFor()
  await h.shot('00-entry-template-library')
  await h.click(`use-template-${template.id}`)
  await h.waitScreen('voucher-entry')
  assertEq(await h.page.getByTestId('input-amount').first().inputValue(), '2,500.00', 'template restores debit amount')
  assertEq(await h.page.getByPlaceholder('Being amount paid…').inputValue(), 'Office rent for the month', 'template restores narration')
  await h.shot('01-template-ready-to-post')

  await h.click('btn-save-voucher')
  await h.page.getByText(/saved$/, { exact: false }).waitFor()
  assertEq((await h.invoke('voucherDraft:list')).length, 0, 'posting consumes only the instantiated draft')
  assertEq((await h.invoke('entryTemplate:list')).length, 1, 'reusable template remains available')
  const vouchers = await h.invoke('voucher:list', { from: today, to: today })
  assert(vouchers.some((voucher) => voucher.narration === 'Office rent for the month'), 'template-based voucher reaches the books')
})
