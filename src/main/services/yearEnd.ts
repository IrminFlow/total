import type { DB } from '../db/connection'
import type { CompanyInfo } from '@shared/domain'
import { fyFromStartYear, todayISO } from '@shared/dates'
import { planClose, type CloseLedgerRow } from '@shared/yearEnd'
import { findOrCreateLedger } from './masters'
import { saveVoucher, setLockDate, getLockDate, deleteVoucher, NOT_DELETED, IN_BOOKS } from './vouchers'
import { writeAudit } from './audit'

/** Marker embedded in the closing journal's narration — how re-close and status checks find it. */
function closeMarker(fyStartYear: number): string {
  return `[year-end close FY${fyStartYear}]`
}

/** Where the books lock stood before this year's close, so reverseClose can put it back. */
function prevLockKey(fyStartYear: number): string {
  return `yearend.prevLock.${fyStartYear}`
}

export interface ClosePreview {
  rows: CloseLedgerRow[]
  /** Positive = profit, negative = loss, in paise. */
  netProfit: number
  alreadyClosed: boolean
}

/** Signed dr-positive net movement + already-closed check for a financial year's income/expense
 *  ledgers. Ledgers with no movement in the FY are omitted (they'd be a no-op closing line anyway).
 *  IN_BOOKS, not NOT_DELETED: optional (memorandum) and unmatured post-dated vouchers are out of
 *  the books, so they must not enter the closing journal — the close must net exactly what the
 *  P&L/trial balance (also IN_BOOKS) show, or Retained Earnings is misstated and the income/
 *  expense ledgers carry residuals into the locked next FY. */
export function closePreview(db: DB, fyStartYear: number): ClosePreview {
  const fy = fyFromStartYear(fyStartYear)
  const rows = (
    db
      .prepare(
        `SELECT l.id AS ledgerId, l.name AS name, g.nature AS nature,
                COALESCE((
                  SELECT SUM(CASE WHEN vl.dr_cr = 'dr' THEN vl.amount ELSE -vl.amount END)
                  FROM voucher_lines vl JOIN vouchers v ON v.id = vl.voucher_id
                  WHERE vl.ledger_id = l.id AND v.date BETWEEN ? AND ? AND ${IN_BOOKS}
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

  // Remembered before the close moves it, because a reversal has to put it back exactly where it
  // was — and "wherever it was" is unrecoverable once setLockDate has overwritten it. Keyed by
  // financial year: two closes of different years each have their own answer.
  const lockBeforeClose = getLockDate(db)

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
    db.prepare(
      'INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
    ).run(prevLockKey(fyStartYear), JSON.stringify(lockBeforeClose))
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

export interface ReverseCloseResult {
  /** The closing journal that was binned. */
  voucherId: number
  /** Where the books lock was left — the date it held before the close, or null. */
  lockedUpTo: string | null
}

/**
 * Undo a year-end close (roadmap #258).
 *
 * Closing the wrong year is a two-keystroke mistake with a heavy consequence: the closing journal
 * zeroes every income and expense ledger and then locks the books up to 31 March, which locks the
 * closing entry itself. Unwinding that by hand means lifting the lock, finding an entry among
 * thousands, deleting it, and hoping the lock date you type back is the one that was there — and
 * every one of those steps is a chance to lose a period nobody meant to reopen.
 *
 * What this does is exactly the inverse of postClose, in the inverse order: lift the lock (or the
 * closing entry cannot be touched), bin the closing journal, and put the lock back where it was
 * before. The journal is soft-deleted into the bin like any other voucher rather than purged —
 * "the close that was run in error" is a thing an auditor should be able to see, and the audit
 * row here says who reversed it.
 *
 * Refuses when there is anything dated after the closing entry: those entries were made in books
 * whose opening position the close created, and reversing underneath them would leave the
 * following year's figures resting on a balance that no longer exists.
 */
export function reverseClose(db: DB, fyStartYear: number): ReverseCloseResult {
  const fy = fyFromStartYear(fyStartYear)
  const marker = closeMarker(fyStartYear)

  const voucher = db
    .prepare(`SELECT v.id, v.date FROM vouchers v WHERE ${NOT_DELETED} AND v.narration LIKE ? ORDER BY v.id DESC LIMIT 1`)
    .get(`%${marker}%`) as { id: number; date: string } | undefined
  if (!voucher) throw new Error(`No year-end close to reverse for FY ${fy.label}`)

  const later = db
    .prepare(`SELECT COUNT(*) AS n FROM vouchers v WHERE ${NOT_DELETED} AND v.date > ? AND v.id <> ?`)
    .get(voucher.date, voucher.id) as { n: number }
  if (later.n > 0) {
    throw new Error(
      `There ${later.n === 1 ? 'is 1 entry' : `are ${later.n} entries`} dated after the closing entry of ${voucher.date}. ` +
        `Reversing the close underneath them would leave the next year opening from a balance that no longer exists — remove or re-date those entries first.`
    )
  }

  // Where the lock stood before the close, as recorded by postClose. A close run by an older
  // build left no record, and null — no lock — is the right fallback: leaving the books locked to
  // 31 March after reversing the entry that locked them would be a reversal in name only.
  const stored = db.prepare('SELECT value FROM meta WHERE key = ?').get(prevLockKey(fyStartYear)) as
    | { value: string }
    | undefined
  let restoredLock: string | null = null
  if (stored) {
    try {
      const parsed = JSON.parse(stored.value) as unknown
      if (typeof parsed === 'string') restoredLock = parsed
    } catch {
      // Unreadable: fall back to no lock, as above.
    }
  }
  // Somebody may have moved the lock forward since the close; never move it backwards past what
  // it is now unless the close is what put it there.
  const currentLock = getLockDate(db)
  if (currentLock !== null && currentLock !== voucher.date && (restoredLock === null || currentLock > restoredLock)) {
    restoredLock = currentLock
  }

  const run = db.transaction((): void => {
    // Order matters and is the mirror of postClose: the lock has to come off first, because
    // deleteVoucher refuses inside a locked period — including for the entry that set the lock.
    setLockDate(db, restoredLock)
    deleteVoucher(db, voucher.id)
  })
  run()

  writeAudit(db, 'year_end', fyStartYear, 'delete', { voucherId: voucher.id, lockedUpTo: voucher.date }, {
    reversed: true,
    lockedUpTo: restoredLock
  })
  return { voucherId: voucher.id, lockedUpTo: restoredLock }
}
