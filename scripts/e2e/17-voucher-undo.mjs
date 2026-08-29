// Scenario 17 — undo a deleted voucher.
//
// The bin could always restore a deleted voucher, but nothing offered it at the moment the
// user is looking for it. The delete toast now carries an Undo, and this proves the restore
// actually puts the books back exactly as they were.
import { scenario, assert, assertEq } from '../lib/harness.mjs'

await scenario('17-voucher-undo', async (h) => {
  await h.createDemoCompany()

  const before = await h.invoke('report:trialBalance', { asOn: '2027-03-31' })
  const vouchers = await h.invoke('voucher:list', { from: '2026-04-01', to: '2027-03-31' })
  const target = vouchers[0]
  assert(target != null, 'the demo company has a voucher to delete')

  await h.goto('daybook')
  await h.invoke('voucher:delete', { id: target.id })
  const afterDelete = await h.invoke('report:trialBalance', { asOn: '2027-03-31' })
  assert(
    afterDelete.totalDebit !== before.totalDebit,
    'deleting the voucher moved the trial balance'
  )

  await h.invoke('voucher:restore', { id: target.id })
  const afterUndo = await h.invoke('report:trialBalance', { asOn: '2027-03-31' })
  assertEq(afterUndo.totalDebit, before.totalDebit, 'undo restored the books exactly')
  assertEq(afterUndo.totalCredit, before.totalCredit, 'and both sides still tie')

  const bin = await h.invoke('voucher:bin')
  assert(!bin.some((v) => v.id === target.id), 'the restored voucher is out of the bin')
})
