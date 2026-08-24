import { describe, expect, it } from 'vitest'
import { seededDb } from '../db/testdb'
import { createLedger } from './masters'
import { saveVoucher } from './vouchers'
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
})
