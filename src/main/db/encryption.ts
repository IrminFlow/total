// WP 7.2 — company database encryption at rest (docs/security/encryption-at-rest.md).
//
// The driver is better-sqlite3-multiple-ciphers (the better-sqlite3 API over SQLite3 Multiple
// Ciphers). An encrypted company file uses the SQLCipher v4 scheme (`cipher = 'sqlcipher'`,
// `legacy = 4`: AES-256-CBC pages with HMAC-SHA512) under a RAW 32-byte key, so no KDF runs on
// open — the passphrase KDF happens once, when the key is unwrapped (keyEnvelope.ts).
//
// Every company / backup file in main is opened through `openDb`, which tells an encrypted file
// from a plaintext one by its header and finds the key the session unlocked for its folder
// (`rememberFolderKey`). A plaintext file opens exactly as it always did — no key, no pragma.
//
// Electron-free (dbtest-able); the key map lives only in this process's memory.
import Database from 'better-sqlite3-multiple-ciphers'
import { closeSync, existsSync, openSync, readSync, rmSync, statSync } from 'fs'
import { resolve, sep } from 'path'
import { AppError } from '@shared/errors'
import { e2eClockOffsetMs } from '@shared/e2eClock'

type DB = Database.Database

/** The first 16 bytes of every plaintext SQLite database file. */
const SQLITE_HEADER = Buffer.from('SQLite format 3\u0000', 'latin1')

/** True when `path` is a non-empty file that does not start with the SQLite header — i.e. an
 *  encrypted database (SQLCipher puts a random salt there). A missing or empty file is not. */
export function isEncryptedFile(path: string): boolean {
  let fd: number
  try {
    if (!existsSync(path) || statSync(path).size === 0) return false
    fd = openSync(path, 'r')
  } catch {
    return false
  }
  try {
    const head = Buffer.alloc(16)
    const n = readSync(fd, head, 0, 16, 0)
    return n === 16 && !head.equals(SQLITE_HEADER)
  } finally {
    closeSync(fd)
  }
}

const handleKeys = new WeakMap<DB, Buffer>()
const folderKeys = new Map<string, Buffer>()

const keyPragma = (key: Buffer): string => `"x'${key.toString('hex')}'"`

function cipherPragmas(db: DB): void {
  db.pragma("cipher = 'sqlcipher'")
  db.pragma('legacy = 4')
}

/** Key an open (not yet read) connection. Throws `wrong_passphrase`-style AppError if the key does
 *  not open the file. */
export function applyKey(db: DB, key: Buffer): void {
  cipherPragmas(db)
  db.exec(`PRAGMA key = ${keyPragma(key)}`)
  try {
    db.prepare('SELECT count(*) FROM sqlite_master').get()
  } catch {
    throw new AppError('db_key_mismatch', 'The key does not open this database')
  }
  handleKeys.set(db, key)
}

/** The key a connection was opened with, or null for a plaintext one. */
export function keyOfHandle(db: DB): Buffer | null {
  return handleKeys.get(db) ?? null
}

/** Remember the unlocked key of a company folder for this session (company file, its backups,
 *  temporary copies the app makes inside it). */
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

export interface OpenDbOptions {
  readonly?: boolean
  fileMustExist?: boolean
  /** Use this key (null = the file must be plaintext). Omitted = find it by folder. */
  key?: Buffer | null
}

/**
 * Open a database file. Plaintext → exactly `new Database(path, opts)`. Encrypted → keyed with
 * the given key or the folder's remembered one; without one, refused with `db_locked` (the
 * caller asks for the passphrase) — never opened as if it were empty.
 */
export function openDb(path: string, opts: OpenDbOptions = {}): DB {
  const encrypted = isEncryptedFile(path)
  const key = opts.key !== undefined ? opts.key : encrypted ? keyForPath(path) : null
  if (encrypted && !key) {
    throw new AppError('db_locked', 'This business is locked with a passphrase — unlock it first')
  }
  const db = new Database(path, {
    ...(opts.readonly ? { readonly: true } : {}),
    ...(opts.fileMustExist ? { fileMustExist: true } : {})
  })
  if (key && encrypted) {
    try {
      applyKey(db, key)
    } catch (err) {
      db.close()
      throw err
    }
  }
  installE2eSqlClock(db)
  return db
}

/** Scripted runs only (TOTAL_E2E_TODAY, shared/e2eClock.ts): SQLite's own 'now' — column defaults
 *  such as vouchers.created_at, `datetime('now')` in updates — reads the REAL clock, so with a
 *  shifted JS clock the books would be half-shifted (back-dated findings compare created_at with the
 *  audit trail's shifted times). The date functions are overridden on this connection to read
 *  'now' (or no time value) as the shifted instant and hand everything else to SQLite's own
 *  function on a private connection. Without a shift nothing is registered. */
const SQL_DATE_FUNCTIONS = ['datetime', 'date', 'time', 'julianday', 'unixepoch', 'strftime'] as const
let sqlClockHelper: DB | null = null
function installE2eSqlClock(db: DB): void {
  const offset = e2eClockOffsetMs()
  if (offset == null) return
  const helper = (sqlClockHelper ??= new Database(':memory:'))
  const nowText = (): string => new Date(Date.now()).toISOString().slice(0, 23).replace('T', ' ')
  for (const name of SQL_DATE_FUNCTIONS) {
    const statements = new Map<number, Database.Statement>()
    db.function(name, { varargs: true, deterministic: false }, (...args: unknown[]) => {
      const timeAt = name === 'strftime' ? 1 : 0
      const fixed = args.map((a) => (typeof a === 'string' && a.trim().toLowerCase() === 'now' ? nowText() : a))
      if (fixed.length === timeAt) fixed.push(nowText()) // datetime() / strftime('%Y') = now
      let st = statements.get(fixed.length)
      if (!st) {
        st = helper.prepare(`SELECT ${name}(${fixed.map(() => '?').join(', ')})`).pluck()
        statements.set(fixed.length, st)
      }
      return st.get(...fixed) as string | number | null
    })
  }
}

/** Remove a database file and its WAL / SHM siblings. */
export function removeDbFiles(path: string): void {
  for (const p of [path, `${path}-wal`, `${path}-shm`, `${path}-journal`]) rmSync(p, { force: true })
}

function vacuumInto(db: DB, dest: string): void {
  db.exec(`VACUUM INTO '${dest.replace(/'/g, "''")}'`)
}

/** Change the key of a CLOSED database file in place (null = plaintext). SQLite3MC refuses to
 *  rekey in WAL mode, so the file is switched to DELETE first; the next open turns WAL back on. */
export function rekeyFile(path: string, from: Buffer | null, to: Buffer | null): void {
  const db = new Database(path, { fileMustExist: true })
  try {
    if (from) applyKey(db, from)
    db.pragma('journal_mode = DELETE')
    cipherPragmas(db)
    db.exec(`PRAGMA rekey = ${to ? keyPragma(to) : "''"}`)
  } finally {
    db.close()
  }
}

/**
 * A compacted copy of an open database at `dest`, encrypted with `to` (null = plaintext).
 * `VACUUM INTO` writes the copy with the source's own key, then the copy is rekeyed if that differs.
 * Works for a live WAL database (uncheckpointed pages included).
 */
export function copyWithKey(db: DB, dest: string, to: Buffer | null): void {
  removeDbFiles(dest)
  vacuumInto(db, dest)
  const from = keyOfHandle(db)
  const same = from && to ? from.equals(to) : !from && !to
  if (!same) {
    try {
      rekeyFile(dest, from, to)
    } catch (err) {
      removeDbFiles(dest)
      throw err
    }
  }
}

/** A plaintext copy (encrypted export, which wraps the whole file under its own passphrase). */
export function plainCopy(db: DB, dest: string): void {
  copyWithKey(db, dest, null)
}
