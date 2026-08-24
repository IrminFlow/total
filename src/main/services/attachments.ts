import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs'
import { createHash, randomBytes } from 'crypto'
import { join } from 'path'
import type { DB } from '../db/connection'
import { companyAttachmentsDir } from '../paths'
import { checkAttachment, safeFileName, storedNameFor } from '@shared/attachments'
import { currentAuditUser, writeAudit } from './audit'

/**
 * The scan of the bill, kept with the books.
 *
 * The file is copied into `<company>/attachments/` and the row records where it went. See
 * src/shared/attachments.ts for why it is a copy rather than a reference — in one line: a
 * reference is a promise about a path on somebody else's disk, and it breaks silently.
 *
 * Everything a person could get wrong is decided in the pure module (type, size, count); this
 * file only does the parts that need a filesystem and a database.
 */

export interface Attachment {
  id: number
  voucherId: number
  fileName: string
  storedName: string
  byteSize: number
  sha256: string
  note: string | null
  addedAt: string
  addedBy: string | null
  /** The file is not on disk any more — somebody removed it from the folder by hand, or the
   *  books were copied without the attachments folder. Shown, never hidden: an attachment that
   *  quietly disappears from the list is the app losing evidence without saying so. */
  missing: boolean
}

interface AttachmentRow {
  id: number
  voucherId: number
  fileName: string
  storedName: string
  byteSize: number
  sha256: string
  note: string | null
  addedAt: string
  addedBy: string | null
}

const SELECT = `SELECT id, voucher_id AS voucherId, file_name AS fileName, stored_name AS storedName,
                       byte_size AS byteSize, sha256, note, added_at AS addedAt, added_by AS addedBy
                FROM voucher_attachments`

function withPresence(slug: string, row: AttachmentRow): Attachment {
  return { ...row, missing: !existsSync(attachmentPath(slug, row.storedName)) }
}

/** Absolute path of a stored attachment. `storedName` is always a name this module generated
 *  (safeFileName has already stripped separators), so it can never point out of the folder. */
export function attachmentPath(slug: string, storedName: string): string {
  return join(companyAttachmentsDir(slug), safeFileName(storedName))
}

export function listAttachments(db: DB, slug: string, voucherId: number): Attachment[] {
  const rows = db.prepare(`${SELECT} WHERE voucher_id = ? ORDER BY id`).all(voucherId) as AttachmentRow[]
  return rows.map((r) => withPresence(slug, r))
}

/** How many attachments each of these vouchers has — one query for a whole day book page. */
export function attachmentCounts(db: DB, voucherIds: number[]): Map<number, number> {
  if (voucherIds.length === 0) return new Map()
  const placeholders = voucherIds.map(() => '?').join(',')
  const rows = db
    .prepare(
      `SELECT voucher_id AS voucherId, COUNT(*) AS n FROM voucher_attachments
       WHERE voucher_id IN (${placeholders}) GROUP BY voucher_id`
    )
    .all(...voucherIds) as { voucherId: number; n: number }[]
  return new Map(rows.map((r) => [r.voucherId, r.n]))
}

export function getAttachment(db: DB, slug: string, id: number): Attachment | null {
  const row = db.prepare(`${SELECT} WHERE id = ?`).get(id) as AttachmentRow | undefined
  return row ? withPresence(slug, row) : null
}

export interface AddAttachmentInput {
  voucherId: number
  /** A file on disk to copy in… */
  sourcePath?: string
  /** …or the bytes themselves, which is how a driver or an agent attaches without a file dialog. */
  bytes?: Buffer
  fileName: string
  note?: string | null
}

/**
 * Copy a file in and record it.
 *
 * The same scan attached twice is recognised by its SHA-256 and the existing row is returned
 * rather than a second copy being written — the common way this happens is a user clicking
 * "Attach" twice on a slow copy, and two identical bills on one voucher is noise, not evidence.
 */
export function addAttachment(db: DB, slug: string, input: AddAttachmentInput): Attachment {
  const voucher = db.prepare('SELECT id FROM vouchers WHERE id = ?').get(input.voucherId) as { id: number } | undefined
  if (!voucher) throw new Error('Voucher not found')

  const bytes = input.bytes ?? null
  if (!bytes && !input.sourcePath) throw new Error('Nothing to attach')
  if (input.sourcePath && !existsSync(input.sourcePath)) throw new Error('That file is no longer there')

  const byteSize = bytes ? bytes.length : statSync(input.sourcePath!).size
  const existingCount = db
    .prepare('SELECT COUNT(*) AS n FROM voucher_attachments WHERE voucher_id = ?')
    .get(input.voucherId) as { n: number }
  const verdict = checkAttachment({ fileName: input.fileName, byteSize, existingCount: existingCount.n })
  if (!verdict.ok) throw new Error(verdict.message)

  const hash = createHash('sha256')
  // Reading the whole file to hash it is bounded by the size check that ran a moment ago.
  hash.update(bytes ?? readFileSync(input.sourcePath!))
  const sha256 = hash.digest('hex')

  const duplicate = db
    .prepare(`${SELECT} WHERE voucher_id = ? AND sha256 = ?`)
    .get(input.voucherId, sha256) as AttachmentRow | undefined
  if (duplicate && existsSync(attachmentPath(slug, duplicate.storedName))) {
    return withPresence(slug, duplicate)
  }

  const storedName = storedNameFor(input.voucherId, randomBytes(6).toString('hex'), input.fileName)
  const dir = companyAttachmentsDir(slug)
  mkdirSync(dir, { recursive: true })
  const dest = join(dir, storedName)
  if (bytes) writeFileSync(dest, bytes)
  else copyFileSync(input.sourcePath!, dest)

  const res = db
    .prepare(
      `INSERT INTO voucher_attachments (voucher_id, file_name, stored_name, byte_size, sha256, note, added_by)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(input.voucherId, safeFileName(input.fileName), storedName, byteSize, sha256, input.note ?? null, currentAuditUser())
  const created = getAttachment(db, slug, Number(res.lastInsertRowid))!
  writeAudit(db, 'attachment', created.id, 'create', null, {
    voucherId: created.voucherId,
    fileName: created.fileName,
    byteSize: created.byteSize
  })
  return created
}

/** Remove an attachment: the row and the copy, in that order, so a failed unlink can never leave
 *  a row pointing at nothing (the reverse would). */
export function removeAttachment(db: DB, slug: string, id: number): void {
  const existing = getAttachment(db, slug, id)
  if (!existing) throw new Error('Attachment not found')
  db.prepare('DELETE FROM voucher_attachments WHERE id = ?').run(id)
  rmSync(attachmentPath(slug, existing.storedName), { force: true })
  writeAudit(db, 'attachment', id, 'delete', { voucherId: existing.voucherId, fileName: existing.fileName }, null)
}

/**
 * Delete copies that no row points at any more.
 *
 * The row goes with the voucher (ON DELETE CASCADE), and a voucher is only really deleted when
 * it is purged out of the bin — at which point nothing in the database remembers the file. Called
 * after every purge path rather than on open: a folder scan is cheap but not free, and paying it
 * on every launch to catch a case that arises after a purge would be paying it 500 times for one
 * occurrence.
 */
export function sweepOrphanFiles(db: DB, slug: string): number {
  const dir = companyAttachmentsDir(slug)
  if (!existsSync(dir)) return 0
  const known = new Set(
    (db.prepare('SELECT stored_name AS storedName FROM voucher_attachments').all() as { storedName: string }[]).map(
      (r) => r.storedName
    )
  )
  let removed = 0
  for (const entry of readdirSync(dir)) {
    if (known.has(entry)) continue
    rmSync(join(dir, entry), { force: true })
    removed++
  }
  return removed
}

/** Total disk the attachments folder is using, from the recorded sizes. Shown in Settings so
 *  "copy the file in" stays a decision the user can see the cost of. */
export function attachmentsFootprint(db: DB): { files: number; bytes: number } {
  const row = db
    .prepare('SELECT COUNT(*) AS files, COALESCE(SUM(byte_size), 0) AS bytes FROM voucher_attachments')
    .get() as { files: number; bytes: number }
  return row
}
