// WP 7.1 — whole-file SQLite checks without blocking the main process. In the built app
// `pragmaCheck` runs in a worker thread (out/main/checkWorker.js, its own read-only connection);
// where that file does not exist (dbtests and the CLI run the sources) it runs in-process on a
// read-only connection of its own — the same check, the same answer, only on this thread.
// Self-contained on purpose: the worker imports runPragmaCheck from here.
import { existsSync } from 'fs'
import { join } from 'path'
import { Worker } from 'worker_threads'
import Database from 'better-sqlite3'

export type CheckPragma = 'quick_check' | 'integrity_check'

/** The pragma's first result row ('ok' when the file is sound). */
export function runPragmaCheck(db: Database.Database, pragma: CheckPragma): string {
  const rows = db.pragma(pragma) as Record<string, string>[]
  return rows[0]?.[pragma] ?? 'no result'
}

// The bundler may put this module in out/main/ or in a shared chunk under out/main/chunks/.
const workerFile = (): string | null => {
  for (const f of [join(__dirname, 'checkWorker.js'), join(__dirname, '..', 'checkWorker.js')]) if (existsSync(f)) return f
  return null
}

let seq = 0

/** Run `PRAGMA <pragma>` on the database file at `path` (read-only). Rejects when the file
 *  cannot be opened or the pragma throws — callers decide what a failure means, as before. */
export async function pragmaCheck(path: string, pragma: CheckPragma): Promise<string> {
  const file = workerFile()
  if (!file) {
    const db = new Database(path, { readonly: true, fileMustExist: true })
    try {
      return runPragmaCheck(db, pragma)
    } finally {
      db.close()
    }
  }
  const worker = new Worker(file)
  const id = ++seq
  try {
    return await new Promise<string>((resolve, reject) => {
      worker.once('error', reject)
      worker.on('message', (m: { id: number; ok: boolean; result?: string; error?: string }) => {
        if (m.id !== id) return
        if (m.ok) resolve(m.result!)
        else reject(new Error(m.error ?? 'check failed'))
      })
      worker.postMessage({ id, path, pragma })
    })
  } finally {
    void worker.terminate()
  }
}

/** quickCheckOk (db/backup.ts) off the main thread: true iff the file opens read-only and passes
 *  quick_check. Never throws. */
export async function quickCheckOkAsync(path: string): Promise<boolean> {
  try {
    return (await pragmaCheck(path, 'quick_check')) === 'ok'
  } catch {
    return false
  }
}
