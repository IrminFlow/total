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
import { outstandingsWithAdvances, partyAllocation } from './analysis'
import { partySide, replaceOpeningBills } from './openingBills'
import { postIntent } from './simplePost'
import { simpleHome } from './simpleHome'
import { peopleList } from './simplePeople'
import { openingsState } from './openings'
import { askTotal } from '../assist/answer'

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
    const names = (db: DB) => { const o = openingsState(db); return { customers: o.customers.map((c) => c.name), suppliers: o.suppliers.map((c) => c.name) } }
    expect(names(imported.db)).toEqual(names(seeded.db))
    expect(names(imported.db).customers).toContain('Gopal')
    expect(names(imported.db).suppliers).toContain('Lakshmi')
  })
})
