// WP 7.2 spike evidence (docs/security/encryption-at-rest.md): the cost of SQLCipher-scheme
// encryption on a 100,000-voucher company — open (+ migrate check + quick_check), a trial balance,
// the verified plaintext → encrypted conversion. Prints the timings; the bound is loose (the
// encrypted open + report may take at most 3× the plaintext one, + 1 s) so it guards against a
// pathological setting (e.g. a KDF on every open), not machine speed. TOTAL_SKIP_PERF=1 skips.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { openDb } from './encryption'
import { newDataKey } from './keyEnvelope'
import { migrate } from './migrate'
import { seedCompany } from './seed'
import { TEST_INFO, testFileDb } from './testdb'
import { trialBalance } from '../services/reports'
import { convertCompanyFile } from '../services/dbEncryption'

const skip = process.env.TOTAL_SKIP_PERF === '1'
const VOUCHERS = 100_000
const ROOT = mkdtempSync(join(tmpdir(), 'total-enc-perf-'))

function seed(path: string): void {
  const db = testFileDb(path)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  migrate(db)
  seedCompany(db, TEST_INFO)
  const g = (name: string): number => (db.prepare('SELECT id FROM groups WHERE name = ?').get(name) as { id: number }).id
  const vt = (db.prepare("SELECT id FROM voucher_types WHERE kind = 'receipt'").get() as { id: number }).id
  const cash = (db.prepare("SELECT id FROM ledgers WHERE name = 'Cash'").get() as { id: number }).id
  db.transaction(() => {
    const parties: number[] = []
    const insL = db.prepare('INSERT INTO ledgers (name, group_id) VALUES (?, ?)')
    for (let i = 0; i < 1000; i++) parties.push(Number(insL.run(`Party ${i}`, g('Sundry Debtors')).lastInsertRowid))
    const insV = db.prepare('INSERT INTO vouchers (voucher_type_id, date, number, party_ledger_id) VALUES (?, ?, ?, ?)')
    const insLine = db.prepare('INSERT INTO voucher_lines (voucher_id, ledger_id, dr_cr, amount, line_order) VALUES (?, ?, ?, ?, ?)')
    const start = Date.UTC(2024, 3, 1)
    for (let i = 0; i < VOUCHERS; i++) {
      const date = new Date(start + (i % 700) * 86_400_000).toISOString().slice(0, 10)
      const p = parties[i % parties.length]!
      const v = Number(insV.run(vt, date, `R-${i}`, p).lastInsertRowid)
      const amt = 10_000 + (i % 977) * 100
      insLine.run(v, cash, 'dr', amt, 0)
      insLine.run(v, p, 'cr', amt, 1)
    }
  })()
  db.exec('ANALYZE')
  db.close()
}

function timeOpenAndReport(path: string, key: Buffer | null): number {
  const t0 = performance.now()
  const db = openDb(path, { key })
  db.pragma('journal_mode = WAL')
  db.pragma('cache_size = -64000')
  migrate(db)
  expect(db.pragma('quick_check', { simple: true })).toBe('ok')
  const tb = trialBalance(db, '2026-03-31')
  expect(tb.movementDebitTotal).toBe(tb.movementCreditTotal)
  db.close()
  return performance.now() - t0
}

describe.skipIf(skip)('encryption cost on 100k vouchers', () => {
  const plain = join(ROOT, 'plain.db')
  const enc = join(ROOT, 'enc.db')
  const key = newDataKey()
  let convertMs = 0

  beforeAll(() => {
    seed(plain)
    seed(enc)
    const t0 = performance.now()
    const db = openDb(enc)
    convertCompanyFile({ db, dbPath: enc, to: key, asOn: '2026-03-31', audit: { before: null, after: { encrypted: true } } })
    convertMs = performance.now() - t0
  }, 600_000)
  afterAll(() => rmSync(ROOT, { recursive: true, force: true }))

  it('opens and reports encrypted within 3× (+1 s) of plaintext', () => {
    const best = (k: Buffer | null, p: string): number => Math.min(timeOpenAndReport(p, k), timeOpenAndReport(p, k), timeOpenAndReport(p, k))
    const p = best(null, plain)
    const e = best(key, enc)
    // eslint-disable-next-line no-console
    console.log(`[WP 7.2 perf] 100k vouchers — open+migrate+quick_check+TB: plaintext ${p.toFixed(0)} ms, encrypted ${e.toFixed(0)} ms; verified conversion ${convertMs.toFixed(0)} ms`)
    expect(e).toBeLessThan(p * 3 + 1000)
  }, 600_000)
})
