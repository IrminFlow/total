// Path-parameterized, Electron-free backup primitives (dbtest-able; better-sqlite3 objects are
// passed in from callers that already opened them with the Electron ABI).
import { existsSync, readdirSync, statSync, unlinkSync } from 'fs'
import { join, basename } from 'path'
import type { DB } from './connection'

export interface BackupInfo {
  file: string
  sizeBytes: number
  mtime: number
  tag: string
}

/** ISO stamp with ':' and '.' replaced by '-', fixed-width (e.g. "2025-08-15T12-34-56"). */
const STAMP_LEN = 19

/** Timestamp segment used in backup filenames: ISO with ':' and '.' replaced by '-'. */
export function backupStamp(now = new Date()): string {
  return now.toISOString().replace(/[:.]/g, '-').slice(0, STAMP_LEN)
}

/**
 * Tag encoded in a backup filename `<stamp>-<tag>.db`. The stamp is a fixed-width ISO
 * timestamp (itself full of hyphens), so the tag is everything after it — not just the
 * segment after the last '-', since tags like 'pre-tally-import' contain hyphens too.
 */
export function tagOf(file: string): string {
  const stem = file.endsWith('.db') ? file.slice(0, -3) : file
  if (stem.length > STAMP_LEN + 1 && stem[STAMP_LEN] === '-') return stem.slice(STAMP_LEN + 1)
  // Fallback for anything that doesn't match the expected shape.
  const idx = stem.lastIndexOf('-')
  return idx === -1 ? stem : stem.slice(idx + 1)
}

/**
 * Live (WAL-safe) snapshot of an open database into `dest`, using better-sqlite3's native
 * online backup API. Captures uncheckpointed WAL content, unlike a raw file copy.
 */
export async function snapshotTo(db: DB, dest: string): Promise<void> {
  await db.backup(dest)
}

/**
 * Synchronous WAL-safe snapshot via `VACUUM INTO`. Used where we can't await (e.g. the
 * before-quit handler) or want a compacted copy (encrypted export).
 * VACUUM INTO cannot take a bound parameter in all better-sqlite3/SQLite builds, so the
 * destination path is escaped and inlined.
 */
export function snapshotSync(db: DB, dest: string): void {
  const escaped = dest.replace(/'/g, "''")
  db.exec(`VACUUM INTO '${escaped}'`)
}

/** List *.db backups in `dir`, newest first. */
export function listBackupsIn(dir: string): BackupInfo[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((f) => f.endsWith('.db'))
    .map((f) => {
      const st = statSync(join(dir, f))
      return { file: basename(f), sizeBytes: st.size, mtime: st.mtimeMs, tag: tagOf(f) }
    })
    .sort((a, b) => b.mtime - a.mtime)
}

/** Tags that are safe to prune once there are more than `keep` of them (newest kept). */
const PRUNABLE_TAGS = new Set(['auto', 'open'])

/**
 * Prune old backups in `dir`, keeping the newest `keep` files overall but only ever deleting
 * files tagged 'auto' or 'open'. Manual / pre-restore / pre-tally-import / quit snapshots are
 * never pruned automatically.
 */
export function pruneBackupsIn(dir: string, keep: number): void {
  const all = listBackupsIn(dir)
  let kept = 0
  for (const b of all) {
    if (kept < keep) {
      kept++
      continue
    }
    if (PRUNABLE_TAGS.has(b.tag)) {
      unlinkSync(join(dir, b.file))
    }
  }
}
