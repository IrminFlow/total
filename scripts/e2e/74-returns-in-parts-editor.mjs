// Scenario 74 — PR #190 review: a return note that emptied its bill (returns in parts, the
// running total) opens in the REAL invoice editor with the tax and round off it posted, and
// re-saves unchanged — untouched, and after a narration change.
//   3 × ₹100.50 less ₹1 at 18 % on credit (₹355), returned 1 + 1 + 1 through simple:post: notes of
//   ₹118, ₹118, ₹119. The last one opened from the Day book must show ₹119 (not the ₹118 its rows
//   compute alone), not ask to discard on leaving, and save back to the same rows.
import { scenario, assert, assertEq, localToday } from '../lib/harness.mjs'

await scenario('74-returns-in-parts-editor', async (h) => {
  const { page } = h
  const today = localToday()
  await h.createCompanyUI('Parts Returns', { gstin: '27AAPFU0939F1ZV' })
  await h.stubDialogs()
  const groups = await h.invoke('master:groups:list')
  const gid = (name) => groups.find((g) => g.name === name).id
  const ledger = (name, group, extra = {}) =>
    h.invoke('master:ledgers:create', {
      name, groupId: gid(group), openingBalance: 0, gstin: null, stateCode: '27', address: null, taxType: null, gstRate: null, hsn: null,
      tdsSectionId: null, pan: null, creditDays: null, exportType: null, ...extra
    })
  const ramesh = await ledger('Ramesh', 'Sundry Debtors')
  await ledger('Sales', 'Sales Accounts', { simpleCategory: 'sales' })
  const unit = (await h.invoke('master:units:list'))[0]
  const widget = await h.invoke('master:stockItems:create', {
    name: 'Widget', groupId: null, unitId: unit.id, hsn: '8471', gstRate: 18, cessRate: null,
    openingQtyMilli: 100_000, openingValue: 1_000_000, barcode: null, reorderLevelMilli: null
  })
  const sale = await h.invoke('simple:post', {
    intent: { clientId: 'e2e74-sale', kind: 'sale', date: today, customerId: ramesh.id, items: [{ itemId: widget.id, qty: '3', rate: '100.50', discount: '1' }], payment: { how: 'credit' } }
  })
  const billId = sale.voucherIds[0]
  const bill = await h.invoke('voucher:get', { id: billId })
  const lineUid = bill.inventory[0].lineUid
  const notes = []
  for (let i = 1; i <= 3; i++) {
    const r = await h.invoke('simple:post', { intent: { clientId: `e2e74-return-${i}`, kind: 'return_sale', date: today, billId, items: [{ lineUid, qty: '1' }] } })
    notes.push(r.voucherIds[0])
  }
  const partyAmount = (v) => v.lines.find((l) => l.ledgerId === ramesh.id).amount
  const last = await h.invoke('voucher:get', { id: notes[2] })
  assertEq(partyAmount(last), 11_900, 'the last return gives back the ₹119 the bill still holds')
  const rowsOf = (v) => JSON.stringify({
    lines: v.lines.map((l) => [l.ledgerId, l.drCr, l.amount]),
    inventory: v.inventory.map((l) => [l.stockItemId, l.qtyMilli, l.ratePaise, l.discountPaise, l.amount, l.direction]),
    refs: v.billRefs
  })
  const before = rowsOf(last)

  // Open it from the Day book in the invoice editor: the total is what it posted.
  await page.reload()
  await page.waitForSelector('[data-screen="company-select"], [data-screen="gateway"]', { state: 'attached', timeout: 20000 })
  if (await page.$('[data-screen="company-select"]')) await h.openCompany('Parts Returns')
  await h.stubDialogs()
  const openNote = async () => {
    await h.goto('gateway')
    await h.goto('daybook')
    await page.click(`[data-testid="rows-daybook"] [data-row-id="${notes[2]}"]`, { timeout: 10000 })
    await h.waitScreen('voucher-entry')
    const mode = await page.waitForSelector('[data-testid="voucher-entry-mode"]', { timeout: 10000 })
    assertEq(await mode.getAttribute('data-mode'), 'invoice', 'the note opens in the invoice editor')
    const total = await page.waitForSelector('[data-testid="invoice-total"]', { timeout: 10000 })
    assertEq(Number(await total.getAttribute('data-paise')), 11_900, 'the editor shows the ₹119 the note posted')
  }
  await openNote()
  await h.shot('01-note-in-editor')
  // Untouched: leaving asks nothing (the form is not dirty on open — a dirty one asks to discard).
  await page.click('button:has-text("Cancel")')
  // A dirty form would stop on the discard question; an untouched one lands on the Day book.
  await page.waitForSelector('[data-screen="daybook"][data-loading="false"], [data-testid="confirm-ok"]', { state: 'attached', timeout: 10000 })
  assert(!(await page.$('[data-testid="confirm-ok"]')), 'leaving an untouched note asks nothing')
  await h.waitScreen('daybook')

  // Saved untouched: the same rows.
  await openNote()
  await h.click('btn-save-voucher')
  await h.waitScreen('daybook')
  assertEq(rowsOf(await h.invoke('voucher:get', { id: notes[2] })), before, 'saved untouched: the same rows')

  // A narration change saves (it used to be refused: "Bill references must add up …"), rows unchanged.
  await openNote()
  const narration = page.locator('[data-testid="input-invoice-narration"]').first()
  await narration.fill('Returned in parts — checked')
  await h.click('btn-save-voucher')
  await h.waitScreen('daybook')
  const after = await h.invoke('voucher:get', { id: notes[2] })
  assertEq(after.narration, 'Returned in parts — checked', 'the narration is saved')
  assertEq(rowsOf(after), before, 'a narration change leaves the rows as they were')

  // The bill and its three returns still net to zero for Ramesh.
  const due = await h.invoke('simple:people:person', { id: ramesh.id, today })
  assertEq(due.open, 0, 'Ramesh owes nothing')
})
