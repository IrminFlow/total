// WP 6.4 — attachments: add / list / open / remove, dedupe by hash, the type and size rules, path
// traversal and symlink safety, the orphan sweep on bin purge, and the round trips through a local
// backup → restore and an encrypted export → import keeping every file and its hash.
import { describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, symlinkSync, unlinkSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { createHash } from 'crypto'
import { migrate } from '../db/migrate'
import { seedCompany } from '../db/seed'
import { TEST_INFO, postSimpleVoucher, seededDb } from '../db/testdb'
import { restoreCompanyDb, snapshotSync, snapshotTo } from '../db/backup'
import { encryptFile, decryptFile } from '../db/crypt'
import {
  BLOB_TABLE, embedAttachments, pruneBackupAttachmentStore, restoreAttachmentFiles, restoreAttachmentFilesAt, stashSnapshotAttachments
} from '../db/attachmentBackup'
import {
  addAttachment, attachmentCounts, getAttachmentConfig, listAttachments, prepareOpen, removeAttachment, setAttachmentConfig, sweepAttachments
} from './attachments'
import { deleteVoucher, purgeVoucher } from './vouchers'
import { createLedger } from './masters'
import { storedPathFor } from '@shared/attachments'

const tmp = (p = 'total-att-'): string => mkdtempSync(join(tmpdir(), p))
const sha = (b: Buffer | string): string => createHash('sha256').update(b).digest('hex')

function file(dir: string, name: string, content: string | Buffer): string {
  const p = join(dir, name)
  writeFileSync(p, content)
  return p
}

function setup() {
  const db = seededDb()
  const root = tmp()
  const store = join(root, 'attachments')
  const src = join(root, 'src')
  mkdirSync(src)
  const v = postSimpleVoucher(db, { date: '2025-06-01', amount: 10000, kind: 'receipt' })
  return { db, root, store, src, v }
}

const auditRows = (db: Database.Database, action: string): number =>
  (db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE entity = 'attachment' AND action = ?").get(action) as { n: number }).n

describe('attachments — store', () => {
  it('adds, lists, dedupes by hash, opens a hash-checked copy, removes', () => {
    const { db, store, src, v, root } = setup()
    const pdf = file(src, 'Bill 42.pdf', '%PDF-1.4 bill 42')
    const a = addAttachment(db, store, { entity: 'voucher', entityId: v.id }, pdf)
    expect(a).toMatchObject({ entity: 'voucher', entityId: v.id, fileName: 'Bill 42.pdf', mime: 'application/pdf', size: 16, sha256: sha('%PDF-1.4 bill 42') })
    expect(readFileSync(join(store, storedPathFor(a.sha256)), 'utf8')).toBe('%PDF-1.4 bill 42')
    expect(auditRows(db, 'create')).toBe(1)

    // The same bytes on another record: one stored file, two rows.
    const led = createLedger(db, { name: 'Alpha', groupId: (db.prepare("SELECT id FROM groups WHERE name = 'Sundry Debtors'").get() as { id: number }).id })
    const copy = file(src, 'kyc.pdf', '%PDF-1.4 bill 42')
    const b = addAttachment(db, store, { entity: 'ledger', entityId: led.id }, copy)
    expect(b.sha256).toBe(a.sha256)
    expect(readdirSync(join(store, a.sha256.slice(0, 2)))).toEqual([a.sha256])
    // …but the same file twice on one record is refused.
    expect(() => addAttachment(db, store, { entity: 'voucher', entityId: v.id }, copy)).toThrow(/already attached here \(as Bill 42\.pdf\)/)
    expect(attachmentCounts(db, 'voucher')).toEqual({ [v.id]: 1 })

    const opened = prepareOpen(db, store, a.id, root)
    expect(opened.endsWith('Bill 42.pdf')).toBe(true)
    expect(sha(readFileSync(opened))).toBe(a.sha256)

    // Removing one row keeps the file the other row still uses; removing the last drops it.
    removeAttachment(db, store, a.id)
    expect(existsSync(join(store, storedPathFor(a.sha256)))).toBe(true)
    removeAttachment(db, store, b.id)
    expect(existsSync(join(store, storedPathFor(a.sha256)))).toBe(false)
    expect(auditRows(db, 'delete')).toBe(2)
    expect(listAttachments(db, { entity: 'voucher', entityId: v.id })).toEqual([])
  })

  it('refuses disallowed types, files over the cap, symlinks, missing / binned parents', () => {
    const { db, store, src, v } = setup()
    expect(() => addAttachment(db, store, { entity: 'voucher', entityId: v.id }, file(src, 'run.exe', 'MZ'))).toThrow(/\.exe can't be attached/)
    expect(() => addAttachment(db, store, { entity: 'voucher', entityId: v.id }, file(src, 'page.html', '<script>'))).toThrow(/\.html can't be attached/)
    setAttachmentConfig(db, { ...getAttachmentConfig(db), maxBytes: 1024 * 1024 })
    expect(() => addAttachment(db, store, { entity: 'voucher', entityId: v.id }, file(src, 'big.pdf', Buffer.alloc(1024 * 1024 + 1)))).toThrow(/limit is 1\.0 MB/)
    const real = file(src, 'real.pdf', 'x')
    const link = join(src, 'link.pdf')
    symlinkSync(real, link)
    expect(() => addAttachment(db, store, { entity: 'voucher', entityId: v.id }, link)).toThrow(/not a link/)
    expect(() => addAttachment(db, store, { entity: 'voucher', entityId: 99999 }, real)).toThrow(/Voucher not found/)
    deleteVoucher(db, v.id)
    expect(() => addAttachment(db, store, { entity: 'voucher', entityId: v.id }, real)).toThrow(/in the bin/)
    expect(auditRows(db, 'create')).toBe(0)
  })

  it('never resolves a tampered stored path, a symlink in the store or changed bytes', () => {
    const { db, store, src, v, root } = setup()
    const a = addAttachment(db, store, { entity: 'voucher', entityId: v.id }, file(src, 'a.pdf', 'AAAA'))
    // Path traversal: a row pointing outside the store is refused before any file is touched.
    const outside = file(root, 'secret.txt', 'secret')
    db.prepare('UPDATE attachments SET stored_path = ? WHERE id = ?').run('../secret.txt', a.id)
    expect(() => prepareOpen(db, store, a.id, root)).toThrow(/stored path is not valid/)
    db.prepare('UPDATE attachments SET stored_path = ? WHERE id = ?').run(outside, a.id)
    expect(() => prepareOpen(db, store, a.id, root)).toThrow(/stored path is not valid/)
    db.prepare('UPDATE attachments SET stored_path = ? WHERE id = ?').run(storedPathFor(a.sha256), a.id)
    // A hash that isn't a hash (e.g. '../../x') never becomes a path either.
    expect(() => storedPathFor('../../etc/passwd')).toThrow(/Not a SHA-256/)
    // Changed bytes in the store: the hash check refuses to open them.
    writeFileSync(join(store, storedPathFor(a.sha256)), 'tampered')
    expect(() => prepareOpen(db, store, a.id, root)).toThrow(/hash mismatch/)
    // A symlink planted at the stored location is refused (lstat, never followed).
    const p = join(store, storedPathFor(a.sha256))
    unlinkSync(p)
    symlinkSync(outside, p)
    expect(() => prepareOpen(db, store, a.id, root)).toThrow(/something other than a file/)
  })

  it('the orphan sweep on bin purge removes the rows and the files nothing references', () => {
    const { db, store, src, v } = setup()
    const keep = postSimpleVoucher(db, { date: '2025-06-02', amount: 20000, kind: 'receipt' })
    const shared = file(src, 'shared.pdf', 'SHARED')
    addAttachment(db, store, { entity: 'voucher', entityId: v.id }, shared)
    addAttachment(db, store, { entity: 'voucher', entityId: keep.id }, file(src, 'other.pdf', 'SHARED'))
    const own = addAttachment(db, store, { entity: 'voucher', entityId: v.id }, file(src, 'own.png', 'PNGDATA'))
    deleteVoucher(db, v.id)
    // Binned: still attached (the bin can restore it).
    expect(sweepAttachments(db, store)).toEqual({ rowsRemoved: 0, filesRemoved: 0 })
    purgeVoucher(db, v.id)
    expect(sweepAttachments(db, store)).toEqual({ rowsRemoved: 2, filesRemoved: 1 })
    expect(existsSync(join(store, storedPathFor(own.sha256)))).toBe(false)
    expect(existsSync(join(store, storedPathFor(sha('SHARED'))))).toBe(true)
    expect(listAttachments(db, { entity: 'voucher', entityId: keep.id })).toHaveLength(1)
    expect((db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE entity = 'attachment' AND action = 'delete' AND before_json LIKE '%\"orphan\":true%'").get() as { n: number }).n).toBe(2)
  })
})

describe('attachments — backups', () => {
  it('local backup → restore keeps the attachments and their hashes', async () => {
    const root = tmp('total-att-bk-')
    const dbPath = join(root, 'company.db')
    const live = join(root, 'attachments')
    const backups = join(root, 'backups')
    const bstore = join(backups, 'attachments')
    mkdirSync(backups)
    const src = join(root, 'src')
    mkdirSync(src)
    let db = new Database(dbPath)
    db.pragma('journal_mode = WAL')
    migrate(db)
    seedCompany(db, TEST_INFO)
    const v = postSimpleVoucher(db, { date: '2025-06-01', amount: 10000, kind: 'receipt' })
    const a = addAttachment(db, live, { entity: 'voucher', entityId: v.id }, file(src, 'invoice.pdf', '%PDF invoice'))
    const b = addAttachment(db, live, { entity: 'voucher', entityId: v.id }, file(src, 'photo.jpg', 'JPEG bytes'))

    const backupPath = join(backups, '2025-06-01T10-00-00-manual.db')
    await snapshotTo(db, backupPath)
    expect(stashSnapshotAttachments(backupPath, live, bstore)).toEqual({ copied: 2, missing: [] })
    // A second backup of the same books copies nothing new.
    const second = join(backups, '2025-06-01T10-30-00-auto.db')
    await snapshotTo(db, second)
    expect(stashSnapshotAttachments(second, live, bstore).copied).toBe(0)

    // After the backup the files are removed from the books (and the live store).
    removeAttachment(db, live, a.id)
    removeAttachment(db, live, b.id)
    expect(existsSync(join(live, storedPathFor(a.sha256)))).toBe(false)

    restoreCompanyDb(db, dbPath, backupPath, backups)
    db = new Database(dbPath)
    const res = restoreAttachmentFiles(db, live, bstore)
    expect(res).toEqual({ restored: 2, present: 0, missing: [] })
    const rows = listAttachments(db, { entity: 'voucher', entityId: v.id })
    expect(rows.map((r) => [r.fileName, r.sha256])).toEqual([['invoice.pdf', a.sha256], ['photo.jpg', b.sha256]])
    for (const r of rows) expect(sha(readFileSync(join(live, storedPathFor(r.sha256))))).toBe(r.sha256)
    expect(sha(readFileSync(prepareOpen(db, live, rows[0]!.id, root)))).toBe(a.sha256)
    db.close()

    // Pruning keeps copies a remaining backup references, drops the rest.
    writeFileSync(join(bstore, 'ab'), '') // not ours: never touched (a file where a prefix dir would be)
    mkdirSync(join(bstore, 'ff'), { recursive: true })
    const stray = 'f'.repeat(64)
    writeFileSync(join(bstore, 'ff', stray), 'orphan')
    expect(pruneBackupAttachmentStore(backups, bstore)).toBe(1)
    expect(existsSync(join(bstore, storedPathFor(a.sha256)))).toBe(true)
  })

  it('encrypted export → import carries the attachments inside the TOTALBK1 file', async () => {
    const { db, store, src, v, root } = setup()
    const a = addAttachment(db, store, { entity: 'voucher', entityId: v.id }, file(src, 'scan.pdf', '%PDF scanned'))
    const snap = join(root, 'export-tmp.db')
    snapshotSync(db, snap)
    expect(embedAttachments(snap, store)).toEqual({ copied: 1, missing: [] })
    const enc = join(root, 'books.totalbak')
    await encryptFile(snap, enc, 'correct horse battery')
    // The encrypted container hides the bytes.
    expect(readFileSync(enc).includes(Buffer.from('%PDF scanned'))).toBe(false)

    const dec = join(root, 'restored.db')
    await decryptFile(enc, dec, 'correct horse battery')
    const newStore = join(root, 'imported-attachments')
    expect(restoreAttachmentFilesAt(dec, newStore, null)).toEqual({ restored: 1, present: 0, missing: [] })
    const imported = new Database(dec)
    expect(imported.prepare("SELECT 1 FROM sqlite_master WHERE name = ?").get(BLOB_TABLE)).toBeUndefined()
    const rows = listAttachments(imported, { entity: 'voucher', entityId: v.id })
    expect(rows.map((r) => r.sha256)).toEqual([a.sha256])
    expect(sha(readFileSync(join(newStore, storedPathFor(a.sha256))))).toBe(a.sha256)
    imported.close()
  })

  it('a damaged blob is reported missing, never written', () => {
    const { db, store, src, v, root } = setup()
    addAttachment(db, store, { entity: 'voucher', entityId: v.id }, file(src, 'x.pdf', 'GOOD'))
    const snap = join(root, 'snap.db')
    snapshotSync(db, snap)
    embedAttachments(snap, store)
    const s = new Database(snap)
    s.prepare(`UPDATE ${BLOB_TABLE} SET data = ?`).run(Buffer.from('EVIL'))
    s.close()
    const out = join(root, 'fresh')
    const r = restoreAttachmentFilesAt(snap, out, null)
    expect(r.restored).toBe(0)
    expect(r.missing).toEqual([sha('GOOD')])
    expect(existsSync(join(out, storedPathFor(sha('GOOD'))))).toBe(false)
  })
})
