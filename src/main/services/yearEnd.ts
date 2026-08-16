import type { DB } from '../db/connection'
import type { CompanyInfo } from '@shared/domain'
import { fyFromStartYear, todayISO } from '@shared/dates'
import { planClose, type CloseLedgerRow } from '@shared/yearEnd'
import { findOrCreateLedger } from './masters'
import { saveVoucher, setLockDate, NOT_DELETED } from './vouchers'

/** Marker embedded in the closing journal's narration — how re-close and status checks find it. */
function closeMarker(fyStartYear: number): string {
  return `[year-end close FY${fyStartYear}]`
}

export interface ClosePreview {
  rows: CloseLedgerRow[]
  /** Positive = profit, negative = loss, in paise. */
  netProfit: number
  alreadyClosed: boolean
}

/** Signed dr-positive net movement + already-closed check for a financial year's income/expense
 *  ledgers. Ledgers with no movement in the FY are omitted (they'd be a no-op closing line anyway). */
export function closePreview(db: DB, fyStartYear: number): ClosePreview {
  const fy = fyFromStartYear(fyStartYear)
  const rows = (
    db
      .prepare(
        `SELECT l.id AS ledgerId, l.name AS name, g.nature AS nature,
                COALESCE((
                  SELECT SUM(CASE WHEN vl.dr_cr = 'dr' THEN vl.amount ELSE -vl.amount END)
                  FROM voucher_lines vl JOIN vouchers v ON v.id = vl.voucher_id
                  WHERE vl.ledger_id = l.id AND v.date BETWEEN ? AND ? AND ${NOT_DELETED}
                ), 0) AS net
         FROM ledgers l JOIN groups g ON g.id = l.group_id
         WHERE g.nature IN ('income', 'expense')`
      )
      .all(fy.from, fy.to) as CloseLedgerRow[]
  )
    .filter((r) => r.net !== 0)
    .sort((a, b) => a.name.localeCompare(b.name))

  const { netProfit } = planClose(rows)

  const marker = closeMarker(fyStartYear)
  const existing = db
    .prepare(`SELECT 1 FROM vouchers v WHERE ${NOT_DELETED} AND v.narration LIKE ? LIMIT 1`)
    .get(`%${marker}%`)

  return { rows, netProfit, alreadyClosed: !!existing }
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

  const preview = closePreview(db, fyStartYear)
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
    setLockDate(db, closeDate)
    return voucher.id
  })

  const voucherId = run()
  return { voucherId, netProfit: plan.netProfit, lockedUpTo: closeDate }
}
