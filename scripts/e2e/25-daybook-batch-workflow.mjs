// Scenario 25 — Day Book multi-select, operational metadata, and explicit linked reversal.
import { scenario, assert, assertEq } from '../lib/harness.mjs'

await scenario('25-daybook-batch-workflow', async (h) => {
  await h.createCompanyUI('Batch Workflow Books')
  const today = new Date().toISOString().slice(0, 10)
  const groups = await h.invoke('master:groups:list')
  const expenseGroup = groups.find((group) => group.name === 'Indirect Expenses')
  const incomeGroup = groups.find((group) => group.name === 'Indirect Incomes')
  const expense = await h.invoke('master:ledgers:create', {
    name: 'Workflow Expense', groupId: expenseGroup.id, openingBalance: 0,
    gstin: null, stateCode: null, address: null, taxType: null, gstRate: null, hsn: null
  })
  const income = await h.invoke('master:ledgers:create', {
    name: 'Workflow Income', groupId: incomeGroup.id, openingBalance: 0,
    gstin: null, stateCode: null, address: null, taxType: null, gstRate: null, hsn: null
  })
  const journal = (await h.invoke('master:voucherTypes:list')).find((type) => type.kind === 'journal')
  const create = (amount, narration) => h.invoke('voucher:save', { data: {
    voucherTypeId: journal.id, date: today, partyLedgerId: null, narration,
    reference: null, instrumentNo: null, instrumentDate: null, transporterId: null,
    vehicleNo: null, transportDistanceKm: null, currencyCode: null, exchangeRate: null,
    lines: [
      { ledgerId: expense.id, drCr: 'dr', amount },
      { ledgerId: income.id, drCr: 'cr', amount }
    ],
    inventory: []
  } })
  const first = await create(25_000, 'Batch workflow one')
  const second = await create(40_000, 'Batch workflow two')

  await h.goto('daybook')
  await h.page.getByTestId(`select-voucher-${first.id}`).check()
  await h.page.getByTestId(`select-voucher-${second.id}`).check()
  await h.page.getByTestId('daybook-batch-tray').waitFor()
  assert(await h.page.getByRole('button', { name: 'Print' }).isVisible(), 'batch print is available')
  assert(await h.page.getByRole('button', { name: 'Export CSV' }).isVisible(), 'batch export is available')
  await h.shot('01-selection-tray')

  await h.page.getByRole('button', { name: 'Tag', exact: true }).click()
  await h.page.getByRole('textbox').last().fill('Quarter close')
  await h.page.getByRole('button', { name: 'Add tag' }).click()
  await h.page.getByText('Quarter close', { exact: true }).first().waitFor()

  await h.page.getByTestId(`select-voucher-${first.id}`).check()
  await h.page.getByTestId(`select-voucher-${second.id}`).check()
  await h.page.getByRole('button', { name: 'Mark reviewed' }).click()
  await h.page.getByText('Reviewed', { exact: true }).first().waitFor()

  await h.page.getByTestId(`select-voucher-${first.id}`).check()
  await h.page.getByRole('button', { name: 'Reverse…' }).click()
  await h.page.getByTestId('input-reversal-reason').fill('Duplicate journal confirmed by owner')
  await h.page.getByTestId('action-confirm-reversal').click()
  await h.page.getByText('Reversed', { exact: true }).waitFor()
  await h.shot('02-linked-reversal-status')

  const source = await h.invoke('voucher:get', { id: first.id })
  assert(typeof source.reversedById === 'number', 'source links to reversal')
  const reversal = await h.invoke('voucher:get', { id: source.reversedById })
  assertEq(reversal.reversalOfId, first.id, 'reversal links back to source')
  assertEq(reversal.reversalReason, 'Duplicate journal confirmed by owner', 'reason is retained')
  const net = [...source.lines, ...reversal.lines].reduce(
    (sum, line) => sum + (line.drCr === 'dr' ? line.amount : -line.amount), 0
  )
  assertEq(net, 0, 'source and reversal net to zero')
})
