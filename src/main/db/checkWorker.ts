// WP 7.1 — SQLite's whole-file checks (PRAGMA quick_check / integrity_check) off the main thread:
// a worker_threads entry built as out/main/checkWorker.js. Each message opens the file read-only
// on its own connection, runs the pragma and closes — the same check the main connection would
// run, reading the same committed pages, while main keeps answering the renderer. checkHost.ts
// runs it in-process where the worker file does not exist (dbtests, the CLI).
//
// WP 7.2 follow-up: a 'verify' job runs the whole restore check of a backup here
// (services/backupVerify.ts verifyBackupFile: copy into the scratch folder main made, open with the
// key main sent, quick_check, migrate the COPY, audit chain, company row, trial balance) and
// answers with the BackupCheck. It never opens the company file: main records the verdict
// (backup_runs + audit). Built by scripts/build-check-worker.mjs as one self-contained file —
// no Electron, no AI / MCP code (checkWorkerBundle.test.ts).
import { parentPort } from 'worker_threads'
import { openForCheck, runPragmaCheck, type CheckJob } from './checkHost'
import type * as BackupVerify from '../services/backupVerify'

// Loaded on the first 'verify' job only: the open-time quick_check (a 'pragma' job, awaited by
// company:open) does not pay for evaluating the migrations / reports code it never runs.
let verifyModule: typeof BackupVerify | null = null
const backupVerify = (): typeof BackupVerify => (verifyModule ??= require('../services/backupVerify') as typeof BackupVerify)

const run = (job: CheckJob): unknown => {
  if (job.kind === 'verify') {
    if (job.keyHex !== null && !/^[0-9a-f]{64}$/.test(job.keyHex)) throw new Error('bad key')
    const key = job.keyHex ? Buffer.from(job.keyHex, 'hex') : null
    try {
      return backupVerify().verifyBackupFile(job.path, { key, asOn: job.asOn, now: new Date(job.nowIso), scratchRoot: job.scratchRoot })
    } finally {
      // The copy's connection is closed by now; no copy of the raw key outlives the job.
      key?.fill(0)
    }
  }
  const db = openForCheck(job.path, job.keyHex ?? null)
  try {
    return runPragmaCheck(db, job.pragma)
  } finally {
    db.close()
  }
}

parentPort?.on('message', (msg: CheckJob & { id: number }) => {
  try {
    parentPort!.postMessage({ id: msg.id, ok: true, result: run(msg) })
  } catch (err) {
    parentPort!.postMessage({ id: msg.id, ok: false, error: err instanceof Error ? err.message : String(err) })
  }
})
