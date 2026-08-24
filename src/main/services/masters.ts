import type { DB } from '../db/connection'
import type { Batch, Godown, Group, Ledger, StockGroup, StockItem, Unit, VoucherType } from '@shared/domain'
import { ledgerInputSchema } from '@shared/schemas'
import type { BatchInput, GroupInput, GodownInput, LedgerInput, StockGroupInput, StockItemInput, UnitInput, VoucherTypeInput } from '@shared/schemas'
import type { GroupTreeNode, LedgerBalanceRow } from '@shared/reports'
import { CASH_BANK_GROUPS } from '@shared/seed'
import { writeAudit } from './audit'

// ---------- row mappers ----------

interface GroupRow {
  id: number; name: string; parent_id: number | null; nature: Group['nature']
  affects_gross_profit: number; is_system: number
}
const mapGroup = (r: GroupRow): Group => ({
  id: r.id, name: r.name, parentId: r.parent_id, nature: r.nature,
  affectsGrossProfit: !!r.affects_gross_profit, isSystem: !!r.is_system
})

interface LedgerRow {
  id: number; name: string; group_id: number; opening_balance: number
  gstin: string | null; state_code: string | null; address: string | null
  tax_type: Ledger['taxType']; gst_rate: number | null; hsn: string | null; is_system: number
  tds_section_id: number | null; pan: string | null; credit_days: number | null; export_type: Ledger['exportType']
  rcm: number; itc_eligibility: Ledger['itcEligibility'] | null
  price_level_id: number | null; credit_limit: number | null; default_cost_centre_id: number | null
  interest_rate_bp: number | null; interest_grace_days: number | null
  msme_status: 'micro' | 'small' | 'medium' | 'not_registered' | null; udyam_number: string | null
  related_party: number; relationship: string | null
  salesperson: string | null; territory: string | null
  phone: string | null; email: string | null
  bank_account: string | null; bank_ifsc: string | null; bank_holder: string | null; bank_shared_ok: number
}
const mapLedger = (r: LedgerRow): Ledger => ({
  id: r.id, name: r.name, groupId: r.group_id, openingBalance: r.opening_balance,
  gstin: r.gstin, stateCode: r.state_code, address: r.address,
  taxType: r.tax_type, gstRate: r.gst_rate, hsn: r.hsn, isSystem: !!r.is_system,
  tdsSectionId: r.tds_section_id, pan: r.pan, creditDays: r.credit_days, exportType: r.export_type,
  rcm: !!r.rcm, itcEligibility: r.itc_eligibility ?? 'eligible',
  priceLevelId: r.price_level_id, creditLimit: r.credit_limit,
  defaultCostCentreId: r.default_cost_centre_id,
  interestRateBp: r.interest_rate_bp, interestGraceDays: r.interest_grace_days,
  msmeStatus: r.msme_status, udyamNumber: r.udyam_number,
  relatedParty: !!r.related_party, relationship: r.relationship,
  salesperson: r.salesperson, territory: r.territory,
  phone: r.phone, email: r.email,
  bankAccount: r.bank_account, bankIfsc: r.bank_ifsc, bankHolder: r.bank_holder,
  bankSharedOk: !!r.bank_shared_ok
})

// ---------- groups ----------

export function listGroups(db: DB): Group[] {
  return (db.prepare('SELECT * FROM groups ORDER BY name').all() as GroupRow[]).map(mapGroup)
}

export function groupTree(db: DB): GroupTreeNode[] {
  const groups = listGroups(db)
  const nodes = new Map<number, GroupTreeNode>()
  for (const g of groups) {
    nodes.set(g.id, { id: g.id, name: g.name, parentId: g.parentId, nature: g.nature, isSystem: g.isSystem, children: [] })
  }
  const roots: GroupTreeNode[] = []
  for (const n of nodes.values()) {
    if (n.parentId && nodes.has(n.parentId)) nodes.get(n.parentId)!.children.push(n)
    else roots.push(n)
  }
  const sortRec = (list: GroupTreeNode[]): void => {
    list.sort((a, b) => a.name.localeCompare(b.name))
    list.forEach((n) => sortRec(n.children))
  }
  sortRec(roots)
  return roots
}

export function createGroup(db: DB, input: GroupInput): Group {
  const parent = db.prepare('SELECT * FROM groups WHERE id = ?').get(input.parentId) as GroupRow | undefined
  if (!parent) throw new Error('Parent group not found')
  const res = db
    .prepare('INSERT INTO groups (name, parent_id, nature, affects_gross_profit, is_system) VALUES (?, ?, ?, ?, 0)')
    .run(input.name, input.parentId, parent.nature, parent.affects_gross_profit)
  const created = mapGroup(db.prepare('SELECT * FROM groups WHERE id = ?').get(res.lastInsertRowid) as GroupRow)
  writeAudit(db, 'group', created.id, 'create', null, created)
  return created
}

export function updateGroup(db: DB, id: number, input: GroupInput): Group {
  const existing = db.prepare('SELECT * FROM groups WHERE id = ?').get(id) as GroupRow | undefined
  if (!existing) throw new Error('Group not found')
  if (existing.is_system) throw new Error('Default groups cannot be edited')
  if (descendantIds(db, [id]).has(input.parentId)) throw new Error('A group cannot be moved under itself')
  const parent = db.prepare('SELECT * FROM groups WHERE id = ?').get(input.parentId) as GroupRow | undefined
  if (!parent) throw new Error('Parent group not found')
  db.prepare('UPDATE groups SET name = ?, parent_id = ?, nature = ?, affects_gross_profit = ? WHERE id = ?')
    .run(input.name, input.parentId, parent.nature, parent.affects_gross_profit, id)
  const updated = mapGroup(db.prepare('SELECT * FROM groups WHERE id = ?').get(id) as GroupRow)
  writeAudit(db, 'group', id, 'update', mapGroup(existing), updated)
  return updated
}

export function deleteGroup(db: DB, id: number): void {
  const existing = db.prepare('SELECT * FROM groups WHERE id = ?').get(id) as GroupRow | undefined
  if (!existing) throw new Error('Group not found')
  if (existing.is_system) throw new Error('Default groups cannot be deleted')
  const childCount = db.prepare('SELECT COUNT(*) AS n FROM groups WHERE parent_id = ?').get(id) as { n: number }
  const ledgerCount = db.prepare('SELECT COUNT(*) AS n FROM ledgers WHERE group_id = ?').get(id) as { n: number }
  if (childCount.n > 0 || ledgerCount.n > 0) throw new Error('Group is in use')
  db.prepare('DELETE FROM groups WHERE id = ?').run(id)
  writeAudit(db, 'group', id, 'delete', mapGroup(existing), null)
}

/** All ids in the subtrees rooted at the given group ids (inclusive). */
export function descendantIds(db: DB, rootIds: number[]): Set<number> {
  const groups = db.prepare('SELECT id, parent_id FROM groups').all() as { id: number; parent_id: number | null }[]
  const children = new Map<number | null, number[]>()
  for (const g of groups) {
    const list = children.get(g.parent_id) ?? []
    list.push(g.id)
    children.set(g.parent_id, list)
  }
  const result = new Set<number>()
  const stack = [...rootIds]
  while (stack.length) {
    const id = stack.pop()!
    if (result.has(id)) continue
    result.add(id)
    for (const c of children.get(id) ?? []) stack.push(c)
  }
  return result
}

export function descendantIdsByName(db: DB, names: string[]): Set<number> {
  const placeholders = names.map(() => '?').join(',')
  const roots = db.prepare(`SELECT id FROM groups WHERE name IN (${placeholders})`).all(...names) as { id: number }[]
  return descendantIds(db, roots.map((r) => r.id))
}

export function cashBankGroupIds(db: DB): Set<number> {
  return descendantIdsByName(db, CASH_BANK_GROUPS)
}

/** Find a ledger by name (case-insensitive), creating it under `groupName` if it doesn't exist yet.
 *  Used by services that auto-book system ledgers (e.g. payroll's Salaries/PF Payable/...). */
export function findOrCreateLedger(db: DB, name: string, groupName: string): number {
  const existing = db.prepare('SELECT id FROM ledgers WHERE name = ? COLLATE NOCASE').get(name) as { id: number } | undefined
  if (existing) return existing.id
  const group = db.prepare('SELECT id FROM groups WHERE name = ?').get(groupName) as { id: number } | undefined
  if (!group) throw new Error(`Group ${groupName} missing`)
  const res = db.prepare('INSERT INTO ledgers (name, group_id, is_system) VALUES (?, ?, 0)').run(name, group.id)
  return Number(res.lastInsertRowid)
}

// ---------- ledgers ----------

export function listLedgers(db: DB): Ledger[] {
  return (db.prepare('SELECT * FROM ledgers ORDER BY name').all() as LedgerRow[]).map(mapLedger)
}

export function getLedger(db: DB, id: number): Ledger | null {
  const row = db.prepare('SELECT * FROM ledgers WHERE id = ?').get(id) as LedgerRow | undefined
  return row ? mapLedger(row) : null
}

export function createLedger(db: DB, raw: LedgerInput): Ledger {
  // Parse here (not just at the IPC boundary) so direct service callers — tests, importers,
  // the Tally import — get defaults for later-added fields (rcm/itcEligibility) applied too.
  const input = ledgerInputSchema.parse(raw)
  const res = db
    .prepare(
      `INSERT INTO ledgers (name, group_id, opening_balance, gstin, state_code, address, tax_type, gst_rate, hsn,
        tds_section_id, pan, credit_days, export_type, rcm, itc_eligibility, price_level_id, credit_limit,
        interest_rate_bp, interest_grace_days, msme_status, udyam_number, related_party, relationship,
        salesperson, territory, phone, email, default_cost_centre_id,
        bank_account, bank_ifsc, bank_holder, bank_shared_ok, is_system)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`
    )
    .run(input.name, input.groupId, input.openingBalance, input.gstin, input.stateCode, input.address,
      input.taxType, input.gstRate, input.hsn, input.tdsSectionId, input.pan, input.creditDays, input.exportType,
      input.rcm ? 1 : 0, input.itcEligibility,
      input.priceLevelId ?? null, input.creditLimit ?? null,
      input.interestRateBp ?? null, input.interestGraceDays ?? null,
      input.msmeStatus ?? null, input.udyamNumber ?? null,
      input.relatedParty ? 1 : 0, input.relationship ?? null,
      input.salesperson ?? null, input.territory ?? null,
      input.phone ?? null, input.email ?? null, input.defaultCostCentreId ?? null,
      input.bankAccount ?? null, input.bankIfsc ?? null, input.bankHolder ?? null,
      input.bankSharedOk ? 1 : 0)
  const created = getLedger(db, Number(res.lastInsertRowid))!
  writeAudit(db, 'ledger', created.id, 'create', null, created)
  return created
}

export function updateLedger(db: DB, id: number, raw: LedgerInput): Ledger {
  const input = ledgerInputSchema.parse(raw)
  const existing = getLedger(db, id)
  if (!existing) throw new Error('Ledger not found')
  db.prepare(
    `UPDATE ledgers SET name = ?, group_id = ?, opening_balance = ?, gstin = ?, state_code = ?,
     address = ?, tax_type = ?, gst_rate = ?, hsn = ?, tds_section_id = ?, pan = ?, credit_days = ?, export_type = ?,
     rcm = ?, itc_eligibility = ?, price_level_id = ?, credit_limit = ?,
     interest_rate_bp = ?, interest_grace_days = ?, msme_status = ?, udyam_number = ?,
     related_party = ?, relationship = ?, salesperson = ?, territory = ?, phone = ?, email = ?,
     default_cost_centre_id = ?, bank_account = ?, bank_ifsc = ?, bank_holder = ?, bank_shared_ok = ?
     WHERE id = ?`
  ).run(input.name, input.groupId, input.openingBalance, input.gstin, input.stateCode, input.address,
    input.taxType, input.gstRate, input.hsn, input.tdsSectionId, input.pan, input.creditDays, input.exportType,
    input.rcm ? 1 : 0, input.itcEligibility,
    input.priceLevelId === undefined ? existing.priceLevelId : input.priceLevelId,
    input.creditLimit === undefined ? existing.creditLimit : input.creditLimit,
    input.interestRateBp === undefined ? existing.interestRateBp : input.interestRateBp,
    input.interestGraceDays === undefined ? existing.interestGraceDays : input.interestGraceDays,
    input.msmeStatus === undefined ? existing.msmeStatus : (input.msmeStatus ?? null),
    input.udyamNumber === undefined ? existing.udyamNumber : (input.udyamNumber ?? null),
    (input.relatedParty === undefined ? existing.relatedParty : input.relatedParty) ? 1 : 0,
    input.relationship === undefined ? existing.relationship : (input.relationship ?? null),
    input.salesperson === undefined ? existing.salesperson : (input.salesperson ?? null),
    input.territory === undefined ? existing.territory : (input.territory ?? null),
    input.phone === undefined ? existing.phone : (input.phone ?? null),
    input.email === undefined ? existing.email : (input.email ?? null),
    input.defaultCostCentreId === undefined ? existing.defaultCostCentreId : (input.defaultCostCentreId ?? null),
    // Bank details absent from the input leave the master alone. Every caller that does not deal
    // in bank details (the CSV importer, the Tally import, a party edited from the invoice
    // screen) therefore cannot clear them by omission, and the two-person rule above this
    // function is never bypassed by a form that simply did not carry the fields.
    input.bankAccount === undefined ? existing.bankAccount : (input.bankAccount ?? null),
    input.bankIfsc === undefined ? existing.bankIfsc : (input.bankIfsc ?? null),
    input.bankHolder === undefined ? existing.bankHolder : (input.bankHolder ?? null),
    (input.bankSharedOk === undefined ? existing.bankSharedOk : input.bankSharedOk) ? 1 : 0,
    id)
  const updated = getLedger(db, id)!
  writeAudit(db, 'ledger', id, 'update', existing, updated)
  return updated
}

export function deleteLedger(db: DB, id: number): void {
  const existing = getLedger(db, id)
  if (!existing) throw new Error('Ledger not found')
  if (existing.isSystem) throw new Error('System ledgers cannot be deleted')
  const used = db.prepare('SELECT COUNT(*) AS n FROM voucher_lines WHERE ledger_id = ?').get(id) as { n: number }
  if (used.n > 0) throw new Error('Ledger has vouchers; delete those first')
  db.prepare('DELETE FROM ledgers WHERE id = ?').run(id)
  writeAudit(db, 'ledger', id, 'delete', existing, null)
}

/** Closing balances (opening + movements up to `asOn` inclusive), only non-zero unless includeZero. */
export function ledgerBalances(db: DB, asOn: string, includeZero = false): LedgerBalanceRow[] {
  const rows = db
    .prepare(
      `SELECT l.id AS ledgerId, l.name, l.group_id AS groupId, g.name AS groupName,
              l.opening_balance + COALESCE(m.movement, 0) AS balance
       FROM ledgers l
       JOIN groups g ON g.id = l.group_id
       LEFT JOIN (
         SELECT vl.ledger_id, SUM(CASE WHEN vl.dr_cr = 'dr' THEN vl.amount ELSE -vl.amount END) AS movement
         FROM voucher_lines vl JOIN vouchers v ON v.id = vl.voucher_id
         WHERE v.date <= ? AND v.deleted_at IS NULL
         GROUP BY vl.ledger_id
       ) m ON m.ledger_id = l.id
       ORDER BY l.name`
    )
    .all(asOn) as LedgerBalanceRow[]
  return includeZero ? rows : rows.filter((r) => r.balance !== 0)
}

// ---------- voucher types ----------

interface VtRow {
  id: number; name: string; kind: VoucherType['kind']; numbering: 'auto' | 'manual'; prefix: string
  suffix: string; pad_width: number; restart_fy: number; is_system: number
}
const mapVt = (r: VtRow): VoucherType => ({
  id: r.id, name: r.name, kind: r.kind, numbering: r.numbering, prefix: r.prefix,
  suffix: r.suffix, padWidth: r.pad_width, restartFy: !!r.restart_fy, isSystem: !!r.is_system
})

export function listVoucherTypes(db: DB): VoucherType[] {
  return (db.prepare('SELECT * FROM voucher_types ORDER BY id').all() as VtRow[]).map(mapVt)
}

export function createVoucherType(db: DB, input: VoucherTypeInput): VoucherType {
  const res = db
    .prepare('INSERT INTO voucher_types (name, kind, numbering, prefix, suffix, pad_width, restart_fy, is_system) VALUES (?, ?, ?, ?, ?, ?, ?, 0)')
    .run(input.name, input.kind, input.numbering, input.prefix, input.suffix, input.padWidth, input.restartFy ? 1 : 0)
  const created = mapVt(db.prepare('SELECT * FROM voucher_types WHERE id = ?').get(res.lastInsertRowid) as VtRow)
  writeAudit(db, 'voucherType', created.id, 'create', null, created)
  return created
}

export function updateVoucherType(db: DB, id: number, input: VoucherTypeInput): VoucherType {
  const existing = db.prepare('SELECT * FROM voucher_types WHERE id = ?').get(id) as VtRow | undefined
  if (!existing) throw new Error('Voucher type not found')
  const kind = existing.is_system ? existing.kind : input.kind
  db.prepare('UPDATE voucher_types SET name = ?, kind = ?, numbering = ?, prefix = ?, suffix = ?, pad_width = ?, restart_fy = ? WHERE id = ?')
    .run(existing.is_system ? existing.name : input.name, kind, input.numbering, input.prefix, input.suffix, input.padWidth, input.restartFy ? 1 : 0, id)
  const updated = mapVt(db.prepare('SELECT * FROM voucher_types WHERE id = ?').get(id) as VtRow)
  writeAudit(db, 'voucherType', id, 'update', mapVt(existing), updated)
  return updated
}

// ---------- inventory masters ----------

interface UnitRow { id: number; name: string; symbol: string; decimals: number; uqc: string }
const mapUnit = (r: UnitRow): Unit => ({ ...r })

export function listUnits(db: DB): Unit[] {
  return (db.prepare('SELECT * FROM units ORDER BY name').all() as UnitRow[]).map(mapUnit)
}

export function createUnit(db: DB, input: UnitInput): Unit {
  const res = db.prepare('INSERT INTO units (name, symbol, decimals, uqc) VALUES (?, ?, ?, ?)')
    .run(input.name, input.symbol, input.decimals, input.uqc)
  const created = mapUnit(db.prepare('SELECT * FROM units WHERE id = ?').get(res.lastInsertRowid) as UnitRow)
  writeAudit(db, 'unit', created.id, 'create', null, created)
  return created
}

interface StockGroupRow {
  id: number; name: string; parent_id: number | null
  gst_rate: number | null; cess_rate: number | null; hsn: string | null
}
const mapStockGroup = (r: StockGroupRow): StockGroup => ({
  id: r.id, name: r.name, parentId: r.parent_id,
  gstRate: r.gst_rate, cessRate: r.cess_rate, hsn: r.hsn
})

export function listStockGroups(db: DB): StockGroup[] {
  return (db.prepare('SELECT * FROM stock_groups ORDER BY name').all() as StockGroupRow[]).map(mapStockGroup)
}

export function createStockGroup(db: DB, input: StockGroupInput): StockGroup {
  const res = db
    .prepare('INSERT INTO stock_groups (name, parent_id, gst_rate, cess_rate, hsn) VALUES (?, ?, ?, ?, ?)')
    .run(input.name, input.parentId, input.gstRate ?? null, input.cessRate ?? null, input.hsn ?? null)
  const r = db.prepare('SELECT * FROM stock_groups WHERE id = ?').get(res.lastInsertRowid) as StockGroupRow
  const created = mapStockGroup(r)
  writeAudit(db, 'stockGroup', created.id, 'create', null, created)
  return created
}

/** An empty code must become NULL: the unique index treats '' as a value, so two items with a
 *  cleared code would collide on it. */
const normaliseCode = (code: string | null | undefined): string | null => (code?.trim() ? code.trim() : null)

/**
 * An alternate unit is only meaningful with a conversion, and a conversion only with a unit.
 * Half of the pair silently stored would make `toBase` a no-op that looks like it worked, so
 * either both are written or neither is.
 */
function altColumns(input: StockItemInput): [number | null, number | null] {
  const unit = input.altUnitId ?? null
  const conversion = input.altConversionMilli ?? null
  if (unit === null || conversion === null || conversion <= 0) return [null, null]
  return [unit, conversion]
}

interface StockItemRow {
  id: number; name: string; group_id: number | null; unit_id: number; hsn: string | null
  gst_rate: number | null; cess_rate: number | null; opening_qty_milli: number; opening_value: number
  barcode: string | null; reorder_level_milli: number | null; valuation_method: 'weighted_avg' | 'fifo'
  block_negative: number | null
  code: string | null; alt_unit_id: number | null; alt_conversion_milli: number | null
}
const mapItem = (r: StockItemRow): StockItem => ({
  id: r.id, name: r.name, groupId: r.group_id, unitId: r.unit_id, hsn: r.hsn,
  gstRate: r.gst_rate, cessRate: r.cess_rate, openingQtyMilli: r.opening_qty_milli, openingValue: r.opening_value,
  code: r.code, barcode: r.barcode, reorderLevelMilli: r.reorder_level_milli,
  altUnitId: r.alt_unit_id, altConversionMilli: r.alt_conversion_milli,
  valuationMethod: r.valuation_method,
  // NULL is a third state, not a missing false: it means "follow the company setting".
  blockNegative: r.block_negative == null ? null : r.block_negative === 1
})

export function listStockItems(db: DB): StockItem[] {
  return (db.prepare('SELECT * FROM stock_items ORDER BY name').all() as StockItemRow[]).map(mapItem)
}

export function createStockItem(db: DB, input: StockItemInput): StockItem {
  const res = db.prepare(
    `INSERT INTO stock_items (name, group_id, unit_id, hsn, gst_rate, cess_rate, opening_qty_milli, opening_value,
      code, barcode, alt_unit_id, alt_conversion_milli, reorder_level_milli, valuation_method, block_negative)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(input.name, input.groupId, input.unitId, input.hsn, input.gstRate, input.cessRate,
    input.openingQtyMilli, input.openingValue, normaliseCode(input.code), input.barcode,
    ...altColumns(input),
    input.reorderLevelMilli, input.valuationMethod ?? 'weighted_avg',
    input.blockNegative == null ? null : input.blockNegative ? 1 : 0)
  const created = mapItem(db.prepare('SELECT * FROM stock_items WHERE id = ?').get(res.lastInsertRowid) as StockItemRow)
  writeAudit(db, 'stockItem', created.id, 'create', null, created)
  return created
}

export function updateStockItem(db: DB, id: number, input: StockItemInput): StockItem {
  const existing = db.prepare('SELECT * FROM stock_items WHERE id = ?').get(id) as StockItemRow | undefined
  if (!existing) throw new Error('Stock item not found')
  db.prepare(
    `UPDATE stock_items SET name = ?, group_id = ?, unit_id = ?, hsn = ?, gst_rate = ?, cess_rate = ?,
     opening_qty_milli = ?, opening_value = ?, code = ?, barcode = ?, alt_unit_id = ?, alt_conversion_milli = ?,
     reorder_level_milli = ?, valuation_method = ?, block_negative = ? WHERE id = ?`
  ).run(input.name, input.groupId, input.unitId, input.hsn, input.gstRate, input.cessRate,
    input.openingQtyMilli, input.openingValue, normaliseCode(input.code), input.barcode,
    ...altColumns(input),
    input.reorderLevelMilli,
    input.valuationMethod ?? existing.valuation_method,
    input.blockNegative == null ? null : input.blockNegative ? 1 : 0, id)
  const updated = mapItem(db.prepare('SELECT * FROM stock_items WHERE id = ?').get(id) as StockItemRow)
  writeAudit(db, 'stockItem', id, 'update', mapItem(existing), updated)
  return updated
}

export function deleteStockItem(db: DB, id: number): void {
  const existing = db.prepare('SELECT * FROM stock_items WHERE id = ?').get(id) as StockItemRow | undefined
  if (!existing) throw new Error('Stock item not found')
  const used = db.prepare('SELECT COUNT(*) AS n FROM inventory_lines WHERE stock_item_id = ?').get(id) as { n: number }
  if (used.n > 0) throw new Error('Stock item has vouchers; delete those first')
  db.prepare('DELETE FROM stock_items WHERE id = ?').run(id)
  writeAudit(db, 'stockItem', id, 'delete', mapItem(existing), null)
}

export function listGodowns(db: DB): Godown[] {
  return db.prepare('SELECT * FROM godowns ORDER BY name').all() as Godown[]
}

export function createGodown(db: DB, input: GodownInput): Godown {
  const res = db.prepare('INSERT INTO godowns (name, address) VALUES (?, ?)').run(input.name, input.address ?? null)
  const created = db.prepare('SELECT * FROM godowns WHERE id = ?').get(res.lastInsertRowid) as Godown
  writeAudit(db, 'godown', created.id, 'create', null, created)
  return created
}

export function updateGodown(db: DB, id: number, input: GodownInput): Godown {
  const existing = db.prepare('SELECT * FROM godowns WHERE id = ?').get(id) as Godown | undefined
  if (!existing) throw new Error('Godown not found')
  db.prepare('UPDATE godowns SET name = ?, address = ? WHERE id = ?')
    .run(input.name, input.address === undefined ? existing.address : input.address, id)
  const updated = db.prepare('SELECT * FROM godowns WHERE id = ?').get(id) as Godown
  writeAudit(db, 'godown', id, 'update', existing, updated)
  return updated
}

export function deleteGodown(db: DB, id: number): void {
  const existing = db.prepare('SELECT * FROM godowns WHERE id = ?').get(id) as Godown | undefined
  if (!existing) throw new Error('Godown not found')
  const used = db.prepare('SELECT COUNT(*) AS n FROM inventory_lines WHERE godown_id = ?').get(id) as { n: number }
  if (used.n > 0) throw new Error('Godown has stock movements; delete those first')
  db.prepare('DELETE FROM godowns WHERE id = ?').run(id)
  writeAudit(db, 'godown', id, 'delete', existing, null)
}

// ---------- batches (F11 `batches`, lane I) ----------

interface BatchRow { id: number; stock_item_id: number; name: string; mfg_date: string | null; expiry_date: string | null }
const mapBatch = (r: BatchRow): Batch => ({
  id: r.id, stockItemId: r.stock_item_id, name: r.name, mfgDate: r.mfg_date, expiryDate: r.expiry_date
})

export function listBatches(db: DB, stockItemId?: number): Batch[] {
  const rows = stockItemId
    ? (db.prepare('SELECT * FROM batches WHERE stock_item_id = ? ORDER BY name').all(stockItemId) as BatchRow[])
    : (db.prepare('SELECT * FROM batches ORDER BY stock_item_id, name').all() as BatchRow[])
  return rows.map(mapBatch)
}

/** Create a batch, or return the existing one with the same (item, name) — voucher entry
 *  creates batches on the fly and re-picking a name must not error. */
export function createBatch(db: DB, input: BatchInput): Batch {
  const existing = db
    .prepare('SELECT * FROM batches WHERE stock_item_id = ? AND name = ?')
    .get(input.stockItemId, input.name) as BatchRow | undefined
  if (existing) return mapBatch(existing)
  const item = db.prepare('SELECT id FROM stock_items WHERE id = ?').get(input.stockItemId)
  if (!item) throw new Error('Stock item not found')
  const res = db
    .prepare('INSERT INTO batches (stock_item_id, name, mfg_date, expiry_date) VALUES (?, ?, ?, ?)')
    .run(input.stockItemId, input.name, input.mfgDate, input.expiryDate)
  const created = mapBatch(db.prepare('SELECT * FROM batches WHERE id = ?').get(res.lastInsertRowid) as BatchRow)
  writeAudit(db, 'batch', created.id, 'create', null, created)
  return created
}


// ---------- item tax inherited from its group (roadmap #129) ----------

export interface EffectiveItemTax {
  gstRate: number | null
  cessRate: number | null
  hsn: string | null
  /** Which of the three came from the group rather than the item — shown, never guessed at. */
  inherited: { gstRate: boolean; cessRate: boolean; hsn: boolean }
  /** The group the values were inherited from, when any were. */
  fromGroup: string | null
}

/**
 * The rate and HSN an item actually charges.
 *
 * A trade with two hundred items in one tax band should state the band once. NULL on the item is
 * the only way to say "whatever the group says" — copying the value down onto every item looks
 * identical on day one and silently stops following the group the day the rate changes, which is
 * exactly the day it matters.
 *
 * Inheritance walks up the group tree, so a sub-group can override its parent and a leaf item can
 * override both. The nearest ancestor that states a value wins.
 */
export function effectiveItemTax(db: DB, stockItemId: number): EffectiveItemTax {
  const item = db
    .prepare('SELECT group_id, gst_rate, cess_rate, hsn FROM stock_items WHERE id = ?')
    .get(stockItemId) as { group_id: number | null; gst_rate: number | null; cess_rate: number | null; hsn: string | null } | undefined
  if (!item) throw new Error('Stock item not found')

  let gstRate = item.gst_rate
  let cessRate = item.cess_rate
  let hsn = item.hsn
  const inherited = { gstRate: false, cessRate: false, hsn: false }
  let fromGroup: string | null = null

  let groupId = item.group_id
  const seen = new Set<number>()
  while (groupId !== null && !seen.has(groupId)) {
    seen.add(groupId)
    const g = db
      .prepare('SELECT name, parent_id, gst_rate, cess_rate, hsn FROM stock_groups WHERE id = ?')
      .get(groupId) as { name: string; parent_id: number | null; gst_rate: number | null; cess_rate: number | null; hsn: string | null } | undefined
    if (!g) break
    if (gstRate === null && g.gst_rate !== null) {
      gstRate = g.gst_rate
      inherited.gstRate = true
      fromGroup ??= g.name
    }
    if (cessRate === null && g.cess_rate !== null) {
      cessRate = g.cess_rate
      inherited.cessRate = true
      fromGroup ??= g.name
    }
    if (hsn === null && g.hsn !== null) {
      hsn = g.hsn
      inherited.hsn = true
      fromGroup ??= g.name
    }
    groupId = g.parent_id
  }

  return { gstRate, cessRate, hsn, inherited, fromGroup }
}

// ---------- finding an item the way a person at a counter would (roadmap #130) ----------

/**
 * Look an item up by code, barcode or name, in that order.
 *
 * Code first because it is the shortest thing to type and the one printed on the shelf label;
 * barcode next because a scanner types it for you; name last because it is the slowest and the
 * most ambiguous. An exact match on any of the three wins outright — a shop with an item called
 * "12" and an item coded "12" wants the coded one.
 */
export function findItem(db: DB, query: string): StockItem | null {
  const q = query.trim()
  if (!q) return null
  const exact = db
    .prepare(
      `SELECT * FROM stock_items
       WHERE code = ? COLLATE NOCASE OR barcode = ? COLLATE NOCASE OR name = ? COLLATE NOCASE
       ORDER BY CASE WHEN code = ? COLLATE NOCASE THEN 0 WHEN barcode = ? COLLATE NOCASE THEN 1 ELSE 2 END
       LIMIT 1`
    )
    .get(q, q, q, q, q) as StockItemRow | undefined
  return exact ? mapItem(exact) : null
}
