/**
 * WP 6.4 — attachments in backups and restores. Path-parameterized and Electron-free (dbtest-able).
 *
 * A company backup is one SQLite file; attachments are files beside the database. Two carriers:
 *
 *  - Local backups (backups/*.db — open, manual, every 30 min, quit, pre-restore, pre-import):
 *    each snapshot's referenced files are copied once into `backups/attachments/` (same
 *    content-addressed layout as the live store). Many snapshots share one copy of a file, so a
 *    30-minute schedule doesn't multiply the bytes; files no remaining backup references are
 *    pruned with the backups themselves. Restoring a backup re-fills the live store from there.
 *
 *  - Encrypted backups (.totalbak, TOTALBK1): the export snapshot gets a
 *    `backup_attachment_blobs (sha256, data)` table with every referenced file, before it is
 *    encrypted — so the one encrypted file carries the attachments and the TOTALBK1 container is
 *    unchanged (AES-256-GCM over the whole snapshot covers the blobs too). Importing extracts them
 *    into the new company's store (each hash-checked) and drops the table.
 *
 * Every copy in either direction is verified against its SHA-256; a file that doesn't match is
 * never written, and is reported as missing instead.
 */
import Database from 'better-sqlite3'
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, unlinkSync } from 'fs'
import { join } from 'path'
import type { DB } from './connection'
import { SHA256_RE } from '@shared/attachments'
import { getAttachmentConfig, putStoredFile, referencedHashes, sha256OfBuffer, sha256OfFile, storedFile } from '../services/attachments'
import { contentRefusal, openRefusal } from '@shared/attachments'

export const BLOB_TABLE = 'backup_attachment_blobs'

function hashesInDbFile(path: string): string[] {
  const db = new Database(path, { readonly: true, fileMustExist: true })
  try {
    return referencedHashes(db)
  } finally {
    db.close()
  }
}

function goodFile(dir: string, sha: string): string | null {
  try {
    const abs = storedFile(dir, sha)
    return abs && sha256OfFile(abs) === sha ? abs : null
  } catch {
    return null
  }
}

export interface StashResult {
  copied: number
  missing: string[]
}

/** After a local snapshot: make sure every file it references has a copy in `storeDir`. */
export function stashSnapshotAttachments(snapshotPath: string, liveDir: string, storeDir: string): StashResult {
  const out: StashResult = { copied: 0, missing: [] }
  const hashes = hashesInDbFile(snapshotPath)
  if (hashes.length === 0) return out
  mkdirSync(storeDir, { recursive: true })
  for (const sha of hashes) {
    if (goodFile(storeDir, sha)) continue
    const src = goodFile(liveDir, sha)
    if (!src) {
      out.missing.push(sha)
      continue
    }
    putStoredFile(storeDir, sha, { copyFrom: src })
    out.copied++
  }
  return out
}

/** Drop copies in `storeDir` that no backup left in `backupsDir` references. */
export function pruneBackupAttachmentStore(backupsDir: string, storeDir: string): number {
  if (!existsSync(storeDir)) return 0
  const keep = new Set<string>()
  for (const f of readdirSync(backupsDir)) {
    if (!f.endsWith('.db')) continue
    try {
      for (const s of hashesInDbFile(join(backupsDir, f))) keep.add(s)
    } catch {
      // An unreadable backup can't vouch for anything — but never delete because of it.
      return 0
    }
  }
  let removed = 0
  for (const prefix of readdirSync(storeDir)) {
    if (!/^[0-9a-f]{2}$/.test(prefix)) continue
    const sub = join(storeDir, prefix)
    const st = lstatSync(sub)
    if (st.isSymbolicLink() || !st.isDirectory()) continue
    for (const name of readdirSync(sub)) {
      if (!SHA256_RE.test(name) || keep.has(name)) continue
      try {
        const abs = storedFile(storeDir, name)
        if (abs) {
          unlinkSync(abs)
          removed++
        }
      } catch {
        // not ours — leave it
      }
    }
  }
  return removed
}

/** Encrypted export: copy every referenced file into the (temporary, unencrypted) snapshot. */
export function embedAttachments(snapshotPath: string, liveDir: string): StashResult {
  const out: StashResult = { copied: 0, missing: [] }
  const db = new Database(snapshotPath, { fileMustExist: true })
  try {
    const hashes = referencedHashes(db)
    if (hashes.length === 0) return out
    db.exec(`CREATE TABLE IF NOT EXISTS ${BLOB_TABLE} (sha256 TEXT PRIMARY KEY, data BLOB NOT NULL)`)
    const ins = db.prepare(`INSERT OR REPLACE INTO ${BLOB_TABLE} (sha256, data) VALUES (?, ?)`)
    db.transaction(() => {
      for (const sha of hashes) {
        const src = goodFile(liveDir, sha)
        if (!src) {
          out.missing.push(sha)
          continue
        }
        const data = readFileSync(src)
        if (sha256OfBuffer(data) !== sha) {
          out.missing.push(sha)
          continue
        }
        ins.run(sha, data)
        out.copied++
      }
    })()
    return out
  } finally {
    db.close()
  }
}

export interface RestoreFilesResult {
  /** Files written into the live store. */
  restored: number
  /** Files already there with the right hash. */
  present: number
  /** Referenced hashes no source could supply, whose bytes failed the hash check, or whose write
   *  failed (each file is tried on its own; one failure never stops the rest). */
  missing: string[]
  /** Files the type policy refuses (extension not allowed, or a web page / script in a text
   *  type) — never written; the rows stay, and opening them is refused too. */
  refused: { sha256: string; fileName: string; reason: string }[]
}

/** The file's bytes from the blob table or the backups' store, hash-checked; null if neither. */
function sourceBytes(sha: string, blob: Database.Statement | null, storeDir: string | null): Buffer | null {
  const b = blob?.get(sha) as { data: Buffer } | undefined
  if (b && sha256OfBuffer(b.data) === sha) return b.data
  const src = storeDir ? goodFile(storeDir, sha) : null
  if (!src) return null
  const data = readFileSync(src)
  return sha256OfBuffer(data) === sha ? data : null
}

/**
 * After a restore / import: make the live store hold every file the (now live) database
 * references — from the embedded blob table when there is one (encrypted import), else from the
 * backups' store — running the attachment type policy on each first. The blob table is always
 * dropped (finally), so the company database is its usual self even when a file fails.
 */
export function restoreAttachmentFiles(db: DB, liveDir: string, storeDir: string | null): RestoreFilesResult {
  const out: RestoreFilesResult = { restored: 0, present: 0, missing: [], refused: [] }
  const hasBlobs = !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(BLOB_TABLE)
  try {
    const blob = hasBlobs ? db.prepare(`SELECT data FROM ${BLOB_TABLE} WHERE sha256 = ?`) : null
    const hashes = referencedHashes(db)
    const cfg = getAttachmentConfig(db)
    const namesOf = db.prepare('SELECT DISTINCT file_name AS n FROM attachments WHERE sha256 = ? ORDER BY n')
    for (const sha of hashes) {
      try {
        if (goodFile(liveDir, sha)) {
          out.present++
          continue
        }
        const names = (namesOf.all(sha) as { n: string }[]).map((r) => r.n)
        const allowed = names.find((n) => !openRefusal(n, cfg))
        if (!allowed) {
          out.refused.push({ sha256: sha, fileName: names[0] ?? sha, reason: openRefusal(names[0] ?? '', cfg) ?? 'Not an allowed file type' })
          continue
        }
        const data = sourceBytes(sha, blob, storeDir)
        if (!data) {
          out.missing.push(sha)
          continue
        }
        const sniff = names.map((n) => contentRefusal(n, data)).find((x) => x)
        if (sniff) {
          out.refused.push({ sha256: sha, fileName: allowed, reason: sniff })
          continue
        }
        mkdirSync(liveDir, { recursive: true })
        putStoredFile(liveDir, sha, data)
        out.restored++
      } catch {
        out.missing.push(sha) // e.g. a read-only or full store — keep going with the rest
      }
    }
  } finally {
    if (hasBlobs) db.exec(`DROP TABLE IF EXISTS ${BLOB_TABLE}`)
  }
  return out
}

/** restoreAttachmentFiles for a database file that isn't open yet (encrypted import). The blob
 *  table is dropped and the file vacuumed even when a file fails. */
export function restoreAttachmentFilesAt(dbPath: string, liveDir: string, storeDir: string | null): RestoreFilesResult {
  const db = new Database(dbPath, { fileMustExist: true })
  try {
    return restoreAttachmentFiles(db, liveDir, storeDir)
  } finally {
    try {
      db.exec('VACUUM') // the blob table's pages go back to the filesystem
    } finally {
      db.close()
    }
  }
}
