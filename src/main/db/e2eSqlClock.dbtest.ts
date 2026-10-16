// TOTAL_E2E_TODAY (shared/e2eClock.ts): SQLite's own 'now' follows the shifted clock on every
// connection openDb hands out — a voucher's created_at and the audit trail's times agree. Its own
// file: installing the clock replaces this worker's global Date for good.
import { afterAll, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { installE2eClock } from '@shared/e2eClock'
import { openDb } from './encryption'
import { migrate } from './migrate'
import { MIGRATIONS } from './migrations'
import { seedCompany } from './seed'
import { TEST_INFO } from './testdb'

const ROOT = mkdtempSync(join(tmpdir(), 'total-e2eclock-'))
afterAll(() => rmSync(ROOT, { recursive: true, force: true }))

describe('shifted clock in SQLite (scripted runs only)', () => {
  it('without a shift SQLite keeps its own clock', () => {
    const db = openDb(join(ROOT, 'plain.db'))
    const year = db.prepare("SELECT strftime('%Y', 'now')").pluck().get()
    expect(year).toBe(String(new Date().getUTCFullYear()))
    db.close()
  })

  it("'now' (and no time value) reads the shifted instant; explicit dates are SQLite's own", () => {
    installE2eClock('2031-07-09')
    const db = openDb(join(ROOT, 'shifted.db'))
    migrate(db, MIGRATIONS)
    seedCompany(db, TEST_INFO)
    const jsUtc = new Date().toISOString().slice(0, 10)
    const row = db
      .prepare(
        `SELECT date('now') AS d, substr(datetime(), 1, 10) AS d0, strftime('%Y-%m-%d', 'now') AS s, substr(strftime('%Y-%m-%dT%H:%M:%fZ', 'NOW'), 1, 10) AS s2,
                date('now', '-1 day') AS y, date('2026-01-31', '+1 day') AS fixed, julianday('2026-01-01') AS jd, unixepoch('1970-01-02') AS ux`
      )
      .get() as Record<string, unknown>
    expect(jsUtc.slice(0, 7)).toBe('2031-07')
    expect(row).toMatchObject({ d: jsUtc, d0: jsUtc, s: jsUtc, s2: jsUtc, fixed: '2026-02-01', jd: 2461041.5, ux: 86400 })
    expect(row.y).not.toBe(jsUtc)
    // A column default (vouchers.created_at = datetime('now')) follows it too.
    const typeId = db.prepare("SELECT id FROM voucher_types WHERE kind = 'journal' LIMIT 1").pluck().get()
    const id = db.prepare("INSERT INTO vouchers (voucher_type_id, date, number) VALUES (?, '2031-07-09', 'T1')").run(typeId).lastInsertRowid
    expect(String(db.prepare('SELECT created_at FROM vouchers WHERE id = ?').pluck().get(id)).slice(0, 10)).toBe(jsUtc)
    db.close()
  })
})
