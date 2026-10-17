import { createHash } from 'crypto'
import type { DB } from '../db/connection'
import type { CompanyInfo } from '@shared/domain'
import { addDaysISO, fyFromStartYear, fyOf } from '@shared/dates'
import {
  diffCloseNets,
  expectedCloseNets,
  type CloseRepairPreview,
  type CloseRepairYear
} from '@shared/yearEnd'
import { deleteVoucher, getLockDate, setLockDate, NOT_DELETED } from './vouchers'
import { writeAudit } from './audit'
import { booksFromYear } from './booksStart'
import { closePreview, postClose } from './yearEnd'

/**
 * Guided re-close (to-do §4, the 0.4.0 → 0.5.0 upgrade note).
 *
 * 0.4.0's close netted each income / expense ledger's FY MOVEMENTS only. Since WP 1.3 (0.5.0)
 * profit for the books' first FY includes the ledgers' stored opening balances
 * (`pnlLedgerAmounts`, @shared/yearOpening), so a first-FY close posted by 0.4.0 left those
 * openings in the P&L ledgers: every later trial balance shows them as the computed
 * "Profit & Loss A/c (opening)" row, and Retained Earnings is short by the same amount. (A 0.4.0
 * close built on a group whose nature migration 018 repaired either missed that group's ledgers
 * or zeroed a balance-sheet ledger; the same per-ledger comparison finds both.)
 *
 * `repairPreview` compares every live closing journal with the one `postClose` would post today
 * and writes nothing. `repairCloses` (owner) bins each differing journal through `deleteVoucher`
 * and posts the corrected one through `postClose` (dated the same 31 March, flagged
 * is_year_end_close, transfer on the same ledger) oldest year first, in ONE transaction, then
 * puts the lock date back where it was. Figures change only when the owner runs it.
 */

interface StoredLine { ledgerId: number; name: string; nature: string; net: number }

function storedClose(db: DB, fyStartYear: number): { id: number; number: string; date: string; lines: StoredLine[] } | null {
  const fy = fyFromStartYear(fyStartYear)
  const v = db
    .prepare(`SELECT v.id, v.number, v.date FROM vouchers v WHERE ${NOT_DELETED} AND v.is_year_end_close = 1 AND v.date BETWEEN ? AND ? ORDER BY v.id LIMIT 1`)
    .get(fy.from, fy.to) as { id: number; number: string; date: string } | undefined
  if (!v) return null
  const lines = db
    .prepare(
      `SELECT vl.ledger_id AS ledgerId, l.name AS name, g.nature AS nature,
              SUM(CASE WHEN vl.dr_cr = 'dr' THEN vl.amount ELSE -vl.amount END) AS net
         FROM voucher_lines vl JOIN ledgers l ON l.id = vl.ledger_id JOIN groups g ON g.id = l.group_id
        WHERE vl.voucher_id = ? GROUP BY vl.ledger_id ORDER BY vl.ledger_id`
    )
    .all(v.id) as StoredLine[]
  return { ...v, lines }
}

/** The ledger the stored journal carried the profit to. 0.4.0 always posted it to the ledger
 *  then named "Retained Earnings" (found or created under Reserves & Surplus, else Capital
 *  Account), so: its one balance-sheet ledger; with several (a 0.4.0 close that also zeroed a
 *  then-misnatured balance-sheet ledger) the one named Retained Earnings, else the ONE under
 *  Capital Account / Reserves & Surplus — never a guess (`ambiguous`: the year is then left alone,
 *  so a repair can never carry a year's profit to, say, Furniture). None → Retained Earnings by
 *  name (null id = created on repair). */
function transferOf(db: DB, lines: StoredLine[]): { id: number | null; name: string; ambiguous?: boolean } {
  const others = lines.filter((l) => l.nature !== 'income' && l.nature !== 'expense')
  if (others.length === 1) return { id: others[0]!.ledgerId, name: others[0]!.name }
  if (others.length > 1) {
    const named = others.find((l) => l.name.toLowerCase() === 'retained earnings')
    if (named) return { id: named.ledgerId, name: named.name }
    const equity = others.filter((l) => underEquity(db, l.ledgerId))
    if (equity.length === 1) return { id: equity[0]!.ledgerId, name: equity[0]!.name }
    return { id: null, name: 'Retained Earnings', ambiguous: true }
  }
  const re = db.prepare("SELECT id, name FROM ledgers WHERE name = 'Retained Earnings' COLLATE NOCASE").get() as { id: number; name: string } | undefined
  return re ? { id: re.id, name: re.name } : { id: null, name: 'Retained Earnings' }
}

/** True when the ledger's group is (or sits under) Capital Account / Reserves & Surplus. */
function underEquity(db: DB, ledgerId: number): boolean {
  return !!db
    .prepare(
      `WITH RECURSIVE up(id, parent_id, name) AS (
         SELECT g.id, g.parent_id, g.name FROM groups g JOIN ledgers l ON l.group_id = g.id WHERE l.id = ?
         UNION ALL SELECT g.id, g.parent_id, g.name FROM groups g JOIN up ON g.id = up.parent_id)
       SELECT 1 FROM up WHERE name IN ('Capital Account', 'Reserves & Surplus') LIMIT 1`
    )
    .get(ledgerId)
}

/** Sentinel id for a Retained Earnings ledger that does not exist yet (preview only). */
const NEW_TRANSFER = -1

function yearCheck(db: DB, fyStartYear: number, booksFrom: number): CloseRepairYear | null {
  const stored = storedClose(db, fyStartYear)
  if (!stored) return null
  const fy = fyFromStartYear(fyStartYear)
  const preview = closePreview(db, fyStartYear, booksFrom)
  const transfer = transferOf(db, stored.lines)
  const transferId = transfer.id ?? NEW_TRANSFER
  const expected = expectedCloseNets(preview.rows, transferId)
  const storedNets = new Map(stored.lines.map((l) => [l.ledgerId, l.net]))
  const names = new Map<number, string>([
    ...stored.lines.map((l) => [l.ledgerId, l.name] as [number, string]),
    ...preview.rows.map((r) => [r.ledgerId, r.name] as [number, string]),
    [transferId, transfer.name]
  ])
  const diffs = diffCloseNets(storedNets, expected).map((d) => ({
    ledgerId: d.ledgerId === NEW_TRANSFER ? null : d.ledgerId,
    name: names.get(d.ledgerId) ?? '',
    transfer: d.ledgerId === transferId,
    stored: d.stored,
    expected: d.expected
  }))
  // What stays in the P&L ledgers after the stored close: the year's amounts + the stored
  // journal's lines on income / expense ledgers.
  let residual = preview.rows.reduce((s, r) => s + r.net, 0)
  for (const l of stored.lines) if (l.nature === 'income' || l.nature === 'expense') residual += l.net
  const corrected = [...expected.entries()]
    .filter(([, net]) => net !== 0)
    .map(([id, net]) => ({
      ledgerId: id === NEW_TRANSFER ? null : id,
      name: names.get(id) ?? '',
      drCr: (net > 0 ? 'dr' : 'cr') as 'dr' | 'cr',
      amount: Math.abs(net)
    }))
    .sort((a, b) => (a.ledgerId === transferId ? 1 : 0) - (b.ledgerId === transferId ? 1 : 0) || a.name.localeCompare(b.name))
  const needsRepair = diffs.length > 0
  let blocked: string | null = null
  if (needsRepair && fyStartYear < booksFrom) blocked = `The books start in FY ${fyFromStartYear(booksFrom).label}, after this year`
  else if (needsRepair && transfer.ambiguous) {
    blocked = 'The closing entry carries amounts to several balance-sheet ledgers and Total can’t tell which one took the profit — repair it by hand (bin it, then close the year again)'
  } else if (needsRepair && corrected.length === 0) {
    blocked = 'Under today’s rule this year has no income or expense to close — move its closing entry to the bin to reopen the year'
  } else if (needsRepair && stored.date !== fy.to) blocked = `The closing entry is dated ${stored.date}, not ${fy.to}`
  return {
    fyStartYear, label: fy.label, voucherId: stored.id, voucherNumber: stored.number, date: stored.date,
    residual, needsRepair, blocked, diffs, corrected, netProfit: preview.netProfit
  }
}

/** Every closed FY (a live closing journal), oldest first, compared with today's rule. Read only. */
export function repairPreview(db: DB, booksFrom: number = booksFromYear(db)): CloseRepairPreview {
  const dates = db
    .prepare(`SELECT DISTINCT v.date FROM vouchers v WHERE ${NOT_DELETED} AND v.is_year_end_close = 1 ORDER BY v.date`)
    .all() as { date: string }[]
  const fys = [...new Set(dates.map((d) => fyOf(d.date).startYear))].sort((a, b) => a - b)
  const years = fys.map((y) => yearCheck(db, y, booksFrom)).filter((y): y is CloseRepairYear => y !== null)
  const lockDate = getLockDate(db)
  const fingerprint = createHash('sha256')
    .update(JSON.stringify({ lockDate, years: years.filter((y) => y.needsRepair).map((y) => [y.fyStartYear, y.voucherId, y.corrected, y.blocked]) }))
    .digest('hex')
  return { years, fingerprint, lockDate }
}

export interface RepairResult {
  repaired: { fyStartYear: number; oldVoucherId: number; voucherId: number; netProfit: number; residual: number }[]
  lockDate: string | null
}

/**
 * Re-close the years `repairPreview` flags, oldest first, in one transaction. `fingerprint` must
 * be the preview the owner was shown (anything changed since → refused, nothing written).
 * `fyStartYears` (optional) limits the run — but only to the OLDEST years needing repair: a later
 * year can't be repaired while an earlier one still differs. Nothing to repair → no write at all.
 */
export function repairCloses(
  db: DB,
  company: CompanyInfo,
  input: { fingerprint: string; fyStartYears?: number[] }
): RepairResult {
  const preview = repairPreview(db, company.booksFrom)
  if (preview.fingerprint !== input.fingerprint) {
    throw new Error('The books changed since you checked the closes — check again before repairing')
  }
  const todo = preview.years.filter((y) => y.needsRepair)
  const firstBlocked = todo.findIndex((y) => y.blocked)
  const runnable = firstBlocked === -1 ? todo : todo.slice(0, firstBlocked)
  let chosen = runnable
  if (input.fyStartYears) {
    const want = [...new Set(input.fyStartYears)].sort((a, b) => a - b)
    const prefix = todo.slice(0, want.length).map((y) => y.fyStartYear)
    if (want.some((y, i) => y !== prefix[i])) {
      const first = todo[0]
      throw new Error(
        first ? `Repair the earliest year first: FY ${first.label}` : 'None of these years needs repairing'
      )
    }
    chosen = runnable.slice(0, want.length)
    if (chosen.length < want.length) throw new Error(todo[chosen.length]?.blocked ?? 'This year can’t be repaired here')
  } else if (chosen.length === 0 && todo.length > 0) {
    throw new Error(todo[0]?.blocked ?? 'This year can’t be repaired here')
  }
  if (chosen.length === 0) return { repaired: [], lockDate: preview.lockDate }

  const lockBefore = preview.lockDate
  const run = db.transaction((): RepairResult['repaired'] => {
    // The close locked the books up to its own date and the bin refuses an entry inside the lock:
    // move the lock back to the day before the oldest repaired year starts (as the editor's Move
    // to Bin does, audited), and put it back afterwards.
    const oldest = chosen[0]!
    if (lockBefore && lockBefore >= oldest.date) setLockDate(db, addDaysISO(fyFromStartYear(oldest.fyStartYear).from, -1))
    const out: RepairResult['repaired'] = []
    for (const y of chosen) {
      const transferLedgerId = transferIdOf(db, y) // read while the old journal is still live
      deleteVoucher(db, y.voucherId)
      const posted = postClose(db, company, y.fyStartYear, transferLedgerId != null ? { transferLedgerId } : {})
      writeAudit(
        db, 'year_end', y.fyStartYear, 'update',
        { voucherId: y.voucherId, residual: y.residual },
        { voucherId: posted.voucherId, netProfit: posted.netProfit, repaired: true, diffs: y.diffs }
      )
      out.push({ fyStartYear: y.fyStartYear, oldVoucherId: y.voucherId, voucherId: posted.voucherId, netProfit: posted.netProfit, residual: y.residual })
    }
    if (getLockDate(db) !== lockBefore) setLockDate(db, lockBefore)
    // The tool's own promise: what it repaired now matches today's rule.
    const after = repairPreview(db, company.booksFrom)
    for (const y of chosen) {
      if (after.years.find((a) => a.fyStartYear === y.fyStartYear)?.needsRepair) {
        throw new Error(`FY ${y.label} still differs after the repair — nothing was changed`)
      }
    }
    return out
  })
  return { repaired: run(), lockDate: lockBefore }
}

/** The ledger the corrected journal carries the profit to: the stored journal's own (see
 *  transferOf), else null = postClose's default (Retained Earnings, created on first use). */
function transferIdOf(db: DB, y: CloseRepairYear): number | null {
  const stored = storedClose(db, y.fyStartYear)
  return stored ? transferOf(db, stored.lines).id : null
}
