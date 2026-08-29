import { describe, expect, it } from 'vitest'
import { seededDb } from '../db/testdb'
import { createLedger } from './masters'
import { deleteVoucher, saveVoucher } from './vouchers'
import { addCollectionNote, collectionQueue, customerWorkspace, draftReminder, listPromises, openDispute, ownerWorkload, receiptSuggestions, resolveDispute, resolvePromise, saveCustomerSettings, savePromise } from './collections'

const defaults = { gstin: null, stateCode: null, address: null, taxType: null, gstRate: null, hsn: null, tdsSectionId: null, pan: null, creditDays: 0, exportType: null }

function createSale(db: ReturnType<typeof seededDb>, partyName: string, amount: number, date: string): number {
  const group = (name: string): number => (db.prepare('SELECT id FROM groups WHERE name = ?').get(name) as { id: number }).id
  const party = createLedger(db, { ...defaults, name: partyName, groupId: group('Sundry Debtors'), openingBalance: 0 }).id
  const sales = createLedger(db, { ...defaults, name: `${partyName} Sales`, groupId: group('Sales Accounts'), openingBalance: 0 }).id
  const type = (db.prepare("SELECT id FROM voucher_types WHERE kind = 'sales'").get() as { id: number }).id
  saveVoucher(db, {
    voucherTypeId: type, date, partyLedgerId: party, narration: 'Credit sale', reference: null,
    instrumentNo: null, instrumentDate: null, transporterId: null, vehicleNo: null, transportDistanceKm: null,
    currencyCode: null, exchangeRate: null,
    lines: [{ ledgerId: party, drCr: 'dr', amount, costAllocations: [] }, { ledgerId: sales, drCr: 'cr', amount, costAllocations: [] }],
    inventory: [], billRefs: [{ kind: 'new', name: `INV-${party}`, amount, dueDate: date }], tds: null
  })
  return party
}

function postReceipt(
  db: ReturnType<typeof seededDb>,
  partyId: number,
  billName: string,
  amount: number,
  date: string,
  options: { postDated?: boolean; isOptional?: boolean; number?: string } = {}
): number {
  const type = (db.prepare("SELECT id FROM voucher_types WHERE kind = 'receipt'").get() as { id: number }).id
  const cash = (db.prepare("SELECT id FROM ledgers WHERE name = 'Cash'").get() as { id: number }).id
  return saveVoucher(db, {
    voucherTypeId: type, date, number: options.number, partyLedgerId: partyId, narration: 'Customer receipt', reference: null,
    instrumentNo: null, instrumentDate: null, transporterId: null, vehicleNo: null, transportDistanceKm: null,
    currencyCode: null, exchangeRate: null, postDated: options.postDated, isOptional: options.isOptional,
    lines: [{ ledgerId: cash, drCr: 'dr', amount, costAllocations: [] }, { ledgerId: partyId, drCr: 'cr', amount, costAllocations: [] }],
    inventory: [], billRefs: [{ kind: 'against', name: billName, amount, dueDate: null }], tds: null
  }).id
}

function postSaleForParty(
  db: ReturnType<typeof seededDb>,
  partyId: number,
  billName: string,
  amount: number,
  options: { postDated?: boolean; isOptional?: boolean }
): number {
  const type = (db.prepare("SELECT id FROM voucher_types WHERE kind = 'sales'").get() as { id: number }).id
  const partyName = (db.prepare('SELECT name FROM ledgers WHERE id=?').get(partyId) as { name: string }).name
  const sales = (db.prepare('SELECT id FROM ledgers WHERE name=?').get(`${partyName} Sales`) as { id: number }).id
  return saveVoucher(db, {
    voucherTypeId: type, date: '2026-01-01', number: billName, partyLedgerId: partyId, narration: 'Test invoice', reference: null,
    instrumentNo: null, instrumentDate: null, transporterId: null, vehicleNo: null, transportDistanceKm: null,
    currencyCode: null, exchangeRate: null, postDated: options.postDated, isOptional: options.isOptional,
    lines: [{ ledgerId: partyId, drCr: 'dr', amount, costAllocations: [] }, { ledgerId: sales, drCr: 'cr', amount, costAllocations: [] }],
    inventory: [], billRefs: [{ kind: 'new', name: billName, amount, dueDate: '2026-01-01' }], tds: null
  }).id
}

describe('collections queue and promises', () => {
  it('ranks older/larger exposure and makes missed promises explicit', () => {
    const db = seededDb()
    const older = createSale(db, 'Older Customer', 500_000, '2026-01-01')
    createSale(db, 'Recent Customer', 100_000, '2026-07-20')
    const promise = savePromise(db, { ledgerId: older, amount: 200_000, promisedDate: '2026-07-31', owner: 'Asha', note: 'Committed by phone' })
    const queue = collectionQueue(db, '2026-08-24')
    expect(queue[0]).toMatchObject({ ledgerId: older, priority: 'critical', reason: 'Promised date missed' })
    expect(queue[0]?.nextPromise).toMatchObject({ id: promise.id, owner: 'Asha', status: 'pending' })
  })

  it('retains promise history and refuses a second outcome', () => {
    const db = seededDb()
    const party = createSale(db, 'Promise Customer', 100_000, '2026-07-01')
    const promise = savePromise(db, { ledgerId: party, amount: 50_000, promisedDate: '2026-08-30', owner: 'Kabir', note: null })
    expect(() => savePromise(db, { ledgerId: party, amount: 10_000, promisedDate: '2026-09-01', owner: 'Kabir', note: null })).toThrow('active promise')
    expect(resolvePromise(db, promise.id, 'broken', 'No response')).toMatchObject({ status: 'broken', outcomeNote: 'No response' })
    expect(() => resolvePromise(db, promise.id, 'kept', null)).toThrow('already been resolved')
    expect(listPromises(db, party)).toHaveLength(1)
  })

  it('builds an explainable customer workspace and receipt suggestions', () => {
    const db = seededDb()
    const party = createSale(db, 'Workspace Customer', 250_000, '2026-06-01')
    const voucher = db.prepare('SELECT id FROM vouchers WHERE party_ledger_id=?').get(party) as { id: number }
    saveCustomerSettings(db, party, { owner: 'Meera', reminderDays: [7, 30], earlyDiscountBps: 200, earlyDays: 10 }, 'Owner')
    addCollectionNote(db, party, 'Customer asked for statement', 'Meera')
    openDispute(db, party, voucher.id, 'Quantity short', 'Meera')
    let workspace = customerWorkspace(db, party, '2026-08-24')
    expect(workspace).toMatchObject({ settings: { owner: 'Meera', reminderDays: [7, 30] }, risk: { band: 'high' } })
    expect(workspace.timeline.some((item) => item.kind === 'note')).toBe(true)
    expect(workspace.remindersDue).toHaveLength(0)
    resolveDispute(db, workspace.disputes[0]!.id, 'Credit note accepted')
    workspace = customerWorkspace(db, party, '2026-08-24')
    expect(workspace.remindersDue.length).toBeGreaterThan(0)
    const reminder = workspace.remindersDue[0]!
    draftReminder(db, party, reminder.voucherId, 'email', 'Reviewed reminder', '2026-08-24', 'Meera')
    expect(customerWorkspace(db, party, '2026-08-24').timeline.some((item) => item.kind === 'reminder')).toBe(true)
    expect(receiptSuggestions(db, { amount: 250_000, date: '2026-08-24', reference: '', payer: 'Workspace' })[0]).toMatchObject({ partyLedgerId: party, score: 90 })
    expect(ownerWorkload(db, '2026-08-24')[0]).toMatchObject({ owner: 'Meera', customers: 1 })
  })

  it('learns payment delay only from active-book receipts and invoices', () => {
    const db = seededDb()
    const party = createSale(db, 'Behavior Customer', 100_000, '2026-01-01')
    const activeBill = `INV-${party}`
    postReceipt(db, party, activeBill, 10_000, '2026-01-11', { number: 'ACTIVE-RECEIPT' })

    postReceipt(db, party, activeBill, 1_000, '2026-04-30', { number: 'OPTIONAL-RECEIPT', isOptional: true })
    postReceipt(db, party, activeBill, 1_000, '2026-05-30', { number: 'PDC-RECEIPT', postDated: true })
    const binnedReceipt = postReceipt(db, party, activeBill, 1_000, '2026-06-30', { number: 'BINNED-RECEIPT' })
    deleteVoucher(db, binnedReceipt)

    const inactiveInvoices = [
      { name: 'OPTIONAL-INVOICE', id: postSaleForParty(db, party, 'OPTIONAL-INVOICE', 1_000, { isOptional: true }) },
      { name: 'PDC-INVOICE', id: postSaleForParty(db, party, 'PDC-INVOICE', 1_000, { postDated: true }) },
      { name: 'BINNED-INVOICE', id: postSaleForParty(db, party, 'BINNED-INVOICE', 1_000, {}) }
    ]
    deleteVoucher(db, inactiveInvoices[2]!.id)
    for (const [index, invoice] of inactiveInvoices.entries()) {
      postReceipt(db, party, invoice.name, 1_000, `2026-0${7 + index}-01`, { number: `INACTIVE-INVOICE-RECEIPT-${index}` })
    }

    const forecast = customerWorkspace(db, party, '2026-12-31').forecast.find((row) => row.label === activeBill)
    expect(forecast).toMatchObject({ source: 'behavior', date: '2026-01-11' })
  })

  it('links disputes and reminders only to active customer sales documents', () => {
    const db = seededDb()
    const customer = createSale(db, 'Guarded Customer', 100_000, '2026-01-01')
    const otherCustomer = createSale(db, 'Other Customer', 100_000, '2026-01-02')
    const activeSale = (db.prepare('SELECT id FROM vouchers WHERE party_ledger_id=? ORDER BY id LIMIT 1').get(customer) as { id: number }).id
    const otherSale = (db.prepare('SELECT id FROM vouchers WHERE party_ledger_id=? ORDER BY id LIMIT 1').get(otherCustomer) as { id: number }).id
    const receipt = postReceipt(db, customer, `INV-${customer}`, 1_000, '2026-01-03')
    const deletedSale = postSaleForParty(db, customer, 'DELETED-SALE', 1_000, {})
    const optionalSale = postSaleForParty(db, customer, 'OPTIONAL-SALE', 1_000, { isOptional: true })
    const postDatedSale = postSaleForParty(db, customer, 'PDC-SALE', 1_000, { postDated: true })
    const creditNoteType = (db.prepare("SELECT id FROM voucher_types WHERE kind='credit_note'").get() as { id: number }).id
    const salesLedger = (db.prepare("SELECT id FROM ledgers WHERE name='Guarded Customer Sales'").get() as { id: number }).id
    const creditNote = saveVoucher(db, {
      voucherTypeId: creditNoteType, date: '2026-01-04', partyLedgerId: customer, narration: 'Customer credit note', reference: null,
      instrumentNo: null, instrumentDate: null, transporterId: null, vehicleNo: null, transportDistanceKm: null,
      currencyCode: null, exchangeRate: null,
      lines: [{ ledgerId: salesLedger, drCr: 'dr', amount: 1_000, costAllocations: [] }, { ledgerId: customer, drCr: 'cr', amount: 1_000, costAllocations: [] }],
      inventory: [], billRefs: [], tds: null
    }).id
    deleteVoucher(db, deletedSale)

    expect(() => openDispute(db, customer, otherSale, 'Wrong customer', 'Owner')).toThrow('does not belong')
    expect(() => draftReminder(db, customer, receipt, 'email', 'Receipt is not an invoice', '2026-02-01', 'Owner')).toThrow('not valid')
    expect(() => openDispute(db, customer, deletedSale, 'Deleted invoice', 'Owner')).toThrow('not active')
    expect(() => draftReminder(db, customer, optionalSale, 'email', 'Optional invoice', '2026-02-01', 'Owner')).toThrow('not active')
    expect(() => openDispute(db, customer, postDatedSale, 'Post-dated invoice', 'Owner')).toThrow('not active')

    expect(() => openDispute(db, customer, activeSale, 'Valid invoice dispute', 'Owner')).not.toThrow()
    expect(() => draftReminder(db, customer, activeSale, 'email', 'Valid invoice reminder', '2026-02-01', 'Owner')).not.toThrow()
    expect(() => openDispute(db, customer, creditNote, 'Valid credit note dispute', 'Owner')).not.toThrow()
  })
})
