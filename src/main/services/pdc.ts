// Post-dated cheque register (WP 4.1), received and issued. A PDC is a post-dated payment or
// receipt voucher (vouchers.post_dated = 1, out of the books until it matures — vouchers.ts).
// After maturity it stays in this register through pdc_events (migration 032's trigger records
// every maturity), where a bounce is handled: the entry is reversed by a new voucher (and any
// bank charges booked by another), all through saveVoucher and audited.
import type { DB } from '../db/connection'
import type { PdcDirection, PdcStatus, PdcRegisterRow, PdcDue, BounceInput, BounceResult } from '@shared/bankTypes'
import { addDays } from '@shared/dashboard'
import { writeAudit } from './audit'
import { bankLedgers } from './banking'
import { NOT_DELETED, getLockDate, getVoucher, saveVoucher } from './vouchers'



interface Row {
  voucherId: number; number: string; voucherTypeName: string; date: string; postDated: number; partyLedgerId: number | null
  partyName: string | null; instrumentNo: string | null; instrumentDate: string | null
  maturedAt: string | null; bouncedOn: string | null; bounceVoucherId: number | null; bounceCharges: number | null; bounceReason: string | null
}

/** The register: pending PDCs plus matured / bounced ones still tracked (pdc_events). */
export function pdcRegisterFull(db: DB, today: string): PdcRegisterRow[] {
  const banks = new Map(bankLedgers(db).map((b) => [b.id, b.name]))
  const rows = db
    .prepare(
      `SELECT v.id AS voucherId, v.number, vt.name AS voucherTypeName, v.date, v.post_dated AS postDated,
              v.party_ledger_id AS partyLedgerId, l.name AS partyName, v.instrument_no AS instrumentNo, v.instrument_date AS instrumentDate,
              e.matured_at AS maturedAt, e.bounced_on AS bouncedOn, e.bounce_voucher_id AS bounceVoucherId,
              e.bounce_charges AS bounceCharges, e.bounce_reason AS bounceReason
       FROM vouchers v
       JOIN voucher_types vt ON vt.id = v.voucher_type_id
       LEFT JOIN ledgers l ON l.id = v.party_ledger_id
       LEFT JOIN pdc_events e ON e.voucher_id = v.id
       WHERE ${NOT_DELETED} AND (v.post_dated = 1 OR e.voucher_id IS NOT NULL)
       ORDER BY v.date, v.id`
    )
    .all() as Row[]
  const lineStmt = db.prepare('SELECT ledger_id AS ledgerId, dr_cr AS drCr, amount FROM voucher_lines WHERE voucher_id = ? ORDER BY line_order, id')
  return rows.map((r) => {
    const lines = lineStmt.all(r.voucherId) as { ledgerId: number; drCr: 'dr' | 'cr'; amount: number }[]
    const bank = lines.find((l) => banks.has(l.ledgerId))
    const counter = lines.filter((l) => !banks.has(l.ledgerId)).sort((a, b) => b.amount - a.amount)[0]
    const direction: PdcDirection = bank ? (bank.drCr === 'dr' ? 'received' : 'issued') : 'issued'
    const amount = bank ? lines.filter((l) => l.ledgerId === bank.ledgerId && l.drCr === bank.drCr).reduce((s, l) => s + l.amount, 0) : lines.filter((l) => l.drCr === 'dr').reduce((s, l) => s + l.amount, 0)
    const status: PdcStatus = r.bouncedOn ? 'bounced' : r.postDated ? (r.date <= today ? 'due' : 'pending') : 'matured'
    const partyLedgerId = r.partyLedgerId ?? counter?.ledgerId ?? null
    const partyName = r.partyName ?? (counter ? ((db.prepare('SELECT name FROM ledgers WHERE id = ?').get(counter.ledgerId) as { name: string } | undefined)?.name ?? null) : null)
    return {
      voucherId: r.voucherId, number: r.number, voucherTypeName: r.voucherTypeName, date: r.date, direction, partyLedgerId, partyName,
      bankLedgerId: bank?.ledgerId ?? null, bankLedgerName: bank ? (banks.get(bank.ledgerId) ?? null) : null,
      instrumentNo: r.instrumentNo, instrumentDate: r.instrumentDate, amount, status, maturedAt: r.maturedAt, bouncedOn: r.bouncedOn,
      bounceVoucherId: r.bounceVoucherId, bounceCharges: r.bounceCharges, bounceReason: r.bounceReason
    }
  })
}


/** PDCs maturing from now to today + days (and any already due) — the dashboard reminder. */
export function pdcsMaturing(db: DB, today: string, days = 7): PdcDue {
  const until = addDays(today, days)
  const due = pdcRegisterFull(db, today).filter((r) => (r.status === 'pending' || r.status === 'due') && r.date <= until)
  const sum = (d: PdcDirection): { count: number; amount: number } => {
    const xs = due.filter((r) => r.direction === d)
    return { count: xs.length, amount: xs.reduce((s, r) => s + r.amount, 0) }
  }
  return {
    until,
    received: sum('received'),
    issued: sum('issued'),
    overdue: due.filter((r) => r.status === 'due').length,
    items: due.slice(0, 6).map((r) => ({ voucherId: r.voucherId, number: r.number, date: r.date, direction: r.direction, partyName: r.partyName, amount: r.amount, status: r.status }))
  }
}



function systemType(db: DB, kind: string): number {
  const vt = db.prepare('SELECT id FROM voucher_types WHERE kind = ? AND is_system = 1 ORDER BY id LIMIT 1').get(kind) as { id: number } | undefined
  if (!vt) throw new Error(`No ${kind} voucher type`)
  return vt.id
}

/**
 * Bounce a matured PDC: a reversal voucher mirrors the original (a received cheque becomes a
 * payment out of the bank back to the party; an issued one a receipt into the bank from the
 * party), dated the return date; bank charges, if any, are a separate payment from the bank to
 * the charges ledger — or to the party for a received cheque when they are recovered. Both go
 * through saveVoucher (validation, lock date, audit); the bounce is recorded in pdc_events.
 */
export function bouncePdc(db: DB, input: BounceInput): BounceResult {
  const v = getVoucher(db, input.voucherId)
  if (!v) throw new Error('Voucher not found')
  if (v.deletedAt) throw new Error('Voucher is in the bin')
  if (v.postDated) throw new Error('This cheque has not matured yet — it is not in the books, so there is nothing to reverse (edit or bin the voucher instead)')
  if (input.date < v.date) throw new Error('The cheque cannot bounce before its date')
  const event = db.prepare('SELECT * FROM pdc_events WHERE voucher_id = ?').get(input.voucherId) as { bounced_on: string | null } | undefined
  if (event?.bounced_on) throw new Error('This cheque is already marked bounced')
  const banks = new Set(bankLedgers(db).map((b) => b.id))
  const bankLines = v.lines.filter((l) => banks.has(l.ledgerId))
  if (bankLines.length === 0) throw new Error('This voucher has no bank entry to reverse')
  const bankLedgerId = bankLines[0]!.ledgerId
  const received = bankLines[0]!.drCr === 'dr'
  if (input.charges < 0) throw new Error('Charges cannot be negative')
  const party = v.partyLedgerId ?? v.lines.filter((l) => !banks.has(l.ledgerId)).sort((a, b) => b.amount - a.amount)[0]?.ledgerId ?? null
  if (input.charges > 0 && !(received && input.recoverChargesFromParty) && !input.chargesLedgerId) throw new Error('Pick the ledger for the bank charges')
  const lock = getLockDate(db)
  if (lock && input.date <= lock) throw new Error(`Books are locked up to ${lock}`)

  const run = db.transaction((): BounceResult => {
    const reason = input.reason.trim()
    const reversal = saveVoucher(db, {
      voucherTypeId: systemType(db, received ? 'payment' : 'receipt'),
      date: input.date,
      partyLedgerId: v.partyLedgerId,
      narration: `Cheque ${v.instrumentNo ?? ''} bounced — reversal of ${v.number}${reason ? `: ${reason}` : ''}`.replace(/\s+/g, ' ').slice(0, 1000),
      reference: v.number,
      instrumentNo: v.instrumentNo,
      lines: v.lines.map((l) => ({ ledgerId: l.ledgerId, drCr: l.drCr === 'dr' ? ('cr' as const) : ('dr' as const), amount: l.amount, costAllocations: [] }))
    })
    let chargesVoucherId: number | null = null
    if (input.charges > 0) {
      const toLedger = received && input.recoverChargesFromParty ? party : input.chargesLedgerId
      if (!toLedger) throw new Error('No ledger for the bank charges')
      const charges = saveVoucher(db, {
        voucherTypeId: systemType(db, 'payment'),
        date: input.date,
        partyLedgerId: received && input.recoverChargesFromParty ? v.partyLedgerId : null,
        narration: `Bank charges — cheque ${v.instrumentNo ?? ''} of ${v.number} returned`.replace(/\s+/g, ' '),
        reference: v.number,
        lines: [
          { ledgerId: toLedger, drCr: 'dr', amount: input.charges, costAllocations: [] },
          { ledgerId: bankLedgerId, drCr: 'cr', amount: input.charges, costAllocations: [] }
        ]
      })
      chargesVoucherId = charges.id
    }
    const before = db.prepare('SELECT * FROM pdc_events WHERE voucher_id = ?').get(input.voucherId) ?? null
    db.prepare(
      `INSERT INTO pdc_events (voucher_id, bounced_on, bounce_voucher_id, bounce_charges, bounce_reason) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(voucher_id) DO UPDATE SET bounced_on = excluded.bounced_on, bounce_voucher_id = excluded.bounce_voucher_id,
         bounce_charges = excluded.bounce_charges, bounce_reason = excluded.bounce_reason`
    ).run(input.voucherId, input.date, reversal.id, input.charges, reason || null)
    writeAudit(db, 'pdc', input.voucherId, 'update', before, {
      bouncedOn: input.date, reversalVoucherId: reversal.id, chargesVoucherId, charges: input.charges, reason: reason || null
    })
    return { reversalVoucherId: reversal.id, chargesVoucherId }
  })
  return run()
}
