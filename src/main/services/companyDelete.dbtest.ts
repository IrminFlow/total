import { describe, it, expect } from 'vitest'
import Database from 'better-sqlite3'
import { mkdtempSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { migrate } from '../db/migrate'
import { seedCompany } from '../db/seed'
import { login, saveUser } from './users'
import { assertDeleteAuthorized } from './companyDelete'
import type { CompanyInfo } from '@shared/domain'

const INFO: CompanyInfo = {
  name: 'Test Co', stateCode: '27', gstin: null, gstRegistrationType: 'regular', address: '',
  booksFrom: 2025, email: null, phone: null, pan: null, tan: null
}

/** A real on-disk company DB file (not :memory:) — assertDeleteAuthorized opens its own
 *  handle by path (read-write since the shared auth throttle persists into meta), so the
 *  fixture needs an actual file. */
function makeCompanyDb(withOwner: boolean): string {
  const dir = mkdtempSync(join(tmpdir(), 'total-company-delete-'))
  const dbPath = join(dir, 'company.db')
  const db = new Database(dbPath)
  db.pragma('journal_mode = WAL')
  migrate(db)
  seedCompany(db, INFO)
  if (withOwner) saveUser(db, { name: 'Priya', role: 'owner', pin: '1234' })
  db.close()
  return dbPath
}

describe('company delete authorization (assertDeleteAuthorized)', () => {
  it('allows an unprotected company (no users yet) to delete with no pin supplied', () => {
    const dbPath = makeCompanyDb(false)
    expect(() => assertDeleteAuthorized(dbPath, undefined)).not.toThrow()
  })

  it('allows deleting when the company DB file does not exist at all', () => {
    expect(() => assertDeleteAuthorized(join(tmpdir(), 'total-does-not-exist', 'company.db'), undefined)).not.toThrow()
  })

  it('refuses a protected company (has users) with no pin', () => {
    const dbPath = makeCompanyDb(true)
    expect(() => assertDeleteAuthorized(dbPath, undefined)).toThrow(
      'This company is protected — an owner PIN is required to delete it'
    )
  })

  it('refuses a protected company with the wrong pin', () => {
    const dbPath = makeCompanyDb(true)
    expect(() => assertDeleteAuthorized(dbPath, '9999')).toThrow(
      'This company is protected — an owner PIN is required to delete it'
    )
  })

  it('succeeds for a protected company with the correct owner pin', () => {
    const dbPath = makeCompanyDb(true)
    expect(() => assertDeleteAuthorized(dbPath, '1234')).not.toThrow()
  })

  it('shares the persisted login throttle: 5 wrong delete-PINs lock the PIN gate AND auth:login (v0.3 review F3)', () => {
    const dbPath = makeCompanyDb(true)
    for (let i = 0; i < 5; i++) {
      expect(() => assertDeleteAuthorized(dbPath, '9999')).toThrow('This company is protected')
    }
    // Even the CORRECT pin is refused while locked out — the delete channel is no longer an
    // unthrottled PIN oracle around the login lockout.
    expect(() => assertDeleteAuthorized(dbPath, '1234')).toThrow('Too many attempts — wait 30 seconds')

    // Same meta-persisted counter as auth:login: the owner is locked out at the login screen too,
    // and every wrong delete-PIN was audited as a login_failed.
    const db = new Database(dbPath)
    const owner = db.prepare("SELECT id FROM users WHERE role = 'owner'").get() as { id: number }
    expect(() => login(db, owner.id, '1234')).toThrow('Too many attempts — wait 30 seconds')
    const audits = db
      .prepare("SELECT COUNT(*) AS n FROM audit_log WHERE entity = 'user' AND action = 'login_failed'")
      .get() as { n: number }
    expect(audits.n).toBe(5)
    db.close()
  })

  it('failed logins also lock the delete PIN gate (throttle is shared in both directions)', () => {
    const dbPath = makeCompanyDb(true)
    const db = new Database(dbPath)
    const owner = db.prepare("SELECT id FROM users WHERE role = 'owner'").get() as { id: number }
    for (let i = 0; i < 5; i++) {
      expect(() => login(db, owner.id, '0000')).toThrow('Wrong PIN')
    }
    db.close()
    expect(() => assertDeleteAuthorized(dbPath, '1234')).toThrow('Too many attempts — wait 30 seconds')
  })

  it('a pin-less probe (how the UI discovers protection) does not consume throttle budget', () => {
    const dbPath = makeCompanyDb(true)
    for (let i = 0; i < 10; i++) {
      expect(() => assertDeleteAuthorized(dbPath, undefined)).toThrow('This company is protected')
    }
    // Still not locked out — and the correct PIN goes straight through.
    expect(() => assertDeleteAuthorized(dbPath, '1234')).not.toThrow()
  })

  it('a successful PIN check clears the failure counter', () => {
    const dbPath = makeCompanyDb(true)
    for (let i = 0; i < 4; i++) {
      expect(() => assertDeleteAuthorized(dbPath, '9999')).toThrow('This company is protected')
    }
    expect(() => assertDeleteAuthorized(dbPath, '1234')).not.toThrow()
    // Counter reset: four more wrong attempts don't lock (5th consecutive would).
    for (let i = 0; i < 4; i++) {
      expect(() => assertDeleteAuthorized(dbPath, '9999')).toThrow('This company is protected')
    }
    expect(() => assertDeleteAuthorized(dbPath, '1234')).not.toThrow()
  })

  it('falls back to allowing delete (name check alone) when the DB file is corrupt/unreadable', () => {
    const dir = mkdtempSync(join(tmpdir(), 'total-company-delete-corrupt-'))
    const dbPath = join(dir, 'company.db')
    writeFileSync(dbPath, 'not a sqlite file at all')
    expect(() => assertDeleteAuthorized(dbPath, undefined)).not.toThrow()
  })
})
