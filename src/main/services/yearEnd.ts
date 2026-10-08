import type { DB } from '../db/connection'
import type { CompanyInfo } from '@shared/domain'
import { fyFromStartYear, fyOf, todayISO } from '@shared/dates'
import { planClose, type CloseLedgerRow } from '@shared/yearEnd'
import { findOrCreateLedger } from './masters'
import { saveVoucher, setLockDate, NOT_DELETED } from './vouchers'
import { writeAudit } from './audit'
import { booksFromYear } from './booksStart'
import { pnlLedgerAmounts } from './reports'
import { yearStatus } from './fixedAssets'
import type { DepreciationYearStatus } from '@shared/fixedAssets'
import type { UnbilledGoods } from '@shared/tradeCycle/types'
import { unbilledGoods } from './tradeAnalysis'
import { msmeYearEndWarning } from './payables'
import type { MsmeYearEndWarning } from '@shared/payables/types'

/** Marker embedded in the closing journal's narration — for readability (and migration 018's
 *  backfill of pre-flag closes). Status checks use vouchers.is_year_end_close, not this text. */
function closeMarker(fyStartYear: number): string {
  return `[year-end close FY${fyStartYear}]`
}

export interface ClosePreview {
  rows: CloseLedgerRow[]
  /** Positive = profit, negative = loss, in paise. */
  netProfit: number
  alreadyClosed: boolean
  /** WP 3.6: book depreciation status for the year — the close screen warns when it's missing. */
  depreciation: DepreciationYearStatus
  /** WP 2.5d (design §9 Q5): goods delivered / received but not invoiced on the FY's last day —
   *  the close screen warns with the values; no provision is posted automatically. */
  unbilled: UnbilledGoods
  /** WP 4.3: micro / small supplier dues past the MSMED Act s.15 period on the FY's last day (and
   *  the s.43B(h) / 2025 Act s.37(2)(g) figure) — the close screen warns; nothing is posted. */
  msme?: MsmeYearEndWarning
}

/** Signed dr-positive net movement + already-closed check for a financial year's income/expense
 *  ledgers. Ledgers with no movement in the FY are omitted (they'd be a no-op closing line anyway).
 *  IN_BOOKS, not NOT_DELETED: optional (memorandum) and unmatured post-dated vouchers are out of
 *  the books, so they must not enter the closing journal — the close must net exactly what the
 *  P&L/trial balance (also IN_BOOKS) show, or Retained Earnings is misstated and the income/
 *  expense ledgers carry residuals into the locked next FY.
 *
 *  WP 1.3: the nets come from reports.pnlLedgerAmounts — the same "profit for a period" the P&L
 *  uses — so the close transfers exactly the FY's P&L net profit. When closing the books' first
 *  FY that includes each ledger's stored opening balance; otherwise it would never reach
 *  Retained Earnings and the trial balance would show it forever as a computed
 *  "Profit & Loss A/c (opening)" row. `booksFrom` defaults to the company's stored value. */
export function closePreview(db: DB, fyStartYear: number, booksFrom: number = booksFromYear(db)): ClosePreview {
  const fy = fyFromStartYear(fyStartYear)
  const { amounts } = pnlLedgerAmounts(db, fy.from, fy.to, booksFrom)
  const ledgers = db
    .prepare(
      `SELECT l.id AS ledgerId, l.name AS name, g.nature AS nature
       FROM ledgers l JOIN groups g ON g.id = l.group_id WHERE g.nature IN ('income', 'expense')`
    )
    .all() as Omit<CloseLedgerRow, 'net'>[]
  const rows: CloseLedgerRow[] = ledgers
    .map((l) => ({ ...l, net: amounts.get(l.ledgerId) ?? 0 }))
    .filter((r) => r.net !== 0)
    .sort((a, b) => a.name.localeCompare(b.name))

  const { netProfit } = planClose(rows)

  // Closed = a live (not binned) voucher flagged is_year_end_close dated anywhere in this FY
  // (postClose dates it 31 March; any date in the year counts so odd legacy data still reads as
  // closed). Migration 018 backfilled the flag for closes posted before it existed. Closing
  // journals are immutable (saveVoucher refuses edits): binning one reopens the year; restoring
  // it re-closes the year unless another close is live (restoreVoucher refuses that).
  const existing = db
    .prepare(`SELECT 1 FROM vouchers v WHERE ${NOT_DELETED} AND v.is_year_end_close = 1 AND v.date BETWEEN ? AND ? LIMIT 1`)
    .get(fy.from, fy.to)

  return {
    rows, netProfit, alreadyClosed: !!existing, depreciation: yearStatus(db, fyStartYear), unbilled: unbilledGoods(db, fy.to),
    msme: msmeYearEndWarning(db, fyStartYear)
  }
}

export interface CloseResult {
  voucherId: number
  netProfit: number
  lockedUpTo: string
}

/**
 * Posts the FY's closing journal (income/expense ledgers zeroed against Retained Earnings) and
 * locks the books up to 31 Mar of the following year. Order matters: the journal is saved *before*
 * the lock is set, since saveVoucher itself refuses to post into a locked period — the lock is set
 * only once the closing entry (dated the same 31 Mar) already exists.
 */
export function postClose(db: DB, company: CompanyInfo, fyStartYear: number): CloseResult {
  const fy = fyFromStartYear(fyStartYear)
  if (fyStartYear < company.booksFrom) {
    throw new Error(`Books start in FY ${fyFromStartYear(company.booksFrom).label} — nothing to close before that`)
  }
  if (fy.to >= todayISO()) {
    throw new Error('Cannot close a financial year that has not ended')
  }

  const preview = closePreview(db, fyStartYear, company.booksFrom)
  if (preview.alreadyClosed) throw new Error(`Books for FY ${fy.label} are already closed`)

  const plan = planClose(preview.rows)
  if (plan.lines.length === 0) throw new Error(`No income or expense activity to close for FY ${fy.label}`)

  const retainedGroupExists = db.prepare("SELECT 1 FROM groups WHERE name = 'Reserves & Surplus'").get()
  const retainedGroup = retainedGroupExists ? 'Reserves & Surplus' : 'Capital Account'
  const retainedId = findOrCreateLedger(db, 'Retained Earnings', retainedGroup)

  const lines: { ledgerId: number; drCr: 'dr' | 'cr'; amount: number; costAllocations: [] }[] = plan.lines.map((l) => ({
    ledgerId: l.ledgerId,
    drCr: l.drCr,
    amount: l.amount,
    costAllocations: []
  }))
  if (plan.netProfit !== 0) {
    lines.push({
      ledgerId: retainedId,
      drCr: plan.netProfit > 0 ? 'cr' : 'dr',
      amount: Math.abs(plan.netProfit),
      costAllocations: []
    })
  }

  const journalType = db.prepare("SELECT id FROM voucher_types WHERE kind = 'journal' AND is_system = 1").get() as
    | { id: number }
    | undefined
  if (!journalType) throw new Error('Journal voucher type not found')

  const closeDate = fy.to // `${fyStartYear + 1}-03-31`

  const run = db.transaction((): number => {
    const voucher = saveVoucher(db, {
      voucherTypeId: journalType.id,
      date: closeDate,
      partyLedgerId: null,
      narration: `Year-end closing entry ${closeMarker(fyStartYear)}`,
      reference: null,
      instrumentNo: null,
      instrumentDate: null,
      transporterId: null,
      vehicleNo: null,
      transportDistanceKm: null,
      currencyCode: null,
      exchangeRate: null,
      lines,
      inventory: [],
      billRefs: [],
      tds: null
    })
    // The flag (migration 018) is what identifies the closing journal; the narration marker is
    // kept for readability only. From here on the voucher is immutable (saveVoucher refuses).
    db.prepare('UPDATE vouchers SET is_year_end_close = 1 WHERE id = ?').run(voucher.id)
    setLockDate(db, closeDate)
    return voucher.id
  })

  const voucherId = run()
  // [lane-Q audit] year-end close summary row (the closing journal + lock write their own rows;
  // this one records the close as a single findable event).
  writeAudit(db, 'year_end', fyStartYear, 'create', null, {
    voucherId,
    netProfit: plan.netProfit,
    lockedUpTo: closeDate
  })
  return { voucherId, netProfit: plan.netProfit, lockedUpTo: closeDate }
}

/**
 * WP 6.3 Books import: flag an imported journal as a year-end closing journal — but ONLY when it is
 * shaped like one, so a user's file can never make an arbitrary journal immutable and invisible to
 * the P&L: a live, dated (not optional / post-dated) journal on the last day of its FY, with no
 * stock or bill lines, at least one income/expense ledger line and at most one other line (the
 * transfer to retained earnings / capital), and no closing journal already in that FY. Throws the
 * reason otherwise. The lock date is not touched here (the importer restores the exported one).
 */
export function markImportedClose(db: DB, voucherId: number): void {
  const v = db
    .prepare(
      `SELECT v.date, v.is_optional, v.post_dated, v.deleted_at, v.is_year_end_close, vt.kind FROM vouchers v
         JOIN voucher_types vt ON vt.id = v.voucher_type_id WHERE v.id = ?`
    )
    .get(voucherId) as { date: string; is_optional: number; post_dated: number; deleted_at: string | null; is_year_end_close: number; kind: string } | undefined
  if (!v || v.deleted_at) throw new Error('Voucher not found')
  if (v.is_year_end_close) return
  const fy = fyOf(v.date)
  if (v.kind !== 'journal') throw new Error('A closing entry must be a journal')
  if (v.is_optional || v.post_dated) throw new Error('A closing entry cannot be optional or post-dated')
  if (v.date !== fy.to) throw new Error(`A closing entry is dated ${fy.to}, the last day of FY ${fy.label}`)
  if (db.prepare('SELECT 1 FROM inventory_lines WHERE voucher_id = ?').get(voucherId) || db.prepare('SELECT 1 FROM bill_refs WHERE voucher_id = ?').get(voucherId)) {
    throw new Error('A closing entry has no stock or bill lines')
  }
  const lines = db
    .prepare('SELECT g.nature FROM voucher_lines vl JOIN ledgers l ON l.id = vl.ledger_id JOIN groups g ON g.id = l.group_id WHERE vl.voucher_id = ?')
    .all(voucherId) as { nature: string }[]
  const pnl = lines.filter((l) => l.nature === 'income' || l.nature === 'expense').length
  if (pnl === 0 || lines.length - pnl > 1) throw new Error('A closing entry moves income and expense ledgers to one transfer ledger')
  if (db.prepare(`SELECT 1 FROM vouchers v WHERE ${NOT_DELETED} AND v.is_year_end_close = 1 AND v.date BETWEEN ? AND ?`).get(fy.from, fy.to)) {
    throw new Error(`FY ${fy.label} already has a closing entry`)
  }
  db.prepare('UPDATE vouchers SET is_year_end_close = 1 WHERE id = ?').run(voucherId)
  writeAudit(db, 'voucher', voucherId, 'update', { isYearEndClose: false }, { isYearEndClose: true, via: 'books import' })
}
