import type { DB } from '../db/connection'
import { prep } from '../db/stmt'
import type {
  Voucher, VoucherLine, InventoryLine, VoucherType, NegativeStockWarning, SaveVoucherWarnings, DrCr
} from '@shared/domain'
import { voucherInputSchema } from '@shared/schemas'
import type { VoucherInput, VoucherInputParsed } from '@shared/schemas'
import type { VoucherListRow } from '@shared/reports'
import { validateVoucher, type LedgerFacts } from '@shared/posting'
import { fyOf } from '@shared/dates'
import { expandSeriesPattern, seriesHasFyToken } from '@shared/numberSeries'
import { cashBankGroupIds } from './masters'
import { getFeatures } from './config'
import { writeAudit } from './audit'
import { applyApprovalGate } from './approvals'
import { setValues as setCustomFieldValues, valuesFor as customFieldValuesFor } from './customFields'
import type { Role } from './roles'
import { primaryRegistrationId } from './registrationId'

interface VoucherRow {
  id: number; voucher_type_id: number; date: string; number: string
  party_ledger_id: number | null; narration: string | null; reference: string | null
  instrument_no: string | null; instrument_date: string | null
  transporter_id: string | null; vehicle_no: string | null; transport_distance: number | null
  pos_override: string | null
  gst_registration_id: number | null
  currency_code: string | null; exchange_rate: number | null
  irn: string | null; irn_ack_no: string | null; irn_ack_date: string | null
  ewb_no: string | null; ewb_valid_upto: string | null
  post_dated: number; is_optional: number
  approval_state: 'pending' | 'approved' | 'rejected' | null
  approval_by: string | null; approval_at: string | null; approval_note: string | null
  import_key: string | null
  deleted_at: string | null
  created_at: string; updated_at: string
}

/** Greppable filter for every query joining `vouchers` as `v` that must exclude binned vouchers. */
export const NOT_DELETED = 'v.deleted_at IS NULL'

/** Post-dated vouchers stay out of the books until they mature (maturePostDated flips the flag). */
export const NOT_POSTDATED = 'v.post_dated = 0'

/** Optional (memorandum) vouchers never count toward the books. */
export const NOT_OPTIONAL = 'v.is_optional = 0'

/**
 * The approval threshold (roadmap V #386) has nothing to say about this voucher, or has said yes.
 *
 * Spelled as "NULL or approved" rather than "not pending": approval_state is NULL on every
 * voucher that was never gated — the overwhelming majority — and `NULL <> 'pending'` is NULL in
 * SQL, which is not true, which would quietly empty every report in the app. Writing the
 * permitted values out also settles the third state: a REJECTED voucher stays out of the books.
 * The owner said no; it is not a memorandum, and it is not silently in the totals.
 */
export const APPROVAL_CLEARED = "(v.approval_state IS NULL OR v.approval_state = 'approved')"

/** Composite filter: the voucher counts toward the books — not binned, not post-dated, not
 *  optional, and either never gated for approval or approved. New report queries should use this
 *  instead of NOT_DELETED alone. */
export const IN_BOOKS = `${NOT_DELETED} AND ${NOT_POSTDATED} AND ${NOT_OPTIONAL} AND ${APPROVAL_CLEARED}`

/** Books-locked-up-to date (inclusive): vouchers dated on or before this date can't be
 *  saved/deleted/restored. Stored in `meta` under key 'lock_before'; null/absent = no lock. */
export function getLockDate(db: DB): string | null {
  const row = prep(db, "SELECT value FROM meta WHERE key = 'lock_before'").get() as { value: string } | undefined
  return row ? row.value : null
}

/** Set (or clear, with null) the period lock date. Audit-logged against the 'company' entity. */
export function setLockDate(db: DB, date: string | null): void {
  const old = getLockDate(db)
  if (date === null) {
    prep(db, "DELETE FROM meta WHERE key = 'lock_before'").run()
  } else {
    prep(db, "INSERT INTO meta (key, value) VALUES ('lock_before', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(date)
  }
  writeAudit(db, 'company', 0, 'update', { lockBefore: old }, { lockBefore: date })
}

function getVoucherType(db: DB, id: number): VoucherType {
  const row = prep(db, 'SELECT * FROM voucher_types WHERE id = ?').get(id) as
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
  const v = prep(db, 'SELECT * FROM vouchers WHERE id = ?').get(id) as VoucherRow | undefined
  if (!v) return null
  const lines = prep(db, 'SELECT id, ledger_id, dr_cr, amount, bank_date FROM voucher_lines WHERE voucher_id = ? ORDER BY line_order, id')
    .all(id) as { id: number; ledger_id: number; dr_cr: 'dr' | 'cr'; amount: number; bank_date: string | null }[]
  const inventory = prep(db, 'SELECT id, stock_item_id, godown_id, batch_id, qty_milli, rate_paise, discount_paise, amount, direction, is_absolute FROM inventory_lines WHERE voucher_id = ? ORDER BY line_order, id')
    .all(id) as {
      id: number; stock_item_id: number; godown_id: number | null; batch_id: number | null
      qty_milli: number; rate_paise: number; discount_paise: number; amount: number; direction: 'in' | 'out'; is_absolute: number
    }[]

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

  const billRefRows = prep(db, 'SELECT kind, name, amount, due_date FROM bill_refs WHERE voucher_id = ? ORDER BY id')
    .all(id) as { kind: 'new' | 'against'; name: string; amount: number; due_date: string | null }[]

  const tdsRow = prep(db, 'SELECT section_id, base_amount, tds_amount FROM tds_entries WHERE voucher_id = ?')
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
    gstRegistrationId: v.gst_registration_id,
    currencyCode: v.currency_code,
    exchangeRate: v.exchange_rate,
    irn: v.irn,
    irnAckNo: v.irn_ack_no,
    irnAckDate: v.irn_ack_date,
    ewbNo: v.ewb_no,
    ewbValidUpto: v.ewb_valid_upto,
    postDated: !!v.post_dated,
    isOptional: !!v.is_optional,
    deletedAt: v.deleted_at,
    approvalState: v.approval_state,
    approvalBy: v.approval_by,
    approvalAt: v.approval_at,
    approvalNote: v.approval_note,
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
        id: l.id, stockItemId: l.stock_item_id, godownId: l.godown_id, batchId: l.batch_id,
        qtyMilli: l.qty_milli, ratePaise: l.rate_paise, discountPaise: l.discount_paise,
        amount: l.amount, direction: l.direction,
        isAbsolute: !!l.is_absolute
      })
    ),
    billRefs: billRefRows.map((r) => ({ kind: r.kind, name: r.name, amount: r.amount, dueDate: r.due_date })),
    tds: tdsRow ? { sectionId: tdsRow.section_id, baseAmount: tdsRow.base_amount, tdsAmount: tdsRow.tds_amount } : null,
    customFields: customFieldValuesFor(db, id)
  }
}

/**
 * Next auto number for a voucher type: prefix + zero-padded sequence + suffix.
 * The scan window is the FY containing `date` (restartFy true, the default — Tally-style numbering
 * that resets to 1 each financial year), or every voucher of this type ever (restartFy false — one
 * running sequence across FYs). Either way, binned (soft-deleted) vouchers still count toward the
 * max — same as before this task, deliberately: a deleted number must never be reissued.
 *
 * The prefix and suffix may carry financial-year tokens ({FY}, {YY}, {YYYY}); they are expanded
 * against THIS voucher's date, so `INV/{FY}/` gives `INV/2024-25/0007` and — because last year's
 * numbers no longer share the prefix — the sequence restarts each April whatever `restartFy`
 * says. The scan still narrows by prefix, so the two mechanisms compose rather than fight.
 */
export function nextVoucherNumber(db: DB, voucherTypeId: number, date: string, excludeVoucherId?: number): string {
  const stored = getVoucherType(db, voucherTypeId)
  const vt = {
    ...stored,
    prefix: expandSeriesPattern(stored.prefix, date),
    suffix: expandSeriesPattern(stored.suffix, date)
  }
  // Strip the suffix then the prefix in SQL (so e.g. "INV-007/24-25" with prefix "INV-" and
  // suffix "/24-25" reads as 7) and take a single MAX — no more loading every number into JS.
  // CAST mirrors the old parseInt(..., 10): leading digits parse, anything else reads as 0.
  const fyClause = vt.restartFy ? 'AND date BETWEEN :from AND :to' : ''
  /**
   * A per-FY series scans only the numbers that belong to THIS year's series.
   *
   * Without it the scan reads every number of the type and strips a prefix that no longer
   * matches, so last year's `1/24` and `2/24` count toward this year's `/25` series and it
   * starts at 3. Restricted to token series on purpose: applying it to every type would mean
   * that editing a prefix mid-year silently restarted the numbering, which is a far worse
   * surprise than the one it fixes.
   */
  const seriesClause =
    seriesHasFyToken(stored.prefix) || seriesHasFyToken(stored.suffix)
      ? 'AND (:plen = 0 OR substr(number, 1, :plen) = :prefix) AND (:slen = 0 OR substr(number, -:slen) = :suffix)'
      : ''
  const row = db
    .prepare(
      `SELECT COALESCE(MAX(CAST(
         CASE WHEN :plen > 0 AND substr(stripped, 1, :plen) = :prefix
              THEN substr(stripped, :plen + 1) ELSE stripped END AS INTEGER)), 0) AS maxn
       FROM (
         SELECT CASE WHEN :slen > 0 AND substr(number, -:slen) = :suffix
                     THEN substr(number, 1, length(number) - :slen) ELSE number END AS stripped
         FROM vouchers
         WHERE voucher_type_id = :vtId AND id IS NOT :excludeId ${fyClause} ${seriesClause}
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

/** True when another live voucher of this type already carries `number` — the renderer's
 *  pre-save confirm for a manually typed number (the post-save duplicateNumber flag on
 *  SavedVoucher stays as the belt-and-braces warning for races). Binned vouchers don't
 *  count: restoring one back into a clash is already the restore flow's problem. */
export function voucherNumberExists(db: DB, voucherTypeId: number, number: string, excludeId?: number): boolean {
  const row = prep(db,
      `SELECT 1 FROM vouchers v WHERE v.voucher_type_id = ? AND v.number = ? AND v.id IS NOT ? AND ${NOT_DELETED} LIMIT 1`
    )
    .get(voucherTypeId, number, excludeId ?? -1)
  return !!row
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
  const rows = prep(db,
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
  const stmt = prep(db, 'SELECT group_id FROM ledgers WHERE id = ?')
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

/**
 * Closing quantity walk for the given stock items as of `date` (opening + chronological
 * movements; physical-stock absolute lines pin the quantity). Returns a row per item whose
 * closing quantity is negative. Used for the negative-stock save warning and by the
 * Exceptions report (stockAnalysis.negativeStock).
 */
export function checkStock(db: DB, stockItemIds: number[], date: string): NegativeStockWarning[] {
  if (stockItemIds.length === 0) return []
  const placeholders = stockItemIds.map(() => '?').join(',')
  const items = db
    .prepare(
      `SELECT si.id, si.name, si.opening_qty_milli AS openingQtyMilli, u.symbol AS unitSymbol
       FROM stock_items si JOIN units u ON u.id = si.unit_id WHERE si.id IN (${placeholders})`
    )
    .all(...stockItemIds) as { id: number; name: string; openingQtyMilli: number; unitSymbol: string }[]
  const movementsStmt = prep(db,
    `SELECT il.qty_milli AS qtyMilli, il.direction, il.is_absolute AS isAbsolute
     FROM inventory_lines il JOIN vouchers v ON v.id = il.voucher_id
     WHERE il.stock_item_id = ? AND v.date <= ? AND ${IN_BOOKS}
     ORDER BY v.date, v.id, il.line_order, il.id`
  )
  const warnings: NegativeStockWarning[] = []
  for (const item of items) {
    let qty = item.openingQtyMilli
    const moves = movementsStmt.all(item.id, date) as { qtyMilli: number; direction: 'in' | 'out'; isAbsolute: number }[]
    for (const m of moves) {
      if (m.isAbsolute) qty = m.qtyMilli
      else qty += m.direction === 'in' ? m.qtyMilli : -m.qtyMilli
    }
    if (qty < 0) {
      warnings.push({ stockItemId: item.id, name: item.name, unitSymbol: item.unitSymbol, closingQtyMilli: qty })
    }
  }
  return warnings
}

/** The saved voucher plus any non-blocking warnings — additive over Voucher, so existing
 *  callers that expect a plain Voucher keep working. Also carries lane R's soft
 *  duplicate-number guard (SavedVoucher). */
export type SaveVoucherResult = SavedVoucher & { warnings: SaveVoucherWarnings }

/**
 * Who is saving, for the approval threshold (roadmap V #386).
 *
 * Passed in rather than read from a session, because services know nothing about sessions — and
 * because the callers that must NEVER be gated (the Tally import, recurring templates, the agent
 * inbox, every test) get that behaviour by simply not passing it.
 */
export interface SaveVoucherActor {
  role: Role | null
  hasUsers: boolean
}

/** The registration a voucher defaults to: the one its godown sits under, else the primary. */
function defaultRegistrationId(db: DB, input: VoucherInputParsed): number | null {
  const godownId = input.inventory.find((l) => l.godownId != null)?.godownId ?? null
  if (godownId != null) {
    const g = db.prepare('SELECT gst_registration_id AS id FROM godowns WHERE id = ?').get(godownId) as
      | { id: number | null }
      | undefined
    if (g?.id != null) return g.id
  }
  return primaryRegistrationId(db)
}

export function saveVoucher(
  db: DB,
  raw: VoucherInput,
  existingId?: number,
  actor?: SaveVoucherActor
): SaveVoucherResult {
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

  const warnings: SaveVoucherWarnings = { negativeStock: [], creditLimitExceeded: null }

  // Post-dated / optional flags (tasks 77–78): absent on the input = keep the stored value
  // (an edit that doesn't mention them mustn't silently mature a PDC).
  const postDated = input.postDated ?? before?.postDated ?? false
  const isOptional = input.isOptional ?? before?.isOptional ?? false

  // Which registration made this supply (roadmap #108). Decided HERE and stored, never inferred
  // when a return is built: a voucher whose registration is re-derived at report time is a
  // voucher whose tax moves under it the day a second registration is added. An edit that says
  // nothing keeps what the voucher already had.
  const gstRegistrationId =
    input.gstRegistrationId ?? before?.gstRegistrationId ?? defaultRegistrationId(db, input)

  const run = db.transaction((): number => {
    let voucherId: number
    if (existingId) {
      prep(db,
        `UPDATE vouchers SET voucher_type_id = ?, date = ?, number = ?, party_ledger_id = ?,
         narration = ?, reference = ?, instrument_no = ?, instrument_date = ?,
         transporter_id = ?, vehicle_no = ?, transport_distance = ?, pos_override = ?,
         gst_registration_id = ?, currency_code = ?, exchange_rate = ?, post_dated = ?, is_optional = ?,
         updated_at = datetime('now') WHERE id = ?`
      ).run(vt.id, input.date, number, input.partyLedgerId, input.narration, input.reference,
        input.instrumentNo, input.instrumentDate, input.transporterId, input.vehicleNo, input.transportDistanceKm,
        input.posOverride, gstRegistrationId, input.currencyCode, input.exchangeRate, postDated ? 1 : 0, isOptional ? 1 : 0, existingId)
      prep(db, 'DELETE FROM voucher_lines WHERE voucher_id = ?').run(existingId)
      prep(db, 'DELETE FROM inventory_lines WHERE voucher_id = ?').run(existingId)
      voucherId = existingId
    } else {
      const res = prep(db,
        `INSERT INTO vouchers (voucher_type_id, date, number, party_ledger_id, narration, reference,
          instrument_no, instrument_date, transporter_id, vehicle_no, transport_distance, pos_override,
          gst_registration_id, currency_code, exchange_rate, post_dated, is_optional)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(vt.id, input.date, number, input.partyLedgerId, input.narration, input.reference,
        input.instrumentNo, input.instrumentDate, input.transporterId, input.vehicleNo, input.transportDistanceKm,
        input.posOverride, gstRegistrationId, input.currencyCode, input.exchangeRate,
        postDated ? 1 : 0, isOptional ? 1 : 0)
      voucherId = Number(res.lastInsertRowid)
    }

    const insertLine = prep(db,
      'INSERT INTO voucher_lines (voucher_id, ledger_id, dr_cr, amount, line_order) VALUES (?, ?, ?, ?, ?)'
    )
    const insertCostAlloc = prep(db,
      'INSERT INTO voucher_line_cost_allocations (voucher_line_id, cost_centre_id, amount) VALUES (?, ?, ?)'
    )
    input.lines.forEach((l, i) => {
      const res = insertLine.run(voucherId, l.ledgerId, l.drCr, l.amount, i)
      const lineId = Number(res.lastInsertRowid)
      for (const alloc of l.costAllocations ?? []) {
        insertCostAlloc.run(lineId, alloc.costCentreId, alloc.amount)
      }
    })

    const insertInv = prep(db,
      `INSERT INTO inventory_lines (voucher_id, stock_item_id, godown_id, batch_id, qty_milli, rate_paise, discount_paise, amount, direction, is_absolute, line_order)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    input.inventory.forEach((l, i) =>
      insertInv.run(voucherId, l.stockItemId, l.godownId, l.batchId ?? null, l.qtyMilli, l.ratePaise,
        l.discountPaise ?? 0, l.amount, l.direction, l.isAbsolute ? 1 : 0, i)
    )

    /**
     * Company-defined custom fields (roadmap #195).
     *
     * Written inside this transaction so a value that fails validation rolls the whole voucher
     * back — a saved entry with a half-written extra field is worse than a refused save.
     *
     * `undefined` means the caller never mentioned custom fields (an importer, a recurring
     * template, an older draft) and the voucher keeps what it already carries; an empty ARRAY
     * means the user cleared them.
     */
    if (input.customFields) {
      setCustomFieldValues(db, voucherId, vt.id, input.customFields)
    }

    // Bill refs and TDS ride on `vouchers`, not `voucher_lines`, so an UPDATE doesn't cascade
    // their deletion the way replacing the line set does — clear and reinsert explicitly.
    prep(db, 'DELETE FROM bill_refs WHERE voucher_id = ?').run(voucherId)
    prep(db, 'DELETE FROM tds_entries WHERE voucher_id = ?').run(voucherId)

    if (input.billRefs.length > 0) {
      const insertBillRef = prep(db,
        'INSERT INTO bill_refs (voucher_id, party_ledger_id, kind, name, amount, due_date) VALUES (?, ?, ?, ?, ?, ?)'
      )
      for (const ref of input.billRefs) {
        insertBillRef.run(voucherId, input.partyLedgerId, ref.kind, ref.name, ref.amount, ref.dueDate)
      }
    }

    if (input.tds) {
      const party = input.partyLedgerId
        ? (prep(db, 'SELECT pan FROM ledgers WHERE id = ?').get(input.partyLedgerId) as { pan: string | null } | undefined)
        : undefined
      prep(db,
        'INSERT INTO tds_entries (voucher_id, section_id, party_ledger_id, pan, base_amount, tds_amount) VALUES (?, ?, ?, ?, ?, ?)'
      ).run(voucherId, input.tds.sectionId, input.partyLedgerId, party?.pan ?? null, input.tds.baseAmount, input.tds.tdsAmount)
    }

    // ---- post-save checks (lane I): run INSIDE the transaction so a hard block rolls the
    // whole save back; soft failures just ride out as warnings on the response. ----
    const features = getFeatures(db)

    // Batches: a line's batch must belong to its stock item, and an outward line can't take
    // more out of a batch than it holds (hard errors — a batch is a physical lot).
    const batchLines = input.inventory.filter((l) => l.batchId != null && !l.isAbsolute)
    if (batchLines.length > 0) {
      const batchStmt = prep(db, 'SELECT id, stock_item_id, name FROM batches WHERE id = ?')
      const balanceStmt = prep(db,
        `SELECT COALESCE(SUM(CASE WHEN il.direction = 'in' THEN il.qty_milli ELSE -il.qty_milli END), 0) AS bal
         FROM inventory_lines il JOIN vouchers v ON v.id = il.voucher_id
         WHERE il.batch_id = ? AND il.is_absolute = 0 AND ${IN_BOOKS}`
      )
      for (const line of batchLines) {
        const batch = batchStmt.get(line.batchId) as { id: number; stock_item_id: number; name: string } | undefined
        if (!batch) throw new Error('Batch not found')
        if (batch.stock_item_id !== line.stockItemId) {
          throw new Error(`Batch ${batch.name} belongs to a different stock item`)
        }
      }
      const outBatchIds = [...new Set(batchLines.filter((l) => l.direction === 'out').map((l) => l.batchId!))]
      for (const batchId of outBatchIds) {
        const { bal } = balanceStmt.get(batchId) as { bal: number }
        if (bal < 0) {
          const batch = batchStmt.get(batchId) as { name: string }
          throw new Error(`Not enough stock in batch ${batch.name} (short by ${-bal / 1000})`)
        }
      }
    }

    // Negative stock — only items this voucher takes out (or recounts) can go negative.
    const outItemIds = [...new Set(
      input.inventory.filter((l) => l.direction === 'out' && !l.isAbsolute).map((l) => l.stockItemId)
    )]
    warnings.negativeStock = checkStock(db, outItemIds, input.date)
    if (warnings.negativeStock.length > 0) {
      // Per-item overrides the company setting in both directions. The company flag is
      // all-or-nothing, and a business that books a sale before the purchase invoice arrives has
      // to leave it off — which leaves it off for the items where going negative really is always
      // a mistake. NULL on an item means "follow the company", which is what they all start as.
      const overrides = new Map(
        (
          db
            .prepare(
              `SELECT id, block_negative AS blockNegative FROM stock_items
               WHERE id IN (${warnings.negativeStock.map(() => '?').join(',')})`
            )
            .all(...warnings.negativeStock.map((w) => w.stockItemId)) as {
              id: number; blockNegative: number | null
            }[]
        ).map((r) => [r.id, r.blockNegative])
      )
      const blocked = warnings.negativeStock.filter((w) => {
        const own = overrides.get(w.stockItemId)
        return own == null ? features.preventNegativeStock : own === 1
      })
      if (blocked.length > 0) {
        const names = blocked.map((w) => w.name).join(', ')
        throw new Error(`Insufficient stock for: ${names}`)
      }
    }

    // Credit limit (task 76): with this voucher's lines now in the books, the party's
    // dr-positive balance IS "outstanding + this invoice". Warn past the ledger's limit;
    // block (roll back) under F11 enforceCreditLimit. Post-dated/optional vouchers are out
    // of the books, so they never trip the limit.
    // The approval threshold, before the credit-limit check below: a held voucher is out of the
    // books, so — exactly like a post-dated or optional one — it must not consume credit.
    const heldForApproval =
      actor
        ? applyApprovalGate(
            db,
            voucherId,
            input.lines.filter((l) => l.drCr === 'dr').reduce((sum, l) => sum + l.amount, 0),
            actor
          ) === 'pending'
        : false

    if (input.partyLedgerId !== null && !postDated && !isOptional && !heldForApproval) {
      const party = prep(db, 'SELECT id, name, opening_balance, credit_limit FROM ledgers WHERE id = ?')
        .get(input.partyLedgerId) as
        | { id: number; name: string; opening_balance: number; credit_limit: number | null }
        | undefined
      if (party && party.credit_limit !== null) {
        const { bal } = prep(db,
            `SELECT COALESCE(SUM(CASE WHEN vl.dr_cr = 'dr' THEN vl.amount ELSE -vl.amount END), 0) AS bal
             FROM voucher_lines vl JOIN vouchers v ON v.id = vl.voucher_id
             WHERE vl.ledger_id = ? AND ${IN_BOOKS}`
          )
          .get(party.id) as { bal: number }
        const outstanding = party.opening_balance + bal
        if (outstanding > party.credit_limit) {
          warnings.creditLimitExceeded = {
            ledgerId: party.id,
            ledgerName: party.name,
            creditLimit: party.credit_limit,
            outstanding
          }
          if (features.enforceCreditLimit) {
            throw new Error(
              `Credit limit exceeded for ${party.name}: outstanding ${outstanding} > limit ${party.credit_limit} paise`
            )
          }
        }
      }
    }

    return voucherId
  })

  const voucherId = run()
  const after = getVoucher(db, voucherId)!
  writeAudit(db, 'voucher', voucherId, existingId ? 'update' : 'create', before, after)
  const duplicate = prep(db,
      `SELECT 1 FROM vouchers v WHERE v.voucher_type_id = ? AND v.number = ? AND v.id <> ? AND ${NOT_DELETED} LIMIT 1`
    )
    .get(vt.id, number, voucherId)
  return duplicate ? { ...after, warnings, duplicateNumber: true } : { ...after, warnings }
}

/**
 * Refuse a change that would alter a frozen reconciliation (#142).
 *
 * The lock itself belongs to services/banking.ts (`getReconLock` / `setReconLock`); the meta key
 * is read directly here because banking.ts already imports this module and going the other way
 * would make the cycle. One `SELECT` against a key/value row is a smaller price than moving the
 * whole reconciliation service to break it.
 *
 * Deleting or restoring a voucher is as much a change to a signed-off BRS as clearing the bank
 * date by hand — the entry simply stops being on the statement side. Only the lines that carry a
 * bank date matter: an unreconciled line in a frozen period was never part of the frozen figure.
 */
function assertNoFrozenBankDates(db: DB, voucher: Voucher, verb: string): void {
  const lockOf = prep(db, 'SELECT value FROM meta WHERE key = ?')
  for (const line of voucher.lines) {
    if (!line.bankDate) continue
    const row = lockOf.get(`recon_lock.${line.ledgerId}`) as { value: string } | undefined
    if (row && line.bankDate <= row.value) {
      throw new Error(
        `Reconciliation on that bank account is frozen up to ${row.value} — this voucher is reconciled inside it and cannot be ${verb}`
      )
    }
  }
}

/** Move a voucher to the bin (soft delete). Report queries exclude it; restoreVoucher undoes this. */
export function deleteVoucher(db: DB, id: number): void {
  const before = getVoucher(db, id)
  if (!before) throw new Error('Voucher not found')
  const lock = getLockDate(db)
  if (lock && before.date <= lock) throw new Error(`Books are locked up to ${lock}`)
  assertNoFrozenBankDates(db, before, 'deleted')
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
  assertNoFrozenBankDates(db, before, 'restored')
  prep(db, 'UPDATE vouchers SET deleted_at = NULL WHERE id = ?').run(id)
  // The full record on both sides, not a `{ restored: true }` marker. A reader comparing two
  // snapshots sees "deletedAt: a date -> none"; against a marker they would see every field on
  // the voucher reported as having been removed, which is the opposite of what happened.
  writeAudit(db, 'voucher', id, 'update', before, getVoucher(db, id))
}

// ---------- post-dated vouchers (lane I, task 77) ----------

export interface MaturePostDatedResult {
  matured: number[]
  /** PDCs whose date has arrived but falls on/before the books lock: maturing them would
   *  silently change a locked (possibly year-end-closed) period, exactly what saveVoucher/
   *  deleteVoucher refuse to do — so they stay post-dated (visible in the PDC register) and are
   *  reported here for the caller to log/surface. Unlock the period to let them mature. */
  blockedByLock: number[]
}

/** Flip matured post-dated vouchers (date ≤ `today`) into the books. Runs on company open;
 *  each maturation is audit-logged individually. Vouchers dated inside the locked period are
 *  refused, not flipped (v0.3 review F3) — see MaturePostDatedResult.blockedByLock. */
export function maturePostDated(db: DB, today: string): MaturePostDatedResult {
  const rows = prep(db, `SELECT v.id, v.date FROM vouchers v WHERE v.post_dated = 1 AND v.date <= ? AND ${NOT_DELETED}`)
    .all(today) as { id: number; date: string }[]
  const lock = getLockDate(db)
  const due = lock === null ? rows : rows.filter((r) => r.date > lock)
  const blockedByLock = lock === null ? [] : rows.filter((r) => r.date <= lock).map((r) => r.id)
  if (due.length === 0) return { matured: [], blockedByLock }
  const flip = db.prepare("UPDATE vouchers SET post_dated = 0, updated_at = datetime('now') WHERE id = ?")
  const run = db.transaction(() => {
    for (const { id } of due) {
      const before = getVoucher(db, id)!
      flip.run(id)
      writeAudit(db, 'voucher', id, 'update', before, { ...before, postDated: false, matured: true })
    }
  })
  run()
  return { matured: due.map((r) => r.id), blockedByLock }
}

/** Mature ONE post-dated voucher on demand (Banking → PDC register's "Mature now"), regardless
 *  of its date — the user is asserting the instrument has cleared early. Refuses vouchers dated
 *  inside the locked period, same as saveVoucher/deleteVoucher (v0.3 review F3). Audit-logged
 *  the same way maturePostDated logs automatic maturations. */
export function maturePdcNow(db: DB, id: number): void {
  const before = getVoucher(db, id)
  if (!before) throw new Error('Voucher not found')
  if (before.deletedAt) throw new Error('Voucher is in the bin')
  if (!before.postDated) throw new Error('Voucher is not post-dated')
  const lock = getLockDate(db)
  if (lock && before.date <= lock) {
    throw new Error(`Books are locked up to ${lock} — this voucher (dated ${before.date}) cannot mature into the locked period`)
  }
  db.prepare("UPDATE vouchers SET post_dated = 0, updated_at = datetime('now') WHERE id = ?").run(id)
  writeAudit(db, 'voucher', id, 'update', before, { ...before, postDated: false, matured: true })
}

/**
 * Change the narration or the cost centre on many vouchers at once (#39).
 *
 * The two fields this touches are the two that are routinely wrong in bulk and never wrong
 * individually: a month of entries keyed with no narration at all, or a quarter of branch
 * expenses that were never allocated because the cost centre was added to the chart in April.
 * Fixing those one voucher at a time means reopening and re-saving each one, which renumbers
 * nothing but rewrites everything — a hundred audit rows saying the whole voucher changed, when
 * one field did.
 *
 * So this writes the narrow change and audits it as a narrow change. What it deliberately will
 * NOT do:
 *
 *   - touch amounts, ledgers, dates or bill references. Every one of those alters what the books
 *     say, and "change it on all of them" is never the right way to say that;
 *   - skip a voucher quietly. A voucher inside the locked period, or in the bin, aborts the whole
 *     run before anything is written. A bulk edit that did 91 of 100 and mentioned it in a toast
 *     is a bulk edit nobody can reconcile afterwards.
 *
 * The cost-centre change replaces every allocation on every line that can carry one, at the
 * line's full amount. Replacing rather than merging is the honest reading of "put these on the
 * Pune cost centre": a line already split 60/40 across two others is not meant to come out of
 * this holding three.
 */
export interface BulkVoucherEdit {
  /** Absent = leave alone. Null or '' = clear the narration. */
  narration?: string | null
  /** Absent = leave alone. Null = remove every allocation. */
  costCentreId?: number | null
}

export interface BulkEditResult {
  vouchers: number
  /** Lines whose allocations were rewritten; 0 when only the narration changed. */
  linesAllocated: number
}

/**
 * Lines a cost centre can meaningfully sit on.
 *
 * Not the party line and not the cash/bank line: a cost centre answers "which part of the
 * business did this cost belong to", and the money leaving the bank belongs to all of them. Tally
 * makes the same distinction, and allocating the bank side as well would double every centre's
 * total.
 */
function allocatableLines(db: DB, voucherId: number): { id: number; amount: number }[] {
  const cashBank = cashBankGroupIds(db)
  const rows = prep(db,
      `SELECT vl.id, vl.amount, vl.ledger_id AS ledgerId, l.group_id AS groupId
       FROM voucher_lines vl JOIN ledgers l ON l.id = vl.ledger_id
       WHERE vl.voucher_id = ?`
    )
    .all(voucherId) as { id: number; amount: number; ledgerId: number; groupId: number }[]
  const party = (prep(db, 'SELECT party_ledger_id AS p FROM vouchers WHERE id = ?').get(voucherId) as
    | { p: number | null }
    | undefined)?.p ?? null
  return rows
    .filter((r) => r.ledgerId !== party && !cashBank.has(r.groupId))
    .map((r) => ({ id: r.id, amount: r.amount }))
}

export function bulkEditVouchers(db: DB, ids: number[], edit: BulkVoucherEdit): BulkEditResult {
  if (ids.length === 0) throw new Error('Nothing selected')
  if (edit.narration === undefined && edit.costCentreId === undefined) {
    throw new Error('Nothing to change')
  }
  if (edit.costCentreId != null) {
    const centre = prep(db, 'SELECT id FROM cost_centres WHERE id = ?').get(edit.costCentreId)
    if (!centre) throw new Error('Cost centre not found')
  }

  const lock = getLockDate(db)
  // Everything is checked before anything is written: a partly-applied bulk edit is worse than
  // one that refused, because the user has no way to tell which half went through.
  const before = ids.map((id) => {
    const v = getVoucher(db, id)
    if (!v) throw new Error(`Voucher ${id} not found`)
    if (v.deletedAt) throw new Error(`Voucher ${v.number} is in the bin`)
    if (lock && v.date <= lock) throw new Error(`Books are locked up to ${lock} — ${v.number} is inside it`)
    return v
  })

  const narration = edit.narration === undefined ? undefined : (edit.narration?.trim() || null)
  let linesAllocated = 0

  const run = db.transaction(() => {
    const setNarration = db.prepare("UPDATE vouchers SET narration = ?, updated_at = datetime('now') WHERE id = ?")
    const clearAlloc = prep(db,
      `DELETE FROM voucher_line_cost_allocations
       WHERE voucher_line_id IN (SELECT id FROM voucher_lines WHERE voucher_id = ?)`
    )
    const addAlloc = prep(db,
      'INSERT INTO voucher_line_cost_allocations (voucher_line_id, cost_centre_id, amount) VALUES (?, ?, ?)'
    )

    for (const v of before) {
      if (narration !== undefined) setNarration.run(narration, v.id)
      if (edit.costCentreId !== undefined) {
        clearAlloc.run(v.id)
        if (edit.costCentreId != null) {
          for (const line of allocatableLines(db, v.id)) {
            if (line.amount <= 0) continue
            addAlloc.run(line.id, edit.costCentreId, line.amount)
            linesAllocated++
          }
        }
      }
      // One audit row per voucher, carrying only the fields that moved — a reader six months
      // later can see this was a narration sweep and not a re-keying of the entry.
      writeAudit(
        db,
        'voucher',
        v.id,
        'update',
        { narration: v.narration, costAllocations: v.lines.map((l) => l.costAllocations) },
        { bulkEdit: true, ...(narration !== undefined ? { narration } : {}),
          ...(edit.costCentreId !== undefined ? { costCentreId: edit.costCentreId } : {}) }
      )
    }
  })
  run()

  return { vouchers: before.length, linesAllocated }
}

export interface PdcRow {
  id: number
  date: string
  number: string
  voucherTypeName: string
  partyName: string | null
  instrumentNo: string | null
  instrumentDate: string | null
  /** Voucher total (sum of debit lines), paise. */
  amount: number
}

/** PDC register (Banking view): every live post-dated voucher, soonest maturity first.
 *  Deliberately NOT filtered by IN_BOOKS — this is the one listing that shows PDCs. */
export function pdcRegister(db: DB): PdcRow[] {
  return prep(db,
      `SELECT v.id, v.date, v.number, vt.name AS voucherTypeName, l.name AS partyName,
              v.instrument_no AS instrumentNo, v.instrument_date AS instrumentDate,
              (SELECT COALESCE(SUM(amount), 0) FROM voucher_lines WHERE voucher_id = v.id AND dr_cr = 'dr') AS amount
       FROM vouchers v
       JOIN voucher_types vt ON vt.id = v.voucher_type_id
       LEFT JOIN ledgers l ON l.id = v.party_ledger_id
       WHERE v.post_dated = 1 AND ${NOT_DELETED}
       ORDER BY v.date, v.id`
    )
    .all() as PdcRow[]
}

/** Permanently remove a voucher that is already in the bin. Irreversible. */
export function purgeVoucher(db: DB, id: number): void {
  const before = getVoucher(db, id)
  if (!before) throw new Error('Voucher not found')
  if (!before.deletedAt) throw new Error('Voucher must be in the bin before it can be purged')
  prep(db, 'DELETE FROM vouchers WHERE id = ?').run(id)
  writeAudit(db, 'voucher', id, 'delete', { ...before, purged: true }, null)
}

/** Vouchers auto-purged after sitting in the bin longer than `days` (default 30). Returns the
 *  count purged. Child rows (voucher_lines, inventory_lines, bill_refs, tds_entries, cost
 *  allocations) cascade; a single summary audit row covers the batch.
 *
 *  Two guards (GST audit F1):
 *  - Only vouchers dated on/before the books LOCK date are auto-purged. Binned vouchers in
 *    unlocked periods are still needed — GSTR-1 Table 13 reports them as CANCELLED documents
 *    and nextVoucherNumber relies on them so a deleted number is never reissued. With no lock
 *    date set, nothing is auto-purged (manual purge via the Bin screen remains available).
 *  - Per-voucher DELETE with continue-past-failures: one purge-blocked voucher (e.g. still
 *    referenced by payroll_runs, which has no ON DELETE CASCADE) must not stop the whole
 *    purge forever. */
export function purgeOldDeleted(db: DB, days = 30): number {
  // Zero is a policy, not a disabled feature: a business under audit wants nothing to disappear.
  if (days <= 0) return 0
  const lock = getLockDate(db)
  if (!lock) return 0
  const rows = prep(db,
      `SELECT id FROM vouchers v
       WHERE v.deleted_at IS NOT NULL AND v.deleted_at <= datetime('now', ?) AND v.date <= ?`
    )
    .all(`-${days} days`, lock) as { id: number }[]
  const del = prep(db, 'DELETE FROM vouchers WHERE id = ?')
  let purged = 0
  for (const { id } of rows) {
    try {
      del.run(id)
      purged++
    } catch {
      // e.g. an FK from payroll_runs — leave this voucher in the bin, keep purging the rest.
    }
  }
  if (purged > 0) {
    writeAudit(db, 'voucher', 0, 'delete', { autoPurgedFromBin: purged, olderThanDays: days }, null)
  }
  return purged
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
  const rows = prep(db,
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
              COALESCE(t.total, 0) AS amount,
              v.is_optional AS isOptional, v.post_dated AS postDated
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
    .all(...(voucherTypeId ? [from, to, voucherTypeId] : [from, to])) as (Omit<VoucherListRow, 'isOptional' | 'postDated'> & {
      isOptional: number
      postDated: number
    })[]
  return rows.map((r) => ({ ...r, isOptional: !!r.isOptional, postDated: !!r.postDated }))
}

/**
 * The most recent voucher of a type, as a draft to start a new one from.
 *
 * "Same as last time, different amount" is most of the data entry in a small business: the rent
 * cheque, the monthly retainer, the standing purchase from one supplier. Recurring templates
 * cover the ones that repeat on a schedule; this covers the far commoner case of one that repeats
 * whenever it happens to.
 *
 * The date is deliberately NOT copied — a new voucher dated a month ago is a mistake, and the
 * entry screen's own working date is the right default. Everything that identifies the
 * transaction (party, ledgers, amounts, narration) is copied, because those are what make it
 * "the same as last time".
 */
export interface VoucherDraftSource {
  date?: string
  partyLedgerId?: number
  narration?: string
  lines?: { ledgerId: number; drCr: DrCr; amount: number }[]
}

export function draftFromVoucher(db: DB, voucherId: number): VoucherDraftSource | null {
  const v = getVoucher(db, voucherId)
  if (!v) return null
  return {
    partyLedgerId: v.partyLedgerId ?? undefined,
    narration: v.narration ?? undefined,
    lines: v.lines.map((l) => ({ ledgerId: l.ledgerId, drCr: l.drCr, amount: l.amount }))
  }
}

/** Id of the newest voucher of a type that is still in the books, or null if there is none. */
export function latestVoucherOfType(db: DB, voucherTypeId: number): number | null {
  const row = prep(db,
      `SELECT id FROM vouchers v
       WHERE voucher_type_id = ? AND ${IN_BOOKS}
       ORDER BY date DESC, id DESC LIMIT 1`
    )
    .get(voucherTypeId) as { id: number } | undefined
  return row?.id ?? null
}

/**
 * What the next auto-purge would remove, without removing it.
 *
 * A policy that silently deletes is a policy nobody can check. The Bin screen shows this so the
 * answer to "is anything about to disappear" is on the screen where it would disappear from,
 * rather than discovered afterwards.
 */
export function binPurgeCandidates(db: DB, days: number): { count: number; oldestDate: string | null } {
  if (days <= 0) return { count: 0, oldestDate: null }
  const lock = getLockDate(db)
  if (!lock) return { count: 0, oldestDate: null }
  const row = prep(db,
      `SELECT COUNT(*) AS count, MIN(v.date) AS oldestDate FROM vouchers v
       WHERE v.deleted_at IS NOT NULL AND v.deleted_at <= datetime('now', ?) AND v.date <= ?`
    )
    .get(`-${days} days`, lock) as { count: number; oldestDate: string | null }
  return row
}
