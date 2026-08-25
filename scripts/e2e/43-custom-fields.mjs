// Scenario 43 — fields a company defines for itself, per voucher type (roadmap #195).
//
// Three properties, end to end:
//   1. A field defined in Settings appears on entry, is saved with the voucher and printed on it.
//   2. It is validated by KIND at the IPC boundary, and a bad value refuses the whole voucher
//      rather than half-writing it.
//   3. It can never change a total — and removing a field never changes what a voucher that was
//      already issued says about itself.
import { scenario, assert, assertEq } from '../lib/harness.mjs'

const iso = (d) => d.toISOString().slice(0, 10)
const today = iso(new Date())

await scenario('43-custom-fields', async (h) => {
  await h.createCompanyUI('Custom Field Books')

  const groups = await h.invoke('master:groups:list')
  const groupId = (name) => groups.find((g) => g.name === name).id
  const buyer = await h.invoke('master:ledgers:create', {
    name: 'Kumar Stores', groupId: groupId('Sundry Debtors'), openingBalance: 0, stateCode: '27'
  })
  const sales = await h.invoke('master:ledgers:create', {
    name: 'Sales', groupId: groupId('Sales Accounts'), openingBalance: 0
  })
  const types = await h.invoke('master:voucherTypes:list')
  const salesType = types.find((t) => t.kind === 'sales')
  const journalType = types.find((t) => t.kind === 'journal')

  // ---- defined on the screen a person would use ----
  await h.goto('settings')
  await h.page.click('[data-testid="tab-settings-customFields"]')
  await h.page.waitForSelector('[data-testid="input-cf-label"]', { timeout: 15000 })
  await h.page.selectOption('[data-testid="select-cf-type"]', String(salesType.id))
  await h.fill('input-cf-label', 'Customer PO')
  await h.click('btn-cf-add')
  await h.page.waitForSelector('[data-testid="row-cf-customer_po"]', { timeout: 10000 })
  await h.shot('01-custom-fields-settings')

  // The rest through the handlers, which is what the screen calls anyway.
  const cartons = await h.invoke('customField:save', {
    data: { voucherTypeId: salesType.id, label: 'Cartons', kind: 'number' }
  })
  const mode = await h.invoke('customField:save', {
    data: { voucherTypeId: salesType.id, label: 'Dispatch mode', kind: 'list', options: ['Road', 'Rail'] }
  })
  const po = (await h.invoke('customField:list', { voucherTypeId: salesType.id }))
    .find((f) => f.key === 'customer_po')
  assert(po, 'the field defined on screen is there')

  // A different voucher type has none of them.
  assertEq((await h.invoke('customField:list', { voucherTypeId: journalType.id })).length, 0,
    'a field belongs to one voucher type, not to all of them')

  // ---- validated by kind ----
  const invoice = (customFields, amount = 118000) =>
    h.invoke('voucher:save', {
      data: {
        voucherTypeId: salesType.id, date: today, partyLedgerId: buyer.id,
        lines: [
          { ledgerId: buyer.id, drCr: 'dr', amount },
          { ledgerId: sales.id, drCr: 'cr', amount }
        ],
        customFields
      }
    })

  const badNumber = await invoice([{ fieldId: cartons.id, value: '1,000' }]).then(() => null, (e) => e)
  assert(badNumber && /plain number/.test(String(badNumber)), 'a number field refuses a thousands separator')
  const badChoice = await invoice([{ fieldId: mode.id, value: 'Sea' }]).then(() => null, (e) => e)
  assert(badChoice && /must be one of/.test(String(badChoice)), 'a list field refuses a value off its list')

  // Nothing was half-written by either refusal.
  assertEq((await h.invoke('voucher:list', { from: today, to: today })).length, 0,
    'a rejected custom field refuses the whole voucher')

  // ---- saved with the voucher, and on the print ----
  const saved = await invoice([
    { fieldId: po.id, value: 'PO/2026/881' },
    { fieldId: cartons.id, value: '12.5' },
    { fieldId: mode.id, value: 'Rail' }
  ])
  const reread = await h.invoke('voucher:get', { id: saved.id })
  assertEq(reread.customFields.length, 3, 'the voucher carries all three')
  assertEq(reread.customFields.find((f) => f.key === 'cartons').value, '12.5',
    'a number is kept as the text it was typed as — it is not paise')

  const printed = await h.invoke('invoice:previewHtml', { voucherId: saved.id })
  assert(/Customer PO: <span>PO\/2026\/881<\/span>/.test(printed.html), 'the field is printed on the invoice')
  assert(/Dispatch mode: <span>Rail<\/span>/.test(printed.html), 'so is the list choice')
  assert(/Cartons: <span>12\.5<\/span>/.test(printed.html), 'and the number, exactly as typed')

  // ---- and never a total ----
  const before = await h.invoke('report:trialBalance', { asOn: today })
  const big = await h.invoke('customField:save', {
    data: { voucherTypeId: salesType.id, label: 'Advance held', kind: 'number' }
  })
  await h.invoke('voucher:save', {
    data: {
      voucherTypeId: salesType.id, date: today, partyLedgerId: buyer.id,
      lines: [
        { ledgerId: buyer.id, drCr: 'dr', amount: 100 },
        { ledgerId: sales.id, drCr: 'cr', amount: 100 }
      ],
      customFields: [
        { fieldId: po.id, value: 'PO/2026/882' },
        { fieldId: big.id, value: '99999999' }
      ]
    }
  })
  const after = await h.invoke('report:trialBalance', { asOn: today })
  const moved = after.totalDebit - before.totalDebit
  assertEq(moved, 100, 'the books moved by the voucher’s own hundred paise and by nothing else')

  // ---- removed while vouchers still carry it ----
  const removal = await h.invoke('customField:remove', { id: mode.id })
  assertEq(removal.retained, 1, 'the removal says how many vouchers keep the value')
  assertEq((await h.invoke('customField:list', { voucherTypeId: salesType.id })).some((f) => f.key === 'dispatch_mode'), false,
    'it is gone from new entries')
  const still = await h.invoke('voucher:get', { id: saved.id })
  const kept = still.customFields.find((f) => f.key === 'dispatch_mode')
  assert(kept && kept.value === 'Rail' && kept.retired === true,
    'and the voucher issued with it still says Rail')
  const printedAgain = await h.invoke('invoice:previewHtml', { voucherId: saved.id })
  assert(/Dispatch mode: <span>Rail<\/span>/.test(printedAgain.html),
    'the document still prints what it said when it was issued')

  // ---- on the entry screen ----
  await h.goto('voucher-entry')
  await h.click('tab-voucher-entry-sales')
  await h.page.waitForSelector('[data-testid="panel-custom-fields"]', { timeout: 15000 })
  const cartonsInput = await h.page.$('[data-testid="input-cf-cartons"]')
  assert(cartonsInput, 'the number field is on the entry form')
  assertEq(await h.page.$('[data-testid="input-cf-dispatch_mode"]') === null, true,
    'the removed field is not offered on a new entry')
  await h.shot('02-custom-fields-entry')

  h.assertNoConsoleErrors()
})
