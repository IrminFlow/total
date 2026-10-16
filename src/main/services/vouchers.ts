import type { DB } from '../db/connection'
import {
  STOCK_NOTE_KINDS,
  type Voucher, type VoucherLine, type InventoryLine, type VoucherType, type NegativeStockWarning, type SaveVoucherWarnings,
  type TradePurpose, type VoucherKind
} from '@shared/domain'
import { voucherInputSchema } from '@shared/schemas'
import type { VoucherInput, VoucherInputParsed } from '@shared/schemas'
import type { VoucherListRow } from '@shared/reports'
import { sumCredits, sumDebits, validateVoucher, type LedgerFacts } from '@shared/posting'
import { formatPaise } from '@shared/money'
import { AppError, isErrorCode } from '@shared/errors'
import { fyOf } from '@shared/dates'
import { nextSeriesNumber } from './numbering'
import { cashBankGroupIds } from './masters'
import { getFeatures } from './config'
import { openSalesOrderValue } from './tradeDocs'
import { writeAudit } from './audit'
import { assertCashFinanceVoucherEditable, binCashFinancePartners, cashFinanceRestorePlan, restoreCashFinancePartners } from './cashFinanceGuards'
import { ensureTdsPayableLedger, PENDING_PAYABLE_LEDGER, PENDING_TCS_PAYABLE_LEDGER, prepareVoucherTds, prepareVoucherWithholding } from './tds'
import { parseLineSerials, rebuildItemSerials, syncVoucherSerials } from './serials'
import {
  assertBinnable, assertRestorable, hasTradeSchema, lineSourcesOf, resolveVoucherLines, syncVoucherLinks, type ResolvedLine
} from './tradeLinks'
import { isGodownTransferShape } from '@shared/voucherEdit/stockJournal'
import { assertFixedAssetVoucherRestorable, assertNotFixedAssetVoucher } from './fixedAssets'
import { chargesGstOn, gstNotChargedMessage, gstRegistrationOf, registrationOn, type GstRegistrationFacts } from '@shared/gst/registration'

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

/** The lock-date refusal — same wording everywhere, with the date for a plain message (WP 8.5). */
export function lockedError(lock: string): AppError {
  return new AppError('books_locked', `Books are locked up to ${lock}`, { field: 'date', params: { date: lock } }) // ISO: mapError writes it in the reader's language
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

export const PAYROLL_VOUCHER_EDIT = 'This is a pay run’s salary journal — delete the pay run on the Payroll screen and post it again'

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
  if (!row) throw new AppError('voucher_type_not_found', 'Voucher type not found')
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

  // TDS and TCS entries share tds_entries; the section's kind tells them apart (migration 027).
  const entryStmt = db.prepare(
    `SELECT te.id, te.section_id, te.base_amount, te.tds_amount, te.is_manual, te.rate_bp_at, te.deductee_type_at,
            te.certificate_id, te.gst_in_base
     FROM tds_entries te JOIN tds_sections ts ON ts.id = te.section_id
     WHERE te.voucher_id = ? AND ts.kind = ? ORDER BY te.id LIMIT 1`
  )
  type EntryRow = {
    id: number; section_id: number; base_amount: number; tds_amount: number; is_manual: number
    rate_bp_at: number | null; deductee_type_at: string | null; certificate_id: number | null; gst_in_base: number | null
  }
  const tdsRow = entryStmt.get(id, 'tds') as EntryRow | undefined
  const tcsRow = entryStmt.get(id, 'tcs') as EntryRow | undefined

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
    tcs: tcsRow
      ? {
          sectionId: tcsRow.section_id, baseAmount: tcsRow.base_amount, tcsAmount: tcsRow.tds_amount,
          isManual: !!tcsRow.is_manual, rateBp: tcsRow.rate_bp_at, deducteeType: tcsRow.deductee_type_at,
          certificateId: tcsRow.certificate_id, gstInBase: tcsRow.gst_in_base == null ? null : !!tcsRow.gst_in_base, entryId: tcsRow.id
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
 *  count: restoring one back into a clash is already the restore flow's problem.
 *  The scope is the series' own: a type that restarts each FY (`restartFy`, the default) only
 *  clashes within the FY containing `date` — last year's No. 1 and this year's No. 1 are not
 *  duplicates — while a continuous series clashes across years. Without a `date` every year
 *  counts (the conservative answer). */
export function voucherNumberExists(db: DB, voucherTypeId: number, number: string, excludeId?: number, date?: string): boolean {
  return numberClash(db, voucherTypeId, number, excludeId ?? -1, date)
}

/** The shared duplicate-number query (pre-save check and the post-save flag). */
function numberClash(db: DB, voucherTypeId: number, number: string, excludeId: number, date: string | undefined): boolean {
  const restartFy = !!(db.prepare('SELECT restart_fy AS r FROM voucher_types WHERE id = ?').get(voucherTypeId) as { r: number } | undefined)?.r
  const fy = restartFy && date ? fyOf(date) : null
  const row = db
    .prepare(
      `SELECT 1 FROM vouchers v WHERE v.voucher_type_id = ? AND v.number = ? AND v.id IS NOT ? AND ${NOT_DELETED}
       ${fy ? 'AND v.date BETWEEN ? AND ?' : ''} LIMIT 1`
    )
    .get(voucherTypeId, number, excludeId, ...(fy ? [fy.from, fy.to] : []))
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

export function ledgerFactsResolver(db: DB): (id: number) => LedgerFacts {
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
 * Exceptions report (stockAnalysis.negativeStock). `beforeVoucherId` stops the walk just before
 * that voucher's position on `date` (the pass's order: date, then voucher id) — what the books
 * held right before an entry (undo.ts).
 */
export function checkStock(db: DB, stockItemIds: number[], date: string, beforeVoucherId?: number): NegativeStockWarning[] {
  if (stockItemIds.length === 0) return []
  const placeholders = stockItemIds.map(() => '?').join(',')
  const items = db
    .prepare(
      `SELECT si.id, si.name, si.opening_qty_milli AS openingQtyMilli, u.symbol AS unitSymbol
       FROM stock_items si JOIN units u ON u.id = si.unit_id WHERE si.id IN (${placeholders})`
    )
    .all(...stockItemIds) as { id: number; name: string; openingQtyMilli: number; unitSymbol: string }[]
  // WP 7.1: one query for every item (was one per item — 500 round trips for the Exceptions /
  // close-checklist scan); each item's movements still walk in the same order.
  // A save checks a few items (their lines by item); a scan of many walks the stock lines in date
  // order once (vouchers first, the covering indexes) and splits them by item — same per-item order.
  const many = stockItemIds.length > 20
  const moves = db
    .prepare(
      `SELECT il.stock_item_id AS itemId, il.qty_milli AS qtyMilli, il.direction, il.is_absolute AS isAbsolute
       FROM ${many ? 'vouchers v CROSS JOIN inventory_lines il ON il.voucher_id = v.id' : 'inventory_lines il JOIN vouchers v ON v.id = il.voucher_id'}
       WHERE il.stock_item_id IN (${placeholders}) AND ${beforeVoucherId === undefined ? 'v.date <= ?' : '(v.date < ? OR (v.date = ? AND v.id < ?))'} AND ${IN_BOOKS} AND ${MOVES_STOCK}
       ORDER BY ${many ? '' : 'il.stock_item_id, '}v.date, v.id, il.line_order, il.id`
    )
    .all(...stockItemIds, ...(beforeVoucherId === undefined ? [date] : [date, date, beforeVoucherId])) as { itemId: number; qtyMilli: number; direction: 'in' | 'out'; isAbsolute: number }[]
  const byItem = new Map<number, typeof moves>()
  for (const m of moves) {
    const list = byItem.get(m.itemId)
    if (list) list.push(m)
    else byItem.set(m.itemId, [m])
  }
  const warnings: NegativeStockWarning[] = []
  for (const item of items) {
    let qty = item.openingQtyMilli
    for (const m of byItem.get(item.id) ?? []) {
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
  /** Set by the job-work service (WP 2.4): it owns send / return challans. */
  jobWork?: boolean
  /** WP 4.2: an owner's override of the party's credit hold, with the reason (audited as
   *  'credit_override'). The IPC layer only passes it for an owner (or a company without users). */
  creditHoldOverride?: { reason: string }
  /** WP 6.3 Books import: keep the input line uids of a NEW voucher when they are free anywhere
   *  (so the links of the exported company can be restored). */
  adoptLineUids?: boolean
  /** WP 8.0: a Tally / books import restores history as it was recorded — the GST registration
   *  rule (assertGstAllowed) applies to entries made in Total, not to imported books. */
  historicImport?: boolean
}

export const IRN_RENUMBER_REFUSED = 'This invoice has an e-invoice IRN — its number and voucher type can’t change (cancel the IRN on the portal and enter a new invoice instead)'

export const INTEREST_NOTE_IMMUTABLE =
  'This is an interest debit note (Credit control › Interest) — bin it and post the interest again; an edit would leave the charged periods wrong'

const interestTable = new WeakMap<DB, boolean>()
function hasInterestCharges(db: DB): boolean {
  let v = interestTable.get(db)
  if (v === undefined) {
    v = !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'interest_charges'").get()
    interestTable.set(db, v)
  }
  return v
}

/** WP 4.2 — the error saveVoucher throws for a new sales invoice to a party on credit hold. The
 *  invoice form recognises the prefix and offers the owner override. */
export const CREDIT_HOLD_PREFIX = 'Credit hold:'

const creditHoldColumn = new WeakMap<DB, boolean>()
function hasCreditHold(db: DB): boolean {
  let v = creditHoldColumn.get(db)
  if (v === undefined) {
    v = (db.prepare('PRAGMA table_info(ledgers)').all() as { name: string }[]).some((c) => c.name === 'credit_hold')
    creditHoldColumn.set(db, v)
  }
  return v
}

/** Voucher kinds a credit hold stops: invoices and the challans goods go out on. */
const HOLD_KINDS = ['sales', 'delivery_note']

/** The credit a voucher extends to its party: the party's debit lines, or for a challan (which
 *  posts nothing) the value of its goods. */
function creditAmount(kind: string, partyId: number | null, lines: { ledgerId: number; drCr: string; amount: number }[], inventory: { amount: number }[]): number {
  if (kind === 'delivery_note') return inventory.reduce((s, l) => s + l.amount, 0)
  return lines.filter((l) => l.ledgerId === partyId && l.drCr === 'dr').reduce((s, l) => s + l.amount, 0)
}

function createsCredit(db: DB, input: VoucherInputParsed, kind: string, before: Voucher | null, postDated: boolean): boolean {
  if (!before) return true
  const beforeKind = getVoucherType(db, before.voucherTypeId).kind
  if (!HOLD_KINDS.includes(beforeKind) || beforeKind !== kind) return true
  if (before.partyLedgerId !== input.partyLedgerId) return true
  if (before.isOptional) return true
  if (before.postDated && !postDated) return true
  return (
    creditAmount(kind, input.partyLedgerId, input.lines, input.inventory) >
    creditAmount(beforeKind, before.partyLedgerId, before.lines, before.inventory)
  )
}

/** The party's credit hold (migration 032), or null when it isn't on hold. */
export function creditHoldOf(db: DB, ledgerId: number): { name: string; reason: string | null; at: string | null } | null {
  if (!hasCreditHold(db)) return null
  const r = db.prepare('SELECT name, credit_hold AS hold, credit_hold_reason AS reason, credit_hold_at AS at FROM ledgers WHERE id = ?').get(ledgerId) as
    | { name: string; hold: number; reason: string | null; at: string | null }
    | undefined
  return r && r.hold ? { name: r.name, reason: r.reason, at: r.at } : null
}

export const MANUFACTURE_EDIT_ELSEWHERE = 'This is a manufacture voucher — alter it from the Manufacture screen'
export const JOB_WORK_EDIT_ELSEWHERE = 'This is a job-work challan — alter it from the Stock journal screen (Send to job worker)'

/** Mark / unmark a voucher for 'transfer' costing (stock_transfers, migration 023). */
export function syncTransferMark(db: DB, voucherId: number, isTransfer: boolean): void {
  if (isTransfer) db.prepare('INSERT OR IGNORE INTO stock_transfers (voucher_id) VALUES (?)').run(voucherId)
  else db.prepare('DELETE FROM stock_transfers WHERE voucher_id = ?').run(voucherId)
}

/** The company's GST registration facts (a DB without company meta — some fixtures — counts as
 *  always regular). */
function registrationOf(db: DB): GstRegistrationFacts {
  const row = db.prepare("SELECT value FROM meta WHERE key = 'company'").get() as { value: string } | undefined
  if (!row) return { gstRegistrationType: 'regular' }
  const c = JSON.parse(row.value) as Partial<GstRegistrationFacts>
  return gstRegistrationOf({ ...c, gstRegistrationType: c.gstRegistrationType ?? 'regular' })
}

/** Kinds that are supplies (a bill / note): the registration rule applies to these. A payment or
 *  journal to a GST ledger (settling a liability from before a cancellation) stays allowed. */
const SUPPLY_KINDS: readonly string[] = ['sales', 'purchase', 'credit_note', 'debit_note']

const TAX_LEDGER_SQL = "SELECT 1 FROM voucher_lines vl JOIN ledgers l ON l.id = vl.ledger_id WHERE vl.voucher_id = ? AND l.tax_type IN ('cgst', 'sgst', 'igst', 'cess') LIMIT 1"

/** WP 8.0 (shared/gst/registration.ts): a sales / purchase / note that posts CGST / SGST / IGST /
 *  cess while the company's registration ON THE VOUCHER DATE is composition or unregistered is
 *  refused — unless it is an alteration of a voucher that already carried tax (saved before the
 *  rule), or a note set against a bill (bill reference or return line) raised while the company
 *  charged GST or that carries tax (s.34). */
export function assertGstAllowed(
  db: DB,
  kind: string,
  input: Pick<VoucherInputParsed, 'date' | 'lines' | 'billRefs' | 'partyLedgerId' | 'inventory'>,
  before: Voucher | null
): void {
  if (!SUPPLY_KINDS.includes(kind)) return
  const reg = registrationOf(db)
  if (chargesGstOn(reg, input.date)) return
  const taxed = (ls: readonly { ledgerId: number }[]): boolean => {
    const ids = [...new Set(ls.map((l) => l.ledgerId))].filter((id) => id > 0)
    if (ids.length === 0) return false
    return !!db
      .prepare(`SELECT 1 FROM ledgers WHERE tax_type IN ('cgst', 'sgst', 'igst', 'cess') AND id IN (${ids.map(() => '?').join(',')}) LIMIT 1`)
      .get(...ids)
  }
  if (!taxed(input.lines)) return
  if (before && taxed(before.lines)) return
  if ((kind === 'credit_note' || kind === 'debit_note') && noteAgainstTaxedBill(db, reg, input)) return
  throw new AppError('gst_not_charged', gstNotChargedMessage(registrationOn(reg, input.date)), { field: 'items' })
}

/** A note's originals — the bills it is set against (same party) and the invoices its return
 *  lines come from — of which one was raised in a GST-charging period or carries tax. */
function noteAgainstTaxedBill(
  db: DB,
  reg: GstRegistrationFacts,
  input: Pick<VoucherInputParsed, 'billRefs' | 'partyLedgerId' | 'inventory'>
): boolean {
  const originals: { id: number; date: string }[] = []
  if (input.partyLedgerId != null) {
    const byBill = db.prepare(
      `SELECT v.id, v.date FROM bill_refs br JOIN vouchers v ON v.id = br.voucher_id
       WHERE br.kind = 'new' AND br.name = ? AND br.party_ledger_id = ? AND ${NOT_DELETED}`
    )
    for (const r of input.billRefs) if (r.kind === 'against') originals.push(...(byBill.all(r.name, input.partyLedgerId) as { id: number; date: string }[]))
  }
  const byLine = db.prepare(`SELECT v.id, v.date FROM inventory_lines il JOIN vouchers v ON v.id = il.voucher_id WHERE il.line_uid = ? AND ${NOT_DELETED}`)
  for (const l of input.inventory) if (l.source?.lineUid) originals.push(...(byLine.all(l.source.lineUid) as { id: number; date: string }[]))
  const taxLine = db.prepare(TAX_LEDGER_SQL)
  return originals.some((o) => chargesGstOn(reg, o.date) || !!taxLine.get(o.id))
}

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
    if (flagged?.f) throw new AppError('year_end_close_immutable', YEAR_END_CLOSE_IMMUTABLE)
    // A manufacture's entry facts (manufacture_details) would go stale under a generic edit.
    if (!hooks.manufacture && db.prepare('SELECT 1 FROM manufacture_details WHERE voucher_id = ?').get(existingId)) {
      throw new AppError('manufacture_edit_elsewhere', MANUFACTURE_EDIT_ELSEWHERE)
    }
    if (!hooks.jobWork && !hooks.manufacture && db.prepare('SELECT 1 FROM job_work_challans WHERE voucher_id = ?').get(existingId)) {
      throw new AppError('job_work_edit_elsewhere', JOB_WORK_EDIT_ELSEWHERE)
    }
    // WP 3.6: depreciation-run and disposal journals belong to the fixed-asset register.
    assertNotFixedAssetVoucher(db, existingId)
    // WP 4.2: an interest debit note belongs to its interest_charges rows (the bill-periods it
    // charged) — an edit would leave them describing other figures.
    if (hasInterestCharges(db) && db.prepare('SELECT 1 FROM interest_charges WHERE debit_note_voucher_id = ?').get(existingId)) {
      throw new AppError('interest_note_immutable', INTEREST_NOTE_IMMUTABLE)
    }
    // WP 3.7: a salary journal belongs to its pay run (payroll lines, statutory dues, salary TDS
    // entries for 24Q) — an edit here would leave them describing other figures.
    if (db.prepare('SELECT 1 FROM payroll_runs WHERE voucher_id = ?').get(existingId)) throw new AppError('payroll_voucher_edit', PAYROLL_VOUCHER_EDIT)
    // WP 4.4: loan instalments, forex revaluations / reversals and settlements — bin, don't edit.
    assertCashFinanceVoucherEditable(db, existingId)
  }
  const vt = getVoucherType(db, input.voucherTypeId)
  // TDS (WP 3.1): resolve the payable credit for tds.autoPayable (a ledger that doesn't exist
  // yet rides as PENDING_PAYABLE_LEDGER until the transaction below creates it) and check the
  // entry against the lines and the rate table. `posting` is what actually gets stored.
  const preparedTds = prepareVoucherTds(db, input, existingId)
  // TCS (WP 3.3): the same for a collection on a sale / receipt — appended after the TDS step
  // (a voucher carries one or the other in practice), its pending ledger on its own placeholder.
  const preparedTcs = prepareVoucherWithholding(db, 'tcs', input, preparedTds.lines, existingId)
  const posting: VoucherInputParsed = { ...input, lines: preparedTcs.lines }
  const baseFacts = ledgerFactsResolver(db)
  const facts = (id: number): LedgerFacts =>
    id === PENDING_PAYABLE_LEDGER
      ? { exists: true, isCashOrBank: false, isTdsPayable: true }
      : id === PENDING_TCS_PAYABLE_LEDGER ? { exists: true, isCashOrBank: false } : baseFacts(id)
  const errors = [...validateVoucher(posting, vt.kind, facts), ...preparedTds.errors, ...preparedTcs.errors]
  if (errors.length) {
    // WP 8.5: the joined message is unchanged; each rule's code (and line) rides along so a
    // screen can put it under its field.
    throw new AppError(errors.length === 1 && isErrorCode(errors[0]!.code) ? errors[0]!.code : 'validation', errors.map((e) => e.message).join('; '), {
      issues: errors.map((e) => ({ code: e.code, message: e.message, ...(e.line != null ? { line: e.line } : {}), ...(e.code === 'unbalanced' ? { params: { amount: formatPaise(Math.abs(sumDebits(posting.lines) - sumCredits(posting.lines)), { symbol: true }) } } : {}) }))
    })
  }

  const number =
    vt.numbering === 'manual'
      ? (input.number ?? '').trim() || (() => { throw new AppError('number_required', 'Voucher number is required', { field: 'number' }) })()
      : input.number?.trim() || nextVoucherNumber(db, vt.id, input.date, existingId)

  const before = existingId ? getVoucher(db, existingId) : null
  if (existingId && !before) throw new AppError('voucher_not_found', 'Voucher not found')
  if (before?.deletedAt) throw new AppError('voucher_in_bin', 'Voucher is in the bin; restore it first')
  // WP 6.4 review: an e-invoice's IRN was generated for this type's number — renumbering it (a new
  // number, or another series) would leave the IRN describing a document that no longer exists.
  if (before?.irn && (number !== before.number || vt.id !== before.voucherTypeId)) {
    throw new AppError('irn_renumber', `${IRN_RENUMBER_REFUSED} (IRN ${before.irn.slice(0, 12)}…)`, { field: 'number' })
  }

  const lock = getLockDate(db)
  if (lock && (input.date <= lock || (before && before.date <= lock))) {
    throw lockedError(lock)
  }

  // WP 8.0: only a regular GST registration charges GST on a bill — see assertGstAllowed.
  if (!hooks.historicImport) assertGstAllowed(db, vt.kind, posting, before)

  const warnings: SaveVoucherWarnings = { negativeStock: [], creditLimitExceeded: null }

  // Delivery challan / GRN purpose (WP 2.5): absent on the input = keep the stored one.
  const stockNote = STOCK_NOTE_KINDS.includes(vt.kind)
  const purpose: TradePurpose | null = stockNote
    ? (input.trade?.purpose ?? before?.trade?.purpose ?? DEFAULT_PURPOSE[vt.kind]!)
    : null
  if (purpose && !PURPOSES_FOR[vt.kind]!.includes(purpose)) {
    throw new AppError('bad_purpose', `A ${vt.name} can't have the purpose "${purpose.replace('_', ' ')}"`)
  }
  const trade = hasTradeSchema(db)

  // Post-dated / optional flags (tasks 77–78): absent on the input = keep the stored value
  // (an edit that doesn't mention them mustn't silently mature a PDC).
  const postDated = input.postDated ?? before?.postDated ?? false
  const isOptional = input.isOptional ?? before?.isOptional ?? false

  // WP 4.2 credit hold: a save that CREATES NEW CREDIT to a party on hold is refused unless an
  // owner overrides it with a reason. New credit = a sales invoice or delivery challan that is new
  // (post-dated ones included — they become credit on maturity), moved onto the held party, turned
  // from another voucher type into one of these, from optional (memorandum) into a real one, from
  // post-dated into dated, or edited to a larger amount. Optional vouchers never count; an edit that
  // keeps or lowers the amount (fixing a typo, a narration) passes.
  const hold = HOLD_KINDS.includes(vt.kind) && !isOptional && input.partyLedgerId !== null && createsCredit(db, input, vt.kind, before, postDated)
    ? creditHoldOf(db, input.partyLedgerId)
    : null
  const holdOverride = hold ? hooks.creditHoldOverride?.reason.trim() || null : null
  if (hold && !holdOverride) {
    throw new AppError('credit_hold', `${CREDIT_HOLD_PREFIX} ${hold.name} is on credit hold${hold.reason ? ` (${hold.reason})` : ''} — an owner can override with a reason`, { field: 'party', params: { name: hold.name } })
  }

  const run = db.transaction((): number => {
    // WP 2.5: stable line uids + resolved link sources (refused here — before anything is
    // written — when a source is unknown, the voucher's own, or not an allowed pair).
    const resolved: ResolvedLine[] = trade ? resolveVoucherLines(db, input.inventory, { kind: vt.kind, before, adoptLineUids: hooks.adoptLineUids }) : []
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
    if (preparedTcs.createPayableFor != null) {
      const payableId = ensureTdsPayableLedger(db, preparedTcs.createPayableFor)
      for (const l of posting.lines) if (l.ledgerId === PENDING_TCS_PAYABLE_LEDGER) l.ledgerId = payableId
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
    // WP 2.4: a stock journal saved as a same-item godown transfer is costed by the engine's
    // 'transfer' rule from now on (marked here, at save; never backfilled).
    syncTransferMark(db, voucherId, vt.kind === 'stock_journal' && !hooks.manufacture && isGodownTransferShape(input))

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

    // One entry per kind (TDS / TCS) — the section's kind tells them apart (migration 027).
    const writeEntry = (
      kind: 'tds' | 'tcs',
      e: { sectionId: number; baseAmount: number; amount: number; isManual: boolean } | null,
      basis: typeof preparedTds.basis
    ): void => {
      const existingEntries = db
        .prepare(
          `SELECT te.id FROM tds_entries te JOIN tds_sections ts ON ts.id = te.section_id
           WHERE te.voucher_id = ? AND ts.kind = ? ORDER BY te.id`
        )
        .all(voucherId, kind) as { id: number }[]
      if (!e) {
        for (const x of existingEntries) db.prepare('DELETE FROM tds_entries WHERE id = ?').run(x.id)
        return
      }
      // A deduction / collection supersedes a "Not applicable" mark (WP 3.2, migration 022).
      db.prepare('DELETE FROM tds_exemptions WHERE voucher_id = ? AND kind = ?').run(voucherId, kind)
      const party = input.partyLedgerId
        ? (db.prepare('SELECT pan FROM ledgers WHERE id = ?').get(input.partyLedgerId) as { pan: string | null } | undefined)
        : undefined
      const gstInBase = kind === 'tcs' && basis?.gstInBase != null ? (basis.gstInBase ? 1 : 0) : null
      const values = [
        e.sectionId, input.partyLedgerId, party?.pan ?? null, e.baseAmount, e.amount,
        basis?.deducteeType ?? null, basis?.rateBp ?? null, basis?.certificateId ?? null, e.isManual ? 1 : 0, gstInBase
      ]
      const keep = existingEntries[0]
      if (keep) {
        db.prepare(
          `UPDATE tds_entries SET section_id = ?, party_ledger_id = ?, pan = ?, base_amount = ?, tds_amount = ?,
             deductee_type_at = ?, rate_bp_at = ?, certificate_id = ?, is_manual = ?, gst_in_base = ? WHERE id = ?`
        ).run(...values, keep.id)
        for (const extra of existingEntries.slice(1)) db.prepare('DELETE FROM tds_entries WHERE id = ?').run(extra.id)
      } else {
        db.prepare(
          `INSERT INTO tds_entries (section_id, party_ledger_id, pan, base_amount, tds_amount,
             deductee_type_at, rate_bp_at, certificate_id, is_manual, gst_in_base, voucher_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(...values, voucherId)
      }
    }
    writeEntry('tds', input.tds ? { sectionId: input.tds.sectionId, baseAmount: input.tds.baseAmount, amount: input.tds.tdsAmount, isManual: input.tds.isManual } : null, preparedTds.basis)
    writeEntry('tcs', input.tcs ? { sectionId: input.tcs.sectionId, baseAmount: input.tcs.baseAmount, amount: input.tcs.tcsAmount, isManual: input.tcs.isManual } : null, preparedTcs.basis)

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
        if (!batch) throw new AppError('batch_not_found', 'Batch not found', { field: 'items' })
        if (batch.stock_item_id !== line.stockItemId) {
          throw new AppError('batch_wrong_item', `Batch ${batch.name} belongs to a different stock item`, { field: 'items' })
        }
      }
      const outBatchIds = [...new Set(
        movingLines.filter((l) => l.batchId != null && !l.isAbsolute && l.direction === 'out').map((l) => l.batchId!)
      )]
      for (const batchId of outBatchIds) {
        const { bal } = balanceStmt.get(batchId) as { bal: number }
        if (bal < 0) {
          const batch = batchStmt.get(batchId) as { name: string }
          throw new AppError('batch_short', `Not enough stock in batch ${batch.name} (short by ${-bal / 1000})`, { field: 'items', params: { batch: batch.name } })
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
      throw new AppError('insufficient_stock', `Insufficient stock for: ${names}`, { field: 'items', params: { names } })
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
        // WP 2.5c (§9 Q9): with Orders & challans on, a sales invoice's warning also names the
        // party's open sales-order value — warn-only, never a block, outstandings unchanged.
        const openSalesOrders = features.orders && vt.kind === 'sales' ? openSalesOrderValue(db, party.id) : undefined
        const overWithOrders = openSalesOrders !== undefined && outstanding + openSalesOrders > party.credit_limit
        if (outstanding > party.credit_limit || overWithOrders) {
          warnings.creditLimitExceeded = {
            ledgerId: party.id,
            ledgerName: party.name,
            creditLimit: party.credit_limit,
            outstanding,
            ...(openSalesOrders !== undefined ? { openSalesOrders, ordersOnly: outstanding <= party.credit_limit } : {})
          }
          if (features.enforceCreditLimit && outstanding > party.credit_limit) {
            throw new AppError(
              'credit_limit',
              `Credit limit exceeded for ${party.name}: outstanding ${outstanding} > limit ${party.credit_limit} paise`,
              { field: 'party', params: { name: party.name } }
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
  if (hold && holdOverride) {
    writeAudit(db, 'credit_override', voucherId, 'create', null, {
      voucherId, number: after.number, ledgerId: input.partyLedgerId, party: hold.name, holdReason: hold.reason, overrideReason: holdOverride
    })
  }
  // Per the series' FY scope (numbering restarts each FY unless the type says otherwise).
  const duplicate = numberClash(db, vt.id, number, voucherId, after.date)
  return duplicate ? { ...after, warnings, duplicateNumber: true } : { ...after, warnings }
}

/** Move a voucher to the bin (soft delete). Report queries exclude it; restoreVoucher undoes this. */
export function deleteVoucher(db: DB, id: number): void {
  const before = getVoucher(db, id)
  if (!before) throw new AppError('voucher_not_found', 'Voucher not found')
  const lock = getLockDate(db)
  if (lock && before.date <= lock) throw lockedError(lock)
  db.transaction(() => {
    // WP 2.5: refused while a live document draws on its lines (or it re-prices a frozen GRN).
    assertBinnable(db, id)
    db.prepare("UPDATE vouchers SET deleted_at = datetime('now') WHERE id = ?").run(id)
    // WP 2.3: a binned voucher's serials no longer count (a sale's go back into stock).
    rebuildItemSerials(db, before.inventory.map((l) => l.stockItemId))
    // WP 4.4: a forex revaluation and its reversal go to the bin together.
    binCashFinancePartners(db, id)
    // Inside the same transaction: a binned voucher never lacks its audit row (and a failed
    // audit write leaves the voucher where it was).
    writeAudit(db, 'voucher', id, 'delete', before, null)
  })()
}

/** WP 4.2 — refuse to restore an interest debit note whose bill-periods overlap a live charge. */
function assertInterestRestorable(db: DB, id: number): void {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'interest_charges'").get()) return
  const clash = db
    .prepare(
      `SELECT a.bill_ref AS bill FROM interest_charges a JOIN interest_charges b
         ON b.party_ledger_id = a.party_ledger_id AND b.bill_ref = a.bill_ref AND b.bill_voucher_id IS a.bill_voucher_id
        AND b.debit_note_voucher_id <> a.debit_note_voucher_id AND b.period_from <= a.period_to AND b.period_to >= a.period_from
       JOIN vouchers v ON v.id = b.debit_note_voucher_id
       WHERE a.debit_note_voucher_id = ? AND ${NOT_DELETED} LIMIT 1`
    )
    .get(id) as { bill: string } | undefined
  if (clash) throw new AppError('interest_restore_clash', `Interest on ${clash.bill} for this period has been charged again on another debit note — restoring this one would charge it twice`)
}

/** Reinstate a binned voucher so it counts in reports again. */
export function restoreVoucher(db: DB, id: number): void {
  const before = getVoucher(db, id)
  if (!before) throw new AppError('voucher_not_found', 'Voucher not found')
  if (!before.deletedAt) throw new AppError('not_in_bin', 'Voucher is not in the bin')
  const lock = getLockDate(db)
  if (lock && before.date <= lock) throw lockedError(lock)
  // WP 4.2: a restored interest debit note must not charge a bill-period that another live
  // note has charged since it was binned.
  assertInterestRestorable(db, id)
  // WP 3.6: a restored depreciation / disposal journal must not double-count a re-posted period.
  assertFixedAssetVoucherRestorable(db, id)
  if (before.isYearEndClose) {
    // Restoring a closing journal re-closes its year — refuse when the year was closed again in
    // the meantime, or Retained Earnings would receive the year's profit twice.
    const fy = fyOf(before.date)
    const live = db
      .prepare(`SELECT 1 FROM vouchers v WHERE ${NOT_DELETED} AND v.is_year_end_close = 1 AND v.date BETWEEN ? AND ? LIMIT 1`)
      .get(fy.from, fy.to)
    if (live) {
      throw new AppError('year_closed_again', `FY ${fy.label} already has a year-end closing entry; bin that one first to restore this one`)
    }
  }
  // WP 4.4: refused when it would double-count a loan instalment / revaluation / settlement.
  const cashFinancePartners = cashFinanceRestorePlan(db, id)
  db.transaction(() => {
    db.prepare('UPDATE vouchers SET deleted_at = NULL WHERE id = ?').run(id)
    restoreCashFinancePartners(db, cashFinancePartners, id)
    // WP 2.5: its links come back to life — re-check their sources and capacity.
    assertRestorable(db, id)
    // WP 2.3: re-apply its serials — refused (rolled back) if one has moved on meanwhile.
    rebuildItemSerials(db, before.inventory.map((l) => l.stockItemId))
    // Same transaction as the restore (see deleteVoucher).
    writeAudit(db, 'voucher', id, 'restore', before, { restored: true })
  })()
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
  db.transaction(() => {
    db.prepare("UPDATE vouchers SET post_dated = 0, updated_at = datetime('now') WHERE id = ?").run(id)
    writeAudit(db, 'voucher', id, 'update', before, { ...before, postDated: false, matured: true })
  })()
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
    // The delete and its audit row commit together (see deleteVoucher).
    db.transaction(() => {
      db.prepare('DELETE FROM vouchers WHERE id = ?').run(id)
      writeAudit(db, 'voucher', id, 'purge', { ...before, purged: true }, null)
    })()
  } catch (err) {
    // WP 2.5: line_links.from_voucher_id has no cascade — a source can't vanish under a link,
    // even one from a binned target (restoring that target would lose its goods).
    if (hasTradeSchema(db) && db.prepare('SELECT 1 FROM line_links WHERE from_voucher_id = ? LIMIT 1').get(id)) {
      throw new Error('Other documents (some possibly in the bin) are linked to this voucher — purge those first')
    }
    throw err
  }
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
  // The deletes and their summary audit row commit together (see deleteVoucher). A refused delete
  // (an immediate FK) rolls back only its own statement, so the rest still go.
  return db.transaction(() => {
    let purged = 0
    const purgedIds: number[] = []
    for (const { id } of rows) {
      try {
        del.run(id)
        purged++
        purgedIds.push(id)
      } catch {
        // e.g. an FK from payroll_runs — leave this voucher in the bin, keep purging the rest.
      }
    }
    if (purged > 0) {
      // WP 3.8: the ids too — each voucher's own create/update/delete rows stay in the trail (audit_log
      // has no foreign key to vouchers), and this row says where they went.
      writeAudit(db, 'voucher', 0, 'purge', { autoPurgedFromBin: purged, olderThanDays: days, voucherIds: purgedIds }, null)
    }
    return purged
  })()
}

export interface BinRow {
  id: number
  date: string
  number: string
  voucherType: string
  account: string
  amount: number
  deletedAt: string
  /** WP 8.5: the undo group it went to the bin with (restoring one restores all), or null. */
  undoGroupId: number | null
  undoGroupSize: number | null
}

/** Binned vouchers, most recently deleted first. Mirrors listVouchers' account/amount derivation. */
export function listBin(db: DB): BinRow[] {
  const rows = db
    .prepare(
      `SELECT v.id, v.date, vt.name AS voucherType, v.number,
              COALESCE(pl.name, fl.name, '') AS account,
              COALESCE(t.total, 0) AS amount,
              v.deleted_at AS deletedAt,
              ug.group_id AS undoGroupId,
              (SELECT COUNT(*) FROM undo_group_vouchers g2 WHERE g2.group_id = ug.group_id) AS undoGroupSize
       FROM vouchers v
       LEFT JOIN undo_group_vouchers ug ON ug.voucher_id = v.id
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
  return voucherListRows(db, from, to, voucherTypeId)
}

/** The last `n` vouchers of listVouchers(from, to), newest first (the Gateway's recent entries) —
 *  the same rows as `listVouchers(...).slice(-n).reverse()`, without listing the whole period. */
export function latestVouchers(db: DB, from: string, to: string, n: number): VoucherListRow[] {
  return voucherListRows(db, from, to, undefined, n)
}

// WP 7.1: each row's first line and debit total are looked up per voucher (correlated, off the
// voucher's own lines) instead of grouping every line in the books first.
function voucherListRows(db: DB, from: string, to: string, voucherTypeId?: number, lastN?: number): VoucherListRow[] {
  const rows = db
    .prepare(
      `SELECT v.id, v.date, vt.name AS voucherType, vt.kind, v.number, v.narration,
              COALESCE(pl.name, fl.name, '') AS account,
              COALESCE(pl.id, fl.id) AS accountLedgerId,
              COALESCE((SELECT SUM(amount) FROM voucher_lines WHERE voucher_id = v.id AND dr_cr = 'dr'), 0) AS amount,
              v.is_optional AS isOptional, v.post_dated AS postDated, v.is_year_end_close AS isYearEndClose
       FROM vouchers v
       JOIN voucher_types vt ON vt.id = v.voucher_type_id
       LEFT JOIN ledgers pl ON pl.id = v.party_ledger_id
       LEFT JOIN voucher_lines fvl ON fvl.id = (SELECT MIN(id) FROM voucher_lines WHERE voucher_id = v.id)
       LEFT JOIN ledgers fl ON fl.id = fvl.ledger_id
       WHERE v.date BETWEEN ? AND ? AND ${NOT_DELETED} ${voucherTypeId ? 'AND v.voucher_type_id = ?' : ''}
       ORDER BY ${lastN ? 'v.date DESC, v.id DESC LIMIT ?' : 'v.date, v.id'}`
    )
    .all(...(voucherTypeId ? [from, to, voucherTypeId] : [from, to]), ...(lastN ? [lastN] : [])) as (Omit<VoucherListRow, 'isOptional' | 'postDated' | 'isYearEndClose'> & {
      isOptional: number
      postDated: number
      isYearEndClose: number
    })[]
  return rows.map((r) => ({
    ...r, isOptional: !!r.isOptional, postDated: !!r.postDated, isYearEndClose: !!r.isYearEndClose
  }))
}
