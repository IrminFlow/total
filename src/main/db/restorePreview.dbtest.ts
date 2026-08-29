import { describe, it, expect } from 'vitest'
import Database from 'better-sqlite3'
import { mkdtempSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { migrate } from './migrate'
import { seedCompany } from './seed'
import { TEST_INFO, postSimpleVoucher } from './testdb'
import { restorePreview, snapshotSync } from './backup'
import { deleteVoucher } from '../services/vouchers'
import { setAuditContext } from '../services/audit'

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'total-preview-'))
}

/** A live company on disk, plus a snapshot of it taken at a chosen moment. */
function liveWithBackup(): { db: Database.Database; backupPath: string; dir: string } {
  setAuditContext({ appVersion: '0.4.0-test', getUserName: () => 'Asha' })
  const dir = tmpDir()
  const db = new Database(join(dir, 'company.db'))
  db.pragma('journal_mode = WAL')
  migrate(db)
  seedCompany(db, TEST_INFO)
  postSimpleVoucher(db, { date: '2026-04-01', amount: 100000, kind: 'receipt' })
  postSimpleVoucher(db, { date: '2026-04-02', amount: 50000, kind: 'payment' })
  const backupPath = join(dir, 'snapshot.db')
  snapshotSync(db, backupPath)
  return { db, backupPath, dir }
}

describe('what a restore would change, before it changes it', () => {
  it('reports nothing lost when the backup is the books as they stand', () => {
    const { db, backupPath } = liveWithBackup()
    const preview = restorePreview(db, backupPath)
    expect(preview.problem).toBeNull()
    expect(preview.vouchersLost).toBe(0)
    expect(preview.vouchersReturned).toBe(0)
    expect(preview.changes.find((c) => c.what === 'Vouchers')).toMatchObject({ now: '2', after: '2', loses: false })
    db.close()
  })

  it('names the entries that would have to be typed again', () => {
    const { db, backupPath } = liveWithBackup()
    postSimpleVoucher(db, { date: '2026-04-05', amount: 75000, kind: 'receipt' })
    postSimpleVoucher(db, { date: '2026-04-06', amount: 25000, kind: 'receipt' })

    const preview = restorePreview(db, backupPath)
    expect(preview.vouchersLost).toBe(2)
    // Newest first, because that is the order somebody reconstructs them in.
    expect(preview.sample[0]!.date).toBe('2026-04-06')
    expect(preview.sample[0]!.amount).toBe(25000)
    expect(preview.changes.find((c) => c.what === 'Vouchers')).toMatchObject({ now: '4', after: '2', loses: true })
    expect(preview.changes.find((c) => c.what === 'Latest entry')).toMatchObject({
      now: '2026-04-06',
      after: '2026-04-02',
      loses: true
    })
    db.close()
  })

  it('counts the deletions a restore would undo, which are the reason people restore', () => {
    const { db, backupPath } = liveWithBackup()
    const voucher = db.prepare('SELECT id FROM vouchers ORDER BY id LIMIT 1').get() as { id: number }
    deleteVoucher(db, voucher.id)

    const preview = restorePreview(db, backupPath)
    expect(preview.vouchersReturned).toBe(1)
    expect(preview.vouchersLost).toBe(0)
    db.close()
  })

  it('says the books would be locked differently, since that decides what can be edited after', () => {
    const { db, backupPath } = liveWithBackup()
    db.prepare("INSERT INTO meta (key, value) VALUES ('lock_before', '2026-03-31')").run()

    const preview = restorePreview(db, backupPath)
    expect(preview.changes.find((c) => c.what === 'Books locked up to')).toMatchObject({
      now: '2026-03-31',
      after: 'not locked'
    })
    db.close()
  })

  it('refuses to guess about a file it cannot read', () => {
    const { db, dir } = liveWithBackup()
    const rubbish = join(dir, 'not-a-database.db')
    writeFileSync(rubbish, 'this is not a database')
    const preview = restorePreview(db, rubbish)
    expect(preview.problem).not.toBeNull()
    expect(preview.changes).toEqual([])

    expect(restorePreview(db, join(dir, 'missing.db')).problem).toBe('Backup file not found')
    db.close()
  })
})
