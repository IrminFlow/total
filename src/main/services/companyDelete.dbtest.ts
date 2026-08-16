import { describe, it, expect } from 'vitest'
import Database from 'better-sqlite3'
import { mkdtempSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { migrate } from '../db/migrate'
import { seedCompany } from '../db/seed'
import { saveUser } from './users'
import { assertDeleteAuthorized } from './companyDelete'
import type { CompanyInfo } from '@shared/domain'

const INFO: CompanyInfo = {
  name: 'Test Co', stateCode: '27', gstin: null, gstRegistrationType: 'regular', address: '',
  booksFrom: 2025, email: null, phone: null, pan: null, tan: null
}

/** A real on-disk company DB file (not :memory:) — assertDeleteAuthorized opens its own
 *  read-only handle by path, so the fixture needs an actual file. */
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

  it('falls back to allowing delete (name check alone) when the DB file is corrupt/unreadable', () => {
    const dir = mkdtempSync(join(tmpdir(), 'total-company-delete-corrupt-'))
    const dbPath = join(dir, 'company.db')
    writeFileSync(dbPath, 'not a sqlite file at all')
    expect(() => assertDeleteAuthorized(dbPath, undefined)).not.toThrow()
  })
})
