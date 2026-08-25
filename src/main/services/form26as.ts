/**
 * Form 26AS reconciliation — the deductee side of TDS (roadmap D-91).
 *
 * The statutory reasoning lives in `@shared/tds/form26as` (Rule 31AB, section 199 read with
 * Rule 37BA). This file does two things the engine cannot: it reads the book side out of
 * `voucher_lines`, and it hands both sides to `reconcile26as`.
 *
 * **Nothing here is persisted, deliberately.** A downloaded 26AS is a snapshot of the
 * department's record on the day it was downloaded — the customers' quarterly statements keep
 * arriving, and corrections keep landing against earlier quarters. A stored copy would look
 * exactly like a fresh one on screen while being weeks stale, and the person reconciling would
 * chase a deductor who has since filed, or miss one who has since revised. So the statement
 * arrives inline in the payload, is used, and is dropped. If a saved history is ever wanted it
 * has to carry the download date on its face, which is a different feature.
 *
 * Statutory position checked on 2026-08-25 against Rule 31AB, section 199 and Rule 37BA.
 */
import type { DB } from '../db/connection'
import {
  parse26asCsv,
  reconcile26as,
  type Book26asEntry,
  type Parse26asResult,
  type Recon26asResult,
  type Statement26asRow
} from '@shared/tds/form26as'
import { nameSimilarity } from '@shared/gst/recon2b'
// IN_BOOKS, not bare NOT_DELETED: a soft-deleted voucher is not a TDS credit, and neither is an
// optional (memorandum) or an unmatured post-dated one. IN_BOOKS is NOT_DELETED plus those, so
// the `deleted_at IS NULL` filter every vouchers/voucher_lines query owes is included by
// construction — see NOT_DELETED in ./vouchers.
import { IN_BOOKS } from './vouchers'

/**
 * What counts as a "TDS deducted from us" ledger.
 *
 * Not `tds_entries`: that table is the DEDUCTOR side — tax this business withheld from its own
 * vendors, which is what the 26Q export files. Form 26AS Part A is the opposite direction, tax
 * withheld from *us* by our customers, and the books record that as a debit to a TDS-receivable
 * asset in the receipt (or in the invoice, where the customer's withholding is booked up front).
 * Reconciling 26AS against `tds_entries` would compare two unrelated populations and report
 * every row on both sides as a finding.
 *
 * Recognised by name because there is no flag for it on the ledger master: anything whose name
 * mentions TDS and does NOT say "payable" (which is exactly the deductor-side ledger
 * `tdsSuggestion` find-or-creates, "TDS Payable 194C"). The pattern is deliberately loose —
 * "TDS Receivable", "TDS Receivable 194J", "TDS on Interest", "Advance Tax & TDS" all count.
 */
const RECEIVABLE_NAME_FILTER = "UPPER(l.name) LIKE '%TDS%' AND UPPER(l.name) NOT LIKE '%PAYABLE%'"

/** Section code as printed on the certificate, dug out of a ledger name like "TDS Receivable 194J". */
function sectionFromLedgerName(name: string): string {
  const m = name.toUpperCase().match(/\b(19[0-9][A-Z]{0,3})\b/)
  return m ? m[1]! : ''
}

interface LineRow {
  lineId: number
  voucherId: number
  date: string
  number: string
  ledgerName: string
  tdsAmount: number
  partyLedgerId: number | null
  partyName: string | null
}

interface PartyLineRow {
  voucherId: number
  drCr: 'dr' | 'cr'
  amount: number
}

/** A book-side entry plus the voucher it came from, so the screen can open it. */
export interface Book26asEntryRef extends Book26asEntry {
  voucherId: number
  voucherNumber: string
  /** The TDS-receivable ledger the debit landed on — the user's own naming, shown back to them. */
  ledgerName: string
  /**
   * Where `deductorTan` came from. 'statement' means it was inferred from the statement by
   * deductor name (see `stampTansFromStatement`) rather than read off a master, and the screen
   * says so — a pairing is only as trustworthy as the key it was made on.
   */
  tanSource: 'statement' | null
}

/**
 * Every TDS-receivable debit in the books between `from` and `to`, as reconcilable entries.
 *
 * `amountPaise` — the gross "paid or credited" the tax was computed on — is reconstructed from
 * the party ledger's own line on the same voucher:
 *   • party CREDITED (a receipt: Dr Bank, Dr TDS receivable, Cr Customer) → the credit is already
 *     the gross, because the customer's account is relieved of the full billed amount.
 *   • party DEBITED (an invoice that books the withholding up front) → the debit is net of the
 *     tax, so the TDS is added back.
 * With no party on the voucher there is nothing to reconstruct from and the gross is reported as
 * the tax itself, which will show as an amount mismatch rather than quietly reading as zero.
 *
 * VERIFY: where GST was billed separately, the customer deducts on the value EXCLUDING GST
 * (CBDT Circular 23/2017), but the party line carries the GST-inclusive figure and the books do
 * not record the section 194x base anywhere. Such a pair still matches on the TAX — which is
 * what the section 199 credit and `creditAtRiskPaise` depend on — but lands in the
 * `amountMismatch` bucket on the gross. Recording the base on the receipt (the deductee mirror
 * of `tds_entries`) is the exact fix and needs a migration.
 */
export function bookEntries(db: DB, from: string, to: string): Book26asEntryRef[] {
  const lines = db
    .prepare(
      `SELECT vl.id AS lineId, v.id AS voucherId, v.date AS date, v.number AS number,
              l.name AS ledgerName, vl.amount AS tdsAmount,
              v.party_ledger_id AS partyLedgerId, p.name AS partyName
       FROM voucher_lines vl
       JOIN vouchers v ON v.id = vl.voucher_id
       JOIN ledgers l ON l.id = vl.ledger_id
       LEFT JOIN ledgers p ON p.id = v.party_ledger_id
       WHERE vl.dr_cr = 'dr' AND ${RECEIVABLE_NAME_FILTER}
         AND v.date BETWEEN ? AND ? AND ${IN_BOOKS}
       ORDER BY v.date, v.id, vl.id`
    )
    .all(from, to) as LineRow[]

  if (lines.length === 0) return []

  // One extra query for the party lines of exactly those vouchers, rather than a correlated
  // subquery per line: a busy year has thousands of receipts and the join above already touches
  // every one of them.
  const ids = [...new Set(lines.map((l) => l.voucherId))]
  const placeholders = ids.map(() => '?').join(',')
  const partyLines = db
    .prepare(
      `SELECT vl.voucher_id AS voucherId, vl.dr_cr AS drCr, SUM(vl.amount) AS amount
       FROM voucher_lines vl
       JOIN vouchers v ON v.id = vl.voucher_id
       WHERE vl.voucher_id IN (${placeholders}) AND vl.ledger_id = v.party_ledger_id AND ${IN_BOOKS}
       GROUP BY vl.voucher_id, vl.dr_cr`
    )
    .all(...ids) as PartyLineRow[]

  const partyByVoucher = new Map<number, PartyLineRow>()
  for (const r of partyLines) partyByVoucher.set(r.voucherId, r)

  return lines.map((l) => {
    const party = partyByVoucher.get(l.voucherId)
    const gross = !party
      ? l.tdsAmount
      : party.drCr === 'cr'
        ? party.amount
        : party.amount + l.tdsAmount
    return {
      id: l.lineId,
      voucherId: l.voucherId,
      voucherNumber: l.number,
      ledgerName: l.ledgerName,
      deductorName: l.partyName,
      // VERIFY: the ledger master has no TAN column, so nothing in the books can supply one.
      // `stampTansFromStatement` borrows it from the statement by deductor name; a `tan` field on
      // `ledgers` would make this exact instead of name-based, and needs a migration.
      deductorTan: null,
      section: sectionFromLedgerName(l.ledgerName),
      date: l.date,
      amountPaise: gross,
      tdsPaise: l.tdsAmount,
      tanSource: null
    }
  })
}

/**
 * Group key for a deductor name. Uppercased with punctuation collapsed to single spaces, and
 * NOT stripped further: `nameSimilarity` compares word tokens, so a key with the spaces taken
 * out would be one long token and score zero against everything.
 */
const nameKey = (s: string | null): string =>
  (s ?? '').toUpperCase().replace(/[^A-Z0-9]+/g, ' ').trim()

/**
 * Give each book entry the TAN its deductor is filing under, taken from the statement by name.
 *
 * The ledger master has no TAN field, so without this every pairing falls to the engine's last
 * pass, which requires the two tax figures to agree within tolerance. That pass cannot see a
 * SHORT DEDUCTION — the deductor filed ₹9,000 against a ₹10,000 claim — which is the single
 * finding this whole screen exists to produce: it would split into a book-only row and a
 * statement-only row and never be named as a shortfall.
 *
 * So the TAN is borrowed from the only place it exists. This is not a new kind of trust: the
 * fallback pass would have paired the same two rows on the same name anyway. It is deliberately
 * strict about it — a near-exact name (0.92), a single best candidate, and that name filing
 * under exactly ONE TAN in the statement. A deductor filing under two TANs, or two customers
 * with confusingly similar names, is left alone for the name pass to handle honestly.
 *
 * `tanSource: 'statement'` marks every entry this touched, so the screen can say the pairing
 * rests on a name rather than on an identifier.
 */
function stampTansFromStatement(books: Book26asEntryRef[], rows: Statement26asRow[]): void {
  if (books.length === 0 || rows.length === 0) return

  // name -> the one TAN filing under it, or null once a second one shows up.
  const byName = new Map<string, string | null>()
  for (const r of rows) {
    const key = nameKey(r.deductorName)
    if (key === '') continue
    if (!byName.has(key)) byName.set(key, r.deductorTan)
    else if (byName.get(key) !== r.deductorTan) byName.set(key, null)
  }
  const names = [...byName.keys()]

  for (const b of books) {
    if (b.deductorTan || !b.deductorName) continue
    let best: { key: string; score: number } | null = null
    let tied = false
    for (const key of names) {
      const score = nameSimilarity(b.deductorName, key)
      if (score < 0.92) continue
      if (!best || score > best.score) {
        best = { key, score }
        tied = false
      } else if (score === best.score) {
        tied = true
      }
    }
    if (!best || tied) continue
    const tan = byName.get(best.key)
    if (!tan) continue
    b.deductorTan = tan
    b.tanSource = 'statement'
  }
}

export interface Recon26asReport {
  /** Parser findings — a malformed line is reported, never thrown. */
  problems: string[]
  /** Rows read out of the pasted/loaded statement. */
  statementRows: Parse26asResult['rows']
  /** The book side, with voucher references the screen can navigate to. */
  bookEntries: Book26asEntryRef[]
  result: Recon26asResult
  from: string
  to: string
}

/**
 * Parse an inline 26AS export and reconcile it against the books for `from`..`to`.
 *
 * `text` is inline for the same reason `tally:import` takes `xmlText` and `bank:importCsv` takes
 * `csvText`: a driver script or an E2E scenario can then exercise the whole path without a native
 * file dialog standing in front of it.
 *
 * A statement with no rows is a valid answer, not a failure: the taxpayer sees every book entry
 * in `missingInStatement` and the whole of their claimed credit in `creditAtRiskPaise`, which is
 * precisely the true position when no customer has filed.
 *
 * VERIFY: the parser was written to the published TRACES Form 26AS (Part A) column wording and
 * to the AIS/TIS CSV variants, but has never been run against a file exported from the live
 * TRACES portal — no credentials. The header matching is by pattern rather than by position, and
 * unreadable lines land in `problems` rather than being dropped silently, so a layout surprise
 * shows up as a visible complaint instead of a wrong total. Confirm against a real export before
 * trusting the buckets.
 */
export function recon26as(
  db: DB,
  args: { text: string; from: string; to: string; amountTolerancePaise: number; dateWindowDays: number }
): Recon26asReport {
  const parsed = parse26asCsv(args.text)
  const books = bookEntries(db, args.from, args.to)
  stampTansFromStatement(books, parsed.rows)
  const result = reconcile26as(books, parsed.rows, {
    amountTolerancePaise: args.amountTolerancePaise,
    dateWindowDays: args.dateWindowDays
  })
  return {
    problems: parsed.problems,
    statementRows: parsed.rows,
    bookEntries: books,
    result,
    from: args.from,
    to: args.to
  }
}
