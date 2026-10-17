// WP 7.2 — the company keys unlocked this session, by folder. Split out of db/encryption.ts (which
// re-exports it) so modules that never open a database — the encrypted file store
// (db/fileCrypto.ts users: attachments, capture files) — can find a folder's key without loading
// the native driver. Lives only in this process's memory.
import { resolve, sep } from 'path'

const folderKeys = new Map<string, Buffer>()

/** Remember the unlocked key of a company folder for this session (company file, its backups,
 *  temporary copies the app makes inside it, its attachment and capture stores). */
export function rememberFolderKey(dir: string, key: Buffer): void {
  folderKeys.set(resolve(dir), Buffer.from(key))
}

export function forgetFolderKey(dir: string): void {
  folderKeys.delete(resolve(dir))
}

export function forgetAllKeys(): void {
  folderKeys.clear()
}

/** The remembered key of the folder that contains `path`, or null. */
export function keyForPath(path: string): Buffer | null {
  const abs = resolve(path)
  let best: { len: number; key: Buffer } | null = null
  for (const [dir, key] of folderKeys) {
    if ((abs === dir || abs.startsWith(dir + sep)) && (!best || dir.length > best.len)) best = { len: dir.length, key }
  }
  return best?.key ?? null
}
