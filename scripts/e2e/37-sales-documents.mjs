// Scenario 37 — non-posting sales lifecycle: quote → order → challan → invoice draft.
import { scenario, assert, assertEq } from '../lib/harness.mjs'

await scenario('37-sales-documents', async (h) => {
  await h.createCompanyUI('Sales Operations Books')
  const groups = await h.invoke('master:groups:list')
  const units = await h.invoke('master:units:list')
  const debtors = groups.find((group) => group.name === 'Sundry Debtors')
  const customer = await h.invoke('master:ledgers:create', { name: 'Northstar Retail', groupId: debtors.id, openingBalance: 0, gstin: '27AAPFU0939F1ZV', stateCode: '27', address: 'Mumbai', taxType: null, gstRate: null, hsn: null })
  const item = await h.invoke('master:stockItems:create', { name: 'Compact Pump', groupId: null, unitId: units[0].id, hsn: '8413', gstRate: 18, cessRate: null, openingQtyMilli: 20_000, openingValue: 2_000_000, barcode: null, reorderLevelMilli: 0, valuationMethod: 'weighted_avg' })
  const series = await h.invoke('salesDocument:seriesList', {})
  const byKind = Object.fromEntries(series.map((row) => [row.kind, row]))
  const quote = await h.invoke('salesDocument:create', {
    kind: 'quotation', seriesId: byKind.quotation.id, partyLedgerId: customer.id,
    date: '2026-08-24', validUntil: '2026-09-07', purpose: 'West-region store rollout',
    gstRegistrationId: null, terms: ['Dispatch within seven days', 'Payment due in 30 days'],
    customFields: { salesperson: 'Meera' },
    lines: [{ stockItemId: item.id, description: 'Compact Pump', qtyMilli: 10_000, rate: 125_000, discountBps: 500, gstRate: 18 }]
  })
  assertEq((await h.invoke('voucher:list', { from: '2026-08-01', to: '2026-08-31' })).length, 0, 'quotation does not post books')

  // Gateway single-letter mnemonic opens the new workspace.
  await h.page.keyboard.press('l')
  await h.waitScreen('sales-documents')
  await h.page.getByText(quote.number, { exact: true }).first().waitFor()
  await h.shot('01-sales-desk-quotation')

  await h.click('btn-sales-document-advance')
  await h.page.getByTestId('sales-document-detail').getByText('sent', { exact: true }).waitFor()
  await h.click('btn-sales-document-advance')
  await h.page.getByTestId('sales-document-detail').getByText('accepted', { exact: true }).waitFor()
  await h.click('btn-sales-document-convert')
  await h.page.getByText('A traceable handoff, not a duplicate', { exact: true }).waitFor()
  await h.shot('02-quotation-conversion')
  await h.click('btn-sales-convert-confirm')
  await h.page.getByTestId('sales-document-detail').getByText('converted', { exact: true }).waitFor()

  await h.click('tab-sales-order')
  const order = (await h.invoke('salesDocument:list', { kind: 'order' }))[0]
  await h.page.getByText(order.number, { exact: true }).first().waitFor()
  await h.click('btn-sales-document-advance')
  await h.page.getByTestId('sales-document-detail').getByText('confirmed', { exact: true }).waitFor()
  await h.click('btn-sales-document-convert')
  await h.click('btn-sales-convert-confirm')

  await h.click('tab-sales-challan')
  const challan = (await h.invoke('salesDocument:list', { kind: 'challan' }))[0]
  await h.page.getByText(challan.number, { exact: true }).first().waitFor()
  await h.click('btn-sales-document-advance')
  await h.page.getByTestId('sales-document-detail').getByText('approved', { exact: true }).waitFor()
  await h.shot('03-delivery-ready')
  await h.click('btn-sales-document-convert')
  await h.page.getByText('A traceable handoff, not a duplicate', { exact: true }).waitFor()
  await h.click('btn-sales-convert-confirm')
  await h.waitScreen('voucher-entry')
  assertEq(await h.page.getByPlaceholder('Being goods sold…').inputValue(), `Converted from ${challan.number}`, 'invoice draft carries source narration')
  assertEq(await h.page.getByTestId('picker-party').inputValue(), 'Northstar Retail', 'invoice draft carries customer')
  await h.shot('04-linked-invoice-draft')

  const vouchers = await h.invoke('voucher:list', { from: '2026-08-01', to: '2026-08-31' })
  assertEq(vouchers.length, 0, 'conversion stops at editable invoice draft')
  const drafts = await h.invoke('voucherDraft:list')
  assert(drafts.some((draft) => draft.payload.salesDocumentId === challan.id), 'invoice draft retains source document identity')
})
