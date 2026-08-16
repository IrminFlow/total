import type { DB } from '../db/connection'
import type { Voucher, VoucherLine, InventoryLine, VoucherType } from '@shared/domain'
import { voucherInputSchema } from '@shared/schemas'
import type { VoucherInput, VoucherInputParsed } from '@shared/schemas'
import type { VoucherListRow } from '@shared/reports'
import { validateVoucher, type LedgerFacts } from '@shared/posting'
import { fyOf } from '@shared/dates'
import { cashBankGroupIds } from './masters'
import { writeAudit } from './audit'

interface VoucherRow {
  id: number; voucher_type_id: number; date: string; number: string
  party_ledger_id: number | null; narration: string | null; reference: string | null
  instrument_no: string | null; instrument_date: string | null
  transporter_id: string | null; vehicle_no: string | null; transport_distance: number | null
  pos_override: string | null
  currency_code: string | null; exchange_rate: number | null
  irn: string | null; irn_ack_no: string | null; irn_ack_date: string | null
  ewb_no: string | null; ewb_valid_upto: string | null
  deleted_at: string | null
  created_at: string; updated_at: string
}

/** Greppable filter for every query joining `vouchers` as `v` that must exclude binned vouchers. */
export const NOT_DELETED = 'v.deleted_at IS NULL'

/** Books-locked-up-to date (inclusive): vouchers dated on or before this date can't be
 *  saved/deleted/restored. Stored in `meta` under key 'lock_before'; null/absent = no lock. */
export function getLockDate(db: DB): string | null {
  const row = db.prepare("SELECT value FROM meta WHERE key = 'lock_before'").get() as { value: string } | undefined
  return row ? row.value : null
}

/** Set (or clear, with null) the period lock date. Audit-logged against the 'company' entity. */
export function setLockDate(db: DB, date: string | null): void {
  const old = getLockDate(db)
  if (date === null) {
    db.prepare("DELETE FROM meta WHERE key = 'lock_before'").run()
  } else {
    db.prepare("INSERT INTO meta (key, value) VALUES ('lock_before', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(date)
  }
  writeAudit(db, 'company', 0, 'update', { lockBefore: old }, { lockBefore: date })
}

function getVoucherType(db: DB, id: number): VoucherType {
  const row = db.prepare('SELECT * FROM voucher_types WHERE id = ?').get(id) as
    | {
        id: number; name: string; kind: VoucherType['kind']; numbering: 'auto' | 'manual'; prefix: string
        suffix: string; pad_width: number; restart_fy: number; is_system: number
      }
    | undefined
  if (!row) throw new Error('Voucher type not found')
  return {
    id: row.id, name: row.name, kind: row.kind, numbering: row.numbering, prefix: row.prefix,
    suffix: row.suffix, padWidth: row.pad_width, restartFy: !!row.restart_fy, isSystem: !!row.is_system
  }
}

export function getVoucher(db: DB, id: number): Voucher | null {
  const v = db.prepare('SELECT * FROM vouchers WHERE id = ?').get(id) as VoucherRow | undefined
  if (!v) return null
  const lines = db
    .prepare('SELECT id, ledger_id, dr_cr, amount, bank_date FROM voucher_lines WHERE voucher_id = ? ORDER BY line_order, id')
    .all(id) as { id: number; ledger_id: number; dr_cr: 'dr' | 'cr'; amount: number; bank_date: string | null }[]
  const inventory = db
    .prepare('SELECT id, stock_item_id, godown_id, qty_milli, rate_paise, amount, direction FROM inventory_lines WHERE voucher_id = ? ORDER BY line_order, id')
    .all(id) as { id: number; stock_item_id: number; godown_id: number | null; qty_milli: number; rate_paise: number; amount: number; direction: 'in' | 'out' }[]

  const costAllocRows = lines.length
    ? (db
        .prepare(
          `SELECT voucher_line_id, cost_centre_id, amount FROM voucher_line_cost_allocations
           WHERE voucher_line_id IN (${lines.map(() => '?').join(',')})`
        )
        .all(...lines.map((l) => l.id)) as { voucher_line_id: number; cost_centre_id: number; amount: number }[])
    : []
  const allocByLine = new Map<number, { costCentreId: number; amount: number }[]>()
  for (const r of costAllocRows) {
    const list = allocByLine.get(r.voucher_line_id) ?? []
    list.push({ costCentreId: r.cost_centre_id, amount: r.amount })
    allocByLine.set(r.voucher_line_id, list)
  }

  const billRefRows = db
    .prepare('SELECT kind, name, amount, due_date FROM bill_refs WHERE voucher_id = ? ORDER BY id')
    .all(id) as { kind: 'new' | 'against'; name: string; amount: number; due_date: string | null }[]

  const tdsRow = db
    .prepare('SELECT section_id, base_amount, tds_amount FROM tds_entries WHERE voucher_id = ?')
    .get(id) as { section_id: number; base_amount: number; tds_amount: number } | undefined

  return {
    id: v.id,
    voucherTypeId: v.voucher_type_id,
    date: v.date,
    number: v.number,
    partyLedgerId: v.party_ledger_id,
    narration: v.narration,
    reference: v.reference,
    instrumentNo: v.instrument_no,
    instrumentDate: v.instrument_date,
    transporterId: v.transporter_id,
    vehicleNo: v.vehicle_no,
    transportDistanceKm: v.transport_distance,
    posOverride: v.pos_override,
    currencyCode: v.currency_code,
    exchangeRate: v.exchange_rate,
    irn: v.irn,
    irnAckNo: v.irn_ack_no,
    irnAckDate: v.irn_ack_date,
    ewbNo: v.ewb_no,
    ewbValidUpto: v.ewb_valid_upto,
    deletedAt: v.deleted_at,
    createdAt: v.created_at,
    updatedAt: v.updated_at,
    lines: lines.map(
      (l): VoucherLine => ({
        id: l.id, ledgerId: l.ledger_id, drCr: l.dr_cr, amount: l.amount, bankDate: l.bank_date,
        costAllocations: allocByLine.get(l.id) ?? []
      })
    ),
    inventory: inventory.map(
      (l): InventoryLine => ({
        id: l.id, stockItemId: l.stock_item_id, godownId: l.godown_id,
        qtyMilli: l.qty_milli, ratePaise: l.rate_paise, amount: l.amount, direction: l.direction
      })
    ),
    billRefs: billRefRows.map((r) => ({ kind: r.kind, name: r.name, amount: r.amount, dueDate: r.due_date })),
    tds: tdsRow ? { sectionId: tdsRow.section_id, baseAmount: tdsRow.base_amount, tdsAmount: tdsRow.tds_amount } : null
  }
}

/**
 * Next auto number for a voucher type: prefix + zero-padded sequence + suffix.
 * The scan window is the FY containing `date` (restartFy true, the default — Tally-style numbering
 * that resets to 1 each financial year), or every voucher of this type ever (restartFy false — one
 * running sequence across FYs). Either way, binned (soft-deleted) vouchers still count toward the
 * max — same as before this task, deliberately: a deleted number must never be reissued.
 */
export function nextVoucherNumber(db: DB, voucherTypeId: number, date: string, excludeVoucherId?: number): string {
  const vt = getVoucherType(db, voucherTypeId)
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
         FROM vouchers
         WHERE voucher_type_id = :vtId AND id IS NOT :excludeId ${fyClause}
       )`
    )
    .get({
      vtId: vt.id,
      excludeId: excludeVoucherId ?? -1,
      plen: vt.prefix.length,
      prefix: vt.prefix,
      slen: vt.suffix.length,
      suffix: vt.suffix,
      ...(vt.restartFy ? { from: fyOf(date).from, to: fyOf(date).to } : {})
    }) as { maxn: number }
  const seq = Math.max(0, row.maxn) + 1
  const padded = vt.padWidth > 0 ? String(seq).padStart(vt.padWidth, '0') : String(seq)
  return `${vt.prefix}${padded}${vt.suffix}`
}

export interface DuplicateWarning {
  voucherId: number
  number: string
  date: string
}

/** Same type + same total + same party within ±3 days — probable double entry. */
export function findDuplicates(db: DB, input: VoucherInputParsed, excludeId?: number): DuplicateWarning[] {
  const total = input.lines.filter((l) => l.drCr === 'dr').reduce((s, l) => s + l.amount, 0)
  if (total === 0) return []
  // Narrow by type + party + date window FIRST (all indexed voucher columns); only the few
  // surviving candidates pay for the line-total subquery — not every voucher in the book.
  const rows = db
    .prepare(
      `SELECT v.id AS voucherId, v.number, v.date
       FROM vouchers v
       WHERE v.voucher_type_id = ? AND v.party_ledger_id IS ? AND v.id IS NOT ?
         AND v.date BETWEEN date(?, '-3 days') AND date(?, '+3 days')
         AND ${NOT_DELETED}
         AND (SELECT COALESCE(SUM(amount), 0) FROM voucher_lines WHERE voucher_id = v.id AND dr_cr = 'dr') = ?
       ORDER BY v.id`
    )
    .all(input.voucherTypeId, input.partyLedgerId, excludeId ?? -1, input.date, input.date, total) as DuplicateWarning[]
  return rows
}

function ledgerFactsResolver(db: DB): (id: number) => LedgerFacts {
  const cashBank = cashBankGroupIds(db)
  const stmt = db.prepare('SELECT group_id FROM ledgers WHERE id = ?')
  const cache = new Map<number, LedgerFacts>()
  return (id: number) => {
    const hit = cache.get(id)
    if (hit) return hit
    const row = stmt.get(id) as { group_id: number } | undefined
    const facts: LedgerFacts = { exists: !!row, isCashOrBank: !!row && cashBank.has(row.group_id) }
    cache.set(id, facts)
    return facts
  }
}

/** Voucher as saved, plus the v0.3 #69 soft guard: `duplicateNumber` is set when another live
 *  voucher of the same type already carries this number (the save still succeeds — the UI
 *  decides whether to warn). */
export type SavedVoucher = Voucher & { duplicateNumber?: boolean }

export function saveVoucher(db: DB, raw: VoucherInput, existingId?: number): SavedVoucher {
  // Parse here as well as at the IPC boundary so direct callers (tests, recurring, importers)
  // get defaults for later-added fields (posOverride) applied consistently.
  const input: VoucherInputParsed = voucherInputSchema.parse(raw)
  const vt = getVoucherType(db, input.voucherTypeId)
  const errors = validateVoucher(input, vt.kind, ledgerFactsResolver(db))
  if (errors.length) {
    throw new Error(errors.map((e) => e.message).join('; '))
  }

  const number =
    vt.numbering === 'manual'
      ? (input.number ?? '').trim() || (() => { throw new Error('Voucher number is required') })()
      : input.number?.trim() || nextVoucherNumber(db, vt.id, input.date, existingId)

  const before = existingId ? getVoucher(db, existingId) : null
  if (existingId && !before) throw new Error('Voucher not found')
  if (before?.deletedAt) throw new Error('Voucher is in the bin; restore it first')

  const lock = getLockDate(db)
  if (lock && (input.date <= lock || (before && before.date <= lock))) {
    throw new Error(`Books are locked up to ${lock}`)
  }

  const run = db.transaction((): number => {
    let voucherId: number
    if (existingId) {
      db.prepare(
        `UPDATE vouchers SET voucher_type_id = ?, date = ?, number = ?, party_ledger_id = ?,
         narration = ?, reference = ?, instrument_no = ?, instrument_date = ?,
         transporter_id = ?, vehicle_no = ?, transport_distance = ?, pos_override = ?,
         currency_code = ?, exchange_rate = ?, updated_at = datetime('now') WHERE id = ?`
      ).run(vt.id, input.date, number, input.partyLedgerId, input.narration, input.reference,
        input.instrumentNo, input.instrumentDate, input.transporterId, input.vehicleNo, input.transportDistanceKm,
        input.posOverride, input.currencyCode, input.exchangeRate, existingId)
      db.prepare('DELETE FROM voucher_lines WHERE voucher_id = ?').run(existingId)
      db.prepare('DELETE FROM inventory_lines WHERE voucher_id = ?').run(existingId)
      voucherId = existingId
    } else {
      const res = db.prepare(
        `INSERT INTO vouchers (voucher_type_id, date, number, party_ledger_id, narration, reference,
          instrument_no, instrument_date, transporter_id, vehicle_no, transport_distance, pos_override,
          currency_code, exchange_rate)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(vt.id, input.date, number, input.partyLedgerId, input.narration, input.reference,
        input.instrumentNo, input.instrumentDate, input.transporterId, input.vehicleNo, input.transportDistanceKm,
        input.posOverride, input.currencyCode, input.exchangeRate)
      voucherId = Number(res.lastInsertRowid)
    }

    const insertLine = db.prepare(
      'INSERT INTO voucher_lines (voucher_id, ledger_id, dr_cr, amount, line_order) VALUES (?, ?, ?, ?, ?)'
    )
    const insertCostAlloc = db.prepare(
      'INSERT INTO voucher_line_cost_allocations (voucher_line_id, cost_centre_id, amount) VALUES (?, ?, ?)'
    )
    input.lines.forEach((l, i) => {
      const res = insertLine.run(voucherId, l.ledgerId, l.drCr, l.amount, i)
      const lineId = Number(res.lastInsertRowid)
      for (const alloc of l.costAllocations ?? []) {
        insertCostAlloc.run(lineId, alloc.costCentreId, alloc.amount)
      }
    })

    const insertInv = db.prepare(
      `INSERT INTO inventory_lines (voucher_id, stock_item_id, godown_id, qty_milli, rate_paise, amount, direction, line_order)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    input.inventory.forEach((l, i) =>
      insertInv.run(voucherId, l.stockItemId, l.godownId, l.qtyMilli, l.ratePaise, l.amount, l.direction, i)
    )

    // Bill refs and TDS ride on `vouchers`, not `voucher_lines`, so an UPDATE doesn't cascade
    // their deletion the way replacing the line set does — clear and reinsert explicitly.
    db.prepare('DELETE FROM bill_refs WHERE voucher_id = ?').run(voucherId)
    db.prepare('DELETE FROM tds_entries WHERE voucher_id = ?').run(voucherId)

    if (input.billRefs.length > 0) {
      const insertBillRef = db.prepare(
        'INSERT INTO bill_refs (voucher_id, party_ledger_id, kind, name, amount, due_date) VALUES (?, ?, ?, ?, ?, ?)'
      )
      for (const ref of input.billRefs) {
        insertBillRef.run(voucherId, input.partyLedgerId, ref.kind, ref.name, ref.amount, ref.dueDate)
      }
    }

    if (input.tds) {
      const party = input.partyLedgerId
        ? (db.prepare('SELECT pan FROM ledgers WHERE id = ?').get(input.partyLedgerId) as { pan: string | null } | undefined)
        : undefined
      db.prepare(
        'INSERT INTO tds_entries (voucher_id, section_id, party_ledger_id, pan, base_amount, tds_amount) VALUES (?, ?, ?, ?, ?, ?)'
      ).run(voucherId, input.tds.sectionId, input.partyLedgerId, party?.pan ?? null, input.tds.baseAmount, input.tds.tdsAmount)
    }

    return voucherId
  })

  const voucherId = run()
  const after = getVoucher(db, voucherId)!
  writeAudit(db, 'voucher', voucherId, existingId ? 'update' : 'create', before, after)
  const duplicate = db
    .prepare(
      `SELECT 1 FROM vouchers v WHERE v.voucher_type_id = ? AND v.number = ? AND v.id <> ? AND ${NOT_DELETED} LIMIT 1`
    )
    .get(vt.id, number, voucherId)
  return duplicate ? { ...after, duplicateNumber: true } : after
}

/** Move a voucher to the bin (soft delete). Report queries exclude it; restoreVoucher undoes this. */
export function deleteVoucher(db: DB, id: number): void {
  const before = getVoucher(db, id)
  if (!before) throw new Error('Voucher not found')
  const lock = getLockDate(db)
  if (lock && before.date <= lock) throw new Error(`Books are locked up to ${lock}`)
  db.prepare("UPDATE vouchers SET deleted_at = datetime('now') WHERE id = ?").run(id)
  writeAudit(db, 'voucher', id, 'delete', before, null)
}

/** Reinstate a binned voucher so it counts in reports again. */
export function restoreVoucher(db: DB, id: number): void {
  const before = getVoucher(db, id)
  if (!before) throw new Error('Voucher not found')
  if (!before.deletedAt) throw new Error('Voucher is not in the bin')
  const lock = getLockDate(db)
  if (lock && before.date <= lock) throw new Error(`Books are locked up to ${lock}`)
  db.prepare('UPDATE vouchers SET deleted_at = NULL WHERE id = ?').run(id)
  writeAudit(db, 'voucher', id, 'update', before, { restored: true })
}

/** Permanently remove a voucher that is already in the bin. Irreversible. */
export function purgeVoucher(db: DB, id: number): void {
  const before = getVoucher(db, id)
  if (!before) throw new Error('Voucher not found')
  if (!before.deletedAt) throw new Error('Voucher must be in the bin before it can be purged')
  db.prepare('DELETE FROM vouchers WHERE id = ?').run(id)
  writeAudit(db, 'voucher', id, 'delete', { ...before, purged: true }, null)
}

/** Vouchers auto-purged after sitting in the bin longer than `days` (default 30). Returns the count purged. */
export function purgeOldDeleted(db: DB, days = 30): number {
  const rows = db
    .prepare(`SELECT id FROM vouchers WHERE deleted_at IS NOT NULL AND deleted_at <= datetime('now', ?)`)
    .all(`-${days} days`) as { id: number }[]
  for (const r of rows) purgeVoucher(db, r.id)
  return rows.length
}

export interface BinRow {
  id: number
  date: string
  number: string
  voucherType: string
  account: string
  amount: number
  deletedAt: string
}

/** Binned vouchers, most recently deleted first. Mirrors listVouchers' account/amount derivation. */
export function listBin(db: DB): BinRow[] {
  const rows = db
    .prepare(
      `SELECT v.id, v.date, vt.name AS voucherType, v.number,
              COALESCE(pl.name, fl.name, '') AS account,
              COALESCE(t.total, 0) AS amount,
              v.deleted_at AS deletedAt
       FROM vouchers v
       JOIN voucher_types vt ON vt.id = v.voucher_type_id
       LEFT JOIN ledgers pl ON pl.id = v.party_ledger_id
       LEFT JOIN (
         SELECT voucher_id, MIN(id) AS first_line FROM voucher_lines GROUP BY voucher_id
       ) f ON f.voucher_id = v.id
       LEFT JOIN voucher_lines fvl ON fvl.id = f.first_line
       LEFT JOIN ledgers fl ON fl.id = fvl.ledger_id
       LEFT JOIN (
         SELECT voucher_id, SUM(amount) AS total FROM voucher_lines WHERE dr_cr = 'dr' GROUP BY voucher_id
       ) t ON t.voucher_id = v.id
       WHERE v.deleted_at IS NOT NULL
       ORDER BY v.deleted_at DESC`
    )
    .all() as BinRow[]
  return rows
}

export function listVouchers(db: DB, from: string, to: string, voucherTypeId?: number): VoucherListRow[] {
  const rows = db
    .prepare(
      `SELECT v.id, v.date, vt.name AS voucherType, vt.kind, v.number, v.narration,
              COALESCE(pl.name, fl.name, '') AS account,
              COALESCE(t.total, 0) AS amount
       FROM vouchers v
       JOIN voucher_types vt ON vt.id = v.voucher_type_id
       LEFT JOIN ledgers pl ON pl.id = v.party_ledger_id
       LEFT JOIN (
         SELECT voucher_id, MIN(id) AS first_line FROM voucher_lines GROUP BY voucher_id
       ) f ON f.voucher_id = v.id
       LEFT JOIN voucher_lines fvl ON fvl.id = f.first_line
       LEFT JOIN ledgers fl ON fl.id = fvl.ledger_id
       LEFT JOIN (
         SELECT voucher_id, SUM(amount) AS total FROM voucher_lines WHERE dr_cr = 'dr' GROUP BY voucher_id
       ) t ON t.voucher_id = v.id
       WHERE v.date BETWEEN ? AND ? AND ${NOT_DELETED} ${voucherTypeId ? 'AND v.voucher_type_id = ?' : ''}
       ORDER BY v.date, v.id`
    )
    .all(...(voucherTypeId ? [from, to, voucherTypeId] : [from, to])) as VoucherListRow[]
  return rows
}
