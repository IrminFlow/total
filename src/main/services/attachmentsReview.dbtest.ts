// WP 6.4 review round (PR #65), attachments: the type policy at open and at restore (a
// `run.command` row injected into a backup), content sniffing of text types, the opened-copy temp
// folder (one per session, deleted on quit, stale ones swept), per-file restore errors with the
// blob table always dropped (a read-only store), and backupCompany never losing its backup or its
// audit row when the attachment copy fails.
import { afterAll, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, symlinkSync, utimesSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { createHash } from 'crypto'
import { migrate } from '../db/migrate'
import { seedCompany } from '../db/seed'
import { TEST_INFO, postSimpleVoucher, seededDb } from '../db/testdb'
import { restoreCompanyDb, snapshotSync, snapshotTo } from '../db/backup'
import { BLOB_TABLE, embedAttachments, restoreAttachmentFiles, restoreAttachmentFilesAt, stashSnapshotAttachments } from '../db/attachmentBackup'
import {
  addAttachment, cleanupOpenedCopies, prepareOpen, putStoredFile, sessionOpenDir, sweepStaleOpenCopies
} from './attachments'
import { storedPathFor } from '@shared/attachments'

const tmp = (p = 'total-attr-'): string => mkdtempSync(join(tmpdir(), p))
const sha = (b: string | Buffer): string => createHash('sha256').update(b).digest('hex')
const readOnly: string[] = []
afterAll(() => {
  for (const d of readOnly) chmodSync(d, 0o755)
})

function setup() {
  const db = seededDb()
  const root = tmp()
  const store = join(root, 'attachments')
  const src = join(root, 'src')
  mkdirSync(src)
  const v = postSimpleVoucher(db, { date: '2025-06-01', amount: 10000, kind: 'receipt' })
  const file = (name: string, content: string | Buffer): string => {
    const p = join(src, name)
    writeFileSync(p, content)
    return p
  }
  return { db, root, store, src, v, file }
}

describe('type policy at open and at restore', () => {
  it('a run.command row injected into a backup is neither restored nor opened', async () => {
    const root = tmp()
    const dbPath = join(root, 'company.db')
    const live = join(root, 'attachments')
    const backups = join(root, 'backups')
    const bstore = join(backups, 'attachments')
    mkdirSync(backups)
    let db = new Database(dbPath)
    db.pragma('journal_mode = WAL')
    migrate(db)
    seedCompany(db, TEST_INFO)
    const v = postSimpleVoucher(db, { date: '2025-06-01', amount: 10000, kind: 'receipt' })
    const backupPath = join(backups, '2025-06-01T10-00-00-manual.db')
    await snapshotTo(db, backupPath)
    // Tamper with the backup: a script row, and its bytes in the backups' store.
    const script = '#!/bin/sh\necho owned\n'
    const s = sha(script)
    putStoredFile(bstore, s, Buffer.from(script))
    const b = new Database(backupPath)
    b.prepare("INSERT INTO attachments (entity, entity_id, file_name, mime, size, sha256, stored_path) VALUES ('voucher', ?, 'run.command', 'text/plain', ?, ?, ?)").run(
      v.id, script.length, s, storedPathFor(s)
    )
    b.close()
    restoreCompanyDb(db, dbPath, backupPath, backups)
    db = new Database(dbPath)
    const r = restoreAttachmentFiles(db, live, bstore)
    expect(r.restored).toBe(0)
    expect(r.refused).toEqual([{ sha256: s, fileName: 'run.command', reason: expect.stringMatching(/\.command can't be attached/) }])
    expect(existsSync(join(live, storedPathFor(s)))).toBe(false)
    // Even if the bytes are put there by hand, opening refuses by type.
    putStoredFile(live, s, Buffer.from(script))
    const row = db.prepare("SELECT id FROM attachments WHERE file_name = 'run.command'").get() as { id: number }
    expect(() => prepareOpen(db, live, row.id, root)).toThrow(/^Not opened: \.command can't be attached/)
    db.close()
  })

  it('a web page inside a text type is refused when added, and at open', () => {
    const { db, store, v, file, root } = setup()
    expect(() => addAttachment(db, store, { entity: 'voucher', entityId: v.id }, file('statement.xml', '<?xml version="1.0"?><svg onload="alert(1)"/>'))).toThrow(
      /looks like a web page or script, not a \.xml file/
    )
    expect(() => addAttachment(db, store, { entity: 'voucher', entityId: v.id }, file('notes.txt', '<!DOCTYPE html><script>x</script>'))).toThrow(/web page or script/)
    // A real XML file is fine.
    const ok = addAttachment(db, store, { entity: 'voucher', entityId: v.id }, file('einv.xml', '<?xml version="1.0"?><Invoice><No>1</No></Invoice>'))
    // Bytes swapped for a page in the store (same hash impossible — so simulate a row whose file
    // name was edited to a sniffed type over HTML bytes).
    const page = '<html><body>hi</body></html>'
    putStoredFile(store, sha(page), Buffer.from(page))
    db.prepare('UPDATE attachments SET sha256 = ?, stored_path = ? WHERE id = ?').run(sha(page), storedPathFor(sha(page)), ok.id)
    expect(() => prepareOpen(db, store, ok.id, root)).toThrow(/^Not opened: .*web page or script/)
  })

  it('a link swapped in for the picked file is refused (no-follow open)', () => {
    const { db, store, v, file, src } = setup()
    const real = file('real.pdf', '%PDF-1.4')
    const link = join(src, 'link.pdf')
    symlinkSync(real, link)
    expect(() => addAttachment(db, store, { entity: 'voucher', entityId: v.id }, link)).toThrow(/not a link/)
  })
})

describe('opened copies', () => {
  it('go into one session folder, are deleted on quit, and stale folders are swept', () => {
    const { db, store, v, file } = setup()
    const tempRoot = tmp('total-attr-temp-')
    const a = addAttachment(db, store, { entity: 'voucher', entityId: v.id }, file('a.pdf', '%PDF a'))
    const b = addAttachment(db, store, { entity: 'voucher', entityId: v.id }, file('b.pdf', '%PDF b'))
    const p1 = prepareOpen(db, store, a.id, tempRoot)
    const p2 = prepareOpen(db, store, b.id, tempRoot)
    const session = sessionOpenDir(tempRoot)
    expect(p1.startsWith(session) && p2.startsWith(session)).toBe(true)
    expect(readdirSync(tempRoot).filter((n) => n.startsWith('total-attachment-'))).toHaveLength(1)

    // A crash left an old folder (and a fresh one from another running copy).
    const stale = join(tempRoot, 'total-attachment-old')
    const fresh = join(tempRoot, 'total-attachment-fresh')
    mkdirSync(stale)
    mkdirSync(fresh)
    const twoDaysAgo = (Date.now() - 2 * 86400000) / 1000
    utimesSync(stale, twoDaysAgo, twoDaysAgo)
    expect(sweepStaleOpenCopies(tempRoot)).toBe(1)
    expect(existsSync(stale)).toBe(false)
    expect(existsSync(fresh)).toBe(true)
    expect(existsSync(session)).toBe(true) // ours is never swept

    cleanupOpenedCopies()
    expect(existsSync(session)).toBe(false)
    expect(existsSync(p1)).toBe(false)
  })
})

describe('restore errors', () => {
  it('a read-only store: every file is tried, missing is accurate, the blob table is dropped', () => {
    const { db, store, v, file, root } = setup()
    addAttachment(db, store, { entity: 'voucher', entityId: v.id }, file('one.pdf', '%PDF one'))
    addAttachment(db, store, { entity: 'voucher', entityId: v.id }, file('two.pdf', '%PDF two'))
    const snap = join(root, 'snap.db')
    snapshotSync(db, snap)
    expect(embedAttachments(snap, store).copied).toBe(2)
    const target = join(root, 'readonly-store')
    mkdirSync(target)
    chmodSync(target, 0o555)
    readOnly.push(target)
    const r = restoreAttachmentFilesAt(snap, target, null)
    expect(r.restored).toBe(0)
    expect(r.missing.sort()).toEqual([sha('%PDF one'), sha('%PDF two')].sort())
    const check = new Database(snap, { readonly: true })
    expect(check.prepare('SELECT 1 FROM sqlite_master WHERE name = ?').get(BLOB_TABLE)).toBeUndefined()
    check.close()
  })
})

describe('backupCompany', () => {
  it('records an attachment-copy failure on the audit row and keeps the backup', async () => {
    const dataDir = tmp('total-attr-data-')
    process.env.TOTAL_DATA_DIR = dataDir
    const { openCompanyDb, backupCompany } = await import('../db/connection')
    const { companyAttachmentsDir, companyBackupAttachmentsDir } = await import('../paths')
    const db = openCompanyDb('acme')
    seedCompany(db, TEST_INFO)
    const v = postSimpleVoucher(db, { date: '2025-06-01', amount: 10000, kind: 'receipt' })
    const src = tmp()
    writeFileSync(join(src, 'bill.pdf'), '%PDF bill')
    addAttachment(db, companyAttachmentsDir('acme'), { entity: 'voucher', entityId: v.id }, join(src, 'bill.pdf'))
    const bstore = companyBackupAttachmentsDir('acme')
    mkdirSync(bstore, { recursive: true })
    chmodSync(bstore, 0o555)
    readOnly.push(bstore)
    const dest = await backupCompany(db, 'acme', 'manual')
    expect(existsSync(dest)).toBe(true)
    const row = db.prepare("SELECT after_json FROM audit_log WHERE entity = 'backup' ORDER BY id DESC LIMIT 1").get() as { after_json: string }
    const after = JSON.parse(row.after_json) as { tag: string; attachmentsError?: string }
    expect(after.tag).toBe('manual')
    expect(after.attachmentsError).toMatch(/EACCES|permission/i)
    db.close()
  })
})
