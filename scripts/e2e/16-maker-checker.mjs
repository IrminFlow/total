// Scenario 16 — configure maker-checker, prove a maker's entry stays outside the books,
// then approve it as a different owner through the visible Action Centre queue.
import { scenario, assert, assertEq } from '../lib/harness.mjs'

await scenario('16-maker-checker', async (h) => {
  await h.createCompanyUI('Controlled Books Co')
  const owner = await h.invoke('users:save', { data: { name: 'Meera Owner', role: 'owner', pin: '1234', active: true } })
  const maker = await h.invoke('users:save', { data: { name: 'Kabir Maker', role: 'accountant', pin: '2345', active: true } })

  await h.relaunch()
  assertEq(await h.openCompany('Controlled Books Co'), 'lock', 'protected company opens locked')
  await h.clickText('Meera Owner')
  await h.fill('input-pin', '1234')
  await h.click('btn-unlock')
  await h.waitScreen('gateway')

  await h.goto('settings')
  await h.click('tab-settings-controls')
  await h.page.waitForFunction(() => document.body.innerText.includes('Maker-checker for vouchers'))
  await h.page.locator('label', { hasText: 'Require approval' }).locator('input').check()
  await h.page.locator('label', { hasText: 'Require review' }).locator('input').check()
  await h.fill('input-approval-threshold', '1000')
  await h.click('btn-approval-policy-save')
  await h.page.waitForFunction(() => document.body.innerText.includes('Enforced'))
  await h.shot('01-controls-policy')

  const types = await h.invoke('master:voucherTypes:list')
  const ledgers = await h.invoke('master:ledgers:list')
  const receipt = types.find((type) => type.kind === 'receipt')
  const cash = ledgers.find((ledger) => ledger.name === 'Cash')
  assert(receipt && cash, 'receipt type and cash ledger exist')

  await h.invoke('auth:logout')
  await h.invoke('auth:login', { userId: maker.id, pin: '2345' })
  const pending = await h.invoke('voucher:save', {
    data: {
      voucherTypeId: receipt.id, date: '2026-08-24', partyLedgerId: null,
      narration: 'Controlled counter receipt', reference: null, instrumentNo: null, instrumentDate: null,
      transporterId: null, vehicleNo: null, transportDistanceKm: null, posOverride: null,
      currencyCode: null, exchangeRate: null,
      lines: [
        { ledgerId: cash.id, drCr: 'dr', amount: 250000, costAllocations: [] },
        { ledgerId: cash.id, drCr: 'cr', amount: 250000, costAllocations: [] }
      ],
      inventory: [], billRefs: [], tds: null
    }
  })
  assertEq(pending.approvalRequired, true, 'maker entry becomes an approval request')
  assertEq((await h.invoke('voucher:list', { from: '2026-08-01', to: '2026-08-31' })).length, 0, 'pending request is outside the day book')

  await h.invoke('auth:logout')
  await h.invoke('auth:login', { userId: owner.id, pin: '1234' })
  await h.goto('action-centre')
  await h.page.waitForFunction((id) => document.body.innerText.includes(`Voucher & expense approvals`) && document.body.innerText.includes(`#${id}`), pending.request.id)
  await h.shot('02-approval-queue')
  await h.click(`approval-approve-${pending.request.id}`)
  await h.page.waitForFunction(() => !document.body.innerText.includes('Voucher & expense approvals'))
  assertEq((await h.invoke('voucher:list', { from: '2026-08-01', to: '2026-08-31' })).length, 1, 'approved request posts exactly one voucher')
  await h.shot('03-approved')

  const groups = await h.invoke('master:groups:list')
  const expense = await h.invoke('master:ledgers:create', { name: 'Employee Field Travel', groupId: groups.find((group) => group.name === 'Indirect Expenses').id, openingBalance: 0, gstin: null, stateCode: null, address: null, taxType: null, gstRate: null, hsn: null })
  const department = await h.invoke('cc:save', { data: { name: 'Field Sales', parentId: null } })
  const payment = types.find((type) => type.kind === 'payment')
  await h.invoke('auth:logout')
  await h.invoke('auth:login', { userId: maker.id, pin: '2345' })
  const expensePending = await h.invoke('voucher:save', { data: { voucherTypeId: payment.id, date: '2026-08-24', partyLedgerId: null, narration: 'Field travel reimbursement', reference: null, instrumentNo: null, instrumentDate: null, transporterId: null, vehicleNo: null, transportDistanceKm: null, posOverride: null, currencyCode: null, exchangeRate: null, lines: [{ ledgerId: expense.id, drCr: 'dr', amount: 50000, costAllocations: [{ costCentreId: department.id, amount: 50000 }] }, { ledgerId: cash.id, drCr: 'cr', amount: 50000, costAllocations: [] }], inventory: [], billRefs: [], tds: null } })
  assertEq(expensePending.request.requestKind, 'expense', 'expense policy classifies the request')
  await h.invoke('auth:logout'); await h.invoke('auth:login', { userId: owner.id, pin: '1234' })
  await h.goto('gateway')
  await h.goto('action-centre')
  await h.page.getByText('Expense', { exact: true }).waitFor()
  await h.page.getByText(/Field Sales/).waitFor()
  await h.shot('04-expense-approval-inbox')
  await h.click(`approval-approve-${expensePending.request.id}`)
  await h.page.waitForFunction((id) => !document.body.innerText.includes(`#${id}`), expensePending.request.id)
})
