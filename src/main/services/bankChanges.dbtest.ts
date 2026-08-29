import { describe, it, expect } from 'vitest'
import { seededDb } from '../db/testdb'
import type { DB } from '../db/connection'
import { createLedger, getLedger } from './masters'
import { saveUser } from './users'
import {
  decideBankChange, listPendingBankChanges, pendingBankChangeCount, submitBankChange
} from './bankChanges'
import { exceptions } from './reports'
import { TEST_INFO } from '../db/testdb'

const OWNER = { role: 'owner' as const, name: 'Priya Owner' }
const ACCOUNTANT = { role: 'accountant' as const, name: 'Arun' }

function party(db: DB, name: string, account: string | null = null): number {
  const group = db.prepare("SELECT id FROM groups WHERE name = 'Sundry Creditors'").get() as { id: number }
  return createLedger(db, {
    name,
    groupId: group.id,
    bankAccount: account,
    bankIfsc: account ? 'HDFC0001234' : null,
    bankHolder: account ? name : null
  }).id
}

function twoPeople(db: DB): DB {
  saveUser(db, { name: 'Priya Owner', role: 'owner', pin: '1234', active: true })
  saveUser(db, { name: 'Arun', role: 'accountant', pin: '2222', active: true })
  return db
}

describe('the two-person rule', () => {
  it('applies the change immediately in a one-person business', () => {
    // A rule nobody can satisfy is a master that never gets corrected.
    const db = seededDb()
    const id = party(db, 'Kumar Traders', '111122223333')

    const outcome = submitBankChange(db, id, { account: '999988887777', ifsc: 'HDFC0001234', holder: 'Kumar Traders' }, OWNER)

    expect(outcome.applied).toBe(true)
    expect(getLedger(db, id)!.bankAccount).toBe('999988887777')
    expect(pendingBankChangeCount(db)).toBe(0)
  })

  it('parks the change once a second person exists — including the owner’s own', () => {
    const db = twoPeople(seededDb())
    const id = party(db, 'Kumar Traders', '111122223333')

    const outcome = submitBankChange(db, id, { account: '999988887777', ifsc: 'HDFC0001234', holder: 'Kumar Traders' }, OWNER)

    expect(outcome.applied).toBe(false)
    // The master has NOT moved. That is the whole point.
    expect(getLedger(db, id)!.bankAccount).toBe('111122223333')
    expect(listPendingBankChanges(db)).toHaveLength(1)
    expect(listPendingBankChanges(db)[0]!.requestedBy).toBe('Priya Owner')
  })

  it('does nothing at all when the details only look different', () => {
    const db = twoPeople(seededDb())
    const id = party(db, 'Kumar Traders', '111122223333')
    const outcome = submitBankChange(db, id, { account: '1111 2222 3333', ifsc: 'hdfc0001234', holder: 'Kumar Traders' }, OWNER)
    expect(outcome.applied).toBe('unchanged')
    expect(pendingBankChangeCount(db)).toBe(0)
  })

  it('applies the change when the second person confirms it', () => {
    const db = twoPeople(seededDb())
    const id = party(db, 'Kumar Traders', '111122223333')
    submitBankChange(db, id, { account: '999988887777', ifsc: 'HDFC0001234', holder: 'Kumar Traders' }, ACCOUNTANT)
    const request = listPendingBankChanges(db)[0]!

    const decided = decideBankChange(db, request.id, true, OWNER, 'Called them on a known number')

    expect(decided.state).toBe('approved')
    expect(getLedger(db, id)!.bankAccount).toBe('999988887777')
  })

  it('leaves the old account in place when the change is refused', () => {
    const db = twoPeople(seededDb())
    const id = party(db, 'Kumar Traders', '111122223333')
    submitBankChange(db, id, { account: '999988887777', ifsc: 'HDFC0001234', holder: 'Kumar Traders' }, ACCOUNTANT)
    const request = listPendingBankChanges(db)[0]!

    decideBankChange(db, request.id, false, OWNER, 'Email came from a lookalike domain')

    expect(getLedger(db, id)!.bankAccount).toBe('111122223333')
  })

  it('refuses to let the requester confirm their own request', () => {
    const db = twoPeople(seededDb())
    const id = party(db, 'Kumar Traders', '111122223333')
    submitBankChange(db, id, { account: '999988887777', ifsc: 'HDFC0001234', holder: 'K' }, ACCOUNTANT)
    const request = listPendingBankChanges(db)[0]!

    expect(() => decideBankChange(db, request.id, true, ACCOUNTANT)).toThrow(/other than the person who asked/)
    expect(getLedger(db, id)!.bankAccount).toBe('111122223333')
  })

  it('refuses a viewer outright', () => {
    const db = twoPeople(seededDb())
    const id = party(db, 'Kumar Traders', '111122223333')
    submitBankChange(db, id, { account: '999988887777', ifsc: 'HDFC0001234', holder: 'K' }, ACCOUNTANT)
    const request = listPendingBankChanges(db)[0]!
    expect(() => decideBankChange(db, request.id, true, { role: 'viewer', name: 'Vidya' })).toThrow(/owner or an accountant/)
  })

  it('supersedes an earlier pending request rather than queueing two truths', () => {
    const db = twoPeople(seededDb())
    const id = party(db, 'Kumar Traders', '111122223333')
    submitBankChange(db, id, { account: '999988887777', ifsc: 'HDFC0001234', holder: 'K' }, ACCOUNTANT)
    submitBankChange(db, id, { account: '555566667777', ifsc: 'HDFC0001234', holder: 'K' }, ACCOUNTANT)

    const pending = listPendingBankChanges(db)
    expect(pending).toHaveLength(1)
    expect(pending[0]!.newAccount).toBe('555566667777')
  })

  it('will not decide a request twice', () => {
    const db = twoPeople(seededDb())
    const id = party(db, 'Kumar Traders', '111122223333')
    submitBankChange(db, id, { account: '999988887777', ifsc: 'HDFC0001234', holder: 'K' }, ACCOUNTANT)
    const request = listPendingBankChanges(db)[0]!
    decideBankChange(db, request.id, true, OWNER)
    expect(() => decideBankChange(db, request.id, false, OWNER)).toThrow(/already been decided/)
  })
})

describe('the same account on two parties', () => {
  const asOn = { from: '2026-04-01', to: '2027-03-31' }
  const shared = (db: DB): { count: number; labels: string[] } => {
    const section = exceptions(db, asOn.from, asOn.to, TEST_INFO).sections.find((s) => s.key === 'sharedBankAccount')!
    return { count: section.count, labels: section.rows.map((r) => r.label) }
  }

  it('reports two parties banking into one account, however it was typed', () => {
    const db = seededDb()
    party(db, 'Kumar Traders', '1111 2222 3333')
    party(db, 'Unknown Payee', '111122223333')
    const result = shared(db)
    expect(result.count).toBe(2)
    expect(result.labels.sort()).toEqual(['Kumar Traders', 'Unknown Payee'])
  })

  it('says nothing about parties with no bank details at all', () => {
    const db = seededDb()
    party(db, 'A')
    party(db, 'B')
    expect(shared(db).count).toBe(0)
  })

  it('goes quiet once every party on the account is marked as knowingly sharing', () => {
    // A proprietor and their firm. Real, common, and not worth a red line every month.
    const db = seededDb()
    const a = party(db, 'S Kumar', '111122223333')
    const b = party(db, 'Kumar Traders', '111122223333')
    for (const id of [a, b]) {
      const ledger = getLedger(db, id)!
      db.prepare('UPDATE ledgers SET bank_shared_ok = 1 WHERE id = ?').run(ledger.id)
    }
    expect(shared(db).count).toBe(0)
  })

  it('speaks up again when a third name lands on that same account', () => {
    const db = seededDb()
    const a = party(db, 'S Kumar', '111122223333')
    const b = party(db, 'Kumar Traders', '111122223333')
    db.prepare('UPDATE ledgers SET bank_shared_ok = 1 WHERE id IN (?, ?)').run(a, b)
    party(db, 'Unknown Payee', '111122223333')
    expect(shared(db).count).toBe(3)
  })
})
