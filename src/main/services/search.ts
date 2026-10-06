import type { DB } from '../db/connection'
import { escapeLike, type SearchHit } from '@shared/search'
import { toDisplayDate } from '@shared/dates'
import { NOT_DELETED } from './vouchers'

interface LedgerRow { id: number; name: string; groupName: string }
interface ItemRow { id: number; name: string }
interface VoucherRow { id: number; type: string; number: string; date: string; narration: string | null }

/** Rows per category. */
export const SEARCH_LIMIT = 20

/** ⌘K "In your books" search — ledgers, stock items and vouchers matching `q` (substring,
 *  case-insensitive), SEARCH_LIMIT rows each; names (voucher numbers) starting with `q` rank
 *  before mid-string matches. `q` is expected to already be trimmed/length-checked by the
 *  IPC schema; callers with a shorter query should just skip calling this at all. */
export function globalSearch(db: DB, q: string): SearchHit[] {
  const like = `%${escapeLike(q)}%`
  const prefix = `${escapeLike(q)}%`

  const ledgers = db
    .prepare(
      `SELECT l.id AS id, l.name AS name, g.name AS groupName
       FROM ledgers l
       JOIN groups g ON g.id = l.group_id
       WHERE l.name COLLATE NOCASE LIKE ? ESCAPE '\\'
       ORDER BY CASE WHEN l.name COLLATE NOCASE LIKE ? ESCAPE '\\' THEN 0 ELSE 1 END, l.name
       LIMIT ${SEARCH_LIMIT}`
    )
    .all(like, prefix) as LedgerRow[]

  const items = db
    .prepare(
      `SELECT id, name
       FROM stock_items
       WHERE name COLLATE NOCASE LIKE ? ESCAPE '\\'
       ORDER BY CASE WHEN name COLLATE NOCASE LIKE ? ESCAPE '\\' THEN 0 ELSE 1 END, name
       LIMIT ${SEARCH_LIMIT}`
    )
    .all(like, prefix) as ItemRow[]

  const vouchers = db
    .prepare(
      `SELECT v.id AS id, vt.name AS type, v.number AS number, v.date AS date, v.narration AS narration
       FROM vouchers v
       JOIN voucher_types vt ON vt.id = v.voucher_type_id
       WHERE (v.number COLLATE NOCASE LIKE ? ESCAPE '\\' OR v.narration COLLATE NOCASE LIKE ? ESCAPE '\\')
         AND ${NOT_DELETED}
       ORDER BY CASE WHEN v.number COLLATE NOCASE LIKE ? ESCAPE '\\' THEN 0 ELSE 1 END, v.date DESC
       LIMIT ${SEARCH_LIMIT}`
    )
    .all(like, like, prefix) as VoucherRow[]

  const hits: SearchHit[] = []
  for (const l of ledgers) hits.push({ kind: 'ledger', id: l.id, label: l.name, sub: l.groupName })
  for (const i of items) hits.push({ kind: 'item', id: i.id, label: i.name, sub: 'Stock item' })
  for (const v of vouchers) {
    hits.push({
      kind: 'voucher',
      id: v.id,
      label: `${v.type} ${v.number}`,
      sub: `${toDisplayDate(v.date)} · ${v.narration ?? ''}`
    })
  }
  return hits
}
