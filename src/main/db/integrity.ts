// Electron-free integrity check (dbtest-able; DB is opened by the caller with the Electron ABI).
import type { DB } from './connection'
import { CheckTimeoutError, pragmaCheck } from './checkHost'
import { keyOfHandle } from './encryption'

export interface IntegrityResult {
  ok: boolean
  quickCheck: string
  unbalancedVoucherIds: number[]
}

/**
 * `PRAGMA quick_check` plus a per-voucher debit/credit balance check across ALL voucher_lines
 * (no deleted_at filter — binned vouchers must balance too). Returns up to 10 offending voucher
 * ids. `ok` is true only when quick_check reports 'ok' and no voucher is unbalanced.
 *
 * Never throws: on exactly the corruption this feature exists to detect, the balance query
 * itself can throw (e.g. SqliteError 'database disk image is malformed') reading real table
 * pages after quick_check already ran clean. That's reported as a failed check, not an
 * exception, so callers can always safely treat this as non-blocking.
 */
export function checkIntegrity(db: DB): IntegrityResult {
  const quickCheck = db.pragma('quick_check', { simple: true }) as string

  try {
    const rows = db
      .prepare(
        `SELECT voucher_id AS id
         FROM voucher_lines
         GROUP BY voucher_id
         HAVING SUM(CASE WHEN dr_cr = 'dr' THEN amount ELSE -amount END) <> 0
         LIMIT 10`
      )
      .all() as { id: number }[]
    const unbalancedVoucherIds = rows.map((r) => r.id)

    return {
      ok: quickCheck === 'ok' && unbalancedVoucherIds.length === 0,
      quickCheck,
      unbalancedVoucherIds
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return { ok: false, quickCheck: `error: ${message}`, unbalancedVoucherIds: [] }
  }
}

/** How long company:open waits for its worker quick_check (checkIntegrityAsync) before it goes
 *  on without it. A quick_check of a sound file takes well under a second at 100k vouchers
 *  (docs/perf-budgets.md); one that runs a minute is a slow disk or a huge file, and the open must
 *  not wait on it for ever. The weekly integrity_check and backup verification have no limit. */
export const OPEN_QUICK_CHECK_TIMEOUT_MS = 60_000

/** IntegrityResult.quickCheck when the open-time quick_check ran past its timeout. */
export const QUICK_CHECK_TIMED_OUT = 'not checked (timed out)'

/**
 * checkIntegrity with the quick_check on its own read-only connection in a worker thread
 * (db/checkHost.ts; WP 7.1 — company:open) while the balance query runs here: the same two checks
 * and the same result, without holding the main process for the whole-file scan. `path` is the
 * database file of `db`. If the worker cannot run the check, it runs on `db` as before.
 *
 * A worker that has not answered within `timeoutMs` (default OPEN_QUICK_CHECK_TIMEOUT_MS) is
 * told to terminate (its thread exits once SQLite returns; stopChecks still waits for it) and the
 * quick_check is reported as QUICK_CHECK_TIMED_OUT — not run again on `db`
 * (that would block the main process on the same slow scan). A file that was not checked is not
 * a file found damaged: `ok` then rests on the balance check alone, and the caller logs it.
 */
export async function checkIntegrityAsync(db: DB, path: string, opts: { timeoutMs?: number } = {}): Promise<IntegrityResult> {
  const timeoutMs = opts.timeoutMs ?? OPEN_QUICK_CHECK_TIMEOUT_MS
  let timedOut = false
  const quick = pragmaCheck(path, 'quick_check', keyOfHandle(db), { timeoutMs }).catch((err: unknown) => {
    if (err instanceof CheckTimeoutError) {
      timedOut = true
      return QUICK_CHECK_TIMED_OUT
    }
    return db.pragma('quick_check', { simple: true }) as string
  })
  let unbalancedVoucherIds: number[] = []
  let balanceError: string | null = null
  try {
    unbalancedVoucherIds = (db
      .prepare(
        `SELECT voucher_id AS id
         FROM voucher_lines
         GROUP BY voucher_id
         HAVING SUM(CASE WHEN dr_cr = 'dr' THEN amount ELSE -amount END) <> 0
         LIMIT 10`
      )
      .all() as { id: number }[]).map((r) => r.id)
  } catch (err) {
    balanceError = err instanceof Error ? err.message : String(err)
  }
  const quickCheck = await quick
  if (balanceError !== null) return { ok: false, quickCheck: `error: ${balanceError}`, unbalancedVoucherIds: [] }
  return { ok: (timedOut || quickCheck === 'ok') && unbalancedVoucherIds.length === 0, quickCheck, unbalancedVoucherIds }
}
