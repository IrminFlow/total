import type { DB } from '../db/connection'
import { fyOf } from '@shared/dates'

/** The numbering knobs a series carries (voucher_types and trade_doc_types share them). */
export interface SeriesKnobs {
  id: number
  prefix: string
  suffix: string
  padWidth: number
  restartFy: boolean
}

/** Which table a series numbers: vouchers by voucher type, or trade docs by trade-doc type. */
export type SeriesTable = { table: 'vouchers'; typeColumn: 'voucher_type_id' } | { table: 'trade_docs'; typeColumn: 'doc_type_id' }

/**
 * Next auto number in a series: prefix + zero-padded sequence + suffix (WP 2.5a: extracted from
 * nextVoucherNumber so orders / quotations number the same way). The scan window is the FY
 * containing `date` (restartFy, the Tally-style default) or every row of the series ever.
 * Binned (soft-deleted) rows still count toward the max — a deleted number is never reissued.
 */
export function nextSeriesNumber(
  db: DB,
  q: SeriesTable & { type: SeriesKnobs; date: string; excludeId?: number }
): string {
  const vt = q.type
  // Strip the suffix then the prefix in SQL (so e.g. "INV-007/24-25" with prefix "INV-" and
  // suffix "/24-25" reads as 7) and take a single MAX — no more loading every number into JS.
  // CAST mirrors the old parseInt(..., 10): leading digits parse, anything else reads as 0.
  const fyClause = vt.restartFy ? 'AND date BETWEEN :from AND :to' : ''
  const row = db
    .prepare(
      `SELECT COALESCE(MAX(CAST(
         CASE WHEN :plen > 0 AND substr(stripped, 1, :plen) = :prefix
              THEN substr(stripped, :plen + 1) ELSE stripped END AS INTEGER)), 0) AS maxn
       FROM (
         SELECT CASE WHEN :slen > 0 AND substr(number, -:slen) = :suffix
                     THEN substr(number, 1, length(number) - :slen) ELSE number END AS stripped
         FROM ${q.table}
         WHERE ${q.typeColumn} = :vtId AND id IS NOT :excludeId ${fyClause}
       )`
    )
    .get({
      vtId: vt.id,
      excludeId: q.excludeId ?? -1,
      plen: vt.prefix.length,
      prefix: vt.prefix,
      slen: vt.suffix.length,
      suffix: vt.suffix,
      ...(vt.restartFy ? { from: fyOf(q.date).from, to: fyOf(q.date).to } : {})
    }) as { maxn: number }
  const seq = Math.max(0, row.maxn) + 1
  const padded = vt.padWidth > 0 ? String(seq).padStart(vt.padWidth, '0') : String(seq)
  return `${vt.prefix}${padded}${vt.suffix}`
}
