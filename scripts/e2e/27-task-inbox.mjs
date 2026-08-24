// Scenario 27 — create a due follow-up from a voucher, surface it in Action Centre, deep-link and complete it.
import { scenario, assertEq } from '../lib/harness.mjs'

await scenario('27-task-inbox', async (h) => {
  await h.createCompanyUI('Task Inbox Books')
  const groups = await h.invoke('master:groups:list')
  const expense = await h.invoke('master:ledgers:create', { name: 'Task Expense', groupId: groups.find((group) => group.name === 'Indirect Expenses').id, openingBalance: 0, gstin: null, stateCode: null, address: null, taxType: null, gstRate: null, hsn: null })
  const income = await h.invoke('master:ledgers:create', { name: 'Task Income', groupId: groups.find((group) => group.name === 'Indirect Incomes').id, openingBalance: 0, gstin: null, stateCode: null, address: null, taxType: null, gstRate: null, hsn: null })
  const journal = (await h.invoke('master:voucherTypes:list')).find((type) => type.kind === 'journal')
  const today = new Date().toISOString().slice(0, 10)
  const voucher = await h.invoke('voucher:save', { data: { voucherTypeId: journal.id, date: today, partyLedgerId: null, narration: 'Needs supporting evidence', reference: null, instrumentNo: null, instrumentDate: null, transporterId: null, vehicleNo: null, transportDistanceKm: null, currencyCode: null, exchangeRate: null, lines: [{ ledgerId: expense.id, drCr: 'dr', amount: 25_000 }, { ledgerId: income.id, drCr: 'cr', amount: 25_000 }], inventory: [] } })

  await h.goto('daybook')
  await h.page.locator(`[data-row-id="${voucher.id}"]`).click()
  await h.page.getByRole('button', { name: 'Add task' }).click()
  await h.page.getByTestId('input-task-title').fill('Collect supporting receipt')
  await h.page.getByPlaceholder('Context, expected outcome, or next step').fill('Ask the bookkeeper before month close')
  await h.page.getByTestId('save-task').click()
  await h.page.getByText('Collect supporting receipt', { exact: true }).waitFor()
  await h.shot('01-voucher-linked-task')

  await h.goto('action-centre')
  await h.page.getByText('Collect supporting receipt', { exact: true }).waitFor()
  await h.shot('02-action-centre-follow-up')
  await h.goto('task-inbox')
  await h.page.getByRole('button', { name: /Open link/ }).click()
  await h.page.getByText(new RegExp(`Alter voucher ${voucher.number}`)).waitFor()

  await h.goto('task-inbox')
  await h.page.getByRole('button', { name: 'Complete Collect supporting receipt' }).click()
  const [done] = await h.invoke('task:list', { status: 'done' })
  assertEq(done.title, 'Collect supporting receipt', 'task remains in completed history')
  assertEq(done.linkKey, String(voucher.id), 'voucher link remains durable')
})
