/**
 * WP 6.4 — attachments on vouchers, ledgers, stock items and trade documents.
 *
 * Storage: the bytes live in the company folder, content-addressed —
 * `<company>/attachments/<sha256[0:2]>/<sha256>` — so the same file attached twice (to two
 * vouchers, say) is stored once. The `attachments` row (migration 036) carries the display name,
 * MIME, size, hash and who added it. Electron-free (the attachments folder is passed in) so the
 * dbtests drive it directly; the IPC layer (ipcWorkspace.ts) owns the native dialogs and
 * shell.openPath.
 *
 * Safety:
 *  - the renderer never sends a path: files come from the native picker in main, and are opened by
 *    id — the main process re-checks the row, the hash and the location first;
 *  - a stored path is only ever the exact `storedPathFor(sha)` of its own hash (never `..`, never
 *    absolute), and the resolved real path must lie inside the store's real path;
 *  - symlinks are refused both as a source and inside the store (lstat, never stat);
 *  - opening copies the file (hash-checked) to a private temp folder under its own name, so the
 *    system viewer can pick the app by extension and nothing edits the store in place.
 *
 * Every add / remove / sweep writes an audit row ('attachment', before/after = the row).
 */
import { createHash, randomBytes } from 'crypto'
import {
  closeSync, copyFileSync, existsSync, fstatSync, lstatSync, mkdirSync, mkdtempSync, openSync,
  readdirSync, readSync, realpathSync, renameSync, rmSync, unlinkSync, writeFileSync
} from 'fs'
import { tmpdir } from 'os'
import { join, relative, isAbsolute, sep } from 'path'
import type { DB } from '../db/connection'
import {
  ATTACHMENT_TYPES, DEFAULT_ATTACHMENT_CONFIG, SHA256_RE, attachmentConfigSchema, attachmentRefusal, cleanFileName, extensionOf,
  isSafeStoredPath, storedPathFor, type Attachment, type AttachmentConfig, type AttachmentEntity, type AttachmentTarget
} from '@shared/attachments'
import { currentAuditUserName, writeAudit } from './audit'

const CONFIG_KEY = 'attachments.config'

export function getAttachmentConfig(db: DB): AttachmentConfig {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(CONFIG_KEY) as { value: string } | undefined
  if (!row) return { ...DEFAULT_ATTACHMENT_CONFIG, allowedExtensions: [...DEFAULT_ATTACHMENT_CONFIG.allowedExtensions] }
  try {
    return attachmentConfigSchema.parse(JSON.parse(row.value))
  } catch {
    return { ...DEFAULT_ATTACHMENT_CONFIG, allowedExtensions: [...DEFAULT_ATTACHMENT_CONFIG.allowedExtensions] }
  }
}

export function setAttachmentConfig(db: DB, raw: unknown): AttachmentConfig {
  const cfg = attachmentConfigSchema.parse(raw)
  const before = getAttachmentConfig(db)
  db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(CONFIG_KEY, JSON.stringify(cfg))
  writeAudit(db, 'company', 0, 'update', { attachments: before }, { attachments: cfg })
  return cfg
}

interface AttachmentRow {
  id: number; entity: AttachmentEntity; entity_id: number; file_name: string; mime: string; size: number
  sha256: string; stored_path: string; added_by: string | null; added_at: string
}
const mapRow = (r: AttachmentRow): Attachment => ({
  id: r.id, entity: r.entity, entityId: r.entity_id, fileName: r.file_name, mime: r.mime, size: r.size,
  sha256: r.sha256, addedBy: r.added_by, addedAt: r.added_at
})

const PARENT_SQL: Record<AttachmentEntity, string> = {
  voucher: 'SELECT deleted_at AS binned FROM vouchers WHERE id = ?',
  ledger: 'SELECT NULL AS binned FROM ledgers WHERE id = ?',
  stockItem: 'SELECT NULL AS binned FROM stock_items WHERE id = ?',
  trade_doc: 'SELECT deleted_at AS binned FROM trade_docs WHERE id = ?'
}
const PARENT_TABLE: Record<AttachmentEntity, string> = { voucher: 'vouchers', ledger: 'ledgers', stockItem: 'stock_items', trade_doc: 'trade_docs' }

function assertParent(db: DB, t: AttachmentTarget): void {
  const r = db.prepare(PARENT_SQL[t.entity]).get(t.entityId) as { binned: string | null } | undefined
  const what = t.entity === 'trade_doc' ? 'Document' : t.entity === 'stockItem' ? 'Stock item' : t.entity === 'ledger' ? 'Ledger' : 'Voucher'
  if (!r) throw new Error(`${what} not found`)
  if (r.binned) throw new Error(`${what} is in the bin; restore it first`)
}

export function listAttachments(db: DB, t: AttachmentTarget): Attachment[] {
  return (db.prepare('SELECT * FROM attachments WHERE entity = ? AND entity_id = ? ORDER BY added_at, id').all(t.entity, t.entityId) as AttachmentRow[]).map(mapRow)
}

/** entityId → number of attachments, for the list screens' "Files" action. */
export function attachmentCounts(db: DB, entity: AttachmentEntity): Record<number, number> {
  const rows = db.prepare('SELECT entity_id AS id, COUNT(*) AS n FROM attachments WHERE entity = ? GROUP BY entity_id').all(entity) as { id: number; n: number }[]
  return Object.fromEntries(rows.map((r) => [r.id, r.n]))
}

export const sha256OfBuffer = (b: Buffer): string => createHash('sha256').update(b).digest('hex')

/** Hash of a file, streamed in chunks (the cap is up to 200 MB). */
export function sha256OfFile(path: string): string {
  const h = createHash('sha256')
  const fd = openSync(path, 'r')
  try {
    const buf = Buffer.allocUnsafe(1 << 20)
    let n: number
    while ((n = readSync(fd, buf, 0, buf.length, null)) > 0) h.update(n === buf.length ? buf : buf.subarray(0, n))
  } finally {
    closeSync(fd)
  }
  return h.digest('hex')
}

/** `target` resolved, only when it lies strictly inside `root` (both real paths). */
function inside(root: string, target: string): boolean {
  const rel = relative(root, target)
  return !!rel && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)
}

/** Absolute path of the stored file for `sha` — refusing anything that isn't a plain regular file
 *  at exactly the content-addressed location (a symlink planted in the store, a directory, …).
 *  Returns null when the file is simply missing. */
export function storedFile(dir: string, sha: string): string | null {
  const rel = storedPathFor(sha)
  const abs = join(dir, rel)
  let st
  try {
    st = lstatSync(abs)
  } catch {
    return null
  }
  if (st.isSymbolicLink() || !st.isFile()) throw new Error('The attachment store holds something other than a file there — refusing to use it')
  const realRoot = realpathSync(dir)
  const real = realpathSync(abs)
  if (!inside(realRoot, real) || relative(realRoot, real).split(sep).join('/') !== rel) throw new Error('Attachment path escapes the attachment folder')
  return abs
}

/** Write `data` into the store under its hash (atomically: temp file + rename in the same
 *  folder). An existing file with the right hash is kept (dedupe); a damaged one is replaced. */
export function putStoredFile(dir: string, sha: string, data: Buffer | { copyFrom: string }): void {
  const rel = storedPathFor(sha)
  const abs = join(dir, rel)
  mkdirSync(join(dir, sha.slice(0, 2)), { recursive: true })
  const realRoot = realpathSync(dir)
  const realSub = realpathSync(join(dir, sha.slice(0, 2)))
  if (!inside(realRoot, realSub)) throw new Error('Attachment path escapes the attachment folder')
  const existing = storedFile(dir, sha)
  if (existing && sha256OfFile(existing) === sha) return
  const tmp = `${abs}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`
  try {
    if (Buffer.isBuffer(data)) writeFileSync(tmp, data, { mode: 0o600, flag: 'wx' })
    else copyFileSync(data.copyFrom, tmp)
    if (sha256OfFile(tmp) !== sha) throw new Error('The file changed while it was being stored')
    renameSync(tmp, abs)
  } finally {
    rmSync(tmp, { force: true })
  }
}

function rowById(db: DB, id: number): AttachmentRow {
  const r = db.prepare('SELECT * FROM attachments WHERE id = ?').get(id) as AttachmentRow | undefined
  if (!r) throw new Error('Attachment not found')
  return r
}

/**
 * Attach the file at `sourcePath` (a path the MAIN process got from the native picker, never one
 * from the renderer) to the target. Refused: a parent that doesn't exist or is binned, a type not
 * on the allowed list, a file over the cap, a symlink or non-regular file, the same file already
 * on the same record.
 */
export function addAttachment(db: DB, dir: string, t: AttachmentTarget, sourcePath: string, displayName?: string): Attachment {
  assertParent(db, t)
  const st = lstatSync(sourcePath)
  if (st.isSymbolicLink()) throw new Error('Pick the file itself, not a link to it')
  if (!st.isFile()) throw new Error('Only a regular file can be attached')
  const fileName = cleanFileName(displayName ?? sourcePath)
  const cfg = getAttachmentConfig(db)
  const refusal = attachmentRefusal(fileName, st.size, cfg)
  if (refusal) throw new Error(refusal)
  // Read once through one descriptor (size re-checked on it), so what is hashed is what is stored.
  const fd = openSync(sourcePath, 'r')
  let data: Buffer
  try {
    const size = fstatSync(fd).size
    if (size > cfg.maxBytes) throw new Error(attachmentRefusal(fileName, size, cfg) ?? 'File too large')
    data = Buffer.alloc(size)
    let off = 0
    while (off < size) {
      const n = readSync(fd, data, off, size - off, off)
      if (n === 0) break
      off += n
    }
    data = data.subarray(0, off)
  } finally {
    closeSync(fd)
  }
  const sha = sha256OfBuffer(data)
  const dup = db.prepare('SELECT file_name FROM attachments WHERE entity = ? AND entity_id = ? AND sha256 = ?').get(t.entity, t.entityId, sha) as { file_name: string } | undefined
  if (dup) throw new Error(`That file is already attached here (as ${dup.file_name})`)
  mkdirSync(dir, { recursive: true })
  putStoredFile(dir, sha, data)
  const mime = ATTACHMENT_TYPES[extensionOf(fileName)] ?? 'application/octet-stream'
  const id = Number(
    db
      .prepare('INSERT INTO attachments (entity, entity_id, file_name, mime, size, sha256, stored_path, added_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(t.entity, t.entityId, fileName, mime, data.length, sha, storedPathFor(sha), currentAuditUserName()).lastInsertRowid
  )
  const created = mapRow(rowById(db, id))
  writeAudit(db, 'attachment', id, 'create', null, created)
  return created
}

/** Remove one attachment; its file goes too once no other row uses that hash. */
export function removeAttachment(db: DB, dir: string, id: number): void {
  const before = mapRow(rowById(db, id))
  if (before.entity === 'voucher' || before.entity === 'trade_doc') {
    const r = db.prepare(PARENT_SQL[before.entity]).get(before.entityId) as { binned: string | null } | undefined
    if (r?.binned) throw new Error('The record is in the bin; restore it first')
  }
  db.prepare('DELETE FROM attachments WHERE id = ?').run(id)
  writeAudit(db, 'attachment', id, 'delete', before, null)
  deleteIfUnreferenced(db, dir, before.sha256)
}

function deleteIfUnreferenced(db: DB, dir: string, sha: string): boolean {
  if (db.prepare('SELECT 1 FROM attachments WHERE sha256 = ? LIMIT 1').get(sha)) return false
  const abs = storedFileOrNull(dir, sha)
  if (!abs) return false
  unlinkSync(abs)
  return true
}

function storedFileOrNull(dir: string, sha: string): string | null {
  try {
    return storedFile(dir, sha)
  } catch {
    return null // something planted there that isn't ours — leave it alone
  }
}

/**
 * The checked, absolute path of a copy of the attachment ready to open: the row must exist, its
 * stored path must be exactly the content-addressed one for its hash, the stored file must be a
 * regular file inside the store, and its bytes must still hash to the row's sha256. The copy is
 * written to a fresh private temp folder under the attachment's own name (so the viewer picks the
 * right app by extension and nothing edits the store in place).
 */
export function prepareOpen(db: DB, dir: string, id: number, tempRoot: string = tmpdir()): string {
  const r = rowById(db, id)
  if (!isSafeStoredPath(r.stored_path, r.sha256)) throw new Error('This attachment’s stored path is not valid — refusing to open it')
  const abs = storedFile(dir, r.sha256)
  if (!abs) throw new Error(`${r.file_name} is missing from the attachments folder — restore a backup that has it`)
  if (sha256OfFile(abs) !== r.sha256) throw new Error(`${r.file_name} has changed on disk since it was attached (hash mismatch) — refusing to open it`)
  const outDir = mkdtempSync(join(tempRoot, 'total-attachment-'))
  const name = cleanFileName(r.file_name) || `attachment.${extensionOf(r.file_name) || 'bin'}`
  const out = join(outDir, name)
  if (!inside(outDir, out)) throw new Error('Bad attachment name')
  copyFileSync(abs, out)
  if (sha256OfFile(out) !== r.sha256) throw new Error('The copy did not match the attachment — refusing to open it')
  return out
}

export interface SweepResult {
  rowsRemoved: number
  filesRemoved: number
}

/**
 * Orphan sweep (after a bin purge, on company open): rows whose parent record no longer exists are
 * removed (audited, marked `orphan`), then stored files no row references are deleted. Binned
 * parents keep their attachments — the bin can still restore them.
 */
export function sweepAttachments(db: DB, dir: string): SweepResult {
  let rowsRemoved = 0
  for (const entity of Object.keys(PARENT_TABLE) as AttachmentEntity[]) {
    const orphans = db
      .prepare(`SELECT a.* FROM attachments a WHERE a.entity = ? AND NOT EXISTS (SELECT 1 FROM ${PARENT_TABLE[entity]} p WHERE p.id = a.entity_id)`)
      .all(entity) as AttachmentRow[]
    for (const o of orphans) {
      db.prepare('DELETE FROM attachments WHERE id = ?').run(o.id)
      writeAudit(db, 'attachment', o.id, 'delete', { ...mapRow(o), orphan: true }, null)
      rowsRemoved++
    }
  }
  let filesRemoved = 0
  if (existsSync(dir)) {
    const used = new Set((db.prepare('SELECT DISTINCT sha256 AS s FROM attachments').all() as { s: string }[]).map((r) => r.s))
    for (const prefix of readdirSync(dir)) {
      if (!/^[0-9a-f]{2}$/.test(prefix)) continue
      const sub = join(dir, prefix)
      const pst = lstatSync(sub)
      if (pst.isSymbolicLink() || !pst.isDirectory()) continue
      for (const name of readdirSync(sub)) {
        if (!SHA256_RE.test(name) || name.slice(0, 2) !== prefix || used.has(name)) continue
        const abs = storedFileOrNull(dir, name)
        if (abs) {
          unlinkSync(abs)
          filesRemoved++
        }
      }
    }
  }
  return { rowsRemoved, filesRemoved }
}

/** Every hash the attachments table references (for the backup stash). */
export function referencedHashes(db: DB): string[] {
  const t = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'attachments'").get()
  if (!t) return []
  return (db.prepare('SELECT DISTINCT sha256 AS s FROM attachments ORDER BY s').all() as { s: string }[]).map((r) => r.s).filter((s) => SHA256_RE.test(s))
}

