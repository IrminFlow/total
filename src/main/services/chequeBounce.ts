/**
 * Cheques that came back (#138).
 *
 * A returned cheque is two separate facts and the app needs both.
 *
 * The accounting one is a reversal: the receipt that put ₹50,000 into the bank never happened,
 * so the money comes back out and the customer owes it again. That much is a journal, and
 * somebody could always have typed it by hand — badly, because the hand-typed version routinely
 * misses the bill reference and leaves the invoice showing as paid while the party balance says
 * otherwise.
 *
 * The other fact is about the customer, and no voucher carries it. A journal reversing a receipt
 * is indistinguishable from a journal correcting a keying error, so "this party's cheques bounce"
 * — the thing that should stop the next credit sale — is unrecoverable from the books alone.
 * That is why `cheque_bounces` exists as a row rather than being inferred.
 *
 * What the reversal does, and why:
 *   - every line of the original voucher, with dr and cr swapped, so the reversal is exact
 *     rather than reconstructed from the "important" two lines;
 *   - each `against` bill reference re-raised as a `new` one under the SAME bill name, so the
 *     invoice re-opens instead of the money landing on account as an unexplained debit;
 *   - the re-opened bill keeps the ORIGINAL due date. Ageing that restarted on the bounce date
 *     would reward the customer for the cheque failing, and the whole reason to record a bounce
 *     is that it should count against them;
 *   - the bank's return charge, when there was one, on the same journal — it is part of the same
 *     event and splitting it across two vouchers makes the pair impossible to read later.
 */

import type { DB } from '../db/connection'
import { isValidISODate } from '@shared/dates'
import { deleteVoucher, getVoucher, saveVoucher } from './vouchers'
import { bankLedgers } from './banking'
import { writeAudit } from './audit'

export interface BounceInput {
  /** The receipt or payment whose cheque was returned. */
  voucherId: number
  /** The day the bank returned it. */
  bounceDate: string
  /** What the return memo said — 'Funds insufficient', 'Signature differs'. */
  reason?: string | null
  /** Bank's return charge in paise. 0 (the default) when the bank charged nothing. */
  chargeAmount?: number
  /** Where the charge is debited. Required when chargeAmount > 0. */
  chargeLedgerId?: number | null
  /** Which bank line was returned. Only needed when the voucher touches more than one bank. */
  bankLedgerId?: number | null
}

export interface BounceRecord {
  id: number
  voucherId: number
  voucherNumber: string
  voucherDate: string
  partyName: string | null
  instrumentNo: string | null
  amount: number
  bounceDate: string
  reason: string | null
  chargeAmount: number
  reversalVoucherId: number | null
  reversalNumber: string | null
}

/** Bank ledgers this voucher touches, in line order. */
function bankLinesOf(db: DB, lines: { ledgerId: number; drCr: 'dr' | 'cr'; amount: number }[]): number[] {
  const banks = new Set(bankLedgers(db).map((b) => b.id))
  return [...new Set(lines.filter((l) => banks.has(l.ledgerId)).map((l) => l.ledgerId))]
}

/**
 * Record a bounce and post its reversal, in one transaction.
 *
 * Refuses rather than guesses in every case where guessing would produce a plausible-looking
 * wrong entry: a voucher that is not a cheque-bearing receipt or payment, a bounce dated before
 * the cheque existed, a second bounce on the same voucher, a charge with nowhere to post it.
 */
export function bounceCheque(db: DB, input: BounceInput): BounceRecord {
  if (!isValidISODate(input.bounceDate)) throw new Error('Invalid bounce date')
  const chargeAmount = input.chargeAmount ?? 0
  if (!Number.isInteger(chargeAmount) || chargeAmount < 0) throw new Error('Invalid return charge')

  const voucher = getVoucher(db, input.voucherId)
  if (!voucher || voucher.deletedAt) throw new Error('Voucher not found')

  const type = db.prepare('SELECT kind FROM voucher_types WHERE id = ?').get(voucher.voucherTypeId) as
    | { kind: string }
    | undefined
  if (!type || (type.kind !== 'receipt' && type.kind !== 'payment')) {
    throw new Error('Only a receipt or a payment can be marked as a bounced cheque')
  }
  if (input.bounceDate < voucher.date) {
    throw new Error('A cheque cannot bounce before the voucher that recorded it')
  }

  const already = db.prepare('SELECT id FROM cheque_bounces WHERE voucher_id = ?').get(input.voucherId) as
    | { id: number }
    | undefined
  if (already) {
    throw new Error('This voucher is already recorded as bounced — re-present it as a fresh receipt')
  }

  const banks = bankLinesOf(db, voucher.lines)
  if (banks.length === 0) throw new Error('This voucher has no bank line — nothing was returned')
  let bankLedgerId = input.bankLedgerId ?? null
  if (bankLedgerId == null) {
    if (banks.length > 1) throw new Error('This voucher touches more than one bank — say which one returned the cheque')
    bankLedgerId = banks[0]!
  } else if (!banks.includes(bankLedgerId)) {
    throw new Error('That bank is not on this voucher')
  }

  if (chargeAmount > 0 && input.chargeLedgerId == null) {
    throw new Error('A return charge needs a ledger to post it to')
  }

  const journal = db.prepare("SELECT id FROM voucher_types WHERE kind = 'journal' AND is_system = 1").get() as
    | { id: number }
    | undefined
  if (!journal) throw new Error('No Journal voucher type to post the reversal against')

  // Every line flipped, not just the two that look important: a receipt with a TDS line or a
  // discount line reverses wrongly if only the party and the bank are undone.
  const lines = voucher.lines.map((l) => ({
    ledgerId: l.ledgerId,
    drCr: (l.drCr === 'dr' ? 'cr' : 'dr') as 'dr' | 'cr',
    amount: l.amount,
    costAllocations: []
  }))
  if (chargeAmount > 0) {
    lines.push({ ledgerId: input.chargeLedgerId!, drCr: 'dr', amount: chargeAmount, costAllocations: [] })
    lines.push({ ledgerId: bankLedgerId, drCr: 'cr', amount: chargeAmount, costAllocations: [] })
  }

  const billRefs = voucher.billRefs
    .filter((r) => r.kind === 'against')
    .map((r) => ({ kind: 'new' as const, name: r.name, amount: r.amount, dueDate: r.dueDate }))

  const label = voucher.instrumentNo ? `Cheque ${voucher.instrumentNo}` : 'Cheque'
  const narration = `${label} returned unpaid — reversal of ${voucher.number}${input.reason ? ` (${input.reason})` : ''}`

  const run = db.transaction(() => {
    const reversal = saveVoucher(db, {
      voucherTypeId: journal.id,
      date: input.bounceDate,
      number: undefined,
      partyLedgerId: voucher.partyLedgerId,
      narration,
      reference: voucher.number,
      instrumentNo: voucher.instrumentNo,
      instrumentDate: voucher.instrumentDate,
      transporterId: null,
      vehicleNo: null,
      transportDistanceKm: null,
      currencyCode: null,
      exchangeRate: null,
      lines,
      inventory: [],
      billRefs,
      tds: null
    })
    const res = db
      .prepare(
        `INSERT INTO cheque_bounces (voucher_id, reversal_voucher_id, bounce_date, reason, charge_amount)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run(input.voucherId, reversal.id, input.bounceDate, input.reason ?? null, chargeAmount)
    const id = Number(res.lastInsertRowid)
    writeAudit(db, 'cheque_bounce', id, 'create', null, {
      voucherId: input.voucherId,
      reversalVoucherId: reversal.id,
      bounceDate: input.bounceDate,
      chargeAmount
    })
    return id
  })

  const id = run()
  const record = listBounces(db).find((b) => b.id === id)
  if (!record) throw new Error('Bounce not found after recording')
  return record
}

/**
 * Undo a recorded bounce.
 *
 * Deletes the reversal voucher (into the bin, like any other) as well as the record, because a
 * bounce recorded against the wrong cheque leaves a journal on the books that nothing else
 * explains. The reversal is deleted first so a lock on its period stops the whole undo rather
 * than leaving an orphan.
 */
export function unbounce(db: DB, id: number): void {
  const row = db.prepare('SELECT * FROM cheque_bounces WHERE id = ?').get(id) as
    | { id: number; voucher_id: number; reversal_voucher_id: number | null }
    | undefined
  if (!row) throw new Error('Bounce record not found')
  const run = db.transaction(() => {
    // deleteVoucher, not a hand-written UPDATE: it carries the period-lock check and writes the
    // audit row, and a reversal that vanished without either would be the exact kind of quiet
    // change to a closed period this feature exists to make visible.
    if (row.reversal_voucher_id != null) deleteVoucher(db, row.reversal_voucher_id)
    db.prepare('DELETE FROM cheque_bounces WHERE id = ?').run(id)
    writeAudit(db, 'cheque_bounce', id, 'delete', row, null)
  })
  run()
}

/** The bounced-cheque register: every recorded bounce, most recent first. */
export function listBounces(db: DB, from?: string, to?: string): BounceRecord[] {
  const where: string[] = []
  const args: unknown[] = []
  if (from) {
    where.push('b.bounce_date >= ?')
    args.push(from)
  }
  if (to) {
    where.push('b.bounce_date <= ?')
    args.push(to)
  }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : ''
  return db
    .prepare(
      `SELECT b.id, b.voucher_id AS voucherId, v.number AS voucherNumber, v.date AS voucherDate,
              p.name AS partyName, v.instrument_no AS instrumentNo,
              (SELECT COALESCE(SUM(vl.amount), 0) FROM voucher_lines vl
               WHERE vl.voucher_id = v.id AND vl.dr_cr = 'dr') AS amount,
              b.bounce_date AS bounceDate, b.reason, b.charge_amount AS chargeAmount,
              b.reversal_voucher_id AS reversalVoucherId, rv.number AS reversalNumber
       FROM cheque_bounces b
       JOIN vouchers v ON v.id = b.voucher_id
       LEFT JOIN ledgers p ON p.id = v.party_ledger_id
       LEFT JOIN vouchers rv ON rv.id = b.reversal_voucher_id
       ${clause}
       ORDER BY b.bounce_date DESC, b.id DESC`
    )
    .all(...args) as BounceRecord[]
}

/** How many of a party's cheques have come back — the number a credit decision wants. */
export function bounceCountByParty(db: DB): { partyLedgerId: number; partyName: string; bounces: number }[] {
  return db
    .prepare(
      `SELECT v.party_ledger_id AS partyLedgerId, p.name AS partyName, COUNT(*) AS bounces
       FROM cheque_bounces b
       JOIN vouchers v ON v.id = b.voucher_id
       JOIN ledgers p ON p.id = v.party_ledger_id
       WHERE v.party_ledger_id IS NOT NULL
       GROUP BY v.party_ledger_id, p.name
       ORDER BY bounces DESC, p.name`
    )
    .all() as { partyLedgerId: number; partyName: string; bounces: number }[]
}
