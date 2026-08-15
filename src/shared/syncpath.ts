/**
 * Pure string-only check for whether a path lives inside a folder synced by a
 * third-party cloud-sync client (Dropbox, OneDrive, Google Drive, iCloud, etc).
 * SQLite databases under active sync can corrupt on concurrent writes from
 * multiple machines, so callers warn the user once per session when this hits.
 *
 * Zero imports so this can be unit-tested with plain vitest (no Electron).
 */

const SYNC_MARKERS = [
  'dropbox',
  'onedrive',
  'google drive',
  'googledrive',
  'mobile documents',
  'com~apple~clouddocs',
  'icloud',
  'box sync',
  'sync.com'
]

/** Returns the matched marker (lowercase) if `root` looks like a synced folder, else null. */
export function syncFolderWarning(root: string): string | null {
  const lower = root.toLowerCase()
  for (const marker of SYNC_MARKERS) {
    if (lower.includes(marker)) return marker
  }
  return null
}
