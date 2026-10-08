// Cheque register (WP 4.1): cheque books (leaf ranges per bank account) and the cheques issued,
// cancelled or stopped from them. "Cleared" is derived from the payment voucher's bank date.
import type { DB } from '../db/connection'
import type { ChequeBook, ChequeBookInput, ChequeRegisterRow, ChequeStatusInput } from '@shared/bankTypes'
import {
  bookFor, displayStatus, formatLeaf, leafValue, nextAvailableLeaf, overlappingBook, type ChequeBookRange, type ChequeStatus, type StoredChequeStatus
} from '@shared/chequeRegister'
import { writeAudit } from './audit'
import { bankLedgers } from './banking'
import { chequeData } from './cheque'
import { NOT_DELETED, getLockDate, getVoucher } from './vouchers'



interface BookRow { id: number; bank_ledger_id: number; name: string; from_no: number; to_no: number; width: number; received_on: string | null; active: number }

const toRange = (r: BookRow): ChequeBookRange => ({ id: r.id, fromNo: r.from_no, toNo: r.to_no, width: r.width, active: !!r.active })

function assertBank(db: DB, id: number): string {
  const b = bankLedgers(db).find((x) => x.id === id)
  if (!b) throw new Error('That ledger is not a bank account')
  return b.name
}

export function listChequeBooks(db: DB, bankLedgerId?: number): ChequeBook[] {
  const rows = db
    .prepare(`SELECT * FROM cheque_books ${bankLedgerId ? 'WHERE bank_ledger_id = ?' : ''} ORDER BY bank_ledger_id, from_no`)
    .all(...(bankLedgerId ? [bankLedgerId] : [])) as BookRow[]
  const names = new Map(bankLedgers(db).map((b) => [b.id, b.name]))
  return rows.map((r) => ({
    ...toRange(r),
    bankLedgerId: r.bank_ledger_id,
    bankLedgerName: names.get(r.bank_ledger_id) ?? '',
    name: r.name,
    receivedOn: r.received_on,
    leaves: r.to_no - r.from_no + 1,
    used: (db.prepare('SELECT COUNT(*) AS n FROM cheques WHERE cheque_book_id = ?').get(r.id) as { n: number }).n
  }))
}

export function saveChequeBook(db: DB, input: ChequeBookInput, id?: number): ChequeBook {
  assertBank(db, input.bankLedgerId)
  if (input.toNo < input.fromNo) throw new Error('The last leaf number must not be below the first')
  if (input.toNo - input.fromNo >= 10000) throw new Error('A cheque book has at most 10,000 leaves')
  const others = (db.prepare('SELECT * FROM cheque_books WHERE bank_ledger_id = ?').all(input.bankLedgerId) as BookRow[]).map(toRange)
  const clash = overlappingBook(others, input.fromNo, input.toNo, id)
  if (clash) throw new Error(`Leaves overlap another cheque book (${formatLeaf(clash.fromNo, clash.width)}–${formatLeaf(clash.toNo, clash.width)})`)
  if (id != null) {
    const before = db.prepare('SELECT * FROM cheque_books WHERE id = ?').get(id) as BookRow | undefined
    if (!before) throw new Error('Cheque book not found')
    const outside = db
      .prepare('SELECT number FROM cheques WHERE cheque_book_id = ? AND (leaf < ? OR leaf > ?) LIMIT 1')
      .get(id, input.fromNo, input.toNo) as { number: string } | undefined
    if (outside) throw new Error(`Cheque ${outside.number} from this book would fall outside the new range`)
    db.prepare('UPDATE cheque_books SET bank_ledger_id = ?, name = ?, from_no = ?, to_no = ?, width = ?, received_on = ?, active = ? WHERE id = ?').run(
      input.bankLedgerId, input.name.trim(), input.fromNo, input.toNo, input.width, input.receivedOn, input.active ? 1 : 0, id
    )
    writeAudit(db, 'cheque_book', id, 'update', before, input)
  } else {
    const res = db
      .prepare('INSERT INTO cheque_books (bank_ledger_id, name, from_no, to_no, width, received_on, active) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(input.bankLedgerId, input.name.trim(), input.fromNo, input.toNo, input.width, input.receivedOn, input.active ? 1 : 0)
    id = Number(res.lastInsertRowid)
    writeAudit(db, 'cheque_book', id, 'create', null, input)
  }
  return listChequeBooks(db, input.bankLedgerId).find((b) => b.id === id)!
}

export function deleteChequeBook(db: DB, id: number): void {
  const before = db.prepare('SELECT * FROM cheque_books WHERE id = ?').get(id)
  if (!before) throw new Error('Cheque book not found')
  const used = (db.prepare('SELECT COUNT(*) AS n FROM cheques WHERE cheque_book_id = ?').get(id) as { n: number }).n
  if (used > 0) throw new Error('Cheques from this book are in the register — deactivate it instead')
  db.prepare('DELETE FROM cheque_books WHERE id = ?').run(id)
  writeAudit(db, 'cheque_book', id, 'delete', before, null)
}


interface ChequeRow {
  id: number; cheque_book_id: number | null; number: string; leaf: number | null; status: StoredChequeStatus; voucher_id: number | null
  payee: string | null; amount: number | null; cheque_date: string | null; note: string | null; printed_count: number
}

/** Every leaf of the account's books (untouched ones as 'available') plus register entries
 *  outside any book, ordered by number. `includeAvailable` false lists only used leaves. */
export function chequeRegister(db: DB, bankLedgerId: number, includeAvailable = true): ChequeRegisterRow[] {
  assertBank(db, bankLedgerId)
  const books = (db.prepare('SELECT * FROM cheque_books WHERE bank_ledger_id = ? ORDER BY from_no').all(bankLedgerId) as BookRow[])
  const cheques = db.prepare('SELECT * FROM cheques WHERE bank_ledger_id = ?').all(bankLedgerId) as ChequeRow[]
  const voucherInfo = db.prepare(
    `SELECT v.number, v.date, v.deleted_at AS deletedAt,
            (SELECT vl.bank_date FROM voucher_lines vl WHERE vl.voucher_id = v.id AND vl.ledger_id = ? ORDER BY vl.id LIMIT 1) AS bankDate
     FROM vouchers v WHERE v.id = ?`
  )
  const rows: ChequeRegisterRow[] = []
  const byLeaf = new Map<string, ChequeRow>()
  for (const c of cheques) byLeaf.set(c.cheque_book_id != null && c.leaf != null ? `${c.cheque_book_id}-${c.leaf}` : `x${c.id}`, c)
  const fromCheque = (c: ChequeRow, book: BookRow | null): ChequeRegisterRow => {
    const v = c.voucher_id != null ? (voucherInfo.get(bankLedgerId, c.voucher_id) as { number: string; date: string; deletedAt: string | null; bankDate: string | null } | undefined) : undefined
    return {
      key: `c${c.id}`, chequeId: c.id, bookId: c.cheque_book_id, bookName: book?.name ?? null, number: c.number, leaf: c.leaf,
      status: displayStatus(c.status, v && !v.deletedAt ? v.bankDate : null),
      voucherId: c.voucher_id, voucherNumber: v?.number ?? null, chequeDate: c.cheque_date ?? v?.date ?? null,
      payee: c.payee, amount: c.amount, bankDate: v?.bankDate ?? null, note: c.note, printedCount: c.printed_count
    }
  }
  for (const b of books) {
    for (let n = b.from_no; n <= b.to_no; n++) {
      const c = byLeaf.get(`${b.id}-${n}`)
      if (c) rows.push(fromCheque(c, b))
      else if (includeAvailable && b.active) {
        rows.push({
          key: `l${b.id}-${n}`, chequeId: null, bookId: b.id, bookName: b.name, number: formatLeaf(n, b.width), leaf: n, status: 'available',
          voucherId: null, voucherNumber: null, chequeDate: null, payee: null, amount: null, bankDate: null, note: null, printedCount: 0
        })
      }
    }
  }
  for (const c of cheques) if (c.cheque_book_id == null) rows.push(fromCheque(c, null))
  return rows.sort((a, z) => (a.leaf ?? Number.MAX_SAFE_INTEGER) - (z.leaf ?? Number.MAX_SAFE_INTEGER) || a.number.localeCompare(z.number))
}

function usedLeaves(db: DB, bankLedgerId: number): Set<number> {
  return new Set(
    (db.prepare('SELECT leaf FROM cheques WHERE bank_ledger_id = ? AND leaf IS NOT NULL').all(bankLedgerId) as { leaf: number }[]).map((r) => r.leaf)
  )
}

export function nextChequeNumber(db: DB, bankLedgerId: number): { bookId: number; leaf: number; label: string } | null {
  const books = (db.prepare('SELECT * FROM cheque_books WHERE bank_ledger_id = ?').all(bankLedgerId) as BookRow[]).map(toRange)
  return nextAvailableLeaf(books, usedLeaves(db, bankLedgerId))
}

export type ChequePlan =
  /** No cheque book for this bank: print with the voucher's own instrument number, record nothing. */
  | { mode: 'unregistered'; number: string | null }
  /** The voucher already has an issued cheque: re-print it. */
  | { mode: 'existing'; chequeId: number; number: string }
  /** Issue this exact leaf (and write it on the voucher when it carries none). */
  | { mode: 'issue'; bookId: number; leaf: number; number: string; setInstrument: boolean }

/**
 * What printing this payment's cheque would do — validated, nothing written. Rules:
 *  - no cheque book for the bank → the pre-0.8 behaviour: print with the voucher's instrument
 *    number, nothing goes into the register;
 *  - the voucher already has an issued cheque → re-print that one;
 *  - the voucher carries an instrument number → it must be a free leaf of one of the bank's
 *    books (never a silent substitute); outside every range or already used → refused;
 *  - no instrument number → the next free leaf, written onto the voucher (refused when the voucher
 *    is inside the locked period, since the voucher could not then carry the number).
 * Register, printed cheque and voucher therefore always agree.
 */
export function planCheque(db: DB, voucherId: number, bankLedgerId: number, number?: string | null): ChequePlan {
  chequeData(db, voucherId, bankLedgerId)
  const voucher = getVoucher(db, voucherId)!
  const bankName = assertBank(db, bankLedgerId)
  const existing = db.prepare("SELECT * FROM cheques WHERE voucher_id = ? AND bank_ledger_id = ? AND status = 'issued'").get(voucherId, bankLedgerId) as ChequeRow | undefined
  if (existing) {
    if (number && number.trim() !== existing.number) throw new Error(`This voucher already has cheque ${existing.number} — cancel it first to use another leaf`)
    return { mode: 'existing', chequeId: existing.id, number: existing.number }
  }
  const rows = db.prepare('SELECT * FROM cheque_books WHERE bank_ledger_id = ?').all(bankLedgerId) as BookRow[]
  if (rows.length === 0) return { mode: 'unregistered', number: voucher.instrumentNo }
  const books = rows.map(toRange)
  const used = usedLeaves(db, bankLedgerId)
  const wanted = (number ?? '').trim() || (voucher.instrumentNo ?? '').trim()
  if (wanted) {
    const leaf = leafValue(wanted)
    const book = leaf != null ? bookFor(books, leaf) : null
    if (leaf == null || !book) {
      throw new Error(`Cheque number ${wanted} on this voucher is not in any cheque book of ${bankName} — correct the voucher's instrument number or add the book`)
    }
    if (!book.active) throw new Error(`Cheque ${wanted} belongs to an inactive cheque book of ${bankName}`)
    if (used.has(leaf)) {
      const taken = db.prepare('SELECT status FROM cheques WHERE bank_ledger_id = ? AND leaf = ?').get(bankLedgerId, leaf) as { status: string } | undefined
      throw new Error(`Cheque ${formatLeaf(leaf, book.width)} is already in the register (${taken?.status ?? 'used'}) — put the right number on the voucher`)
    }
    return { mode: 'issue', bookId: book.id, leaf, number: formatLeaf(leaf, book.width), setInstrument: !voucher.instrumentNo || voucher.instrumentNo.trim() !== formatLeaf(leaf, book.width) }
  }
  const next = nextAvailableLeaf(books, used)
  if (!next) throw new Error(`No cheque leaves left for ${bankName} — add a cheque book (Banking → Cheques)`)
  const lock = getLockDate(db)
  if (lock && voucher.date <= lock) throw new Error(`The voucher is inside the locked period (up to ${lock}), so it can't take a cheque number — unlock or type the number on it first`)
  return { mode: 'issue', bookId: next.bookId, leaf: next.leaf, number: next.label, setInstrument: true }
}

/**
 * Carry out a plan (re-validated inside the transaction). Returns the register row, or null when
 * the bank has no cheque book (nothing is recorded). When the voucher's instrument number is
 * filled or normalised (457 → 000457) the change is audited as a voucher update.
 */
export function issueCheque(db: DB, voucherId: number, bankLedgerId: number, number?: string | null): ChequeRegisterRow | null {
  const data = chequeData(db, voucherId, bankLedgerId)
  const id = db.transaction((): number | null => {
    const plan = planCheque(db, voucherId, bankLedgerId, number)
    if (plan.mode === 'unregistered') return null
    if (plan.mode === 'existing') return plan.chequeId
    const res = db
      .prepare(
        `INSERT INTO cheques (bank_ledger_id, cheque_book_id, number, leaf, status, voucher_id, payee, amount, cheque_date)
         VALUES (?, ?, ?, ?, 'issued', ?, ?, ?, ?)`
      )
      .run(bankLedgerId, plan.bookId, plan.number, plan.leaf, voucherId, data.payee, data.amount, data.date)
    const chequeId = Number(res.lastInsertRowid)
    writeAudit(db, 'cheque', chequeId, 'create', null, { bankLedgerId, number: plan.number, voucherId, payee: data.payee, amount: data.amount, chequeDate: data.date })
    if (plan.setInstrument) {
      const v = getVoucher(db, voucherId)!
      // The cheque date defaults to the voucher date, as the voucher editor does.
      const instrumentDate = v.instrumentDate ?? v.date
      db.prepare("UPDATE vouchers SET instrument_no = ?, instrument_date = ?, updated_at = datetime('now') WHERE id = ?").run(plan.number, instrumentDate, voucherId)
      writeAudit(db, 'voucher', voucherId, 'update', { instrumentNo: v.instrumentNo, instrumentDate: v.instrumentDate }, { instrumentNo: plan.number, instrumentDate, chequeIssued: chequeId })
    }
    return chequeId
  })()
  if (id == null) return null
  return chequeRegister(db, bankLedgerId, false).find((r) => r.chequeId === id)!
}

/** Undo an issue whose PDF could not be written (the leaf goes back to the book). Audited. */
export function revokeIssuedCheque(db: DB, chequeId: number, previousInstrumentNo: string | null): void {
  const row = db.prepare('SELECT * FROM cheques WHERE id = ?').get(chequeId) as ChequeRow | undefined
  if (!row) return
  db.transaction(() => {
    db.prepare('DELETE FROM cheques WHERE id = ?').run(chequeId)
    writeAudit(db, 'cheque', chequeId, 'delete', row, { reason: 'cheque PDF could not be written' })
    if (row.voucher_id != null) {
      const v = getVoucher(db, row.voucher_id)
      if (v && v.instrumentNo === row.number && previousInstrumentNo !== row.number) {
        db.prepare("UPDATE vouchers SET instrument_no = ?, instrument_date = CASE WHEN ? IS NULL THEN NULL ELSE instrument_date END, updated_at = datetime('now') WHERE id = ?").run(previousInstrumentNo, previousInstrumentNo, row.voucher_id)
        writeAudit(db, 'voucher', row.voucher_id, 'update', { instrumentNo: row.number }, { instrumentNo: previousInstrumentNo, chequeRevoked: chequeId })
      }
    }
  })()
}

/** Count a print of an issued cheque (the PDF itself is audited as an export by the IPC). */
export function recordChequePrint(db: DB, chequeId: number): void {
  db.prepare("UPDATE cheques SET printed_count = printed_count + 1, last_printed_at = datetime('now'), updated_at = datetime('now') WHERE id = ?").run(chequeId)
}


/** Cancel / stop-payment a leaf (used or blank), or put a cancelled one back to issued. Audited. */
export function setChequeStatus(db: DB, input: ChequeStatusInput): ChequeRegisterRow {
  assertBank(db, input.bankLedgerId)
  const run = db.transaction(() => {
    let row: ChequeRow | undefined
    if (input.chequeId) row = db.prepare('SELECT * FROM cheques WHERE id = ? AND bank_ledger_id = ?').get(input.chequeId, input.bankLedgerId) as ChequeRow | undefined
    else if (input.number) row = db.prepare('SELECT * FROM cheques WHERE number = ? AND bank_ledger_id = ?').get(input.number.trim(), input.bankLedgerId) as ChequeRow | undefined
    if (row) {
      if (input.status === 'issued' && row.voucher_id == null) throw new Error('A blank leaf can only be issued from a payment voucher (Print cheque)')
      if (input.status === 'issued' && row.voucher_id != null) {
        const v = db.prepare(`SELECT 1 FROM vouchers v WHERE v.id = ? AND ${NOT_DELETED}`).get(row.voucher_id)
        if (!v) throw new Error('The payment voucher of this cheque is in the bin')
        const other = db.prepare("SELECT number FROM cheques WHERE voucher_id = ? AND status = 'issued' AND id <> ?").get(row.voucher_id, row.id) as { number: string } | undefined
        if (other) throw new Error(`That voucher now has cheque ${other.number}`)
      }
      db.prepare("UPDATE cheques SET status = ?, note = ?, updated_at = datetime('now') WHERE id = ?").run(input.status, input.note ?? row.note, row.id)
      writeAudit(db, 'cheque', row.id, 'update', { status: row.status, note: row.note }, { status: input.status, note: input.note ?? row.note })
      return row.number
    }
    if (input.status === 'issued') throw new Error('Cheque not found')
    const label = (input.number ?? '').trim()
    const leaf = leafValue(label)
    if (leaf == null) throw new Error('Give the leaf number to cancel or stop')
    const books = (db.prepare('SELECT * FROM cheque_books WHERE bank_ledger_id = ?').all(input.bankLedgerId) as BookRow[]).map(toRange)
    const book = bookFor(books, leaf)
    const finalLabel = book ? formatLeaf(leaf, book.width) : label
    const res = db
      .prepare('INSERT INTO cheques (bank_ledger_id, cheque_book_id, number, leaf, status, note) VALUES (?, ?, ?, ?, ?, ?)')
      .run(input.bankLedgerId, book?.id ?? null, finalLabel, leaf, input.status, input.note ?? null)
    writeAudit(db, 'cheque', Number(res.lastInsertRowid), 'create', null, { bankLedgerId: input.bankLedgerId, number: finalLabel, status: input.status, note: input.note ?? null })
    return finalLabel
  })
  const label = run()
  return chequeRegister(db, input.bankLedgerId, false).find((r) => r.number === label)!
}
