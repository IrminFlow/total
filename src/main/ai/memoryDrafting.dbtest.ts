// WP 5.6 × WP 5.3 — the drafting tools consult memory for what the user did NOT say: a party's
// usual ledger / item / bill day (forParty) and the preferred ledger per purpose (preferredLedger).
// Every such default is recorded as a source ("from memory [M<id>]") and an assumption
// ("From memory [M<id>]: …"), returned as `fromMemory`, and marked used; what the user typed always wins.
import { beforeEach, describe, expect, it } from 'vitest'
import type { InvoiceFormState, StockNoteFormState } from '@shared/voucherEdit'
import { activeMemories, createMemory } from './memory'
import { createMemoryContext, type MemoryContext } from './memoryRules'
import { db, draft, fixture, ids, ledger, payloadOf, TODAY } from './drafting.testutil'

let exportSales = 0
let partyMemoryId = 0
let payMemoryId = 0
let memory: MemoryContext

beforeEach(() => {
  fixture()
  exportSales = ledger('Export Sales', 'Sales Accounts')
  partyMemoryId = createMemory(
    db,
    { kind: 'party', text: 'Umbrella Retail is billed to Export Sales, usually laptops, around the 25th', data: { partyLedgerId: ids.umbrella, ledgerId: exportSales, itemId: ids.laptop, billDay: 25 } },
    { source: 'user', status: 'active', createdBy: null }
  ).id
  payMemoryId = createMemory(db, { kind: 'preference', text: 'Pay from HDFC Bank', data: { purpose: 'payment', ledgerId: ids.bank } }, { source: 'user', status: 'active', createdBy: null }).id
  // A suggestion is never consulted.
  createMemory(db, { kind: 'preference', text: 'Receive into Cash', data: { purpose: 'receipt', ledgerId: ids.cash } }, { source: 'assistant', status: 'suggested', createdBy: null })
  memory = createMemoryContext(activeMemories(db))
})

describe('drafting with memory as defaults', () => {
  it('draft_invoice: the party memory fills the unsaid ledger and item, notes the bill day — recorded as assumptions and sources', async () => {
    const r = await draft('draft_invoice', { kind: 'sales', party: 'Umbrella Retail', items: [{ qty: '1', rate: '45000' }] }, { memory })
    expect(r.ok, r.error).toBe(true)
    const p = payloadOf(r.draftId!)
    const state = p.state as InvoiceFormState
    expect(state.accountId).toBe(exportSales)
    expect(state.rows[0]!.itemId).toBe(ids.laptop)
    const m = `From memory [M${partyMemoryId}]`
    expect(p.assumptions).toEqual(
      expect.arrayContaining([
        `${m}: Umbrella Retail is usually booked to Export Sales`,
        `${m}: Umbrella Retail usually takes Laptop 14"`,
        `${m}: Umbrella Retail usually bills around day 25 of the month — check the date`
      ])
    )
    expect(p.date).toBe(TODAY) // the bill day never moves the date
    expect(p.sources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ field: 'account', kind: 'ledger', id: exportSales, why: `from memory [M${partyMemoryId}]` }),
        expect.objectContaining({ field: 'line:0', kind: 'item', id: ids.laptop, why: `from memory [M${partyMemoryId}]` })
      ])
    )
    expect(r.data.fromMemory).toEqual([`M${partyMemoryId}`])
    expect(r.data.assumptions).toContain(`${m}: Umbrella Retail is usually booked to Export Sales`)
    expect([...memory.used]).toEqual([partyMemoryId])
  })

  it('what the user typed wins: a named ledger, item and date leave memory unused', async () => {
    const r = await draft(
      'draft_invoice',
      { kind: 'sales', party: 'Umbrella Retail', date: '2025-08-14', account: 'Sales A/c', items: [{ item: 'Wireless Mouse', qty: '1', rate: '500' }] },
      { memory }
    )
    expect(r.ok, r.error).toBe(true)
    const p = payloadOf(r.draftId!)
    expect((p.state as InvoiceFormState).accountId).toBe(ids.sales)
    expect((p.state as InvoiceFormState).rows[0]!.itemId).toBe(ids.mouse)
    expect(p.assumptions!.some((a) => a.startsWith('From memory'))).toBe(false)
    expect(r.data.fromMemory).toBeUndefined()
    expect([...memory.used]).toEqual([])
  })

  it('draft_voucher: the remembered pay-from ledger is the default account; a named account overrides it', async () => {
    const r = await draft('draft_voucher', { kind: 'payment', party: 'Bharat Steel Suppliers', amount: '5000' }, { memory })
    expect(r.ok, r.error).toBe(true)
    const p = payloadOf(r.draftId!)
    expect(p.lines).toEqual(expect.arrayContaining([expect.objectContaining({ ledgerId: ids.bank, drCr: 'cr', amount: 500_000 })]))
    expect(p.assumptions).toContain(`From memory [M${payMemoryId}]: Pay from HDFC Bank`)
    expect(r.data.fromMemory).toEqual([`M${payMemoryId}`])

    const cash = await draft('draft_voucher', { kind: 'payment', party: 'Bharat Steel Suppliers', account: 'Cash', amount: '5000' }, { memory: createMemoryContext(activeMemories(db)) })
    expect(cash.ok, cash.error).toBe(true)
    expect(payloadOf(cash.draftId!).lines).toEqual(expect.arrayContaining([expect.objectContaining({ ledgerId: ids.cash, drCr: 'cr' })]))
    expect(payloadOf(cash.draftId!).assumptions!.some((a) => a.startsWith('From memory'))).toBe(false)

    // Without memory (and two cash / bank ledgers) the account is asked, not guessed.
    const ask = await draft('draft_voucher', { kind: 'payment', party: 'Bharat Steel Suppliers', amount: '5000' })
    expect(ask.ok).toBe(true)
    expect(ask.data.status).toBe('needs_clarification')
  })

  it('draft_voucher lines may name a remembered purpose', async () => {
    const r = await draft('draft_voucher', { kind: 'payment', lines: [{ ledgerId: ids.rent, drCr: 'dr', amount: '100' }, { preferred: 'payment', drCr: 'cr', amount: '100' }] }, { memory })
    expect(r.ok, r.error).toBe(true)
    expect(payloadOf(r.draftId!).lines[1]).toMatchObject({ ledgerId: ids.bank, drCr: 'cr', amount: 10_000 })
    const none = await draft('draft_voucher', { kind: 'receipt', lines: [{ preferred: 'receipt', drCr: 'dr', amount: '100' }, { ledgerId: ids.umbrella, drCr: 'cr', amount: '100' }] }, { memory })
    expect(none.ok).toBe(false)
    expect(none.error).toMatch(/no remembered receipt ledger/) // the suggested one is never used
  })

  it('draft_stock_note: a line naming no item takes the party’s usual item', async () => {
    const r = await draft('draft_stock_note', { kind: 'delivery_note', party: 'Umbrella Retail', date: '2025-08-24', items: [{ qty: '2' }] }, { memory })
    expect(r.ok, r.error).toBe(true)
    const p = payloadOf(r.draftId!)
    expect((p.state as StockNoteFormState).rows[0]!.itemId).toBe(ids.laptop)
    expect(p.assumptions).toContain(`From memory [M${partyMemoryId}]: Umbrella Retail usually takes Laptop 14"`)
    // A date was said: no bill-day note.
    expect(p.assumptions!.some((a) => a.includes('bills around day'))).toBe(false)
  })
})
