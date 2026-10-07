import type { DB } from '../db/connection'
import {
  STOCK_NOTE_KINDS,
  type Voucher, type VoucherLine, type InventoryLine, type VoucherType, type NegativeStockWarning, type SaveVoucherWarnings,
  type TradePurpose, type VoucherKind
} from '@shared/domain'
import { voucherInputSchema } from '@shared/schemas'
import type { VoucherInput, VoucherInputParsed } from '@shared/schemas'
import type { VoucherListRow } from '@shared/reports'
import { validateVoucher, type LedgerFacts } from '@shared/posting'
import { fyOf } from '@shared/dates'
import { nextSeriesNumber } from './numbering'
import { cashBankGroupIds } from './masters'
import { getFeatures } from './config'
import { writeAudit } from './audit'
import { ensureTdsPayableLedger, PENDING_PAYABLE_LEDGER, prepareVoucherTds } from './tds'
import { parseLineSerials, rebuildItemSerials, syncVoucherSerials } from './serials'
import {
  assertBinnable, assertRestorable, hasTradeSchema, lineSourcesOf, resolveVoucherLines, syncVoucherLinks, type ResolvedLine
} from './tradeLinks'

interface VoucherRow {
  id: number; voucher_type_id: number; date: string; number: string
  party_ledger_id: number | null; narration: string | null; reference: string | null
  instrument_no: string | null; instrument_date: string | null
  transporter_id: string | null; vehicle_no: string | null; transport_distance: number | null
  pos_override: string | null
  currency_code: string | null; exchange_rate: number | null
  irn: string | null; irn_ack_no: string | null; irn_ack_date: string | null
  ewb_no: string | null; ewb_valid_upto: string | null
  post_dated: number; is_optional: number; is_year_end_close: number
  deleted_at: string | null
  created_at: string; updated_at: string
}

/** Greppable filter for every query joining `vouchers` as `v` that must exclude binned vouchers. */
export const NOT_DELETED = 'v.deleted_at IS NULL'

/** Post-dated vouchers stay out of the books until they mature (maturePostDated flips the flag). */
export const NOT_POSTDATED = 'v.post_dated = 0'

/** Optional (memorandum) vouchers never count toward the books. */
export const NOT_OPTIONAL = 'v.is_optional = 0'

/** Composite filter: the voucher counts toward the books — not binned, not post-dated, not
 *  optional. New report queries should use this instead of NOT_DELETED alone. */
export const IN_BOOKS = `${NOT_DELETED} AND ${NOT_POSTDATED} AND ${NOT_OPTIONAL}`

/** Greppable filter for every query reading `inventory_lines` as `il` for STOCK MOVEMENT: an
 *  invoice / bill line whose goods moved on its linked challan / GRN (moves_stock = 0, WP 2.5)
 *  is an item line of the invoice, not a second movement. movesStockLint.test.ts checks that
 *  every inventory_lines query in services either filters this or is allowlisted. */
export const MOVES_STOCK = 'il.moves_stock = 1'

/** Default purpose of a stock note when the input names none. */
const DEFAULT_PURPOSE: Partial<Record<VoucherKind, TradePurpose>> = { delivery_note: 'supply', receipt_note: 'purchase' }
const PURPOSES_FOR: Partial<Record<VoucherKind, readonly TradePurpose[]>> = {
  delivery_note: ['supply', 'job_work', 'approval', 'liquid_gas', 'non_supply'],
  receipt_note: ['purchase', 'return', 'job_work']
}

/** Year-end closing journals (migration 018 flag) are real postings — the trial balance, ledger
 *  statements and balances keep them — but profit-for-a-period reports (P&L, close preview, cash
 *  flow, budget actuals) exclude them, so a closed year still reports its real profit. */
export const NOT_YEAR_END_CLOSE = 'v.is_year_end_close = 0'

export const YEAR_END_CLOSE_IMMUTABLE =
  "Year-end closing entries can't be edited. Move it to the bin to reopen the year, then close again."

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
    // SELECT * so `serials` (migration 021) is simply absent on an older schema (migration tests).
    .prepare('SELECT * FROM inventory_lines WHERE voucher_id = ? ORDER BY line_order, id')
    .all(id) as {
      id: number; stock_item_id: number; godown_id: number | null; batch_id: number | null
      qty_milli: number; rate_paise: number; discount_paise: number; amount: number; direction: 'in' | 'out'; is_absolute: number
      serials?: string | null
      line_uid?: string | null; moves_stock?: number
    }[]
  const trade = hasTradeSchema(db)
  const sources = trade ? lineSourcesOf(db, id) : new Map()
  const tradeRow = trade
    ? (db.prepare('SELECT purpose FROM trade_voucher_details WHERE voucher_id = ?').get(id) as { purpose: TradePurpose } | undefined)
    : undefined

  const costAllocRows = lines.length
    ? (db
        .prepare(
          `SELECT voucher_line_id, cost_centre_id, amount FROM voucher_line_cost_allocations
           WHERE voucher_line_id IN (${lines.map(() => '?').join(',')}) ORDER BY id`
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
    .prepare(
      `SELECT id, section_id, base_amount, tds_amount, is_manual, rate_bp_at, deductee_type_at, certificate_id
       FROM tds_entries WHERE voucher_id = ? ORDER BY id LIMIT 1`
    )
    .get(id) as
    | {
        id: number; section_id: number; base_amount: number; tds_amount: number; is_manual: number
        rate_bp_at: number | null; deductee_type_at: string | null; certificate_id: number | null
      }
    | undefined

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
    postDated: !!v.post_dated,
    isOptional: !!v.is_optional,
    isYearEndClose: !!v.is_year_end_close,
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
        id: l.id, stockItemId: l.stock_item_id, godownId: l.godown_id, batchId: l.batch_id,
        qtyMilli: l.qty_milli, ratePaise: l.rate_paise, discountPaise: l.discount_paise,
        amount: l.amount, direction: l.direction,
        isAbsolute: !!l.is_absolute,
        serials: parseLineSerials(l.serials),
        ...(l.line_uid != null
          ? { lineUid: l.line_uid, movesStock: l.moves_stock !== 0, source: sources.get(l.line_uid) ?? null }
          : {})
      })
    ),
    billRefs: billRefRows.map((r) => ({ kind: r.kind, name: r.name, amount: r.amount, dueDate: r.due_date })),
    tds: tdsRow
      ? {
          sectionId: tdsRow.section_id, baseAmount: tdsRow.base_amount, tdsAmount: tdsRow.tds_amount,
          isManual: !!tdsRow.is_manual, rateBp: tdsRow.rate_bp_at, deducteeType: tdsRow.deductee_type_at,
          certificateId: tdsRow.certificate_id, entryId: tdsRow.id
        }
      : null,
    trade: tradeRow ? { purpose: tradeRow.purpose } : null
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
  // The series arithmetic lives in numbering.ts (shared with order / quotation series, WP 2.5a).
  return nextSeriesNumber(db, {
    table: 'vouchers', typeColumn: 'voucher_type_id', type: getVoucherType(db, voucherTypeId), date, excludeId: excludeVoucherId
  })
}

/** True when another live voucher of this type already carries `number` — the renderer's
 *  pre-save confirm for a manually typed number (the post-save duplicateNumber flag on
 *  SavedVoucher stays as the belt-and-braces warning for races). Binned vouchers don't
 *  count: restoring one back into a clash is already the restore flow's problem. */
export function voucherNumberExists(db: DB, voucherTypeId: number, number: string, excludeId?: number): boolean {
  const row = db
    .prepare(
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
  const stmt = db.prepare('SELECT group_id, tds_payable_section_id FROM ledgers WHERE id = ?')
  const cache = new Map<number, LedgerFacts>()
  return (id: number) => {
    const hit = cache.get(id)
    if (hit) return hit
    const row = stmt.get(id) as { group_id: number; tds_payable_section_id: number | null } | undefined
    const facts: LedgerFacts = {
      exists: !!row, isCashOrBank: !!row && cashBank.has(row.group_id), isTdsPayable: row?.tds_payable_section_id != null
    }
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
  const movementsStmt = db.prepare(
    `SELECT il.qty_milli AS qtyMilli, il.direction, il.is_absolute AS isAbsolute
     FROM inventory_lines il JOIN vouchers v ON v.id = il.voucher_id
     WHERE il.stock_item_id = ? AND v.date <= ? AND ${IN_BOOKS} AND ${MOVES_STOCK}
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

/** Extension points for services that build on the voucher pipeline (WP 2.2 manufacture). */
export interface SaveVoucherHooks {
  /** Runs inside the save transaction after the voucher's lines are written and BEFORE the
   *  post-save checks — so a hard negative-stock block (or a throw here) rolls everything back
   *  together. Receives the saved voucher id. */
  withinTransaction?: (voucherId: number) => void
  /** Set by the manufacture service: it owns vouchers that carry a manufacture_details row. */
  manufacture?: boolean
}

export const MANUFACTURE_EDIT_ELSEWHERE = 'This is a manufacture voucher — alter it from the Manufacture screen'

export function saveVoucher(db: DB, raw: VoucherInput, existingId?: number, hooks: SaveVoucherHooks = {}): SaveVoucherResult {
  // Parse here as well as at the IPC boundary so direct callers (tests, importers)
  // get defaults for later-added fields (posOverride) applied consistently.
  const input: VoucherInputParsed = voucherInputSchema.parse(raw)
  // Year-end closing journals are immutable (WP 1.3) — checked before any validation so the user
  // always gets this reason. An edited date/type/lines would reopen the year or hide real
  // postings from the P&L. The flag itself is never part of voucher input — only postClose sets it.
  if (existingId) {
    const flagged = db.prepare('SELECT is_year_end_close AS f FROM vouchers WHERE id = ?').get(existingId) as
      | { f: number }
      | undefined
    if (flagged?.f) throw new Error(YEAR_END_CLOSE_IMMUTABLE)
    // A manufacture's entry facts (manufacture_details) would go stale under a generic edit.
    if (!hooks.manufacture && db.prepare('SELECT 1 FROM manufacture_details WHERE voucher_id = ?').get(existingId)) {
      throw new Error(MANUFACTURE_EDIT_ELSEWHERE)
    }
  }
  const vt = getVoucherType(db, input.voucherTypeId)
  // TDS (WP 3.1): resolve the payable credit for tds.autoPayable (a ledger that doesn't exist
  // yet rides as PENDING_PAYABLE_LEDGER until the transaction below creates it) and check the
  // entry against the lines and the rate table. `posting` is what actually gets stored.
  const preparedTds = prepareVoucherTds(db, input, existingId)
  const posting: VoucherInputParsed = { ...input, lines: preparedTds.lines }
  const baseFacts = ledgerFactsResolver(db)
  const facts = (id: number): LedgerFacts =>
    id === PENDING_PAYABLE_LEDGER ? { exists: true, isCashOrBank: false, isTdsPayable: true } : baseFacts(id)
  const errors = [...validateVoucher(posting, vt.kind, facts), ...preparedTds.errors]
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

  // Delivery challan / GRN purpose (WP 2.5): absent on the input = keep the stored one.
  const stockNote = STOCK_NOTE_KINDS.includes(vt.kind)
  const purpose: TradePurpose | null = stockNote
    ? (input.trade?.purpose ?? before?.trade?.purpose ?? DEFAULT_PURPOSE[vt.kind]!)
    : null
  if (purpose && !PURPOSES_FOR[vt.kind]!.includes(purpose)) {
    throw new Error(`A ${vt.name} can't have the purpose "${purpose.replace('_', ' ')}"`)
  }
  const trade = hasTradeSchema(db)

  // Post-dated / optional flags (tasks 77–78): absent on the input = keep the stored value
  // (an edit that doesn't mention them mustn't silently mature a PDC).
  const postDated = input.postDated ?? before?.postDated ?? false
  const isOptional = input.isOptional ?? before?.isOptional ?? false

  const run = db.transaction((): number => {
    // WP 2.5: stable line uids + resolved link sources (refused here — before anything is
    // written — when a source is unknown, the voucher's own, or not an allowed pair).
    const resolved: ResolvedLine[] = trade ? resolveVoucherLines(db, input.inventory, { kind: vt.kind, before }) : []
    let voucherId: number
    if (existingId) {
      db.prepare(
        `UPDATE vouchers SET voucher_type_id = ?, date = ?, number = ?, party_ledger_id = ?,
         narration = ?, reference = ?, instrument_no = ?, instrument_date = ?,
         transporter_id = ?, vehicle_no = ?, transport_distance = ?, pos_override = ?,
         currency_code = ?, exchange_rate = ?, post_dated = ?, is_optional = ?,
         updated_at = datetime('now') WHERE id = ?`
      ).run(vt.id, input.date, number, input.partyLedgerId, input.narration, input.reference,
        input.instrumentNo, input.instrumentDate, input.transporterId, input.vehicleNo, input.transportDistanceKm,
        input.posOverride, input.currencyCode, input.exchangeRate, postDated ? 1 : 0, isOptional ? 1 : 0, existingId)
      db.prepare('DELETE FROM voucher_lines WHERE voucher_id = ?').run(existingId)
      db.prepare('DELETE FROM inventory_lines WHERE voucher_id = ?').run(existingId)
      voucherId = existingId
    } else {
      const res = db.prepare(
        `INSERT INTO vouchers (voucher_type_id, date, number, party_ledger_id, narration, reference,
          instrument_no, instrument_date, transporter_id, vehicle_no, transport_distance, pos_override,
          currency_code, exchange_rate, post_dated, is_optional)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(vt.id, input.date, number, input.partyLedgerId, input.narration, input.reference,
        input.instrumentNo, input.instrumentDate, input.transporterId, input.vehicleNo, input.transportDistanceKm,
        input.posOverride, input.currencyCode, input.exchangeRate, postDated ? 1 : 0, isOptional ? 1 : 0)
      voucherId = Number(res.lastInsertRowid)
    }

    // Bank reconciliation dates live on voucher_lines (set by banking.setBankDate, not by this
    // input), so replacing the line set would silently un-reconcile an altered voucher. Carry
    // each reconciled date over to the first new line posting the same ledger/side/amount — an
    // edit that changes a reconciled line's amount legitimately drops its reconciliation.
    const carriedBankDates = (before?.lines ?? [])
      .filter((l) => l.bankDate != null)
      .map((l) => ({ ledgerId: l.ledgerId, drCr: l.drCr, amount: l.amount, bankDate: l.bankDate!, used: false }))
    const bankDateFor = (l: { ledgerId: number; drCr: 'dr' | 'cr'; amount: number }): string | null => {
      const hit = carriedBankDates.find((c) => !c.used && c.ledgerId === l.ledgerId && c.drCr === l.drCr && c.amount === l.amount)
      if (!hit) return null
      hit.used = true
      return hit.bankDate
    }
    const insertLine = db.prepare(
      'INSERT INTO voucher_lines (voucher_id, ledger_id, dr_cr, amount, line_order, bank_date) VALUES (?, ?, ?, ?, ?, ?)'
    )
    const insertCostAlloc = db.prepare(
      'INSERT INTO voucher_line_cost_allocations (voucher_line_id, cost_centre_id, amount) VALUES (?, ?, ?)'
    )
    // Created here, inside the save transaction, so a rejected save never leaves a stray ledger.
    if (preparedTds.createPayableFor != null) {
      const payableId = ensureTdsPayableLedger(db, preparedTds.createPayableFor)
      for (const l of posting.lines) if (l.ledgerId === PENDING_PAYABLE_LEDGER) l.ledgerId = payableId
    }
    posting.lines.forEach((l, i) => {
      const res = insertLine.run(voucherId, l.ledgerId, l.drCr, l.amount, i, bankDateFor(l))
      const lineId = Number(res.lastInsertRowid)
      for (const alloc of l.costAllocations ?? []) {
        insertCostAlloc.run(lineId, alloc.costCentreId, alloc.amount)
      }
    })

    const insertInv = db.prepare(
      trade
        ? `INSERT INTO inventory_lines (voucher_id, stock_item_id, godown_id, batch_id, qty_milli, rate_paise, discount_paise, amount, direction, is_absolute, line_order, line_uid, moves_stock)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        : `INSERT INTO inventory_lines (voucher_id, stock_item_id, godown_id, batch_id, qty_milli, rate_paise, discount_paise, amount, direction, is_absolute, line_order)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    input.inventory.forEach((l, i) =>
      insertInv.run(voucherId, l.stockItemId, l.godownId, l.batchId ?? null, l.qtyMilli, l.ratePaise,
        l.discountPaise ?? 0, l.amount, l.direction, l.isAbsolute ? 1 : 0, i,
        ...(trade ? [resolved[i]!.uid, resolved[i]!.movesStock ? 1 : 0] : []))
    )
    if (trade) {
      // WP 2.5: the voucher's own links (as target) and its role as a source — tradeLinks.ts.
      const lw = syncVoucherLinks(db, {
        voucherId, kind: vt.kind, date: input.date, partyLedgerId: input.partyLedgerId, isOptional,
        lines: input.inventory, resolved, before
      })
      if (lw.linkDates.length > 0) warnings.linkDates = lw.linkDates
      if (lw.frozenRepricing.length > 0) warnings.frozenRepricing = lw.frozenRepricing
      if (purpose) {
        db.prepare(
          `INSERT INTO trade_voucher_details (voucher_id, purpose) VALUES (?, ?)
           ON CONFLICT(voucher_id) DO UPDATE SET purpose = excluded.purpose`
        ).run(voucherId, purpose)
      } else {
        db.prepare('DELETE FROM trade_voucher_details WHERE voucher_id = ?').run(voucherId)
      }
    }
    // WP 2.3: line serials (validated, stored, serial_numbers re-projected) — services/serials.ts.
    syncVoucherSerials(db, voucherId, input.inventory, before?.inventory)

    // Bill refs ride on `vouchers`, not `voucher_lines`, so an UPDATE doesn't cascade their
    // deletion the way replacing the line set does — clear and reinsert explicitly. The TDS entry
    // is updated IN PLACE instead (its id keys the challan allocation, which must survive edits).
    db.prepare('DELETE FROM bill_refs WHERE voucher_id = ?').run(voucherId)

    if (input.billRefs.length > 0) {
      const insertBillRef = db.prepare(
        'INSERT INTO bill_refs (voucher_id, party_ledger_id, kind, name, amount, due_date) VALUES (?, ?, ?, ?, ?, ?)'
      )
      for (const ref of input.billRefs) {
        insertBillRef.run(voucherId, input.partyLedgerId, ref.kind, ref.name, ref.amount, ref.dueDate)
      }
    }

    const existingEntries = db.prepare('SELECT id FROM tds_entries WHERE voucher_id = ? ORDER BY id').all(voucherId) as { id: number }[]
    if (input.tds) {
      const party = input.partyLedgerId
        ? (db.prepare('SELECT pan FROM ledgers WHERE id = ?').get(input.partyLedgerId) as { pan: string | null } | undefined)
        : undefined
      const basis = preparedTds.basis
      const values = [
        input.tds.sectionId, input.partyLedgerId, party?.pan ?? null, input.tds.baseAmount, input.tds.tdsAmount,
        basis?.deducteeType ?? null, basis?.rateBp ?? null, basis?.certificateId ?? null, input.tds.isManual ? 1 : 0
      ]
      const keep = existingEntries[0]
      if (keep) {
        db.prepare(
          `UPDATE tds_entries SET section_id = ?, party_ledger_id = ?, pan = ?, base_amount = ?, tds_amount = ?,
             deductee_type_at = ?, rate_bp_at = ?, certificate_id = ?, is_manual = ? WHERE id = ?`
        ).run(...values, keep.id)
        for (const extra of existingEntries.slice(1)) db.prepare('DELETE FROM tds_entries WHERE id = ?').run(extra.id)
      } else {
        db.prepare(
          `INSERT INTO tds_entries (section_id, party_ledger_id, pan, base_amount, tds_amount,
             deductee_type_at, rate_bp_at, certificate_id, is_manual, voucher_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(...values, voucherId)
      }
    } else if (existingEntries.length > 0) {
      db.prepare('DELETE FROM tds_entries WHERE voucher_id = ?').run(voucherId)
    }

    hooks.withinTransaction?.(voucherId)

    // ---- post-save checks (lane I): run INSIDE the transaction so a hard block rolls the
    // whole save back; soft failures just ride out as warnings on the response. ----
    const features = getFeatures(db)

    // Batches: a line's batch must belong to its stock item, and an outward line can't take
    // more out of a batch than it holds (hard errors — a batch is a physical lot).
    // A line whose goods moved on its linked challan / GRN (WP 2.5) moves nothing here.
    const moves = (i: number): boolean => !trade || resolved[i]!.movesStock
    const movingLines = input.inventory.filter((_l, i) => moves(i))
    const batchLines = input.inventory.filter((l) => l.batchId != null && !l.isAbsolute)
    if (batchLines.length > 0) {
      const batchStmt = db.prepare('SELECT id, stock_item_id, name FROM batches WHERE id = ?')
      const balanceStmt = db.prepare(
        `SELECT COALESCE(SUM(CASE WHEN il.direction = 'in' THEN il.qty_milli ELSE -il.qty_milli END), 0) AS bal
         FROM inventory_lines il JOIN vouchers v ON v.id = il.voucher_id
         WHERE il.batch_id = ? AND il.is_absolute = 0 AND ${IN_BOOKS} ${trade ? `AND ${MOVES_STOCK}` : ''}`
      )
      for (const line of batchLines) {
        const batch = batchStmt.get(line.batchId) as { id: number; stock_item_id: number; name: string } | undefined
        if (!batch) throw new Error('Batch not found')
        if (batch.stock_item_id !== line.stockItemId) {
          throw new Error(`Batch ${batch.name} belongs to a different stock item`)
        }
      }
      const outBatchIds = [...new Set(
        movingLines.filter((l) => l.batchId != null && !l.isAbsolute && l.direction === 'out').map((l) => l.batchId!)
      )]
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
      movingLines.filter((l) => l.direction === 'out' && !l.isAbsolute).map((l) => l.stockItemId)
    )]
    warnings.negativeStock = checkStock(db, outItemIds, input.date)
    if (features.preventNegativeStock && warnings.negativeStock.length > 0) {
      const names = warnings.negativeStock.map((w) => w.name).join(', ')
      throw new Error(`Insufficient stock for: ${names}`)
    }

    // Credit limit (task 76): with this voucher's lines now in the books, the party's
    // dr-positive balance IS "outstanding + this invoice". Warn past the ledger's limit;
    // block (roll back) under F11 enforceCreditLimit. Post-dated/optional vouchers are out
    // of the books, so they never trip the limit.
    // A challan / GRN posts nothing, so it never moves the party's outstanding (WP 2.5).
    if (input.partyLedgerId !== null && !postDated && !isOptional && !stockNote) {
      const party = db
        .prepare('SELECT id, name, opening_balance, credit_limit FROM ledgers WHERE id = ?')
        .get(input.partyLedgerId) as
        | { id: number; name: string; opening_balance: number; credit_limit: number | null }
        | undefined
      if (party && party.credit_limit !== null) {
        const { bal } = db
          .prepare(
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
  const duplicate = db
    .prepare(
      `SELECT 1 FROM vouchers v WHERE v.voucher_type_id = ? AND v.number = ? AND v.id <> ? AND ${NOT_DELETED} LIMIT 1`
    )
    .get(vt.id, number, voucherId)
  return duplicate ? { ...after, warnings, duplicateNumber: true } : { ...after, warnings }
}

/** Move a voucher to the bin (soft delete). Report queries exclude it; restoreVoucher undoes this. */
export function deleteVoucher(db: DB, id: number): void {
  const before = getVoucher(db, id)
  if (!before) throw new Error('Voucher not found')
  const lock = getLockDate(db)
  if (lock && before.date <= lock) throw new Error(`Books are locked up to ${lock}`)
  db.transaction(() => {
    // WP 2.5: refused while a live document draws on its lines (or it re-prices a frozen GRN).
    assertBinnable(db, id)
    db.prepare("UPDATE vouchers SET deleted_at = datetime('now') WHERE id = ?").run(id)
    // WP 2.3: a binned voucher's serials no longer count (a sale's go back into stock).
    rebuildItemSerials(db, before.inventory.map((l) => l.stockItemId))
  })()
  writeAudit(db, 'voucher', id, 'delete', before, null)
}

/** Reinstate a binned voucher so it counts in reports again. */
export function restoreVoucher(db: DB, id: number): void {
  const before = getVoucher(db, id)
  if (!before) throw new Error('Voucher not found')
  if (!before.deletedAt) throw new Error('Voucher is not in the bin')
  const lock = getLockDate(db)
  if (lock && before.date <= lock) throw new Error(`Books are locked up to ${lock}`)
  if (before.isYearEndClose) {
    // Restoring a closing journal re-closes its year — refuse when the year was closed again in
    // the meantime, or Retained Earnings would receive the year's profit twice.
    const fy = fyOf(before.date)
    const live = db
      .prepare(`SELECT 1 FROM vouchers v WHERE ${NOT_DELETED} AND v.is_year_end_close = 1 AND v.date BETWEEN ? AND ? LIMIT 1`)
      .get(fy.from, fy.to)
    if (live) {
      throw new Error(`FY ${fy.label} already has a year-end closing entry; bin that one first to restore this one`)
    }
  }
  db.transaction(() => {
    db.prepare('UPDATE vouchers SET deleted_at = NULL WHERE id = ?').run(id)
    // WP 2.5: its links come back to life — re-check their sources and capacity.
    assertRestorable(db, id)
    // WP 2.3: re-apply its serials — refused (rolled back) if one has moved on meanwhile.
    rebuildItemSerials(db, before.inventory.map((l) => l.stockItemId))
  })()
  writeAudit(db, 'voucher', id, 'update', before, { restored: true })
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
  const rows = db
    .prepare(`SELECT v.id, v.date FROM vouchers v WHERE v.post_dated = 1 AND v.date <= ? AND ${NOT_DELETED}`)
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

export interface PdcRow {
  id: number
  date: string
  number: string
  voucherTypeName: string
  partyLedgerId: number | null
  partyName: string | null
  instrumentNo: string | null
  instrumentDate: string | null
  /** Voucher total (sum of debit lines), paise. */
  amount: number
}

/** PDC register (Banking view): every live post-dated voucher, soonest maturity first.
 *  Deliberately NOT filtered by IN_BOOKS — this is the one listing that shows PDCs. */
export function pdcRegister(db: DB): PdcRow[] {
  return db
    .prepare(
      `SELECT v.id, v.date, v.number, vt.name AS voucherTypeName, v.party_ledger_id AS partyLedgerId, l.name AS partyName,
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
  try {
    db.prepare('DELETE FROM vouchers WHERE id = ?').run(id)
  } catch (err) {
    // WP 2.5: line_links.from_voucher_id has no cascade — a source can't vanish under a link,
    // even one from a binned target (restoring that target would lose its goods).
    if (hasTradeSchema(db) && db.prepare('SELECT 1 FROM line_links WHERE from_voucher_id = ? LIMIT 1').get(id)) {
      throw new Error('Other documents (some possibly in the bin) are linked to this voucher — purge those first')
    }
    throw err
  }
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
  const lock = getLockDate(db)
  if (!lock) return 0
  const rows = db
    .prepare(
      `SELECT id FROM vouchers v
       WHERE v.deleted_at IS NOT NULL AND v.deleted_at <= datetime('now', ?) AND v.date <= ?`
    )
    .all(`-${days} days`, lock) as { id: number }[]
  const del = db.prepare('DELETE FROM vouchers WHERE id = ?')
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
              COALESCE(pl.id, fl.id) AS accountLedgerId,
              COALESCE(t.total, 0) AS amount,
              v.is_optional AS isOptional, v.post_dated AS postDated, v.is_year_end_close AS isYearEndClose
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
    .all(...(voucherTypeId ? [from, to, voucherTypeId] : [from, to])) as (Omit<VoucherListRow, 'isOptional' | 'postDated' | 'isYearEndClose'> & {
      isOptional: number
      postDated: number
      isYearEndClose: number
    })[]
  return rows.map((r) => ({
    ...r, isOptional: !!r.isOptional, postDated: !!r.postDated, isYearEndClose: !!r.isYearEndClose
  }))
}
