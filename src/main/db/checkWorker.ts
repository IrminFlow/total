// WP 7.1 — SQLite's whole-file checks (PRAGMA quick_check / integrity_check) off the main thread:
// a worker_threads entry built as out/main/checkWorker.js. Each message opens the file read-only
// on its own connection, runs the pragma and closes — the same check the main connection would
// run, reading the same committed pages, while main keeps answering the renderer. checkHost.ts
// runs it in-process where the worker file does not exist (dbtests, the CLI).
import { parentPort } from 'worker_threads'
import { openForCheck, runPragmaCheck, type CheckPragma } from './checkHost'

parentPort?.on('message', (msg: { id: number; path: string; pragma: CheckPragma }) => {
  try {
    const db = openForCheck(msg.path)
    try {
      parentPort!.postMessage({ id: msg.id, ok: true, result: runPragmaCheck(db, msg.pragma) })
    } finally {
      db.close()
    }
  } catch (err) {
    parentPort!.postMessage({ id: msg.id, ok: false, error: err instanceof Error ? err.message : String(err) })
  }
})
