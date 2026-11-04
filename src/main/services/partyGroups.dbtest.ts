// Phase 1 triage (to-do §4 People): parties under imported group names — "Trade Receivables"
// under Current Assets, "Trade Payables" under Current Liabilities — are customers / suppliers like
// those under Sundry Debtors / Creditors. Every bill-wise reader takes the side from the group's
// ROLE (shared/chartOfAccounts `partyGroupRole`: name AND nature), never the seeded name alone.
// Proof: twin companies with the same entries, one with its parties under the seeded groups and
// one under imported names, give the same Outstandings, allocations, People list and Home tiles.
import { describe, expect, it } from 'vitest'
import { seededDb, TEST_INFO } from '../db/testdb'
import { writeCompanyInfo } from '../db/seed'
import type { DB } from '../db/connection'
import type { CompanyInfo } from '@shared/domain'
import { createGroup, createLedger, partyGroupIdsBySide } from './masters'
import { openBills, outstandingsWithAdvances, partyAllocation } from './analysis'
import { partySide, replaceOpeningBills } from './openingBills'
import { postIntent } from './simplePost'
import { simpleHome } from './simpleHome'
import { peopleList } from './simplePeople'
import { openingsState } from './openings'
import { askTotal } from '../assist/answer'
import { saveVoucher } from './vouchers'
import { outwardDebitNoteIds } from './gst'

const INFO: CompanyInfo = { ...TEST_INFO, name: 'Groups Co', gstin: null, stateCode: '27', gstRegistrationType: 'unregistered' }
const TODAY = '2025-08-14'

function twin(imported: boolean): { db: DB; L: (n: string) => number } {
  const db = seededDb()
  writeCompanyInfo(db, INFO)
  const gid = (name: string): number => (db.prepare('SELECT id FROM groups WHERE name = ?').get(name) as { id: number }).id
  // Both twins get the extra groups, so ledger / group ids line up.
  createGroup(db, { name: 'Trade Receivables', parentId: gid('Current Assets') })
  createGroup(db, { name: 'Trade Payables', parentId: gid('Current Liabilities') })
  const debtors = imported ? 'Trade Receivables' : 'Sundry Debtors'
  const creditors = imported ? 'Trade Payables' : 'Sundry Creditors'
  const ledger = (name: string, group: string, extra: Record<string, unknown> = {}): number =>
    createLedger(db, {
      name, groupId: gid(group), openingBalance: 0, gstin: null, stateCode: '27', address: null, taxType: null, gstRate: null, hsn: null,
      tdsSectionId: null, pan: null, creditDays: null, exportType: null, ...extra
    }).id
  ledger('Sales', 'Sales Accounts', { simpleCategory: 'sales' })
  ledger('Purchases', 'Purchase Accounts', { simpleCategory: 'purchases' })
  ledger('HDFC Bank', 'Bank Accounts')
  ledger('Ramesh', debtors, { creditDays: 15 })
  ledger('Gopal', debtors, { openingBalance: 300_000, creditDays: 30 })
  ledger('Sita', debtors)
  ledger('Bharat Steel', creditors, { creditDays: 30 })
  ledger('Lakshmi', creditors, { openingBalance: -120_000 })
  const L = (n: string): number => (db.prepare('SELECT id FROM ledgers WHERE name = ?').get(n) as { id: number }).id
  replaceOpeningBills(db, L('Gopal'), [
    { name: 'OB-1', date: '2025-04-01', dueDate: '2025-05-01', amount: 200_000 },
    { name: 'OB-2', date: '2025-04-01', dueDate: '2025-12-31', amount: 100_000 }
  ])
  let seq = 0
  const post = (intent: Record<string, unknown>): void => {
    postIntent(db, INFO, { clientId: `groups-${imported ? 'i' : 's'}-${++seq}-xxxx`, ...intent } as never, TODAY)
  }
  post({ kind: 'sale', date: '2025-06-01', customerId: L('Ramesh'), amount: { amount: '5000' }, payment: { how: 'credit' } })
  post({ kind: 'sale', date: '2025-08-10', customerId: L('Ramesh'), amount: { amount: '2000' }, payment: { how: 'credit' } })
  post({ kind: 'money_in', date: '2025-07-01', customerId: L('Ramesh'), amount: '1500', into: { how: 'cash' } })
  post({ kind: 'money_in', date: '2025-07-05', customerId: L('Sita'), amount: '500', into: { how: 'cash' }, advance: true })
  post({ kind: 'purchase', date: '2025-06-15', supplierId: L('Bharat Steel'), billNo: 'BS-1', amount: { amount: '4000', accountId: L('Purchases') }, payment: { how: 'credit' } })
  post({ kind: 'money_out', date: '2025-07-20', supplierId: L('Bharat Steel'), amount: '1000', from: { how: 'cash' } })
  return { db, L }
}

describe('parties under imported group names (Trade Receivables / Trade Payables)', () => {
  const seeded = twin(false)
  const imported = twin(true)

  it('the imported groups are party roots on their side', () => {
    const { db } = imported
    const gid = (n: string): number => (db.prepare('SELECT id FROM groups WHERE name = ?').get(n) as { id: number }).id
    expect(partyGroupIdsBySide(db, 'debtor').has(gid('Trade Receivables'))).toBe(true)
    expect(partyGroupIdsBySide(db, 'creditor').has(gid('Trade Payables'))).toBe(true)
    expect(partyGroupIdsBySide(db, 'debtor').has(gid('Sundry Debtors'))).toBe(true)
    expect(partySide(db, gid('Trade Receivables'))).toBe(1)
    expect(partySide(db, gid('Trade Payables'))).toBe(-1)
    expect(partySide(db, gid('Bank Accounts'))).toBeNull()
  })

  it('Outstandings is the same on both sides, to the paisa, and not empty', () => {
    for (const side of ['receivable', 'payable'] as const) {
      const a = outstandingsWithAdvances(seeded.db, side, TODAY)
      const b = outstandingsWithAdvances(imported.db, side, TODAY)
      expect(b.parties.length).toBeGreaterThan(0)
      expect(b.parties).toEqual(a.parties)
      expect(b.advances).toBe(a.advances)
      expect([...b.advanceByParty]).toEqual([...a.advanceByParty])
    }
    // Hand-worked: Ramesh 5,000 + 2,000 − 1,500 = 5,500; Gopal's openings 3,000; Sita 500 ahead.
    const r = outstandingsWithAdvances(imported.db, 'receivable', TODAY)
    expect(r.parties.find((p) => p.name === 'Ramesh')?.pending).toBe(550_000)
    expect(r.parties.find((p) => p.name === 'Gopal')?.pending).toBe(300_000)
    expect(r.advances).toBe(50_000)
    const p = outstandingsWithAdvances(imported.db, 'payable', TODAY)
    expect(p.parties.find((x) => x.name === 'Bharat Steel')?.pending).toBe(300_000)
    expect(p.parties.find((x) => x.name === 'Lakshmi')?.pending).toBe(120_000)
  })

  it('one party allocation takes its side from the group role', () => {
    for (const n of ['Ramesh', 'Gopal', 'Sita', 'Bharat Steel', 'Lakshmi']) {
      expect(partyAllocation(imported.db, imported.L(n), TODAY)).toEqual(partyAllocation(seeded.db, seeded.L(n), TODAY))
    }
  })

  it('People and Home show the same balances', () => {
    expect(peopleList(imported.db, TODAY)).toEqual(peopleList(seeded.db, TODAY))
    const home = (db: DB): unknown => {
      const h = simpleHome(db, INFO, { today: TODAY, backups: [] }) as unknown as Record<string, unknown>
      return { receivables: h.receivables, payables: h.payables }
    }
    expect(home(imported.db)).toEqual(home(seeded.db))
  })

  it('Ask Total and the opening setup take the side from the role too', () => {
    // "baki" reads as money owed to you; Bharat Steel is a supplier, so the answer is the payable side.
    const ask = (db: DB): string => askTotal(db, INFO, { text: 'Bharat Steel ka kitna baki', today: TODAY, lang: 'en' }, { canDraft: false }).sentences.join(' ')
    expect(ask(imported.db)).toBe(ask(seeded.db))
    expect(ask(imported.db)).toContain('3,000')
    // "Open Gopal" goes to the person's page (a party by its group's role), as with Sundry Debtors.
    const open = (db: DB): string => JSON.stringify(askTotal(db, INFO, { text: 'open Gopal', today: TODAY, lang: 'en' }, { canDraft: false }).links)
    expect(open(imported.db)).toBe(open(seeded.db))
    expect(open(imported.db)).toContain('simple-person')
    const names = (db: DB) => { const o = openingsState(db); return { customers: o.customers.map((c) => c.name), suppliers: o.suppliers.map((c) => c.name) } }
    expect(names(imported.db)).toEqual(names(seeded.db))
    expect(names(imported.db).customers).toContain('Gopal')
    expect(names(imported.db).suppliers).toContain('Lakshmi')
  })

  it('never a party: loans given, deposits, duties & taxes, bank and cash (by role, not by being an asset / liability)', () => {
    const { db } = imported
    const gid = (n: string): number => (db.prepare('SELECT id FROM groups WHERE name = ?').get(n) as { id: number }).id
    const mk = (name: string, group: string, opening: number): number =>
      createLedger(db, {
        name, groupId: gid(group), openingBalance: opening, gstin: null, stateCode: '27', address: null, taxType: null, gstRate: null, hsn: null,
        tdsSectionId: null, pan: null, creditDays: null, exportType: null
      }).id
    const ids = [
      mk('Loan to Mehta', 'Loans & Advances (Asset)', 50_000),
      mk('Electricity deposit', 'Deposits (Asset)', 20_000),
      mk('GST payable (old)', 'Duties & Taxes', -10_000),
      imported.L('HDFC Bank'),
      (db.prepare("SELECT id FROM ledgers WHERE name = 'Cash'").get() as { id: number }).id
    ]
    const debtors = partyGroupIdsBySide(db, 'debtor')
    const creditors = partyGroupIdsBySide(db, 'creditor')
    for (const id of ids) {
      const g = (db.prepare('SELECT group_id AS g FROM ledgers WHERE id = ?').get(id) as { g: number }).g
      expect(debtors.has(g) || creditors.has(g), String(id)).toBe(false)
      expect(partySide(db, g)).toBeNull()
    }
    for (const side of ['receivable', 'payable'] as const) {
      const rows = outstandingsWithAdvances(db, side, TODAY).parties.map((p) => p.ledgerId)
      for (const id of ids) expect(rows).not.toContain(id)
    }
    const people = peopleList(db, TODAY).people.map((p) => p.ledgerId)
    for (const id of ids) expect(people).not.toContain(id)
  })

  it('GST returns are left as on main (owner, 4 Nov): a debit note to a “Trade Receivables” customer stays purchase-side', () => {
    // The same note in both twins: Dr the customer, Cr an expense (no income line — so only the
    // party's group decides the side). Main reads only the seeded Sundry Debtors tree.
    const note = (t: { db: DB; L: (n: string) => number }): number => {
      const db = t.db
      const gid = (n: string): number => (db.prepare('SELECT id FROM groups WHERE name = ?').get(n) as { id: number }).id
      const exp = createLedger(db, {
        name: 'Rate difference', groupId: gid('Indirect Expenses'), openingBalance: 0, gstin: null, stateCode: '27', address: null, taxType: null, gstRate: null, hsn: null,
        tdsSectionId: null, pan: null, creditDays: null, exportType: null
      }).id
      const type = (db.prepare("SELECT id FROM voucher_types WHERE kind = 'debit_note' ORDER BY id").get() as { id: number }).id
      return saveVoucher(db, {
        voucherTypeId: type, date: '2025-08-12', partyLedgerId: t.L('Ramesh'), narration: null,
        lines: [{ ledgerId: t.L('Ramesh'), drCr: 'dr', amount: 10_000 }, { ledgerId: exp, drCr: 'cr', amount: 10_000 }], inventory: []
      }).id
    }
    const s = note(seeded)
    const i = note(imported)
    expect(outwardDebitNoteIds(seeded.db, '2025-08-01', '2025-08-31').has(s)).toBe(true)
    expect(outwardDebitNoteIds(imported.db, '2025-08-01', '2025-08-31').has(i)).toBe(false)
  })

  it('GST rule 37 (ITC reversal, GSTR-3B) keeps main\'s side: a purchase from a "Trade Receivables" party is an open bill there', () => {
    // A customer under an imported group who also sells to the business. The role rule nets the
    // purchase against his sales; main's seeded-tree side (what gstItcReversal reads, seededSide)
    // keeps it as a supplier bill still to pay — so the reversal at day 180 is unchanged.
    const { db, L } = imported
    const gid = (n: string): number => (db.prepare('SELECT id FROM groups WHERE name = ?').get(n) as { id: number }).id
    const type = (db.prepare("SELECT id FROM voucher_types WHERE kind = 'purchase' ORDER BY id").get() as { id: number }).id
    const id = saveVoucher(db, {
      voucherTypeId: type, date: '2025-08-13', partyLedgerId: L('Ramesh'), narration: null, reference: 'R-77',
      lines: [{ ledgerId: L('Purchases'), drCr: 'dr', amount: 80_000 }, { ledgerId: L('Ramesh'), drCr: 'cr', amount: 80_000 }], inventory: [],
      billRefs: [{ kind: 'new', name: 'R-77', amount: 80_000 }]
    }).id
    expect(gid('Trade Receivables')).toBeGreaterThan(0)
    // (main's own allocation also nets this party's earlier debits against it — open, whatever they are)
    expect(openBills(db, L('Ramesh'), TODAY, { seededSide: true }).find((b) => b.voucherId === id)?.pending ?? 0).toBeGreaterThan(0)
    expect(openBills(db, L('Ramesh'), TODAY).find((b) => b.voucherId === id)).toBeUndefined()
  })
})
