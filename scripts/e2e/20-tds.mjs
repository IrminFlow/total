// Scenario 20 — the TDS screen (WP 3.2), driven through the UI: a contract bill above the 194C
// single-payment limit saved WITHOUT TDS shows on Eligible → Move to TDS → Deducted lists it and
// the tagged payable ledger carries the credit → the deposit (a payment voucher) becomes a
// challan with its deduction allocated → Returns' 26Q data shows the challan → deleting the
// deduction leaves the voucher balanced and puts it back on Eligible.
import { scenario, assert, assertEq } from '../lib/harness.mjs'

await scenario('20-tds', async (h) => {
  await h.createCompanyUI('TDS Works')
  await h.stubDialogs()
  const page = h.page
  const today = await page.evaluate(() => {
    const d = new Date()
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  })
  const groups = await h.invoke('master:groups:list')
  const groupId = (name) => groups.find((g) => g.name === name).id
  const types = await h.invoke('master:voucherTypes:list')
  const typeOf = (kind) => types.find((t) => t.kind === kind)
  const s194c = (await h.invoke('tds:sections')).find((s) => s.code === '194C')
  const mkLedger = (name, group, extra = {}) =>
    h.invoke('master:ledgers:create', {
      name, groupId: groupId(group), openingBalance: 0, gstin: null, stateCode: null, address: null,
      taxType: null, gstRate: null, hsn: null, ...extra
    })
  const contractor = await mkLedger('E2E Builders Pvt Ltd', 'Sundry Creditors', { tdsSectionId: s194c.id, pan: 'AABCE1234F' })
  const labour = await mkLedger('E2E Site Labour', 'Direct Expenses')
  const bank = await mkLedger('E2E Bank', 'Bank Accounts')

  const waitText = (selector, needle, timeout = 10000) =>
    page.waitForFunction(([s, n]) => (document.querySelector(s)?.textContent ?? '').includes(n), [selector, needle], { timeout })
  const balanced = (v) => {
    const dr = v.lines.filter((l) => l.drCr === 'dr').reduce((s, l) => s + l.amount, 0)
    const cr = v.lines.filter((l) => l.drCr === 'cr').reduce((s, l) => s + l.amount, 0)
    return dr === cr && dr > 0
  }

  // ---------- a ₹50,000 contract bill booked without TDS ----------
  const bill = await h.invoke('voucher:save', {
    data: {
      voucherTypeId: typeOf('purchase').id, date: today, partyLedgerId: contractor.id, narration: 'Site work, no TDS',
      lines: [{ ledgerId: labour.id, drCr: 'dr', amount: 5000000 }, { ledgerId: contractor.id, drCr: 'cr', amount: 5000000 }],
      billRefs: [{ kind: 'new', name: 'BLD-17', amount: 5000000, dueDate: null }]
    }
  })
  assertEq(bill.tds, null, 'saved without TDS')

  await h.goto('tds')
  await page.waitForSelector('[data-testid="rows-tds-eligible"] tr.dt-row', { timeout: 15000 })
  await waitText('[data-testid="rows-tds-eligible"]', 'E2E Builders Pvt Ltd')
  const eligibleText = await page.textContent('[data-testid="rows-tds-eligible"]')
  assert(/194C/.test(eligibleText) && /1,000\.00/.test(eligibleText), `Eligible suggests ₹1,000 u/s 194C (got: ${eligibleText})`)
  assert(/Single payment above the limit/.test(eligibleText), 'reason: single payment above the limit')
  await h.shot('01-eligible')

  // ---------- Move to TDS ----------
  await h.click(`btn-tds-move-${bill.id}`)
  await page.waitForFunction(() => !document.querySelector('[data-testid="rows-tds-eligible"] tr.dt-row'), null, { timeout: 15000 })
  const moved = await h.invoke('voucher:get', { id: bill.id })
  assertEq(moved.tds && moved.tds.tdsAmount, 100000, 'the bill now carries ₹1,000 TDS')
  assert(balanced(moved), 'the bill still balances')
  assertEq(moved.lines.find((l) => l.ledgerId === contractor.id).amount, 4900000, 'the supplier credit gave up the TDS')
  const payable = (await h.invoke('master:ledgers:list')).find((l) => l.tdsPayableSectionId === s194c.id)
  assert(payable, 'the tagged payable ledger was created')
  const last = moved.lines[moved.lines.length - 1]
  assert(last.ledgerId === payable.id && last.drCr === 'cr' && last.amount === 100000, 'payable ledger credited ₹1,000 (last line)')
  await waitText('[data-testid="rows-tds-summary"]', '1,000.00')
  assert(/194C/.test(await page.textContent('[data-testid="rows-tds-summary"]')), 'the TDS ledger card shows 194C')

  await h.click('tab-tds-deducted')
  await page.waitForSelector('[data-testid="rows-tds-deducted"] tr.dt-row', { timeout: 10000 })
  const deductedText = await page.textContent('[data-testid="rows-tds-deducted"]')
  assert(/E2E Builders Pvt Ltd/.test(deductedText) && /1,000\.00/.test(deductedText) && /Not on a challan/.test(deductedText), `Deducted lists it (got: ${deductedText})`)
  await h.shot('02-deducted')

  // ---------- the deposit, then a challan from it ----------
  const deposit = await h.invoke('voucher:save', {
    data: {
      voucherTypeId: typeOf('payment').id, date: today, narration: 'ITNS 281',
      lines: [{ ledgerId: payable.id, drCr: 'dr', amount: 100000 }, { ledgerId: bank.id, drCr: 'cr', amount: 100000 }]
    }
  })
  await h.click('tab-tds-challans')
  await h.click('btn-tds-challan-new')
  await page.waitForSelector('[data-testid="select-tds-challan-payment"]', { timeout: 10000 })
  assertEq(await page.locator('[data-testid="select-tds-challan-payment"]').inputValue(), String(deposit.id), 'the deposit is offered')
  await h.fill('input-tds-challan-bsr', '0510308')
  await h.fill('input-tds-challan-no', '42')
  await h.shot('03-new-challan')
  await h.click('btn-tds-challan-create')
  await page.waitForSelector('[data-testid="rows-tds-challans"] tr.dt-row', { timeout: 10000 })
  const challanText = await page.textContent('[data-testid="rows-tds-challans"]')
  assert(/42/.test(challanText) && /0510308/.test(challanText) && /1,000\.00/.test(challanText), `challan listed (got: ${challanText})`)
  const entries = await h.invoke('tds:deducted', { from: today, to: today })
  assertEq(entries[0].challanStatus, 'paid', 'the deduction is allocated to the paid challan')
  await h.shot('04-challans')

  // ---------- Returns ----------
  await h.click('tab-tds-returns')
  await page.waitForSelector('[data-testid="rows-tds-26q"] tr.dt-row', { timeout: 10000 })
  const q = await page.textContent('[data-testid="rows-tds-26q"]')
  assert(/E2E Builders Pvt Ltd/.test(q) && /AABCE1234F/.test(q) && /1,000\.00/.test(q), `26Q deductee row (got: ${q})`)
  await waitText('[data-testid="rows-tds-26q-challans"]', '0510308')
  await page.waitForSelector('[data-testid="rows-tds-16a"] tr.dt-row', { timeout: 10000 })
  await h.click('btn-tds-export')
  await h.shot('05-returns')

  // ---------- delete the deduction: the voucher balances, the bill is eligible again ----------
  await h.click('tab-tds-deducted')
  await page.waitForSelector('[data-testid="rows-tds-deducted"] tr.dt-row', { timeout: 10000 })
  await h.click(`btn-tds-delete-${entries[0].entryId}`)
  await h.click('confirm-ok')
  await page.waitForFunction(() => !document.querySelector('[data-testid="rows-tds-deducted"] tr.dt-row'), null, { timeout: 15000 })
  const back = await h.invoke('voucher:get', { id: bill.id })
  assertEq(back.tds, null, 'deduction removed')
  assert(balanced(back), 'the bill balances after the delete')
  assertEq(back.lines.find((l) => l.ledgerId === contractor.id).amount, 5000000, 'the supplier credit is restored')
  assertEq(back.billRefs[0].amount, 5000000, 'the bill reference is restored')
  await h.click('tab-tds-eligible')
  await waitText('[data-testid="rows-tds-eligible"]', 'E2E Builders Pvt Ltd')
  await h.shot('06-eligible-again')
})
