// WP 7.1 — whole-file SQLite checks without blocking the main process. In the built app
// `pragmaCheck` runs in a worker thread (out/main/checkWorker.js, its own read-only connection);
// where that file does not exist (dbtests and the CLI run the sources) it runs in-process on a
// read-only connection of its own — the same check, the same answer, only on this thread.
// Self-contained on purpose: the worker imports runPragmaCheck from here.
import { existsSync } from 'fs'
import { join } from 'path'
import { Worker } from 'worker_threads'
import Database from 'better-sqlite3-multiple-ciphers'

export type CheckPragma = 'quick_check' | 'integrity_check'

/** mmap_size for company connections (db/connection.ts) and these checks: SQLite's default
 *  compile-time ceiling (SQLITE_MAX_MMAP_SIZE, 0x7fff0000 ≈ 2 GB). */
export const MMAP_SIZE = 0x7fff0000

/** A read-only connection for a whole-file check, memory-mapped like the app's own. WP 7.2: an
 *  encrypted file (a business locked with a passphrase) is keyed with `keyHex` — the key the main
 *  thread remembered for its folder, handed to the worker with the message (never stored). */
function openForCheck(path: string, keyHex: string | null = null): Database.Database {
  const db = new Database(path, { readonly: true, fileMustExist: true })
  if (keyHex) {
    if (!/^[0-9a-f]{64}$/.test(keyHex)) {
      db.close()
      throw new Error('bad key')
    }
    db.pragma("cipher = 'sqlcipher'")
    db.pragma('legacy = 4')
    db.exec(`PRAGMA key = "x'${keyHex}'"`)
  }
  db.pragma(`mmap_size = ${MMAP_SIZE}`)
  return db
}

/** The pragma's first result row ('ok' when the file is sound). */
export { openForCheck }

export function runPragmaCheck(db: Database.Database, pragma: CheckPragma): string {
  const rows = db.pragma(pragma) as Record<string, string>[]
  return rows[0]?.[pragma] ?? 'no result'
}

// The bundler may put this module in out/main/ or in a shared chunk under out/main/chunks/.
let workerOverride: string | null | undefined
/** Tests: run the checks with this worker file (null = in-process; undefined = the built one). */
export function setCheckWorkerFile(file: string | null | undefined): void {
  workerOverride = file
}
const workerFile = (): string | null => {
  if (workerOverride !== undefined) return workerOverride
  for (const f of [join(__dirname, 'checkWorker.js'), join(__dirname, '..', 'checkWorker.js')]) if (existsSync(f)) return f
  return null
}

let seq = 0

/** Workers still running a check, by database path (stopChecks). */
const running = new Map<string, Set<Worker>>()
const stopped = new WeakSet<Worker>()

/** The rejection of a check stopped by stopChecks — not a finding about the file. */
export class CheckStoppedError extends Error {
  constructor() {
    super('check stopped: the file is being replaced or removed')
    this.name = 'CheckStoppedError'
  }
}

/** The rejection of a check that ran past its `timeoutMs` (the worker is terminated). */
export class CheckTimeoutError extends Error {
  constructor(ms: number) {
    super(`check timed out after ${ms} ms`)
    this.name = 'CheckTimeoutError'
  }
}

export interface PragmaCheckOptions {
  /** Reject with CheckTimeoutError (and terminate the worker) when no answer comes in this many
   *  ms. Absent = no limit (the weekly integrity_check, backup verification). Applies to the
   *  worker only: the in-process fallback (dbtests, the CLI) is synchronous and runs to the end. */
  timeoutMs?: number
}

/** Run `PRAGMA <pragma>` on the database file at `path` (read-only). Rejects when the file
 *  cannot be opened, the pragma throws, the worker dies (an 'error' or an exit without an
 *  answer — never a promise that hangs company:open), the check is stopped (stopChecks) or it
 *  runs past `opts.timeoutMs` — callers decide what a failure means, as before. */
export async function pragmaCheck(path: string, pragma: CheckPragma, key?: Buffer | null, opts: PragmaCheckOptions = {}): Promise<string> {
  // WP 7.2: the caller passes the key of an encrypted file (its handle's — keyOfHandle); the
  // worker bundle stays self-contained (no key map, no app modules).
  const keyHex = key ? key.toString('hex') : null
  const file = workerFile()
  if (!file) {
    const db = openForCheck(path, keyHex)
    try {
      return runPragmaCheck(db, pragma)
    } finally {
      db.close()
    }
  }
  const worker = new Worker(file)
  const set = running.get(path) ?? new Set<Worker>()
  set.add(worker)
  running.set(path, set)
  const id = ++seq
  let timer: NodeJS.Timeout | undefined
  try {
    return await new Promise<string>((resolve, reject) => {
      if (opts.timeoutMs !== undefined) {
        const ms = opts.timeoutMs
        timer = setTimeout(() => reject(new CheckTimeoutError(ms)), ms)
      }
      worker.once('error', reject)
      worker.once('exit', (code) => reject(stopped.has(worker) ? new CheckStoppedError() : new Error(`check worker exited (${code}) before answering`)))
      worker.on('message', (m: { id: number; ok: boolean; result?: string; error?: string }) => {
        if (m.id !== id) return
        if (m.ok) resolve(m.result!)
        else reject(new Error(m.error ?? 'check failed'))
      })
      worker.postMessage({ id, path, pragma, keyHex })
    })
  } finally {
    if (timer) clearTimeout(timer)
    set.delete(worker)
    if (set.size === 0 && running.get(path) === set) running.delete(path)
    void worker.terminate()
  }
}

/** Stop every check still reading the file at `path` and wait until their threads are gone (their
 *  read-only connections closed with them). Call before the file is replaced or removed (restore,
 *  delete): on Windows an open handle refuses the rename / unlink (EPERM / EBUSY). The stopped
 *  checks reject; their callers treat that as a failed check of a file that is going away. */
export async function stopChecks(path: string): Promise<void> {
  const set = running.get(path)
  if (!set) return
  await Promise.all(
    [...set].map((w) => {
      stopped.add(w)
      return w.terminate().catch(() => undefined)
    })
  )
}

/** How many checks are reading `path` right now (tests). */
export const runningChecks = (path: string): number => running.get(path)?.size ?? 0

/** quickCheckOk (db/backup.ts) off the main thread: true iff the file opens read-only and passes
 *  quick_check. Never throws. */
export async function quickCheckOkAsync(path: string, key?: Buffer | null): Promise<boolean> {
  try {
    return (await pragmaCheck(path, 'quick_check', key)) === 'ok'
  } catch {
    return false
  }
}
