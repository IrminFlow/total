// Return a sale / Return a purchase (WP 9.5, plan 2026-10-13 §3): the READ side of the simple
// return screens. Writing goes through simple:post only (`return_sale` / `return_purchase`
// intents, services/simplePost.ts — a credit / debit note linked as a `return`, plus the refund
// in the same transaction). These reads give the screens their choices:
//
// - returnBills: the recent in-books sales / purchase bills (last 12 months up to today, or any
//   date when searching by party name / bill number), each with the returns already made against
//   it and whether anything is still returnable;
// - returnBill: one bill as the return form needs it — exactly what simple:post maps the return
//   from (simplePost.loadOriginal: lines with what is left to return through the live `return`
//   links, the GST rates as the bill posted them, what is still pending on it as on the return's
//   date, the value still returnable of a bill without item lines), plus names for the screen;
// - returnsOfBills: the returns against given bills (the sales / purchase lists' chips).
//
// A return is "against" a bill when it is linked to the bill's lines (`line_links`, link_type
// 'return') or — a bill without item lines — when it is a note of the same party carrying the
// bill as its reference (mapReturn sets it; e-invoice PrecDocDtls and the 2B netting read it).
import type { DB } from '../db/connection'
import type { CompanyInfo } from '@shared/domain'
import { addDaysISO } from '@shared/dates'
import { billAmount } from '@shared/simple/saveCard'
import type { ReturnBill, ReturnBillRow, ReturnSide } from '@shared/simple/returns'
import { getVoucher, IN_BOOKS } from './vouchers'
import { listLedgers } from './masters'
import { counterAccounts, WALK_IN_NAME } from './counter'
import { loadOriginal, notesByReference } from './simplePost'

/** How many bills the "Which bill?" list shows (newest first; searching reaches the rest). */
export const RETURN_LIST_CAP = 300

const billKind = (side: ReturnSide): 'sales' | 'purchase' => (side === 'sale' ? 'sales' : 'purchase')
const noteKind = (side: ReturnSide): 'credit_note' | 'debit_note' => (side === 'sale' ? 'credit_note' : 'debit_note')

export interface EarlierReturn { voucherId: number; number: string; date: string; total: number; offBill: number }

interface BillHead { id: number; number: string; reference: string | null; date: string; partyId: number | null }

/** The returns already made against each bill (in the books), oldest first, with each one's total
 *  and the part of it set against the bill itself (its 'against' refs to the bill's name). */
export function returnsOfBills(db: DB, side: ReturnSide, bills: readonly BillHead[]): Map<number, EarlierReturn[]> {
  const out = new Map<number, EarlierReturn[]>()
  if (bills.length === 0) return out
  const kind = noteKind(side)
  const found = new Map<number, Set<number>>()
  const add = (billId: number, noteId: number): void => {
    const s = found.get(billId) ?? new Set<number>()
    s.add(noteId)
    found.set(billId, s)
  }
  const ids = bills.map((b) => b.id)
  for (let i = 0; i < ids.length; i += 500) {
    const chunk = ids.slice(i, i + 500)
    const linked = db
      .prepare(
        `SELECT DISTINCT ll.from_voucher_id AS billId, v.id AS noteId FROM line_links ll
         JOIN vouchers v ON v.id = ll.to_voucher_id JOIN voucher_types vt ON vt.id = v.voucher_type_id
         WHERE ll.link_type = 'return' AND vt.kind = ? AND ll.from_voucher_id IN (${chunk.map(() => '?').join(',')}) AND ${IN_BOOKS}`
      )
      .all(kind, ...chunk) as { billId: number; noteId: number }[]
    for (const r of linked) add(r.billId, r.noteId)
  }
  // WP 7.1: a note naming its bill by reference is rare — ask notesByReference only for the
  // (party, reference) pairs some in-books note of this kind carries (its own WHERE needs both),
  // instead of one query per bill.
  const refPairs = new Set(
    (db
      .prepare(
        `SELECT DISTINCT v.party_ledger_id AS partyId, TRIM(v.reference) AS ref FROM vouchers v JOIN voucher_types vt ON vt.id = v.voucher_type_id
         WHERE vt.kind = ? AND v.reference IS NOT NULL AND ${IN_BOOKS}`
      )
      .all(kind) as { partyId: number | null; ref: string }[]).map((r) => `${r.partyId}\u0000${r.ref}`)
  )
  for (const b of bills) {
    if (b.partyId == null) continue
    const ref = side === 'sale' ? b.number : b.reference?.trim() || b.number
    if (!refPairs.has(`${b.partyId}\u0000${ref}`)) continue
    for (const noteId of notesByReference(db, billKind(side), { id: b.id, partyId: b.partyId, date: b.date, ref })) add(b.id, noteId)
  }
  const head = db.prepare('SELECT number, date, party_ledger_id AS partyId FROM vouchers WHERE id = ?')
  const lines = db.prepare('SELECT ledger_id AS ledgerId, dr_cr AS drCr, amount FROM voucher_lines WHERE voucher_id = ?')
  const billName = db.prepare("SELECT name FROM bill_refs WHERE voucher_id = ? AND kind = 'new' ORDER BY id LIMIT 1")
  const against = db.prepare("SELECT COALESCE(SUM(amount), 0) AS t FROM bill_refs WHERE voucher_id = ? AND kind = 'against' AND name = ?")
  const byId = new Map(bills.map((b) => [b.id, b]))
  for (const [billId, notes] of found) {
    const b = byId.get(billId)!
    const name = (billName.get(billId) as { name: string } | undefined)?.name ?? b.number
    const list = [...notes].map((noteId) => {
      const h = head.get(noteId) as { number: string; date: string; partyId: number | null }
      const total = billAmount(lines.all(noteId) as { ledgerId: number; drCr: 'dr' | 'cr'; amount: number }[], h.partyId)
      return { voucherId: noteId, number: h.number, date: h.date, total, offBill: Math.min(total, (against.get(noteId, name) as { t: number }).t) }
    })
    out.set(billId, list.sort((x, y) => x.date.localeCompare(y.date) || x.voucherId - y.voucherId))
  }
  return out
}

function isWalkIn(db: DB, partyId: number | null, name: string): boolean {
  return partyId != null && (partyId === counterAccounts(db).walkInLedgerId || name === WALK_IN_NAME)
}

/** The "Which bill?" list: newest first, capped; `q` searches the party name and bill numbers at
 *  any date up to today. */
export function returnBills(db: DB, company: CompanyInfo, side: ReturnSide, today: string, q?: string): ReturnBillRow[] {
  const search = q?.trim() ? `%${q.trim().replace(/[\\%_]/g, (c) => `\\${c}`)}%` : null
  const from = search ? '0000-01-01' : addDaysISO(today, -365)
  const heads = db
    .prepare(
      `SELECT v.id, v.number, v.reference, v.date, v.party_ledger_id AS partyId, p.name AS partyName
       FROM vouchers v JOIN voucher_types vt ON vt.id = v.voucher_type_id LEFT JOIN ledgers p ON p.id = v.party_ledger_id
       WHERE vt.kind = ? AND v.date BETWEEN ? AND ? AND v.party_ledger_id IS NOT NULL AND ${IN_BOOKS}
         ${search ? "AND (p.name LIKE ? ESCAPE '\\' OR v.number LIKE ? ESCAPE '\\' OR v.reference LIKE ? ESCAPE '\\')" : ''}
       ORDER BY v.date DESC, v.id DESC LIMIT ${RETURN_LIST_CAP}`
    )
    .all(billKind(side), from, today, ...(search ? [search, search, search] : [])) as (BillHead & { partyName: string | null })[]
  const withItems = new Set<number>()
  for (let i = 0; i < heads.length; i += 500) {
    const chunk = heads.slice(i, i + 500).map((h) => h.id)
    // Returnable lines are the bill's own items, wherever the goods moved (not a stock reading).
    const rows = db.prepare(`SELECT DISTINCT voucher_id AS id FROM inventory_lines WHERE voucher_id IN (${chunk.map(() => '?').join(',')})`).all(...chunk) as { id: number }[]
    for (const r of rows) withItems.add(r.id)
  }
  const returns = returnsOfBills(db, side, heads)
  const lines = db.prepare('SELECT ledger_id AS ledgerId, dr_cr AS drCr, amount FROM voucher_lines WHERE voucher_id = ?')
  const ledgers = listLedgers(db)
  return heads.map((h) => {
    const earlier = returns.get(h.id) ?? []
    const mode = withItems.has(h.id) ? ('items' as const) : ('amount' as const)
    let left: ReturnBillRow['left'] = 'all'
    if (earlier.length) {
      // What is left: the same reading the return itself is mapped from.
      const o = loadOriginal(db, company, ledgers, h.id, today)
      if (o && mode === 'items') {
        const sold = o.lines.reduce((s, l) => s + l.qtyMilli, 0)
        const rest = o.lines.reduce((s, l) => s + Math.max(0, l.leftMilli), 0)
        left = rest <= 0 ? 'none' : rest < sold ? 'part' : 'all'
      } else if (o) {
        left = o.amountLeft != null && o.amountLeft <= 0 ? 'none' : 'part'
      }
    }
    return {
      voucherId: h.id,
      number: h.number,
      billNo: side === 'purchase' ? h.reference?.trim() || null : null,
      date: h.date,
      partyId: h.partyId,
      partyName: h.partyName ?? '',
      walkIn: side === 'sale' && isWalkIn(db, h.partyId, h.partyName ?? ''),
      total: billAmount(lines.all(h.id) as { ledgerId: number; drCr: 'dr' | 'cr'; amount: number }[], h.partyId),
      mode,
      returns: earlier.length,
      returned: earlier.reduce((s, r) => s + r.total, 0),
      left
    }
  })
}

/** One bill as the return form needs it, as on `asOn` (the return's date); null when it is not an
 *  in-books bill of that side. */
export function returnBill(db: DB, company: CompanyInfo, side: ReturnSide, id: number, asOn: string): ReturnBill | null {
  const inBooks = db
    .prepare(`SELECT 1 FROM vouchers v JOIN voucher_types vt ON vt.id = v.voucher_type_id WHERE v.id = ? AND vt.kind = ? AND ${IN_BOOKS}`)
    .get(id, billKind(side))
  if (!inBooks) return null
  const ledgers = listLedgers(db)
  const o = loadOriginal(db, company, ledgers, id, asOn)
  const v = getVoucher(db, id)
  if (!o || !v || v.partyLedgerId == null) return null
  const party = ledgers.find((l) => l.id === o.partyId)
  const item = db.prepare('SELECT s.name, u.symbol FROM stock_items s LEFT JOIN units u ON u.id = s.unit_id WHERE s.id = ?')
  const byUid = new Map(v.inventory.map((l) => [l.lineUid, l]))
  const taxIds = new Set(ledgers.filter((l) => l.taxType).map((l) => l.id))
  const counter = side === 'sale' ? 'cr' : 'dr'
  const tax = v.lines.filter((l) => taxIds.has(l.ledgerId) && l.drCr === counter).reduce((s, l) => s + l.amount, 0)
  const isRoundOff = (ledgerId: number): boolean => (ledgers.find((l) => l.id === ledgerId)?.name ?? '').trim().toLowerCase() === 'round off'
  const amountTaxable = v.inventory.length
    ? 0
    : v.lines.filter((l) => l.drCr === counter && l.ledgerId !== v.partyLedgerId && !taxIds.has(l.ledgerId) && !isRoundOff(l.ledgerId)).reduce((s, l) => s + l.amount, 0)
  const earlier = returnsOfBills(db, side, [{ id: v.id, number: v.number, reference: v.reference, date: v.date, partyId: v.partyLedgerId }]).get(v.id) ?? []
  return {
    voucherId: v.id,
    side,
    number: v.number,
    billNo: side === 'purchase' ? v.reference?.trim() || null : null,
    date: v.date,
    partyId: o.partyId,
    partyName: party?.name ?? '',
    partyStateCode: party?.stateCode ?? null,
    walkIn: side === 'sale' && isWalkIn(db, o.partyId, party?.name ?? ''),
    total: billAmount(v.lines, v.partyLedgerId),
    tax,
    billName: o.billName,
    pending: o.pending,
    carriesGst: o.carriesGst,
    rates: o.rates,
    accountId: o.accountId,
    mode: v.inventory.length ? 'items' : 'amount',
    lines: o.lines.map((l) => {
      const it = item.get(l.itemId) as { name: string; symbol: string | null } | undefined
      return { ...l, leftMilli: Math.max(0, l.leftMilli), name: it?.name ?? '', unit: it?.symbol ?? '', amount: byUid.get(l.lineUid)?.amount ?? 0 }
    }),
    amountTaxable,
    amountLeft: o.amountLeft ?? null,
    earlier: earlier.map(({ offBill: _o, ...r }) => r)
  }
}
