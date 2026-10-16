// WP 7.1 — whole-file SQLite checks without blocking the main process. In the built app
// `pragmaCheck` runs in a worker thread (out/main/checkWorker.js, its own read-only connection);
// where that file does not exist (dbtests and the CLI run the sources) it runs in-process on a
// read-only connection of its own — the same check, the same answer, only on this thread.
// Self-contained on purpose: the worker imports runPragmaCheck from here.
// The restore check of a backup (services/backupVerify.ts) runs in the same worker — a 'verify' job
// (runCheckJob); the worker file is built on its own (scripts/build-check-worker.mjs) so it carries
// the migrations / audit / trial-balance code without a shared chunk that needs Electron.
import { existsSync } from 'fs'
import { join, resolve, sep } from 'path'
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
/** The built worker file, or null where there is none (dbtests, the CLI: run in-process). */
export const checkWorkerFile = (): string | null => {
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
  /** Reject with CheckTimeoutError when no answer comes in this many ms, and ask the worker to
   *  terminate — it exits once the native pragma returns (terminate cannot interrupt it) and
   *  stays visible to stopChecks until then. Absent = no limit (the weekly integrity_check,
   *  backup verification). Applies to the worker only: the in-process fallback (dbtests, the
   *  CLI) is synchronous and runs to the end. */
  timeoutMs?: number
}

/** Run `PRAGMA <pragma>` on the database file at `path` (read-only). Rejects when the file
 *  cannot be opened, the pragma throws, the worker dies (an 'error' or an exit without an
 *  answer — never a promise that hangs company:open), the check is stopped (stopChecks) or it
 *  runs past `opts.timeoutMs` — callers decide what a failure means, as before. */
export async function pragmaCheck(path: string, pragma: CheckPragma, key?: Buffer | null, opts: PragmaCheckOptions = {}): Promise<string> {
  // WP 7.2: the caller passes the key of an encrypted file (its handle's — keyOfHandle); the
  // worker holds no key map of its own.
  const keyHex = key ? key.toString('hex') : null
  const file = checkWorkerFile()
  if (!file) {
    const db = openForCheck(path, keyHex)
    try {
      return runPragmaCheck(db, pragma)
    } finally {
      db.close()
    }
  }
  return runCheckJob<string>(file, { kind: 'pragma', path, pragma, keyHex }, { timeoutMs: opts.timeoutMs })
}

/** A job for the check worker: a pragma on a file, or the whole restore check of a backup
 *  (services/backupVerify.ts verifyBackupFile, run on the worker's own connections). */
export type CheckJob =
  | { kind: 'pragma'; path: string; pragma: CheckPragma; keyHex: string | null }
  | { kind: 'verify'; path: string; keyHex: string | null; asOn: string; nowIso: string; scratchRoot: string }

export type CheckJobOptions = PragmaCheckOptions

/** Run `job` in a fresh worker on `file`; the answer, or a rejection when the job fails, the
 *  worker dies (an 'error' or an exit without an answer), it is stopped (CheckStoppedError) or it
 *  runs past `opts.timeoutMs` (CheckTimeoutError). */
export async function runCheckJob<T>(file: string, job: CheckJob, opts: CheckJobOptions = {}): Promise<T> {
  const worker = new Worker(file)
  // Tracked under the file it reads only. A restore check of a backup is NOT tracked under the live
  // company file: it never opens it (it reads the backup, then its own scratch copy), so a
  // backup:restore — stopChecks(live file) — does not stop or wait for it (on Windows a long verify
  // would stall the restore, the #118 timing problem); delete / passphrase change, which remove or
  // rewrite the backups themselves, stop it through stopChecksUnder(folder).
  const set = running.get(job.path) ?? new Set<Worker>()
  set.add(worker)
  running.set(job.path, set)
  const id = ++seq
  let timer: NodeJS.Timeout | undefined
  // A worker leaves `running` once it can no longer be reading the file: when it has answered
  // (its connection is closed), else only when its thread has exited. terminate() does not
  // interrupt a pragma already running in native code — a timed-out quick_check keeps reading
  // until SQLite returns — so stopChecks (restore / delete) must still see it and wait for it.
  let answered = false
  const untrack = (): void => {
    set.delete(worker)
    if (set.size === 0 && running.get(job.path) === set) running.delete(job.path)
  }
  worker.once('exit', () => untrack())
  try {
    return await new Promise<T>((resolve, reject) => {
      if (opts.timeoutMs !== undefined) {
        const ms = opts.timeoutMs
        timer = setTimeout(() => reject(new CheckTimeoutError(ms)), ms)
      }
      worker.once('error', reject)
      worker.once('exit', (code) => reject(stopped.has(worker) ? new CheckStoppedError() : new Error(`check worker exited (${code}) before answering`)))
      worker.on('message', (m: { id: number; ok: boolean; result?: T; error?: string }) => {
        if (m.id !== id) return
        answered = true
        if (m.ok) resolve(m.result as T)
        else reject(new Error(m.error ?? 'check failed'))
      })
      worker.postMessage({ id, ...job })
    })
  } finally {
    if (timer) clearTimeout(timer)
    if (answered) untrack()
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

/** Stop every check of every file (a data-folder move copies the whole folder: a backup check
 *  still reading — or creating a `-shm` beside — a file there would make the copy differ). This
 *  includes the restore checks ('verify' jobs), tracked under the backup they read. */
export async function stopAllChecks(): Promise<void> {
  await Promise.all([...running.keys()].map((path) => stopChecks(path)))
}

/** stopChecks for every file inside `dir` (the company folder on delete, the backups folder before
 *  a passphrase change rewrites every backup): the restore checks reading its backups included. */
export async function stopChecksUnder(dir: string): Promise<void> {
  const root = resolve(dir)
  const inside = [...running.keys()].filter((p) => {
    const abs = resolve(p)
    return abs === root || abs.startsWith(root + sep)
  })
  await Promise.all(inside.map((p) => stopChecks(p)))
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
