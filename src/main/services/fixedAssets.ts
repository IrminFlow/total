/**
 * Fixed-asset register and depreciation (WP 3.6). Persistence + posting around the pure engine in
 * @shared/depreciation (the statutory sources are cited with migration 026's seeds).
 *
 * - Book (Companies Act) depreciation is POSTED: a run for a period books one journal through
 *   saveVoucher (Dr depreciation expense / Cr accumulated depreciation per asset group, or per
 *   asset when the group says so) and records depreciation_runs + depreciation_lines. A run counts
 *   only while its voucher is live; re-running a period is refused until that voucher is binned.
 * - A disposal posts one journal (proceeds, accumulated depreciation written back, the asset's
 *   cost out, profit / loss on sale, and — optionally — the catch-up depreciation to the day
 *   before disposal) and marks the asset disposed. Binning that journal reinstates the asset.
 * - Income-tax depreciation is a COMPUTATION only (block of assets), never posted.
 * - Every report figure is computed at query time from the register + live runs; the schedule
 *   reconciles to ledger balances (reports.closingBalances).
 */
import type { DB } from '../db/connection'
import { fyFromStartYear, fyOf } from '@shared/dates'
import {
  addDays, companiesActPeriod, disposalLines, mulDivRound, splitShare, itBlockYear, lifeEndDate, scheduleTotals,
  type CaAssetInput, type CostLayer, type DepMethod
} from '@shared/depreciation'
import {
  assetAdditionInputSchema, assetGroupInputSchema, caClassInputSchema, componentSplitSchema, disposalInputSchema, fixedAssetInputSchema,
  itBlockInputSchema, itBlockOpeningInputSchema, itBlockRateInputSchema,
  type AssetAdditionInput, type AssetAdditionRow, type AssetGroupInput, type AssetGroupRow, type AssetSchedule,
  EXTRA_SHIFT_SEEDED_CLASS_CODES,
  type CaClassInput, type CaClassRow, type ComponentSplitInput, type DepreciationPreview, type DisposalGstPreview, type DisposalPart, type ExtraShiftInput, type DepreciationPreviewRow, type DepreciationRunRow,
  type DepreciationYearStatus, type DisposalInput, type DisposalKind, type DisposalPreview, type FixedAssetInput,
  type FixedAssetRow, type ItBlockInput, type ItBlockOpeningInput, type ItBlockRateInput, type ItBlockRateRow,
  type ItBlockRow, type ItStatement, type ItStatementBlockRow, type JournalPreviewLine, type PurchaseCandidate,
  type ScheduleAssetRow, type ScheduleGroupRow, type ScheduleReconRow
} from '@shared/fixedAssets'
import { createLedger, descendantIdsByName, findOrCreateLedger } from './masters'
import { readCompanyInfo } from '../db/seed'
import { chargesGstOn, gstRegistrationOf } from '@shared/gst/registration'
import { computeGst, supplyTypeFor } from '@shared/gst/calc'
import { pickTaxLedger } from '@shared/voucherEdit'
import type { GstDoc } from '@shared/gst/returns'
import {
  capitalGoodsSale, capitalGoodsWorkingText, headsTotal, ZERO_TAX_HEADS, type TaxHeads
} from '@shared/capitalGoodsGst'
import { getLockDate, getVoucher, saveVoucher, NOT_DELETED, IRN_LIVE_BIN, liveIrnOf } from './vouchers'
import { AppError } from '@shared/errors'
import { closingBalances } from './reports'
import { writeAudit } from './audit'

// ---------------------------------------------------------------------------------------------
// Ledger naming
// ---------------------------------------------------------------------------------------------

export const DEPRECIATION_LEDGER = 'Depreciation'
export const PROFIT_ON_SALE_LEDGER = 'Profit on Sale of Fixed Assets'
export const LOSS_ON_SALE_LEDGER = 'Loss on Sale of Fixed Assets'
export const accDepLedgerName = (groupName: string): string => `Accumulated Depreciation - ${groupName}`

const FIXED_ASSETS_GROUP = 'Fixed Assets'

/** 'YYYY-MM-DD' → 'DD-MM-YYYY' for messages and narrations. */
function fmtDate(iso: string): string {
  const [y, m, d] = iso.split('-')
  return `${d}-${m}-${y}`
}

function fixedAssetGroupIds(db: DB): Set<number> {
  return descendantIdsByName(db, [FIXED_ASSETS_GROUP])
}

function ledgerName(db: DB, id: number | null): string | null {
  if (id == null) return null
  return (db.prepare('SELECT name FROM ledgers WHERE id = ?').get(id) as { name: string } | undefined)?.name ?? null
}

function ledgerIdByName(db: DB, name: string): number | null {
  return (db.prepare('SELECT id FROM ledgers WHERE name = ? COLLATE NOCASE').get(name) as { id: number } | undefined)?.id ?? null
}

function assertFixedAssetLedger(db: DB, ledgerId: number, what: string): void {
  const row = db.prepare('SELECT group_id FROM ledgers WHERE id = ?').get(ledgerId) as { group_id: number } | undefined
  if (!row) throw new Error(`${what}: ledger not found`)
  if (!fixedAssetGroupIds(db).has(row.group_id)) throw new Error(`${what} must be a ledger under Fixed Assets`)
}

function assertExpenseLedger(db: DB, ledgerId: number): void {
  const row = db
    .prepare('SELECT g.nature FROM ledgers l JOIN groups g ON g.id = l.group_id WHERE l.id = ?')
    .get(ledgerId) as { nature: string } | undefined
  if (!row) throw new Error('Depreciation ledger not found')
  if (row.nature !== 'expense') throw new Error('The depreciation ledger must be an expense ledger')
}

function journalTypeId(db: DB): number {
  const row = db.prepare("SELECT id FROM voucher_types WHERE kind = 'journal' AND is_system = 1").get() as { id: number } | undefined
  if (!row) throw new Error('Journal voucher type not found')
  return row.id
}

function salesTypeId(db: DB): number {
  const row = db.prepare("SELECT id FROM voucher_types WHERE kind = 'sales' ORDER BY is_system DESC, id LIMIT 1").get() as { id: number } | undefined
  if (!row) throw new Error('Sales voucher type not found')
  return row.id
}

function fyIsClosed(db: DB, fyStartYear: number): boolean {
  const fy = fyFromStartYear(fyStartYear)
  return !!db
    .prepare(`SELECT 1 FROM vouchers v WHERE ${NOT_DELETED} AND v.is_year_end_close = 1 AND v.date BETWEEN ? AND ? LIMIT 1`)
    .get(fy.from, fy.to)
}

/** Lock / closed-year reason a posting dated `date` would be refused for, or null. */
function postingBlock(db: DB, date: string): string | null {
  const lock = getLockDate(db)
  if (lock && date <= lock) return `Books are locked up to ${lock}`
  const fy = fyOf(date)
  if (fyIsClosed(db, fy.startYear)) return `FY ${fy.label} is closed — bin its closing journal to reopen the year`
  return null
}

// ---------------------------------------------------------------------------------------------
// Masters: Schedule II classes, IT blocks + rates + openings, asset groups
// ---------------------------------------------------------------------------------------------

interface ClassRowDb { id: number; code: string; name: string; life_months: number; effective_from: string; effective_to: string | null; source: string; is_seeded: number }

const mapClass = (r: ClassRowDb): CaClassRow => ({
  id: r.id, code: r.code, name: r.name, lifeMonths: r.life_months, effectiveFrom: r.effective_from,
  effectiveTo: r.effective_to, source: r.source, isSeeded: !!r.is_seeded
})

export function listClasses(db: DB): CaClassRow[] {
  return (db.prepare('SELECT * FROM ca_asset_classes ORDER BY id').all() as ClassRowDb[]).map(mapClass)
}

export function saveClass(db: DB, raw: CaClassInput, id?: number): CaClassRow {
  const input = caClassInputSchema.parse(raw)
  if (input.effectiveTo && input.effectiveTo < input.effectiveFrom) throw new Error('Effective-to is before effective-from')
  const before = id ? (db.prepare('SELECT * FROM ca_asset_classes WHERE id = ?').get(id) as ClassRowDb | undefined) : undefined
  if (id && !before) throw new Error('Class not found')
  let rowId = id
  if (id) {
    db.prepare('UPDATE ca_asset_classes SET code = ?, name = ?, life_months = ?, effective_from = ?, effective_to = ?, source = ? WHERE id = ?')
      .run(input.code, input.name, input.lifeMonths, input.effectiveFrom, input.effectiveTo, input.source, id)
  } else {
    rowId = Number(db.prepare('INSERT INTO ca_asset_classes (code, name, life_months, effective_from, effective_to, source) VALUES (?, ?, ?, ?, ?, ?)')
      .run(input.code, input.name, input.lifeMonths, input.effectiveFrom, input.effectiveTo, input.source).lastInsertRowid)
  }
  const after = mapClass(db.prepare('SELECT * FROM ca_asset_classes WHERE id = ?').get(rowId) as ClassRowDb)
  writeAudit(db, 'ca_asset_class', after.id, id ? 'update' : 'create', before ? mapClass(before) : null, after)
  return after
}

export function deleteClass(db: DB, id: number): void {
  const before = db.prepare('SELECT * FROM ca_asset_classes WHERE id = ?').get(id) as ClassRowDb | undefined
  if (!before) throw new Error('Class not found')
  db.prepare('DELETE FROM ca_asset_classes WHERE id = ?').run(id)
  writeAudit(db, 'ca_asset_class', id, 'delete', mapClass(before), null)
}

interface RateRowDb {
  id: number; block_id: number; effective_from: string; effective_to: string | null; rate_bp: number
  additional_rate_bp: number; act: '1961' | '2025'; section_ref: string; source: string; is_seeded: number
}

const mapRate = (r: RateRowDb): ItBlockRateRow => ({
  id: r.id, blockId: r.block_id, effectiveFrom: r.effective_from, effectiveTo: r.effective_to, rateBp: r.rate_bp,
  additionalRateBp: r.additional_rate_bp, act: r.act, sectionRef: r.section_ref, source: r.source, isSeeded: !!r.is_seeded
})

export function listBlocks(db: DB): ItBlockRow[] {
  const blocks = db.prepare('SELECT * FROM it_blocks ORDER BY id').all() as { id: number; code: string; name: string; is_seeded: number }[]
  const rates = (db.prepare('SELECT * FROM it_block_rates ORDER BY block_id, effective_from').all() as RateRowDb[]).map(mapRate)
  const openings = db.prepare('SELECT * FROM it_block_openings ORDER BY block_id, fy_start_year').all() as {
    block_id: number; fy_start_year: number; opening_wdv_paise: number; additional_bf_paise: number
  }[]
  return blocks.map((b) => ({
    id: b.id, code: b.code, name: b.name, isSeeded: !!b.is_seeded,
    rates: rates.filter((r) => r.blockId === b.id),
    openings: openings.filter((o) => o.block_id === b.id).map((o) => ({
      fyStartYear: o.fy_start_year, openingWdv: o.opening_wdv_paise, additionalBroughtForward: o.additional_bf_paise
    }))
  }))
}

export function saveBlock(db: DB, raw: ItBlockInput, id?: number): ItBlockRow {
  const input = itBlockInputSchema.parse(raw)
  let rowId = id
  if (id) {
    if (!db.prepare('SELECT 1 FROM it_blocks WHERE id = ?').get(id)) throw new Error('Block not found')
    db.prepare('UPDATE it_blocks SET code = ?, name = ? WHERE id = ?').run(input.code, input.name, id)
  } else {
    rowId = Number(db.prepare('INSERT INTO it_blocks (code, name) VALUES (?, ?)').run(input.code, input.name).lastInsertRowid)
  }
  const after = listBlocks(db).find((b) => b.id === rowId)!
  writeAudit(db, 'it_block', after.id, id ? 'update' : 'create', null, { code: after.code, name: after.name })
  return after
}

export function deleteBlock(db: DB, id: number): void {
  const used = db.prepare('SELECT COUNT(*) AS n FROM fixed_assets WHERE it_block_id = ?').get(id) as { n: number }
  if (used.n > 0) throw new Error('Assets are assigned to this block — move them first')
  const before = db.prepare('SELECT * FROM it_blocks WHERE id = ?').get(id)
  if (!before) throw new Error('Block not found')
  db.prepare('DELETE FROM it_blocks WHERE id = ?').run(id)
  writeAudit(db, 'it_block', id, 'delete', before, null)
}

export function saveBlockRate(db: DB, raw: ItBlockRateInput, id?: number): ItBlockRateRow {
  const input = itBlockRateInputSchema.parse(raw)
  if (input.effectiveTo && input.effectiveTo < input.effectiveFrom) throw new Error('Effective-to is before effective-from')
  const before = id ? (db.prepare('SELECT * FROM it_block_rates WHERE id = ?').get(id) as RateRowDb | undefined) : undefined
  if (id && !before) throw new Error('Rate not found')
  let rowId = id
  if (id) {
    db.prepare(
      `UPDATE it_block_rates SET block_id = ?, effective_from = ?, effective_to = ?, rate_bp = ?, additional_rate_bp = ?,
         act = ?, section_ref = ?, source = ? WHERE id = ?`
    ).run(input.blockId, input.effectiveFrom, input.effectiveTo, input.rateBp, input.additionalRateBp, input.act, input.sectionRef, input.source, id)
  } else {
    rowId = Number(db.prepare(
      `INSERT INTO it_block_rates (block_id, effective_from, effective_to, rate_bp, additional_rate_bp, act, section_ref, source)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(input.blockId, input.effectiveFrom, input.effectiveTo, input.rateBp, input.additionalRateBp, input.act, input.sectionRef, input.source).lastInsertRowid)
  }
  const after = mapRate(db.prepare('SELECT * FROM it_block_rates WHERE id = ?').get(rowId) as RateRowDb)
  writeAudit(db, 'it_block_rate', after.id, id ? 'update' : 'create', before ? mapRate(before) : null, after)
  return after
}

export function deleteBlockRate(db: DB, id: number): void {
  const before = db.prepare('SELECT * FROM it_block_rates WHERE id = ?').get(id) as RateRowDb | undefined
  if (!before) throw new Error('Rate not found')
  db.prepare('DELETE FROM it_block_rates WHERE id = ?').run(id)
  writeAudit(db, 'it_block_rate', id, 'delete', mapRate(before), null)
}

export function setBlockOpening(db: DB, raw: ItBlockOpeningInput): void {
  const input = itBlockOpeningInputSchema.parse(raw)
  db.prepare(
    `INSERT INTO it_block_openings (block_id, fy_start_year, opening_wdv_paise, additional_bf_paise) VALUES (?, ?, ?, ?)
     ON CONFLICT(block_id, fy_start_year) DO UPDATE SET opening_wdv_paise = excluded.opening_wdv_paise, additional_bf_paise = excluded.additional_bf_paise`
  ).run(input.blockId, input.fyStartYear, input.openingWdv, input.additionalBroughtForward)
  writeAudit(db, 'it_block', input.blockId, 'update', null, { opening: input })
}

export function clearBlockOpening(db: DB, blockId: number, fyStartYear: number): void {
  db.prepare('DELETE FROM it_block_openings WHERE block_id = ? AND fy_start_year = ?').run(blockId, fyStartYear)
  writeAudit(db, 'it_block', blockId, 'update', { fyStartYear }, { opening: null })
}

interface GroupRowDb {
  id: number; name: string; ca_class_id: number | null; life_months: number; residual_bp: number; method: DepMethod
  it_block_id: number | null; asset_ledger_id: number | null; acc_dep_ledger_id: number | null; dep_expense_ledger_id: number | null
  post_per_asset: number
}

function getGroupRow(db: DB, id: number): GroupRowDb {
  const g = db.prepare('SELECT * FROM fixed_asset_groups WHERE id = ?').get(id) as GroupRowDb | undefined
  if (!g) throw new Error('Asset group not found')
  return g
}

export function listAssetGroups(db: DB): AssetGroupRow[] {
  const rows = db.prepare(
    `SELECT g.*, c.name AS class_name, b.name AS block_name,
            la.name AS asset_ledger_name, lc.name AS acc_ledger_name, ld.name AS dep_ledger_name,
            (SELECT COUNT(*) FROM fixed_assets a WHERE a.asset_group_id = g.id) AS asset_count
       FROM fixed_asset_groups g
       LEFT JOIN ca_asset_classes c ON c.id = g.ca_class_id
       LEFT JOIN it_blocks b ON b.id = g.it_block_id
       LEFT JOIN ledgers la ON la.id = g.asset_ledger_id
       LEFT JOIN ledgers lc ON lc.id = g.acc_dep_ledger_id
       LEFT JOIN ledgers ld ON ld.id = g.dep_expense_ledger_id
      ORDER BY g.name`
  ).all() as (GroupRowDb & {
    class_name: string | null; block_name: string | null; asset_ledger_name: string | null
    acc_ledger_name: string | null; dep_ledger_name: string | null; asset_count: number
  })[]
  return rows.map((g) => ({
    id: g.id, name: g.name, caClassId: g.ca_class_id, caClassName: g.class_name, lifeMonths: g.life_months,
    residualBp: g.residual_bp, method: g.method, itBlockId: g.it_block_id, itBlockName: g.block_name,
    assetLedgerId: g.asset_ledger_id, assetLedgerName: g.asset_ledger_name,
    accDepLedgerId: g.acc_dep_ledger_id, accDepLedgerName: g.acc_ledger_name,
    depExpenseLedgerId: g.dep_expense_ledger_id, depExpenseLedgerName: g.dep_ledger_name,
    postPerAsset: !!g.post_per_asset, assetCount: g.asset_count
  }))
}

export function saveAssetGroup(db: DB, raw: AssetGroupInput, id?: number): AssetGroupRow {
  const input = assetGroupInputSchema.parse(raw)
  if (input.method === 'wdv' && input.residualBp <= 0) throw new Error('WDV needs a residual value above zero')
  if (input.assetLedgerId) assertFixedAssetLedger(db, input.assetLedgerId, 'The asset ledger')
  if (input.accDepLedgerId) assertFixedAssetLedger(db, input.accDepLedgerId, 'The accumulated depreciation ledger')
  if (input.depExpenseLedgerId) assertExpenseLedger(db, input.depExpenseLedgerId)
  const before = id ? getGroupRow(db, id) : null
  const values = [
    input.name, input.caClassId, input.lifeMonths, input.residualBp, input.method, input.itBlockId,
    input.assetLedgerId, input.accDepLedgerId, input.depExpenseLedgerId, input.postPerAsset ? 1 : 0
  ]
  let rowId = id
  if (id) {
    db.prepare(
      `UPDATE fixed_asset_groups SET name = ?, ca_class_id = ?, life_months = ?, residual_bp = ?, method = ?, it_block_id = ?,
         asset_ledger_id = ?, acc_dep_ledger_id = ?, dep_expense_ledger_id = ?, post_per_asset = ? WHERE id = ?`
    ).run(...values, id)
  } else {
    rowId = Number(db.prepare(
      `INSERT INTO fixed_asset_groups (name, ca_class_id, life_months, residual_bp, method, it_block_id,
         asset_ledger_id, acc_dep_ledger_id, dep_expense_ledger_id, post_per_asset) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(...values).lastInsertRowid)
  }
  const after = listAssetGroups(db).find((g) => g.id === rowId)!
  writeAudit(db, 'fixed_asset_group', after.id, id ? 'update' : 'create', before, after)
  return after
}

export function deleteAssetGroup(db: DB, id: number): void {
  const before = getGroupRow(db, id)
  const used = db.prepare('SELECT COUNT(*) AS n FROM fixed_assets WHERE asset_group_id = ?').get(id) as { n: number }
  if (used.n > 0) throw new Error('This group has assets — move or delete them first')
  db.prepare('DELETE FROM fixed_asset_groups WHERE id = ?').run(id)
  writeAudit(db, 'fixed_asset_group', id, 'delete', before, null)
}

// ---------------------------------------------------------------------------------------------
// Register: loading + per-asset book position
// ---------------------------------------------------------------------------------------------

interface AssetRowDb {
  id: number; name: string; asset_group_id: number; ledger_id: number; purchase_voucher_id: number | null
  purchase_date: string; put_to_use_date: string; cost_paise: number; residual_pct_bp: number; useful_life_months: number
  method: DepMethod; basis_date: string; it_block_id: number | null; it_additional_eligible: number
  location: string | null; identifier: string | null; acc_dep_ledger_id: number | null
  opening_acc_dep_paise: number; opening_acc_dep_as_of: string | null
  disposal_date: string | null; disposal_voucher_id: number | null; disposal_kind: DisposalKind | null
  disposal_proceeds_paise: number | null; status: 'active' | 'disposed'; notes: string | null
}

/** One live depreciation line (its run's voucher is not binned). */
interface LiveLine {
  runId: number
  assetId: number
  amount: number
  periodFrom: string
  periodTo: string
  /** Date of the voucher it was booked in (period end; the disposal date for a catch-up). */
  voucherDate: string
  catchUp: boolean
}

interface AssetRec {
  row: AssetRowDb
  group: GroupRowDb & { name: string }
  additions: AssetAdditionRow[]
  lines: LiveLine[]
  /** The disposal journal is live. */
  disposed: boolean
  purchaseVoucherBinned: boolean
}

function liveLines(db: DB, assetIds?: number[]): LiveLine[] {
  const filter = assetIds ? `AND dl.asset_id IN (${assetIds.map(() => '?').join(',') || 'NULL'})` : ''
  return (db.prepare(
    `SELECT dl.run_id AS runId, dl.asset_id AS assetId, dl.depreciation AS amount, r.period_from AS periodFrom,
            r.period_to AS periodTo, v.date AS voucherDate, (r.asset_id IS NOT NULL) AS catchUp
       FROM depreciation_lines dl
       JOIN depreciation_runs r ON r.id = dl.run_id
       JOIN vouchers v ON v.id = r.voucher_id
      WHERE ${NOT_DELETED} AND r.basis = 'companies_act' ${filter}
      ORDER BY r.period_to, r.id`
  ).all(...(assetIds ?? [])) as (Omit<LiveLine, 'catchUp'> & { catchUp: number })[]).map((l) => ({ ...l, catchUp: !!l.catchUp }))
}

function loadAssets(db: DB, ids?: number[]): AssetRec[] {
  const where = ids ? `WHERE a.id IN (${ids.map(() => '?').join(',') || 'NULL'})` : ''
  const rows = db.prepare(
    `SELECT a.*,
            (SELECT v.deleted_at IS NULL FROM vouchers v WHERE v.id = a.disposal_voucher_id) AS disposal_live,
            (SELECT v.deleted_at IS NOT NULL FROM vouchers v WHERE v.id = a.purchase_voucher_id) AS purchase_binned
       FROM fixed_assets a ${where} ORDER BY a.name, a.id`
  ).all(...(ids ?? [])) as (AssetRowDb & { disposal_live: number | null; purchase_binned: number | null })[]
  const groups = new Map((db.prepare('SELECT * FROM fixed_asset_groups').all() as GroupRowDb[]).map((g) => [g.id, g]))
  const adds = db.prepare('SELECT * FROM fixed_asset_additions ORDER BY date, id').all() as {
    id: number; asset_id: number; date: string; voucher_id: number | null; amount_paise: number; kind: 'addition' | 'improvement'; note: string | null
  }[]
  const lines = liveLines(db, ids)
  return rows.map((row) => ({
    row,
    group: groups.get(row.asset_group_id)!,
    additions: adds.filter((x) => x.asset_id === row.id).map((x) => ({
      id: x.id, assetId: x.asset_id, date: x.date, voucherId: x.voucher_id, amountPaise: x.amount_paise, kind: x.kind, note: x.note
    })),
    lines: lines.filter((l) => l.assetId === row.id),
    disposed: row.disposal_voucher_id != null && !!row.disposal_live,
    purchaseVoucherBinned: !!row.purchase_binned
  }))
}

function getAssetRec(db: DB, id: number): AssetRec {
  const rec = loadAssets(db, [id])[0]
  if (!rec) throw new Error('Asset not found')
  return rec
}

function layersOf(a: AssetRec): CostLayer[] {
  return [
    { date: a.row.put_to_use_date, bookedOn: a.row.purchase_date, amount: a.row.cost_paise },
    ...a.additions.map((x) => ({ date: x.date, amount: x.amountPaise }))
  ]
}

const disposalDateOf = (a: AssetRec): string | null => (a.disposed ? a.row.disposal_date : null)

/** Gross block of the asset on `asOn` (inclusive): cost (from the purchase date) + additions. */
function grossOn(a: AssetRec, asOn: string): number {
  const d = disposalDateOf(a)
  if (d && d <= asOn) return 0
  let g = a.row.purchase_date <= asOn ? a.row.cost_paise : 0
  for (const x of a.additions) if (x.date <= asOn) g += x.amountPaise
  return g
}

/** Gross cost written off on disposal (everything booked before the disposal date). */
function grossAtDisposal(a: AssetRec, date: string): number {
  return a.row.cost_paise + a.additions.filter((x) => x.date < date).reduce((s, x) => s + x.amountPaise, 0)
}

/** Accumulated depreciation booked through period ends before `before` (exclusive). */
function accBefore(a: AssetRec, before: string): number {
  return a.row.opening_acc_dep_paise + a.lines.filter((l) => l.periodTo < before).reduce((s, l) => s + l.amount, 0)
}

function accTotal(a: AssetRec): number {
  return a.row.opening_acc_dep_paise + a.lines.reduce((s, l) => s + l.amount, 0)
}

/** Accumulated depreciation in the books on `asOn` (by voucher date), before any disposal write-back. */
function accOn(a: AssetRec, asOn: string): number {
  return a.row.opening_acc_dep_paise + a.lines.filter((l) => l.voucherDate <= asOn).reduce((s, l) => s + l.amount, 0)
}

/** Last day depreciation is booked for. With `upTo`, only lines starting on or before it count —
 *  so re-running an earlier, binned period isn't blocked by a later live run. */
function depreciatedThrough(a: AssetRec, upTo?: string): string | null {
  let t = a.row.opening_acc_dep_paise > 0 || a.row.opening_acc_dep_as_of ? a.row.opening_acc_dep_as_of : null
  for (const l of a.lines) if ((!upTo || l.periodFrom <= upTo) && (!t || l.periodTo > t)) t = l.periodTo
  return t
}

function engineInput(a: AssetRec, period: { from: string; to: string }, disposalDate: string | null = disposalDateOf(a)): CaAssetInput {
  const fy = fyOf(period.from)
  return {
    method: a.row.method,
    residualBp: a.row.residual_pct_bp,
    lifeMonths: a.row.useful_life_months,
    putToUseDate: a.row.put_to_use_date,
    disposalDate,
    layers: layersOf(a),
    basisDate: a.row.basis_date,
    accBeforeBasis: accBefore(a, a.row.basis_date),
    accBeforeFy: accBefore(a, fy.from),
    accInFyBeforePeriod: a.lines.filter((l) => l.periodTo >= fy.from && l.periodTo < period.from).reduce((s, l) => s + l.amount, 0),
    depreciatedThrough: depreciatedThrough(a, period.to)
  }
}

function toRow(db: DB, a: AssetRec, asOn: string, names: Map<number, string>): FixedAssetRow {
  const r = a.row
  const gross = a.disposed && r.disposal_date && r.disposal_date <= asOn ? 0 : grossOn(a, asOn)
  const acc = a.disposed && r.disposal_date && r.disposal_date <= asOn ? 0 : accOn(a, asOn)
  const block = r.it_block_id ? (db.prepare('SELECT name FROM it_blocks WHERE id = ?').get(r.it_block_id) as { name: string } | undefined) : undefined
  return {
    id: r.id, name: r.name, assetGroupId: r.asset_group_id, groupName: a.group.name, ledgerId: r.ledger_id,
    ledgerName: names.get(r.ledger_id) ?? '', accDepLedgerId: r.acc_dep_ledger_id,
    purchaseVoucherId: r.purchase_voucher_id, purchaseVoucherBinned: a.purchaseVoucherBinned,
    purchaseDate: r.purchase_date, putToUseDate: r.put_to_use_date, costPaise: r.cost_paise, residualBp: r.residual_pct_bp,
    lifeMonths: r.useful_life_months, method: r.method, basisDate: r.basis_date, itBlockId: r.it_block_id,
    itBlockName: block?.name ?? null, itAdditionalEligible: !!r.it_additional_eligible, location: r.location,
    identifier: r.identifier, openingAccDepPaise: r.opening_acc_dep_paise, openingAccDepAsOf: r.opening_acc_dep_as_of,
    notes: r.notes, status: a.disposed ? 'disposed' : 'active',
    disposalDate: a.disposed ? r.disposal_date : null, disposalVoucherId: a.disposed ? r.disposal_voucher_id : null,
    disposalKind: a.disposed ? r.disposal_kind : null, disposalProceedsPaise: a.disposed ? r.disposal_proceeds_paise : null,
    grossPaise: gross, accumulatedPaise: acc, carryingPaise: gross - acc,
    depreciatedThrough: depreciatedThrough(a), hasDepreciation: a.lines.length > 0, lifeEnd: lifeEndDate(r.put_to_use_date, r.useful_life_months),
    additions: a.additions
  }
}

function ledgerNames(db: DB): Map<number, string> {
  return new Map((db.prepare('SELECT id, name FROM ledgers').all() as { id: number; name: string }[]).map((l) => [l.id, l.name]))
}

export function listAssets(db: DB, asOn: string): FixedAssetRow[] {
  const names = ledgerNames(db)
  return loadAssets(db).map((a) => toRow(db, a, asOn, names))
}

export function getAsset(db: DB, id: number, asOn: string): FixedAssetRow {
  return toRow(db, getAssetRec(db, id), asOn, ledgerNames(db))
}

// ---------------------------------------------------------------------------------------------
// Register: create / edit / delete, additions
// ---------------------------------------------------------------------------------------------

export function saveAsset(db: DB, raw: FixedAssetInput, id?: number): FixedAssetRow {
  const input = fixedAssetInputSchema.parse(raw)
  getGroupRow(db, input.assetGroupId)
  assertFixedAssetLedger(db, input.ledgerId, 'The asset ledger')
  if (input.accDepLedgerId) assertFixedAssetLedger(db, input.accDepLedgerId, 'The accumulated depreciation ledger')
  if (input.purchaseVoucherId && !db.prepare('SELECT 1 FROM vouchers WHERE id = ?').get(input.purchaseVoucherId)) {
    throw new Error('Purchase voucher not found')
  }
  const before = id ? getAssetRec(db, id) : null
  let basisDate = input.putToUseDate
  if (before) {
    const b = before.row
    const booked = before.lines.length > 0
    if (before.disposed) {
      const frozen: [unknown, unknown][] = [
        [b.cost_paise, input.costPaise], [b.purchase_date, input.purchaseDate], [b.put_to_use_date, input.putToUseDate],
        [b.ledger_id, input.ledgerId], [b.asset_group_id, input.assetGroupId], [b.useful_life_months, input.lifeMonths],
        [b.method, input.method], [b.residual_pct_bp, input.residualBp]
      ]
      if (frozen.some(([x, y]) => x !== y)) throw new Error('This asset is disposed — only its name, location, identifier and notes can change')
    }
    if (booked) {
      const fixed: [unknown, unknown, string][] = [
        [b.cost_paise, input.costPaise, 'cost'], [b.purchase_date, input.purchaseDate, 'purchase date'],
        [b.put_to_use_date, input.putToUseDate, 'put-to-use date'], [b.ledger_id, input.ledgerId, 'asset ledger'],
        [b.asset_group_id, input.assetGroupId, 'group'], [b.opening_acc_dep_paise, input.openingAccDepPaise, 'opening accumulated depreciation'],
        [b.acc_dep_ledger_id, input.accDepLedgerId, 'accumulated depreciation ledger']
      ]
      const changed = fixed.filter(([x, y]) => x !== y).map(([, , what]) => what)
      if (changed.length) {
        throw new Error(
          `Depreciation is booked for this asset, so its ${changed.join(', ')} can't change — record an improvement, or bin the depreciation runs first`
        )
      }
    }
    const estimateChanged = b.useful_life_months !== input.lifeMonths || b.method !== input.method || b.residual_pct_bp !== input.residualBp
    basisDate = b.basis_date
    if (estimateChanged && booked) {
      const eff = input.changeEffectiveFrom
      if (!eff) throw new Error('Depreciation is booked for this asset — give the financial year the new life / method / residual applies from')
      if (eff !== fyOf(eff).from) throw new Error('A change of estimate applies from the start of a financial year (1 April)')
      if (eff <= input.putToUseDate) throw new Error('The change must apply after the asset was put to use')
      const through = depreciatedThrough(before)
      if (through && eff <= through) {
        throw new Error(`Depreciation is booked up to ${fmtDate(through)} — the change can only apply from a later year (bin those runs to restate)`)
      }
      basisDate = eff
    } else if (!booked) {
      basisDate = input.putToUseDate
    }
  }
  const values = [
    input.name, input.assetGroupId, input.ledgerId, input.purchaseVoucherId, input.purchaseDate, input.putToUseDate,
    input.costPaise, input.residualBp, input.lifeMonths, input.method, basisDate, input.itBlockId,
    input.itAdditionalEligible ? 1 : 0, input.location, input.identifier, input.accDepLedgerId,
    input.openingAccDepPaise, input.openingAccDepPaise > 0 ? input.openingAccDepAsOf : null, input.notes
  ]
  let rowId = id
  if (id) {
    db.prepare(
      `UPDATE fixed_assets SET name = ?, asset_group_id = ?, ledger_id = ?, purchase_voucher_id = ?, purchase_date = ?,
         put_to_use_date = ?, cost_paise = ?, residual_pct_bp = ?, useful_life_months = ?, method = ?, basis_date = ?,
         it_block_id = ?, it_additional_eligible = ?, location = ?, identifier = ?, acc_dep_ledger_id = ?,
         opening_acc_dep_paise = ?, opening_acc_dep_as_of = ?, notes = ? WHERE id = ?`
    ).run(...values, id)
  } else {
    rowId = Number(db.prepare(
      `INSERT INTO fixed_assets (name, asset_group_id, ledger_id, purchase_voucher_id, purchase_date, put_to_use_date,
         cost_paise, residual_pct_bp, useful_life_months, method, basis_date, it_block_id, it_additional_eligible,
         location, identifier, acc_dep_ledger_id, opening_acc_dep_paise, opening_acc_dep_as_of, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(...values).lastInsertRowid)
  }
  const after = getAsset(db, rowId!, '9999-12-31')
  writeAudit(db, 'fixed_asset', after.id, id ? 'update' : 'create', before?.row ?? null, after)
  return after
}

export function deleteAsset(db: DB, id: number): void {
  const a = getAssetRec(db, id)
  if (a.lines.length > 0) throw new Error('Depreciation is booked for this asset — bin its depreciation runs first')
  if (a.disposed) throw new Error('This asset is disposed — bin the disposal journal first')
  db.prepare('DELETE FROM fixed_assets WHERE id = ?').run(id)
  writeAudit(db, 'fixed_asset', id, 'delete', a.row, null)
}

export function saveAddition(db: DB, raw: AssetAdditionInput, id?: number): AssetAdditionRow {
  const input = assetAdditionInputSchema.parse(raw)
  const a = getAssetRec(db, input.assetId)
  if (a.disposed) throw new Error('This asset is disposed')
  if (input.date < a.row.purchase_date) throw new Error('An addition cannot be dated before the asset was bought')
  const through = depreciatedThrough(a)
  if (through && input.date <= through) throw new Error(`Depreciation is booked up to ${fmtDate(through)} — date the addition after that`)
  if (id) {
    const existing = a.additions.find((x) => x.id === id)
    if (!existing) throw new Error('Addition not found')
    if (through && existing.date <= through) throw new Error('Depreciation is booked over this addition — bin those runs first')
    db.prepare('UPDATE fixed_asset_additions SET date = ?, voucher_id = ?, amount_paise = ?, kind = ?, note = ? WHERE id = ?')
      .run(input.date, input.voucherId, input.amountPaise, input.kind, input.note, id)
  } else {
    id = Number(db.prepare('INSERT INTO fixed_asset_additions (asset_id, date, voucher_id, amount_paise, kind, note) VALUES (?, ?, ?, ?, ?, ?)')
      .run(input.assetId, input.date, input.voucherId, input.amountPaise, input.kind, input.note).lastInsertRowid)
  }
  const row = getAssetRec(db, input.assetId).additions.find((x) => x.id === id)!
  writeAudit(db, 'fixed_asset', input.assetId, 'update', null, { addition: row })
  return row
}

export function deleteAddition(db: DB, id: number): void {
  const x = db.prepare('SELECT * FROM fixed_asset_additions WHERE id = ?').get(id) as { asset_id: number; date: string } | undefined
  if (!x) throw new Error('Addition not found')
  const a = getAssetRec(db, x.asset_id)
  const through = depreciatedThrough(a)
  if (through && x.date <= through) throw new Error('Depreciation is booked over this addition — bin those runs first')
  db.prepare('DELETE FROM fixed_asset_additions WHERE id = ?').run(id)
  writeAudit(db, 'fixed_asset', x.asset_id, 'update', { additionId: id }, { additionDeleted: true })
}

// ---------------------------------------------------------------------------------------------
// Create from a purchase voucher
// ---------------------------------------------------------------------------------------------

/** Ledgers that hold accumulated depreciation (never offered as an asset line). */
function accDepLedgerIds(db: DB): Set<number> {
  const ids = new Set<number>()
  for (const r of db.prepare('SELECT acc_dep_ledger_id AS id FROM fixed_asset_groups WHERE acc_dep_ledger_id IS NOT NULL UNION SELECT acc_dep_ledger_id FROM fixed_assets WHERE acc_dep_ledger_id IS NOT NULL').all() as { id: number }[]) ids.add(r.id)
  for (const r of db.prepare("SELECT id FROM ledgers WHERE name LIKE 'Accumulated Depreciation%'").all() as { id: number }[]) ids.add(r.id)
  return ids
}

function suggestedGroup(db: DB, ledgerId: number): number | null {
  const byLedger = db.prepare('SELECT id FROM fixed_asset_groups WHERE asset_ledger_id = ? ORDER BY id LIMIT 1').get(ledgerId) as { id: number } | undefined
  if (byLedger) return byLedger.id
  const byUse = db.prepare(
    'SELECT asset_group_id AS id FROM fixed_assets WHERE ledger_id = ? GROUP BY asset_group_id ORDER BY COUNT(*) DESC LIMIT 1'
  ).get(ledgerId) as { id: number } | undefined
  return byUse?.id ?? null
}

function candidatesWhere(db: DB, where: string, params: unknown[]): PurchaseCandidate[] {
  const faGroups = fixedAssetGroupIds(db)
  const accIds = accDepLedgerIds(db)
  const rows = db.prepare(
    `SELECT v.id AS voucherId, v.date, v.number, vt.name AS voucherTypeName, v.party_ledger_id AS partyLedgerId,
            p.name AS partyName, vl.ledger_id AS ledgerId, l.name AS ledgerName, l.group_id AS groupId, SUM(vl.amount) AS amount
       FROM vouchers v
       JOIN voucher_types vt ON vt.id = v.voucher_type_id
       JOIN voucher_lines vl ON vl.voucher_id = v.id AND vl.dr_cr = 'dr'
       JOIN ledgers l ON l.id = vl.ledger_id
       LEFT JOIN ledgers p ON p.id = v.party_ledger_id
      WHERE ${NOT_DELETED} AND v.is_year_end_close = 0 AND ${where}
      GROUP BY v.id, vl.ledger_id
      ORDER BY v.date DESC, v.id DESC`
  ).all(...params) as {
    voucherId: number; date: string; number: string; voucherTypeName: string; partyLedgerId: number | null
    partyName: string | null; ledgerId: number; ledgerName: string; groupId: number; amount: number
  }[]
  const linked = new Set(
    (db.prepare(
      `SELECT purchase_voucher_id AS v, ledger_id AS l FROM fixed_assets WHERE purchase_voucher_id IS NOT NULL
       UNION SELECT x.voucher_id, a.ledger_id FROM fixed_asset_additions x JOIN fixed_assets a ON a.id = x.asset_id WHERE x.voucher_id IS NOT NULL`
    ).all() as { v: number; l: number }[]).map((r) => `${r.v}:${r.l}`)
  )
  // Depreciation and disposal journals are never purchases.
  const ownVouchers = new Set(
    (db.prepare('SELECT voucher_id AS v FROM depreciation_runs WHERE voucher_id IS NOT NULL UNION SELECT disposal_voucher_id FROM fixed_assets WHERE disposal_voucher_id IS NOT NULL').all() as { v: number }[]).map((r) => r.v)
  )
  const out = new Map<number, PurchaseCandidate>()
  for (const r of rows) {
    if (!faGroups.has(r.groupId) || accIds.has(r.ledgerId) || ownVouchers.has(r.voucherId)) continue
    if (linked.has(`${r.voucherId}:${r.ledgerId}`)) continue
    const c = out.get(r.voucherId) ?? {
      voucherId: r.voucherId, date: r.date, number: r.number, voucherTypeName: r.voucherTypeName,
      partyLedgerId: r.partyLedgerId, partyName: r.partyName, lines: []
    }
    c.lines.push({ ledgerId: r.ledgerId, ledgerName: r.ledgerName, amount: r.amount, suggestedGroupId: suggestedGroup(db, r.ledgerId) })
    out.set(r.voucherId, c)
  }
  return [...out.values()]
}

/** Vouchers in the period with a debit to a Fixed Assets ledger that isn't on the register yet. */
export function purchaseCandidates(db: DB, from: string, to: string): PurchaseCandidate[] {
  return candidatesWhere(db, 'v.date BETWEEN ? AND ?', [from, to])
}

/** The fixed-asset lines of one voucher (for "create asset from purchase voucher"). */
export function candidateFromVoucher(db: DB, voucherId: number): PurchaseCandidate | null {
  return candidatesWhere(db, 'v.id = ?', [voucherId])[0] ?? null
}

// ---------------------------------------------------------------------------------------------
// Depreciation runs
// ---------------------------------------------------------------------------------------------

interface ResolvedLedgers {
  depId: number | null
  depName: string
  accId: number | null
  accName: string
}

function resolveLedgers(db: DB, a: AssetRec): ResolvedLedgers {
  const depId = a.group.dep_expense_ledger_id ?? ledgerIdByName(db, DEPRECIATION_LEDGER)
  const accName = accDepLedgerName(a.group.name)
  const accId = a.row.acc_dep_ledger_id ?? a.group.acc_dep_ledger_id ?? ledgerIdByName(db, accName)
  return {
    depId,
    depName: ledgerName(db, depId) ?? DEPRECIATION_LEDGER,
    accId,
    accName: ledgerName(db, accId) ?? accName
  }
}

/** Creates the group's depreciation / accumulated-depreciation ledgers when missing and stores them on the group. */
function ensureLedgers(db: DB, a: AssetRec): { depId: number; accId: number } {
  let depId = a.group.dep_expense_ledger_id
  if (depId == null) {
    depId = findOrCreateLedger(db, DEPRECIATION_LEDGER, 'Indirect Expenses')
    db.prepare('UPDATE fixed_asset_groups SET dep_expense_ledger_id = ? WHERE id = ? AND dep_expense_ledger_id IS NULL').run(depId, a.group.id)
    a.group.dep_expense_ledger_id = depId
  }
  let accId = a.row.acc_dep_ledger_id ?? a.group.acc_dep_ledger_id
  if (accId == null) {
    accId = findOrCreateLedger(db, accDepLedgerName(a.group.name), FIXED_ASSETS_GROUP)
    db.prepare('UPDATE fixed_asset_groups SET acc_dep_ledger_id = ? WHERE id = ? AND acc_dep_ledger_id IS NULL').run(accId, a.group.id)
    a.group.acc_dep_ledger_id = accId
  }
  return { depId, accId }
}

interface LiveRun { id: number; voucherId: number; from: string; to: string }

function overlappingRun(db: DB, from: string, to: string): LiveRun | null {
  return (db.prepare(
    `SELECT r.id, r.voucher_id AS voucherId, r.period_from AS "from", r.period_to AS "to"
       FROM depreciation_runs r JOIN vouchers v ON v.id = r.voucher_id
      WHERE ${NOT_DELETED} AND r.asset_id IS NULL AND r.basis = 'companies_act'
        AND r.period_from <= ? AND r.period_to >= ?
      ORDER BY r.period_from LIMIT 1`
  ).get(to, from) as LiveRun | undefined) ?? null
}

interface ComputedRun {
  preview: DepreciationPreview
  perAsset: { a: AssetRec; row: DepreciationPreviewRow }[]
}

/** Schedule II Notes para 6: extra-shift depreciation is not permitted for a class marked NESD in
 *  Part C. Seeded classes are checked against EXTRA_SHIFT_SEEDED_CLASS_CODES; a class the user added
 *  (or a group without a class) is not checked (FIXED_ASSET_UNVERIFIED 'shift-user-class'). */
function extraShiftAllowed(db: DB, a: AssetRec): { allowed: boolean; note: string | null } {
  if (a.group.ca_class_id == null) return { allowed: true, note: `${a.group.name} has no Schedule II class — check Part C for an NESD mark before charging extra shift` }
  const c = db.prepare('SELECT code, name, is_seeded FROM ca_asset_classes WHERE id = ?').get(a.group.ca_class_id) as { code: string; name: string; is_seeded: number } | undefined
  if (!c) return { allowed: true, note: null }
  if (!c.is_seeded) return { allowed: true, note: `${c.code} ${c.name} is a class you added — NESD is not checked for it; Part C's mark decides` }
  return { allowed: EXTRA_SHIFT_SEEDED_CLASS_CODES.includes(c.code), note: null }
}

function computeRun(db: DB, from: string, to: string, shifts: ExtraShiftInput[] = []): ComputedRun {
  const fy = fyOf(from)
  if (to > fy.to) throw new Error('A depreciation run must lie inside one financial year')
  const assets = loadAssets(db).filter((a) => {
    if (a.row.put_to_use_date > to) return false
    const d = disposalDateOf(a)
    return !d || d > from
  })
  const shiftBy = new Map(shifts.map((x) => [x.assetId, { doubleDays: x.doubleShiftDays ?? 0, tripleDays: x.tripleShiftDays ?? 0 }]))
  let shiftBlocked: string | null = null
  for (const id of shiftBy.keys()) {
    if (!assets.some((a) => a.row.id === id)) shiftBlocked ??= 'Extra shifts are given for an asset that is not in use in this period'
  }
  const perAsset: ComputedRun['perAsset'] = []
  for (const a of assets) {
    const input = engineInput(a, { from, to })
    const r = companiesActPeriod(input, { from, to })
    const { allowed, note } = extraShiftAllowed(db, a)
    const shift = shiftBy.get(a.row.id)
    let charged = r
    let extraShift: DepreciationPreviewRow['extraShift'] = null
    let extraShiftNote: string | null = null
    if (shift && (shift.doubleDays > 0 || shift.tripleDays > 0)) {
      extraShiftNote = note
      if (!allowed) {
        shiftBlocked ??= `${a.row.name}: its Schedule II class is marked NESD — no extra-shift depreciation (Sch II Notes para 6)`
      } else if (shift.doubleDays + shift.tripleDays > r.daysUsed) {
        shiftBlocked ??= `${a.row.name}: ${shift.doubleDays + shift.tripleDays} extra-shift days, but it is depreciated for ${r.daysUsed} days in this period`
      } else {
        charged = companiesActPeriod({ ...input, extraShift: shift }, { from, to })
        extraShift = { ...shift, extra: charged.depreciation - r.depreciation }
      }
    }
    perAsset.push({
      a,
      row: {
        assetId: a.row.id, assetName: a.row.name, groupId: a.group.id, groupName: a.group.name, method: a.row.method,
        openingWdv: charged.openingWdv, additions: charged.additions, depreciation: charged.depreciation, closingWdv: charged.closingWdv,
        daysUsed: charged.daysUsed, fullyDepreciated: charged.fullyDepreciated, ratePpb: charged.ratePpb,
        extraShiftAllowed: allowed, extraShift, extraShiftNote
      }
    })
  }
  const journal = runJournalPreview(db, perAsset)
  const total = perAsset.reduce((s, p) => s + p.row.depreciation, 0)
  const existing = overlappingRun(db, from, to)
  let blocked: string | null = null
  if (shiftBlocked && !existing) {
    blocked = shiftBlocked
  } else if (existing) {
    const num = (db.prepare('SELECT number FROM vouchers WHERE id = ?').get(existing.voucherId) as { number: string }).number
    blocked = `Depreciation for ${fmtDate(existing.from)} to ${fmtDate(existing.to)} is already posted (Journal ${num}) — move that voucher to the bin to run this period again`
  } else {
    blocked = postingBlock(db, to)
    if (!blocked && total === 0) blocked = assets.length === 0 ? 'No assets in service in this period' : 'Nothing to depreciate in this period'
  }
  return {
    preview: {
      from, to, fyStartYear: fy.startYear, rows: perAsset.map((p) => p.row), journal, total, blocked,
      existingRun: existing ? { runId: existing.id, voucherId: existing.voucherId, from: existing.from, to: existing.to } : null
    },
    perAsset
  }
}

function runJournalPreview(db: DB, perAsset: ComputedRun['perAsset']): JournalPreviewLine[] {
  const dr = new Map<string, JournalPreviewLine>()
  const cr = new Map<string, JournalPreviewLine>()
  for (const { a, row } of perAsset) {
    if (row.depreciation <= 0) continue
    const L = resolveLedgers(db, a)
    const dk = L.depId != null ? `id:${L.depId}` : `name:${L.depName}`
    const d = dr.get(dk) ?? { ledgerId: L.depId, ledgerName: L.depName, drCr: 'dr' as const, amount: 0, assetId: null }
    d.amount += row.depreciation
    dr.set(dk, d)
    const perAssetLine = !!a.group.post_per_asset
    const ck = `${L.accId != null ? `id:${L.accId}` : `name:${L.accName}`}${perAssetLine ? `:a${a.row.id}` : ''}`
    const c = cr.get(ck) ?? { ledgerId: L.accId, ledgerName: L.accName, drCr: 'cr' as const, amount: 0, assetId: perAssetLine ? a.row.id : null }
    c.amount += row.depreciation
    cr.set(ck, c)
  }
  return [...dr.values(), ...cr.values()]
}

export function previewRun(db: DB, from: string, to: string, shifts: ExtraShiftInput[] = []): DepreciationPreview {
  return computeRun(db, from, to, shifts).preview
}

/** Post a depreciation run: ONE journal (dated the period end) + the run and its lines, in one
 *  transaction (saveVoucher nests as a savepoint). Refused while a live run overlaps the period,
 *  inside a locked period or closed year, or when there is nothing to charge. */
export function postRun(db: DB, from: string, to: string, shifts: ExtraShiftInput[] = []): DepreciationRunRow {
  const tx = db.transaction((): { runId: number; shifts: { assetId: number; doubleDays: number; tripleDays: number; extra: number }[] } => {
    const { preview, perAsset } = computeRun(db, from, to, shifts)
    if (preview.blocked) throw new Error(preview.blocked)
    const lines: { ledgerId: number; drCr: 'dr' | 'cr'; amount: number; costAllocations: [] }[] = []
    const dr = new Map<number, number>()
    const crLines: { ledgerId: number; amount: number; key: string }[] = []
    for (const { a, row } of perAsset) {
      if (row.depreciation <= 0) continue
      const { depId, accId } = ensureLedgers(db, a)
      dr.set(depId, (dr.get(depId) ?? 0) + row.depreciation)
      const key = a.group.post_per_asset ? `${accId}:a${a.row.id}` : `${accId}`
      const existing = crLines.find((c) => c.key === key)
      if (existing) existing.amount += row.depreciation
      else crLines.push({ ledgerId: accId, amount: row.depreciation, key })
    }
    for (const [ledgerId, amount] of dr) lines.push({ ledgerId, drCr: 'dr', amount, costAllocations: [] })
    for (const c of crLines) lines.push({ ledgerId: c.ledgerId, drCr: 'cr', amount: c.amount, costAllocations: [] })
    const count = perAsset.filter((p) => p.row.depreciation > 0).length
    const shifted = perAsset.filter((p) => p.row.extraShift && p.row.extraShift.extra > 0)
    const shiftNote = shifted.length
      ? `; extra shift (Sch II Notes para 6): ${shifted.map((p) => `${p.row.assetName} ${p.row.extraShift!.doubleDays} double / ${p.row.extraShift!.tripleDays} triple-shift days`).join(', ')}`
      : ''
    const voucher = saveVoucher(db, {
      voucherTypeId: journalTypeId(db),
      date: to,
      partyLedgerId: null,
      narration: `Depreciation ${fmtDate(from)} to ${fmtDate(to)} — Companies Act 2013, Schedule II (${count} asset${count === 1 ? '' : 's'})${shiftNote}`.slice(0, 1000),
      reference: null,
      lines,
      inventory: [],
      billRefs: [],
      tds: null
    })
    const runId = Number(db.prepare(
      "INSERT INTO depreciation_runs (fy_start_year, period_from, period_to, basis, voucher_id) VALUES (?, ?, ?, 'companies_act', ?)"
    ).run(preview.fyStartYear, from, to, voucher.id).lastInsertRowid)
    const ins = db.prepare('INSERT INTO depreciation_lines (run_id, asset_id, opening_wdv, depreciation, closing_wdv, days_used) VALUES (?, ?, ?, ?, ?, ?)')
    for (const { row } of perAsset) {
      if (row.depreciation <= 0) continue
      ins.run(runId, row.assetId, row.openingWdv + row.additions, row.depreciation, row.closingWdv, row.daysUsed)
    }
    return { runId, shifts: shifted.map((p) => ({ assetId: p.row.assetId, ...p.row.extraShift! })) }
  })
  const { runId, shifts: shiftsPosted } = tx()
  const run = listRuns(db).find((r) => r.id === runId)!
  // The shift days have no column: they are kept in the run's audit row (and the narration).
  writeAudit(db, 'depreciation_run', runId, 'create', null, shiftsPosted.length ? { ...run, extraShift: shiftsPosted } : run)
  return run
}

export function listRuns(db: DB): DepreciationRunRow[] {
  const rows = db.prepare(
    `SELECT r.id, r.fy_start_year, r.period_from, r.period_to, r.basis, r.voucher_id, r.asset_id, r.posted_at,
            v.number AS voucher_number, v.deleted_at, a.name AS asset_name,
            COALESCE((SELECT SUM(depreciation) FROM depreciation_lines dl WHERE dl.run_id = r.id), 0) AS total,
            (SELECT COUNT(*) FROM depreciation_lines dl WHERE dl.run_id = r.id) AS line_count
       FROM depreciation_runs r
       LEFT JOIN vouchers v ON v.id = r.voucher_id
       LEFT JOIN fixed_assets a ON a.id = r.asset_id
      ORDER BY r.period_to DESC, r.id DESC`
  ).all() as {
    id: number; fy_start_year: number; period_from: string; period_to: string; basis: 'companies_act' | 'income_tax'
    voucher_id: number | null; asset_id: number | null; posted_at: string; voucher_number: string | null
    deleted_at: string | null; asset_name: string | null; total: number; line_count: number
  }[]
  return rows.map((r) => ({
    id: r.id, fyStartYear: r.fy_start_year, periodFrom: r.period_from, periodTo: r.period_to, basis: r.basis,
    voucherId: r.voucher_id, voucherNumber: r.voucher_number, voided: r.voucher_id == null || r.deleted_at != null,
    assetId: r.asset_id, assetName: r.asset_name, postedAt: r.posted_at, total: r.total, lineCount: r.line_count
  }))
}

export function runLines(db: DB, runId: number): DepreciationPreviewRow[] {
  return (db.prepare(
    `SELECT dl.asset_id AS assetId, a.name AS assetName, g.id AS groupId, g.name AS groupName, a.method,
            dl.opening_wdv AS openingWdv, dl.depreciation, dl.closing_wdv AS closingWdv, dl.days_used AS daysUsed
       FROM depreciation_lines dl JOIN fixed_assets a ON a.id = dl.asset_id JOIN fixed_asset_groups g ON g.id = a.asset_group_id
      WHERE dl.run_id = ? ORDER BY a.name`
  ).all(runId) as Omit<DepreciationPreviewRow, 'additions' | 'fullyDepreciated' | 'ratePpb' | 'extraShiftAllowed' | 'extraShift' | 'extraShiftNote'>[]).map((r) => ({
    ...r, additions: 0, fullyDepreciated: false, ratePpb: null, extraShiftAllowed: false, extraShift: null, extraShiftNote: null
  }))
}

// ---------------------------------------------------------------------------------------------
// Disposal
// ---------------------------------------------------------------------------------------------

interface ComputedDisposal {
  preview: DisposalPreview
  a: AssetRec
  catchUpPeriod: { from: string; to: string } | null
  catchUpRow: { openingWdv: number; closingWdv: number; daysUsed: number } | null
}

function computeDisposal(db: DB, input: ReturnType<typeof disposalInputSchema.parse>): ComputedDisposal {
  const a = getAssetRec(db, input.assetId)
  const date = input.date
  let blocked: string | null = null
  if (a.disposed) blocked = 'This asset is already disposed'
  else if (date < a.row.purchase_date) blocked = 'The disposal date is before the asset was bought'
  else if (a.additions.some((x) => x.date >= date)) blocked = 'An addition is dated on or after the disposal date'
  const through = depreciatedThrough(a)
  if (!blocked && through && through >= date) {
    blocked = `Depreciation is booked up to ${fmtDate(through)}, past the disposal date — bin that run first`
  }
  const lastDay = addDays(date, -1)
  let catchUp = 0
  let catchUpPeriod: ComputedDisposal['catchUpPeriod'] = null
  let catchUpRow: ComputedDisposal['catchUpRow'] = null
  let catchUpFrom: string | null = null
  if (!blocked && input.chargeCatchUp && lastDay >= a.row.put_to_use_date) {
    const fy = fyOf(lastDay)
    const start = [fy.from, a.row.put_to_use_date, through ? addDays(through, 1) : fy.from].reduce((m, d) => (d > m ? d : m))
    if (a.row.put_to_use_date < fy.from && (!through || through < addDays(fy.from, -1))) {
      blocked = `Depreciation for the year before ${fmtDate(fy.from)} isn't booked for this asset — run it first`
    } else if (start <= lastDay) {
      const r = companiesActPeriod(engineInput(a, { from: start, to: lastDay }, date), { from: start, to: lastDay })
      catchUp = r.depreciation
      catchUpFrom = start
      if (catchUp > 0) {
        catchUpPeriod = { from: start, to: lastDay }
        catchUpRow = { openingWdv: r.openingWdv + r.additions, closingWdv: r.closingWdv, daysUsed: r.daysUsed }
      }
    }
  }
  if (!blocked) blocked = postingBlock(db, date)
  if (!blocked && input.proceedsPaise > 0 && input.considerationLedgerId == null) {
    blocked = 'Pick the cash, bank or buyer account the proceeds go to'
  }
  const gross = grossAtDisposal(a, date)
  const accumulatedBooked = accTotal(a)
  const L = resolveLedgers(db, a)
  const profitId = ledgerIdByName(db, PROFIT_ON_SALE_LEDGER)
  const lossId = ledgerIdByName(db, LOSS_ON_SALE_LEDGER)
  // Placeholder ids (negative) for ledgers that will be created at posting; names map them back.
  // GST on the sale (s.18(6)): the proceeds are the transaction value; the tax invoice credits the
  // "Sale of Fixed Assets" clearing account, which this journal debits instead of the buyer.
  const gst = input.gst ? gstOnSale(db, a, input, blocked) : null
  if (!blocked && gst?.blocked) blocked = gst.blocked
  const saleId = ledgerIdByName(db, SALE_OF_ASSETS_LEDGER)
  const s186Id = ledgerIdByName(db, S186_LEDGER)
  // Placeholder ids (negative) for ledgers that will be created at posting; names map them back.
  const ids = {
    asset: a.row.ledger_id, acc: L.accId ?? -1, dep: L.depId ?? -2, cons: gst ? saleId ?? -6 : input.considerationLedgerId ?? -3,
    profit: profitId ?? -4, loss: lossId ?? -5, s186: s186Id ?? -7
  }
  const names = new Map<number, string>([
    [ids.asset, ledgerName(db, a.row.ledger_id) ?? ''], [ids.acc, L.accName], [ids.dep, L.depName],
    [ids.cons, gst ? SALE_OF_ASSETS_LEDGER : ledgerName(db, input.considerationLedgerId) ?? ''], [ids.profit, PROFIT_ON_SALE_LEDGER],
    [ids.loss, LOSS_ON_SALE_LEDGER], [ids.s186, S186_LEDGER]
  ])
  const { lines, figures } = disposalLines({
    gross, accumulatedBooked, catchUp, proceeds: input.proceedsPaise,
    assetLedgerId: ids.asset, accDepLedgerId: ids.acc, depExpenseLedgerId: ids.dep,
    considerationLedgerId: input.proceedsPaise > 0 ? ids.cons : null, profitLedgerId: ids.profit, lossLedgerId: ids.loss
  })
  const journal: JournalPreviewLine[] = lines.map((l) => ({ ledgerId: l.ledgerId > 0 ? l.ledgerId : null, ledgerName: names.get(l.ledgerId) ?? '', drCr: l.drCr, amount: l.amount, assetId: null }))
  // The extra output tax (rule 44(6) proviso): its own expense, paid as output GST.
  if (gst) {
    const extra = headsTotal(gst.preview.extraOutputTax)
    if (extra > 0) {
      journal.push({ ledgerId: s186Id, ledgerName: S186_LEDGER, drCr: 'dr', amount: extra, assetId: null })
      journal.push(...outputTaxLines(db, gst.preview.extraOutputTax))
    }
  }
  return {
    a,
    catchUpPeriod,
    catchUpRow,
    preview: {
      assetId: a.row.id, date, gross, accumulatedBooked, catchUp, catchUpFrom, carrying: figures.carrying,
      proceeds: input.proceedsPaise, profit: figures.profit, blocked, part: null, remainingCost: null,
      journal, gst: gst?.preview ?? null, gstApplies: chargesGstOn(gstRegistrationOf(readCompanyInfo(db)), date),
      suggestedGstRate: purchaseItc(db, a).ratePercent
    }
  }
}

// ---------------------------------------------------------------------------------------------
// GST on the sale of a capital good — CGST Act s.18(6), rules 40(2) / 44(6)
// (src/shared/capitalGoodsGst.ts; texts FIXED_ASSET_EVENT_SOURCES CGST-*)
// ---------------------------------------------------------------------------------------------

export const SALE_OF_ASSETS_LEDGER = 'Sale of Fixed Assets'
export const S186_LEDGER = 'GST on Sale of Capital Goods (s.18(6))'
/** meta key: { [disposal journal id]: tax invoice id } — the invoice a GST disposal posted. */
const SALE_INVOICES_META = 'fixedAssets.saleInvoices'
const TAX_KEYS = ['cgst', 'sgst', 'igst', 'cess'] as const

function taxLedgers(db: DB): { id: number; name: string; taxType: string }[] {
  return db.prepare('SELECT id, name, tax_type AS taxType FROM ledgers WHERE tax_type IS NOT NULL ORDER BY id').all() as { id: number; name: string; taxType: string }[]
}

/** Cr output-tax lines for `heads` (the ledger the sales editor would pick; a missing one is named
 *  as the editor creates it — CGST / SGST / IGST / CESS under Duties & Taxes). */
function outputTaxLines(db: DB, heads: TaxHeads): JournalPreviewLine[] {
  const all = taxLedgers(db)
  return TAX_KEYS.filter((k) => heads[k] > 0).map((k) => {
    const id = pickTaxLedger(all, k, 'output')
    return { ledgerId: id, ledgerName: id != null ? ledgerName(db, id) ?? k.toUpperCase() : k.toUpperCase(), drCr: 'cr' as const, amount: heads[k], assetId: null }
  })
}

function ensureOutputTaxLedgers(db: DB, heads: TaxHeads): void {
  const groupId = (db.prepare("SELECT id FROM groups WHERE name = 'Duties & Taxes'").get() as { id: number } | undefined)?.id
  if (groupId == null) throw new Error('Duties & Taxes group missing')
  for (const k of TAX_KEYS) {
    if (heads[k] <= 0 || pickTaxLedger(taxLedgers(db), k, 'output') != null) continue
    createLedger(db, {
      name: k.toUpperCase(), groupId, taxType: k, openingBalance: 0, gstin: null, stateCode: null, address: null, gstRate: null,
      hsn: null, tdsSectionId: null, pan: null, creditDays: null, exportType: null
    })
  }
}

/** Credit taken on the asset, from its purchase voucher's input-tax lines in the share the asset's
 *  cost bears to the voucher's fixed-asset lines (FIXED_ASSET_UNVERIFIED 'cg-itc'), the invoice
 *  date, and the rate that tax implies (a hint). */
function purchaseItc(db: DB, a: AssetRec): { heads: TaxHeads; invoiceDate: string; ratePercent: number | null } {
  const none = { heads: { ...ZERO_TAX_HEADS }, invoiceDate: a.row.purchase_date, ratePercent: null }
  const pv = a.row.purchase_voucher_id
  if (pv == null || a.purchaseVoucherBinned) return none
  const v = db.prepare('SELECT date FROM vouchers WHERE id = ?').get(pv) as { date: string } | undefined
  if (!v) return none
  const rows = db.prepare(
    `SELECT vl.amount, vl.dr_cr AS drCr, l.tax_type AS taxType, l.group_id AS groupId
       FROM voucher_lines vl JOIN ledgers l ON l.id = vl.ledger_id WHERE vl.voucher_id = ?`
  ).all(pv) as { amount: number; drCr: 'dr' | 'cr'; taxType: string | null; groupId: number }[]
  const faGroups = fixedAssetGroupIds(db)
  const value = rows.filter((r) => r.drCr === 'dr' && r.taxType == null && faGroups.has(r.groupId)).reduce((s, r) => s + r.amount, 0)
  const tax = { ...ZERO_TAX_HEADS }
  for (const r of rows) {
    if (!r.taxType) continue
    const k = r.taxType as keyof TaxHeads
    tax[k] += r.drCr === 'dr' ? r.amount : -r.amount
  }
  if (value <= 0) return { ...none, invoiceDate: v.date }
  const share = (n: number): number => Math.max(0, mulDivRound(n, a.row.cost_paise, value))
  const heads: TaxHeads = { igst: share(tax.igst), cgst: share(tax.cgst), sgst: share(tax.sgst), cess: share(tax.cess) }
  const gstTax = tax.igst + tax.cgst + tax.sgst
  const ratePercent = gstTax > 0 ? mulDivRound(gstTax, 10_000, value) / 100 : null
  return { heads, invoiceDate: v.date, ratePercent }
}

function gstOnSale(
  db: DB, a: AssetRec, input: ReturnType<typeof disposalInputSchema.parse>, earlier: string | null
): { preview: DisposalGstPreview; blocked: string | null } {
  const g = input.gst!
  const company = readCompanyInfo(db)
  let blocked: string | null = null
  if (!chargesGstOn(gstRegistrationOf(company), input.date)) blocked = 'GST is not charged on this date (the registration is not regular) — sell without GST'
  if (!blocked && input.considerationLedgerId == null) blocked = 'Pick the buyer (or cash / bank) the tax invoice is made out to'
  const buyerState = input.considerationLedgerId != null
    ? (db.prepare('SELECT state_code AS s FROM ledgers WHERE id = ?').get(input.considerationLedgerId) as { s: string | null } | undefined)?.s ?? null
    : null
  const supply = supplyTypeFor(company.stateCode, buyerState ?? company.stateCode)
  const t = computeGst(input.proceedsPaise, g.ratePercent, supply, g.cessPercent)
  const taxOnValue: TaxHeads = { igst: t.igst, cgst: t.cgst, sgst: t.sgst, cess: t.cess }
  const fromPurchase = purchaseItc(db, a)
  const itc: TaxHeads = g.itc ? { igst: g.itc.igst, cgst: g.itc.cgst, sgst: g.itc.sgst, cess: g.itc.cess } : fromPurchase.heads
  const itcSource: DisposalGstPreview['itcSource'] = g.itc ? 'entered' : headsTotal(fromPurchase.heads) > 0 ? 'purchase' : 'none'
  const invoiceDate = g.itcInvoiceDate ?? fromPurchase.invoiceDate
  const supplyDate = input.date < invoiceDate ? invoiceDate : input.date
  if (!blocked && !earlier && input.date < invoiceDate) blocked = 'The sale is dated before the purchase invoice the credit was taken on'
  const working = capitalGoodsSale({ itc, invoiceDate, supplyDate, taxOnValue, supply, scrapProviso: g.scrapProviso })
  const buyerName = ledgerName(db, input.considerationLedgerId) ?? ''
  const saleId = ledgerIdByName(db, SALE_OF_ASSETS_LEDGER)
  const invoiceTotal = input.proceedsPaise + headsTotal(taxOnValue)
  const invoice: JournalPreviewLine[] = [
    { ledgerId: input.considerationLedgerId, ledgerName: buyerName, drCr: 'dr' as const, amount: invoiceTotal, assetId: null },
    ...(input.proceedsPaise > 0 ? [{ ledgerId: saleId, ledgerName: SALE_OF_ASSETS_LEDGER, drCr: 'cr' as const, amount: input.proceedsPaise, assetId: null }] : []),
    ...outputTaxLines(db, taxOnValue)
  ].filter((l) => l.amount > 0)
  return {
    blocked,
    preview: {
      ratePercent: g.ratePercent, supply, taxableValue: input.proceedsPaise, working, workingText: capitalGoodsWorkingText(working),
      itcSource, invoice, invoiceTotal, extraOutputTax: working.excess
    }
  }
}

function saleInvoices(db: DB): Record<string, number> {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(SALE_INVOICES_META) as { value: string } | undefined
  if (!row) return {}
  try {
    const v = JSON.parse(row.value) as Record<string, number>
    return v && typeof v === 'object' ? v : {}
  } catch {
    return {}
  }
}

function linkSaleInvoice(db: DB, journalId: number, invoiceId: number): void {
  const map = { ...saleInvoices(db), [String(journalId)]: invoiceId }
  db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(SALE_INVOICES_META, JSON.stringify(map))
}

/** The tax invoice a GST disposal journal posted (null for a disposal without GST). */
export function saleInvoiceOf(db: DB, journalId: number): number | null {
  return saleInvoices(db)[String(journalId)] ?? null
}

/**
 * Rule 44(6) proviso: the s.18(6) amount beyond the tax on the transaction value "shall form part of
 * the output tax liability and the same shall be furnished in FORM GSTR-1". The disposal journal
 * posts that excess as output tax; here it is added to the TAX INVOICE's outward document (taxable
 * value and rate unchanged, the tax raised), so GSTR-1, GSTR-3B 3.1(a), GSTR-9 and the HSN summary
 * all carry what the books post for that invoice (FIXED_ASSET_UNVERIFIED 'cg-where'). Read from the
 * live disposal journals' Cr output-tax lines; returns `docs` untouched for a company without such
 * sales. Called by extractOutwardDocs.
 */
export function applyCapitalGoodsExtraTax(db: DB, docs: readonly GstDoc[], from: string, to: string): GstDoc[] {
  const links = saleInvoices(db)
  const journalIds = Object.keys(links).map(Number)
  if (journalIds.length === 0) return [...docs]
  const lineStmt = db.prepare(
    `SELECT l.tax_type AS taxType, SUM(vl.amount) AS amount FROM voucher_lines vl JOIN ledgers l ON l.id = vl.ledger_id
      WHERE vl.voucher_id = ? AND vl.dr_cr = 'cr' AND l.tax_type IS NOT NULL GROUP BY l.tax_type`
  )
  const extraByInvoice = new Map<number, TaxHeads>()
  for (const jid of journalIds) {
    const v = db.prepare(`SELECT v.id FROM vouchers v WHERE v.id = ? AND ${NOT_DELETED} AND v.date BETWEEN ? AND ?`).get(jid, from, to)
    if (!v) continue
    const heads = { ...ZERO_TAX_HEADS }
    for (const r of lineStmt.all(jid) as { taxType: keyof TaxHeads; amount: number }[]) heads[r.taxType] += r.amount
    if (headsTotal(heads) > 0) extraByInvoice.set(links[String(jid)]!, heads)
  }
  if (extraByInvoice.size === 0) return [...docs]
  return docs.map((d) => {
    const extra = extraByInvoice.get(d.voucherId)
    if (!extra) return d
    const add = <T extends { cgst: number; sgst: number; igst: number; cess: number }>(x: T): T =>
      ({ ...x, cgst: x.cgst + extra.cgst, sgst: x.sgst + extra.sgst, igst: x.igst + extra.igst, cess: x.cess + extra.cess })
    // Onto the invoice's (one) rated line; a rate-less invoice (a free disposal) gets a 0-value line.
    const items = d.items.length > 0 ? d.items.map((it, i) => (i === 0 ? add(it) : it)) : [add({ rate: 0, taxable: 0, cgst: 0, sgst: 0, igst: 0, cess: 0 })]
    const hsnLines = d.hsnLines.map((h, i) => (i === 0 ? add(h) : h))
    return { ...d, items, hsnLines }
  })
}

/** Inside deleteVoucher's transaction: a GST disposal's tax invoice and journal go to the bin
 *  together (the journal clears the invoice's value; the invoice carries the sale the journal
 *  describes). Binning either bins the other. */
export function binFixedAssetPartner(db: DB, voucherId: number): void {
  const partner = fixedAssetPartnerOf(db, voucherId)
  if (partner == null || !db.prepare(`SELECT 1 FROM vouchers v WHERE v.id = ? AND ${NOT_DELETED}`).get(partner)) return
  const lock = getLockDate(db)
  const pv = db.prepare('SELECT date FROM vouchers WHERE id = ?').get(partner) as { date: string }
  if (lock && pv.date <= lock) throw new Error(`Books are locked up to ${lock} (the paired voucher is dated ${pv.date})`)
  // The paired tax invoice goes to the bin too — not while its e-invoice IRN is live.
  if (liveIrnOf(db, partner)) throw new AppError('irn_live', IRN_LIVE_BIN)
  const before = getVoucher(db, partner)
  db.prepare("UPDATE vouchers SET deleted_at = datetime('now') WHERE id = ?").run(partner)
  writeAudit(db, 'voucher', partner, 'delete', before, { pairedWith: voucherId })
}

/** Inside restoreVoucher's transaction: a restored GST disposal journal brings its tax invoice
 *  back with it (the invoice alone may be restored on its own — it is an ordinary sale). */
export function restoreFixedAssetPartners(db: DB, voucherId: number): void {
  const invoiceId = saleInvoiceOf(db, voucherId)
  if (invoiceId == null || db.prepare(`SELECT 1 FROM vouchers v WHERE v.id = ? AND ${NOT_DELETED}`).get(invoiceId)) return
  const lock = getLockDate(db)
  const before = getVoucher(db, invoiceId)
  if (!before) return
  if (lock && before.date <= lock) throw new Error(`Books are locked up to ${lock} (the tax invoice is dated ${before.date})`)
  db.prepare('UPDATE vouchers SET deleted_at = NULL WHERE id = ?').run(invoiceId)
  writeAudit(db, 'voucher', invoiceId, 'restore', before, { restored: true, pairedWith: voucherId })
}

/** The other half of a GST disposal pair: the journal's invoice, or the invoice's journal. */
function fixedAssetPartnerOf(db: DB, voucherId: number): number | null {
  const links = saleInvoices(db)
  const asJournal = links[String(voucherId)]
  if (asJournal != null) return asJournal
  const asInvoice = Object.entries(links).find(([, inv]) => inv === voucherId)
  return asInvoice ? Number(asInvoice[0]) : null
}

// ---------------------------------------------------------------------------------------------
// Partial disposal: split the part off as its own record (Sch II Note 2 — FIXED_ASSET_EVENT_SOURCES
// 'SCH2-N2'; block side IT61-S50 / IT25-S41: the part's moneys payable reduce the block)
// ---------------------------------------------------------------------------------------------

const partLabel = (p: DisposalPart): string => `${p.quantity} of ${p.of}`

class Rehearsed extends Error {}

/** Run `fn` in a transaction that is always rolled back (the WP 5.3 rehearsal pattern, kept local:
 *  this module is bundled into the check worker, which may not reach src/main/ai). */
function rolledBack<T>(db: DB, fn: () => T): T {
  let out: { v: T } | null = null
  try {
    db.transaction(() => {
      out = { v: fn() }
      throw new Rehearsed()
    })()
  } catch (e) {
    if (!(e instanceof Rehearsed)) throw e
  }
  return (out as { v: T } | null)!.v
}

/**
 * Splits `part` of an asset off into a new register record: the same share of the cost, of every
 * addition, of the opening accumulated depreciation and of EVERY depreciation line booked so far
 * (live or binned runs — so a restored run stays consistent), each rounded once, the remainder left
 * on the asset. Totals per run, per voucher and per ledger are unchanged; nothing is posted. The
 * new record copies the asset's group, ledgers, dates, life, method, residual %, IT block and
 * purchase voucher. Returns the new record's id. Audited: the asset's update (whole before /
 * after) and the part's create.
 */
function splitAsset(db: DB, a: AssetRec, part: DisposalPart, name: string): number {
  const cost = splitShare(a.row.cost_paise, part.quantity, part.of)
  if (cost.part <= 0 || cost.rest <= 0) throw new Error('This share of the cost rounds to nothing — give a larger part (or dispose of the whole asset)')
  const opening = splitShare(a.row.opening_acc_dep_paise, part.quantity, part.of)
  const before = getAsset(db, a.row.id, '9999-12-31')
  const r = a.row
  const partId = Number(db.prepare(
    `INSERT INTO fixed_assets (name, asset_group_id, ledger_id, purchase_voucher_id, purchase_date, put_to_use_date,
       cost_paise, residual_pct_bp, useful_life_months, method, basis_date, it_block_id, it_additional_eligible,
       location, identifier, acc_dep_ledger_id, opening_acc_dep_paise, opening_acc_dep_as_of, notes)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    name, r.asset_group_id, r.ledger_id, r.purchase_voucher_id, r.purchase_date, r.put_to_use_date, cost.part,
    r.residual_pct_bp, r.useful_life_months, r.method, r.basis_date, r.it_block_id, r.it_additional_eligible,
    r.location, r.identifier, r.acc_dep_ledger_id, opening.part, r.opening_acc_dep_as_of,
    `Part (${partLabel(part)}) split off ${r.name} (asset #${r.id})`
  ).lastInsertRowid)
  db.prepare('UPDATE fixed_assets SET cost_paise = ?, opening_acc_dep_paise = ? WHERE id = ?').run(cost.rest, opening.rest, r.id)

  for (const x of a.additions) {
    const s = splitShare(x.amountPaise, part.quantity, part.of)
    if (s.rest === 0) {
      db.prepare('UPDATE fixed_asset_additions SET asset_id = ? WHERE id = ?').run(partId, x.id)
      continue
    }
    if (s.part === 0) continue
    db.prepare('INSERT INTO fixed_asset_additions (asset_id, date, voucher_id, amount_paise, kind, note) VALUES (?, ?, ?, ?, ?, ?)')
      .run(partId, x.date, x.voucherId, s.part, x.kind, x.note)
    db.prepare('UPDATE fixed_asset_additions SET amount_paise = ? WHERE id = ?').run(s.rest, x.id)
  }

  // Every line of the asset, the part's line inserted even when its share is 0 so the part's
  // "depreciated through" date is the asset's (no period is ever charged twice).
  const lines = db.prepare('SELECT id, run_id, opening_wdv, depreciation, closing_wdv, days_used FROM depreciation_lines WHERE asset_id = ? ORDER BY id').all(r.id) as {
    id: number; run_id: number; opening_wdv: number; depreciation: number; closing_wdv: number; days_used: number
  }[]
  const ins = db.prepare('INSERT INTO depreciation_lines (run_id, asset_id, opening_wdv, depreciation, closing_wdv, days_used) VALUES (?, ?, ?, ?, ?, ?)')
  const upd = db.prepare('UPDATE depreciation_lines SET opening_wdv = ?, depreciation = ?, closing_wdv = ? WHERE id = ?')
  for (const l of lines) {
    const ow = splitShare(l.opening_wdv, part.quantity, part.of)
    const dep = splitShare(l.depreciation, part.quantity, part.of)
    const cw = splitShare(l.closing_wdv, part.quantity, part.of)
    ins.run(l.run_id, partId, ow.part, dep.part, cw.part, l.days_used)
    upd.run(ow.rest, dep.rest, cw.rest, l.id)
  }
  const after = getAsset(db, r.id, '9999-12-31')
  writeAudit(db, 'fixed_asset', r.id, 'update', before, { ...after, split: { part, partAssetId: partId } })
  writeAudit(db, 'fixed_asset', partId, 'create', null, { ...getAsset(db, partId, '9999-12-31'), splitFrom: { assetId: r.id, part } })
  return partId
}

/**
 * Component accounting (Schedule II Notes para 4 — FIXED_ASSET_EVENT_SOURCES 'SCH2-N4'): a part
 * whose cost is significant and whose useful life differs is split off as its own record with its
 * own life (and, optionally, residual % and method); the asset keeps the rest of the cost. Allowed
 * only while nothing is depreciated on the asset (no run, no opening accumulated depreciation) —
 * after that a change of life is the prospective change of estimate on the asset form. The new
 * record copies the asset's group, ledgers, dates, IT block and purchase voucher; additions stay on
 * the asset. Nothing is posted (both records sit on the same ledger). Audited: the asset's update
 * and the component's create.
 */
export function splitComponent(db: DB, raw: ComponentSplitInput): { asset: FixedAssetRow; component: FixedAssetRow } {
  const input = componentSplitSchema.parse(raw)
  const tx = db.transaction((): number => {
    const a = getAssetRec(db, input.assetId)
    const r = a.row
    if (a.disposed) throw new Error('This asset is disposed')
    if (a.lines.length > 0 || r.opening_acc_dep_paise > 0) {
      throw new Error('Depreciation is booked for this asset — split components before the first run (or bin the runs first)')
    }
    if (input.costPaise >= r.cost_paise) throw new Error('A component must cost less than the asset')
    const method = input.method ?? r.method
    const residualBp = input.residualBp ?? r.residual_pct_bp
    if (method === 'wdv' && residualBp <= 0) throw new Error('WDV needs a residual value above zero')
    const before = getAsset(db, r.id, '9999-12-31')
    const id = Number(db.prepare(
      `INSERT INTO fixed_assets (name, asset_group_id, ledger_id, purchase_voucher_id, purchase_date, put_to_use_date,
         cost_paise, residual_pct_bp, useful_life_months, method, basis_date, it_block_id, it_additional_eligible,
         location, identifier, acc_dep_ledger_id, opening_acc_dep_paise, opening_acc_dep_as_of, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, ?)`
    ).run(
      input.name, r.asset_group_id, r.ledger_id, r.purchase_voucher_id, r.purchase_date, r.put_to_use_date, input.costPaise,
      residualBp, input.lifeMonths, method, r.put_to_use_date, r.it_block_id, r.it_additional_eligible, r.location, r.identifier,
      r.acc_dep_ledger_id, `Component of ${r.name} (asset #${r.id}) with its own useful life — Schedule II Notes para 4`
    ).lastInsertRowid)
    db.prepare('UPDATE fixed_assets SET cost_paise = ? WHERE id = ?').run(r.cost_paise - input.costPaise, r.id)
    writeAudit(db, 'fixed_asset', r.id, 'update', before, { ...getAsset(db, r.id, '9999-12-31'), component: { assetId: id, costPaise: input.costPaise } })
    writeAudit(db, 'fixed_asset', id, 'create', null, { ...getAsset(db, id, '9999-12-31'), componentOf: r.id })
    return id
  })
  const componentId = tx()
  return { asset: getAsset(db, input.assetId, '9999-12-31'), component: getAsset(db, componentId, '9999-12-31') }
}

function partName(a: AssetRec, part: DisposalPart): string {
  return `${a.row.name} (part ${partLabel(part)})`
}

/** The cost (incl. additions before the date) the asset keeps after the part is split off. */
function remainingCostAfter(a: AssetRec, part: DisposalPart, date: string): number {
  return grossAtDisposal(a, date) - (splitShare(a.row.cost_paise, part.quantity, part.of).part +
    a.additions.filter((x) => x.date < date).reduce((s, x) => s + splitShare(x.amountPaise, part.quantity, part.of).part, 0))
}

export function previewDisposal(db: DB, raw: DisposalInput): DisposalPreview {
  const input = disposalInputSchema.parse(raw)
  if (!input.part) return computeDisposal(db, input).preview
  const part = input.part
  const a = getAssetRec(db, input.assetId)
  if (a.disposed) return { ...computeDisposal(db, input).preview, part, remainingCost: null }
  // Rehearse the split (always rolled back) and preview the part's disposal on it.
  try {
    return rolledBack(db, () => {
      const partId = splitAsset(db, a, part, partName(a, part))
      const p = computeDisposal(db, { ...input, assetId: partId }).preview
      return { ...p, assetId: input.assetId, part, remainingCost: remainingCostAfter(a, part, input.date) }
    })
  } catch (e) {
    return { ...computeDisposal(db, { ...input, part: null }).preview, blocked: (e as Error).message, part, remainingCost: null }
  }
}

export function disposeAsset(db: DB, raw: DisposalInput): {
  asset: FixedAssetRow; voucherId: number; preview: DisposalPreview; remaining: FixedAssetRow | null
  /** The tax invoice of a GST sale (null without GST). */
  invoiceVoucherId: number | null
} {
  const parsed = disposalInputSchema.parse(raw)
  let input = parsed
  const tx = db.transaction((): { voucherId: number; preview: DisposalPreview; invoiceVoucherId: number | null } => {
    if (parsed.part) {
      const whole = getAssetRec(db, parsed.assetId)
      const check = computeDisposal(db, { ...parsed, part: null })
      if (check.preview.blocked) throw new Error(check.preview.blocked)
      const partId = splitAsset(db, whole, parsed.part, partName(whole, parsed.part))
      input = { ...parsed, assetId: partId }
    }
    const first = computeDisposal(db, input)
    if (first.preview.blocked) throw new Error(first.preview.blocked)
    // Create whatever ledgers the journal needs, then recompute so every line has a real id.
    if (first.preview.accumulatedBooked > 0 || first.preview.catchUp > 0) ensureLedgers(db, first.a)
    if (first.preview.profit > 0) findOrCreateLedger(db, PROFIT_ON_SALE_LEDGER, 'Indirect Incomes')
    if (first.preview.profit < 0) findOrCreateLedger(db, LOSS_ON_SALE_LEDGER, 'Indirect Expenses')
    if (first.preview.gst) {
      const g = first.preview.gst
      if (g.taxableValue > 0) findOrCreateLedger(db, SALE_OF_ASSETS_LEDGER, 'Indirect Incomes')
      if (headsTotal(g.extraOutputTax) > 0) findOrCreateLedger(db, S186_LEDGER, 'Indirect Expenses')
      const need = { ...ZERO_TAX_HEADS }
      for (const k of TAX_KEYS) need[k] = g.working.taxOnValue[k] + g.extraOutputTax[k]
      ensureOutputTaxLedgers(db, need)
    }
    const { preview, a, catchUpPeriod, catchUpRow } = computeDisposal(db, input)
    const lines = preview.journal.map((l) => {
      if (l.ledgerId == null) throw new Error(`Ledger ${l.ledgerName} could not be resolved`)
      return { ledgerId: l.ledgerId, drCr: l.drCr, amount: l.amount, costAllocations: [] as [] }
    })
    const verb = input.kind === 'sale' ? 'Sale' : 'Scrap'
    const what = parsed.part ? `part (${partLabel(parsed.part)}) of fixed asset` : 'fixed asset'
    const assetName = parsed.part ? getAssetRec(db, parsed.assetId).row.name : a.row.name
    const describe = `${verb} of ${what} ${assetName}${a.row.identifier ? ` (${a.row.identifier})` : ''}`
    // GST: the tax invoice first (the sales series, the buyer as party) — GSTR-1 / 3B / e-invoice
    // read it like any ledger-line sale; the working goes in both narrations.
    let invoice: { id: number; number: string } | null = null
    if (preview.gst) {
      const g = preview.gst
      const invLines = g.invoice.map((l) => {
        if (l.ledgerId == null) throw new Error(`Ledger ${l.ledgerName} could not be resolved`)
        return { ledgerId: l.ledgerId, drCr: l.drCr, amount: l.amount, costAllocations: [] as [] }
      })
      const saved = saveVoucher(db, {
        voucherTypeId: salesTypeId(db),
        date: input.date,
        partyLedgerId: input.considerationLedgerId,
        narration: `${describe} — GST ${g.ratePercent}% on ₹${(g.taxableValue / 100).toFixed(2)}. ${g.workingText}`.slice(0, 1000),
        reference: null,
        lines: invLines,
        inventory: [],
        billRefs: [],
        tds: null
      })
      invoice = { id: saved.id, number: saved.number }
    }
    const voucher = saveVoucher(db, {
      voucherTypeId: journalTypeId(db),
      date: input.date,
      partyLedgerId: null,
      narration: (input.narration ?? (preview.gst ? `${describe} — tax invoice ${invoice!.number}. ${preview.gst.workingText}` : describe)).slice(0, 1000),
      reference: invoice ? `Invoice ${invoice.number}`.slice(0, 120) : null,
      lines,
      inventory: [],
      billRefs: [],
      tds: null
    })
    if (catchUpPeriod && catchUpRow && preview.catchUp > 0) {
      const runId = Number(db.prepare(
        "INSERT INTO depreciation_runs (fy_start_year, period_from, period_to, basis, voucher_id, asset_id) VALUES (?, ?, ?, 'companies_act', ?, ?)"
      ).run(fyOf(catchUpPeriod.from).startYear, catchUpPeriod.from, catchUpPeriod.to, voucher.id, a.row.id).lastInsertRowid)
      db.prepare('INSERT INTO depreciation_lines (run_id, asset_id, opening_wdv, depreciation, closing_wdv, days_used) VALUES (?, ?, ?, ?, ?, ?)')
        .run(runId, a.row.id, catchUpRow.openingWdv, preview.catchUp, catchUpRow.closingWdv, catchUpRow.daysUsed)
    }
    db.prepare(
      "UPDATE fixed_assets SET disposal_date = ?, disposal_voucher_id = ?, disposal_kind = ?, disposal_proceeds_paise = ?, status = 'disposed' WHERE id = ?"
    ).run(input.date, voucher.id, input.kind, input.proceedsPaise, a.row.id)
    if (invoice) linkSaleInvoice(db, voucher.id, invoice.id)
    const out = { voucherId: voucher.id, preview, invoiceVoucherId: invoice?.id ?? null }
    // Audited inside the transaction: the disposal is recorded with the books it changed.
    writeAudit(db, 'fixed_asset', input.assetId, 'update', null, {
      disposal: { ...input, part: parsed.part, voucherId: voucher.id, invoiceVoucherId: invoice?.id ?? null, gstWorking: preview.gst?.working ?? null }
    })
    return out
  })
  const { voucherId, preview, invoiceVoucherId } = tx()
  const asset = getAsset(db, input.assetId, '9999-12-31')
  const remaining = parsed.part ? getAsset(db, parsed.assetId, '9999-12-31') : null
  const shaped: DisposalPreview = parsed.part
    ? { ...preview, assetId: parsed.assetId, part: parsed.part, remainingCost: remaining ? remaining.costPaise + remaining.additions.filter((x) => x.date < parsed.date).reduce((s, x) => s + x.amountPaise, 0) : null }
    : preview
  return { asset, voucherId, preview: shaped, remaining, invoiceVoucherId }
}

// ---------------------------------------------------------------------------------------------
// Voucher guards (called from services/vouchers.ts)
// ---------------------------------------------------------------------------------------------

export const FIXED_ASSET_VOUCHER_EDIT =
  'This journal was posted by Fixed assets (a depreciation run or a disposal) — move it to the bin and post it again from Fixed assets'

/** A depreciation / disposal journal is owned by its run: an edit would leave the register's
 *  depreciation lines out of step with the books. */
export function assertNotFixedAssetVoucher(db: DB, voucherId: number): void {
  const owned = db.prepare(
    'SELECT 1 FROM depreciation_runs WHERE voucher_id = ? UNION SELECT 1 FROM fixed_assets WHERE disposal_voucher_id = ? LIMIT 1'
  ).get(voucherId, voucherId)
  if (owned) throw new Error(FIXED_ASSET_VOUCHER_EDIT)
  // The tax invoice of a GST disposal: its value is cleared by the disposal journal.
  if (Object.values(saleInvoices(db)).includes(voucherId)) {
    throw new Error('This tax invoice was posted by a fixed-asset disposal — bin it (the disposal journal goes with it) and dispose of the asset again')
  }
}

/** Restoring a binned depreciation journal must not double-charge a period that has since been
 *  re-run; restoring a disposal journal must not resurrect a disposal the asset no longer has. */
export function assertFixedAssetVoucherRestorable(db: DB, voucherId: number): void {
  const run = db.prepare('SELECT period_from AS "from", period_to AS "to", asset_id FROM depreciation_runs WHERE voucher_id = ? AND asset_id IS NULL')
    .get(voucherId) as { from: string; to: string } | undefined
  if (run) {
    const clash = db.prepare(
      `SELECT r.period_from AS "from", r.period_to AS "to" FROM depreciation_runs r JOIN vouchers v ON v.id = r.voucher_id
        WHERE ${NOT_DELETED} AND r.asset_id IS NULL AND r.voucher_id <> ? AND r.period_from <= ? AND r.period_to >= ? LIMIT 1`
    ).get(voucherId, run.to, run.from) as { from: string; to: string } | undefined
    if (clash) throw new Error(`Depreciation for ${fmtDate(clash.from)} to ${fmtDate(clash.to)} has been posted again since — bin that run to restore this one`)
  }
  // A GST disposal's journal comes back with its tax invoice (restoreFixedAssetPartners) — the
  // invoice must still exist (not purged).
  const invoiceId = saleInvoiceOf(db, voucherId)
  if (invoiceId != null && !db.prepare('SELECT 1 FROM vouchers WHERE id = ?').get(invoiceId)) {
    throw new Error('The sale\'s tax invoice was purged — dispose of the asset again instead')
  }
  const disposalOf = db.prepare('SELECT id FROM depreciation_runs WHERE voucher_id = ? AND asset_id IS NOT NULL').get(voucherId)
  const asset = db.prepare('SELECT id, disposal_voucher_id FROM fixed_assets WHERE disposal_voucher_id = ?').get(voucherId)
  if (disposalOf && !asset) throw new Error('This disposal no longer belongs to its asset — dispose of the asset again instead')
}

// ---------------------------------------------------------------------------------------------
// Asset schedule (Schedule III note) + reconciliation to the ledgers
// ---------------------------------------------------------------------------------------------

export function assetSchedule(db: DB, from: string, to: string): AssetSchedule {
  if (to < from) throw new Error('The period ends before it starts')
  const dayBefore = addDays(from, -1)
  const assets = loadAssets(db)
  const assetRows: ScheduleAssetRow[] = []
  for (const a of assets) {
    const d = disposalDateOf(a)
    const disposedBefore = !!d && d < from
    const disposedIn = !!d && d >= from && d <= to
    if (disposedBefore) continue
    const grossOpening = grossOn(a, dayBefore)
    const grossClosingRaw = grossOn({ ...a, disposed: false }, to)
    const grossAdditions = grossClosingRaw - grossOpening
    const accOpening = accOn(a, dayBefore)
    const accAtTo = accOn(a, to)
    const accCharge = accAtTo - accOpening
    const grossDisposals = disposedIn ? grossAtDisposal(a, d!) : 0
    const accDisposals = disposedIn ? accTotal(a) : 0
    if (grossOpening === 0 && grossAdditions === 0 && accOpening === 0 && accCharge === 0) continue
    const t = scheduleTotals([{ grossOpening, grossAdditions, grossDisposals, accOpening, accCharge, accDisposals }])
    assetRows.push({ assetId: a.row.id, assetName: a.row.name, groupId: a.group.id, ...t })
  }
  const groups = new Map<number, { name: string; rows: ScheduleAssetRow[] }>()
  for (const a of assets) if (!groups.has(a.group.id)) groups.set(a.group.id, { name: a.group.name, rows: [] })
  for (const r of assetRows) groups.get(r.groupId)!.rows.push(r)
  const groupRows: ScheduleGroupRow[] = [...groups.entries()]
    .filter(([, g]) => g.rows.length > 0)
    .map(([groupId, g]) => ({ groupId, groupName: g.name, assetCount: g.rows.length, ...scheduleTotals(g.rows) }))
    .sort((x, y) => x.groupName.localeCompare(y.groupName))

  // Reconciliation: register figures vs ledger closing balances on `to` (computed at query time).
  const balances = closingBalances(db, to)
  const names = ledgerNames(db)
  const recon = new Map<string, ScheduleReconRow>()
  const add = (ledgerId: number, role: ScheduleReconRow['role'], register: number): void => {
    const key = `${role}:${ledgerId}`
    const bal = balances.get(ledgerId) ?? 0
    const row = recon.get(key) ?? {
      ledgerId, ledgerName: names.get(ledgerId) ?? '', role, register: 0,
      ledger: role === 'asset' ? bal : 0 - bal, difference: 0
    }
    row.register += register
    recon.set(key, row)
  }
  for (const a of assets) {
    const d = disposalDateOf(a)
    const gone = !!d && d <= to
    add(a.row.ledger_id, 'asset', gone ? 0 : grossOn(a, to))
    const accId = a.row.acc_dep_ledger_id ?? a.group.acc_dep_ledger_id
    if (accId != null) add(accId, 'accumulated_depreciation', gone ? 0 : accOn(a, to))
  }
  for (const g of db.prepare('SELECT acc_dep_ledger_id AS id FROM fixed_asset_groups WHERE acc_dep_ledger_id IS NOT NULL').all() as { id: number }[]) {
    add(g.id, 'accumulated_depreciation', 0)
  }
  const reconciliation = [...recon.values()]
    .map((r) => ({ ...r, difference: r.ledger - r.register }))
    .sort((x, y) => (x.role === y.role ? x.ledgerName.localeCompare(y.ledgerName) : x.role === 'asset' ? -1 : 1))
  return { from, to, groups: groupRows, assets: assetRows, totals: scheduleTotals(assetRows), reconciliation }
}

// ---------------------------------------------------------------------------------------------
// Income-tax statement (block of assets) — computation only
// ---------------------------------------------------------------------------------------------

function rateFor(rates: ItBlockRateRow[], fyFrom: string): ItBlockRateRow | null {
  return [...rates]
    .filter((r) => r.effectiveFrom <= fyFrom && (r.effectiveTo == null || r.effectiveTo >= fyFrom))
    .sort((a, b) => b.effectiveFrom.localeCompare(a.effectiveFrom))[0] ?? null
}

/** Income-tax Rules, 2026 rule 25(2): normal depreciation of a block "shall not exceed 40% of the
 *  written down value" for the persons and regimes in its Table (FIXED_ASSET_EVENT_SOURCES R2026-R25-2). */
export const RULE_25_2_CAP_BP = 4000

/** The rate and additional rate a year computes with: the block's own, or — for a rule 25(2)
 *  regime in a 2025-Act year — capped at 40% with no additional depreciation (s.202(2)(a)(vi) /
 *  s.205(1)(a): total income without the deduction under s.33(8)). */
export function itRateFor(rate: ItBlockRateRow | null, concessional: boolean): { rateBp: number; additionalRateBp: number; cappedFromBp: number | null; additionalDisallowed: boolean } {
  const rateBp = rate?.rateBp ?? 0
  const additionalRateBp = rate?.additionalRateBp ?? 0
  if (!concessional || rate?.act !== '2025') return { rateBp, additionalRateBp, cappedFromBp: null, additionalDisallowed: false }
  return {
    rateBp: Math.min(rateBp, RULE_25_2_CAP_BP),
    additionalRateBp: 0,
    cappedFromBp: rateBp > RULE_25_2_CAP_BP ? rateBp : null,
    additionalDisallowed: true
  }
}

export function itStatement(db: DB, fyStartYear: number, opts: { concessionalRegime?: boolean } = {}): ItStatement {
  const concessional = !!opts.concessionalRegime
  const blocks = listBlocks(db)
  const assets = loadAssets(db)
  const rows: ItStatementBlockRow[] = []
  for (const b of blocks) {
    const inBlock = assets.filter((a) => a.row.it_block_id === b.id)
    const firstYear = Math.min(
      fyStartYear,
      ...b.openings.map((o) => o.fyStartYear),
      ...inBlock.map((a) => fyOf(a.row.put_to_use_date).startYear)
    )
    let carried: { wdv: number; addl: number } | null = null
    let result: ItStatementBlockRow | null = null
    for (let y = firstYear; y <= fyStartYear; y++) {
      const fy = fyFromStartYear(y)
      const entered = b.openings.find((o) => o.fyStartYear === y)
      const openingSource: ItStatementBlockRow['openingSource'] = entered ? 'entered' : carried ? 'carried' : 'none'
      const openingWdv = entered ? entered.openingWdv : carried?.wdv ?? 0
      const addlBf = entered ? entered.additionalBroughtForward : carried?.addl ?? 0
      const rate = rateFor(b.rates, fy.from)
      const eff = itRateFor(rate, concessional)
      const additions = [
        ...inBlock
          .filter((a) => a.row.put_to_use_date >= fy.from && a.row.put_to_use_date <= fy.to)
          .map((a) => ({ putToUseDate: a.row.put_to_use_date, amount: a.row.cost_paise, additionalEligible: !!a.row.it_additional_eligible })),
        ...inBlock.flatMap((a) => a.additions.filter((x) => x.date >= fy.from && x.date <= fy.to).map((x) => ({ putToUseDate: x.date, amount: x.amountPaise })))
      ]
      const sold = inBlock.filter((a) => a.disposed && a.row.disposal_date! >= fy.from && a.row.disposal_date! <= fy.to)
      const remaining = inBlock.filter((a) => a.row.put_to_use_date <= fy.to && !(a.disposed && a.row.disposal_date! <= fy.to))
      const r = itBlockYear({
        fy, rateBp: eff.rateBp, openingWdv, additions,
        saleProceeds: sold.reduce((s, a) => s + (a.row.disposal_proceeds_paise ?? 0), 0),
        blockCeases: sold.length > 0 && remaining.length === 0,
        additionalRateBp: eff.additionalRateBp,
        additionalBroughtForward: eff.additionalDisallowed ? 0 : addlBf
      })
      carried = { wdv: r.closingWdv, addl: r.additionalCarriedForward }
      result = {
        ...r, blockId: b.id, blockCode: b.code, blockName: b.name, rateBp: eff.rateBp,
        additionalRateBp: eff.additionalRateBp, act: rate?.act ?? null, sectionRef: rate?.sectionRef ?? '',
        rateSource: rate?.source ?? '', openingSource, assetCount: remaining.length,
        cappedFromBp: eff.cappedFromBp, additionalDisallowed: eff.additionalDisallowed
      }
    }
    if (result && (result.openingWdv !== 0 || result.wdvBeforeDepreciation !== 0 || result.saleProceeds !== 0 || result.assetCount > 0)) rows.push(result)
  }
  return {
    fyStartYear,
    concessionalRegime: concessional,
    blocks: rows,
    unassignedAssets: assets.filter((a) => a.row.it_block_id == null).map((a) => ({ assetId: a.row.id, name: a.row.name }))
  }
}

// ---------------------------------------------------------------------------------------------
// Year-end check
// ---------------------------------------------------------------------------------------------

/** Has book depreciation been run up to 31 March for every asset in service in the FY? */
export function yearStatus(db: DB, fyStartYear: number): DepreciationYearStatus {
  const fy = fyFromStartYear(fyStartYear)
  const inService = loadAssets(db).filter((a) => {
    if (a.row.put_to_use_date > fy.to) return false
    const d = disposalDateOf(a)
    if (d && d <= fy.from) return false
    // Fully written down before the year began: nothing to charge.
    const lifeEnd = lifeEndDate(a.row.put_to_use_date, a.row.useful_life_months)
    return lifeEnd >= fy.from
  })
  const covered = db.prepare(
    `SELECT MAX(r.period_to) AS t FROM depreciation_runs r JOIN vouchers v ON v.id = r.voucher_id
      WHERE ${NOT_DELETED} AND r.asset_id IS NULL AND r.basis = 'companies_act' AND r.period_to BETWEEN ? AND ?`
  ).get(fy.from, fy.to) as { t: string | null }
  // Assets disposed during the year are covered by their disposal's catch-up.
  const needsRun = inService.some((a) => !disposalDateOf(a))
  return {
    fyStartYear,
    assetsInService: inService.length,
    coveredThrough: covered.t,
    missing: needsRun && covered.t !== fy.to
  }
}
