// Electron-free integrity check (dbtest-able; DB is opened by the caller with the Electron ABI).
import type { DB } from './connection'
import { pragmaCheck } from './checkHost'
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

/**
 * checkIntegrity with the quick_check on its own read-only connection in a worker thread
 * (db/checkHost.ts; WP 7.1 — company:open) while the balance query runs here: the same two checks
 * and the same result, without holding the main process for the whole-file scan. `path` is the
 * database file of `db`. If the worker cannot run the check, it runs on `db` as before.
 */
export async function checkIntegrityAsync(db: DB, path: string): Promise<IntegrityResult> {
  const quick = pragmaCheck(path, 'quick_check', keyOfHandle(db)).catch(() => db.pragma('quick_check', { simple: true }) as string)
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
  return { ok: quickCheck === 'ok' && unbalancedVoucherIds.length === 0, quickCheck, unbalancedVoucherIds }
}
