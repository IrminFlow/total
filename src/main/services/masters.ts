import type { DB } from '../db/connection'
import type { Godown, Group, Ledger, StockGroup, StockItem, Unit, VoucherType } from '@shared/domain'
import type { GroupInput, GodownInput, LedgerInput, StockGroupInput, StockItemInput, UnitInput, VoucherTypeInput } from '@shared/schemas'
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
}
const mapLedger = (r: LedgerRow): Ledger => ({
  id: r.id, name: r.name, groupId: r.group_id, openingBalance: r.opening_balance,
  gstin: r.gstin, stateCode: r.state_code, address: r.address,
  taxType: r.tax_type, gstRate: r.gst_rate, hsn: r.hsn, isSystem: !!r.is_system
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

export function createLedger(db: DB, input: LedgerInput): Ledger {
  const res = db
    .prepare(
      `INSERT INTO ledgers (name, group_id, opening_balance, gstin, state_code, address, tax_type, gst_rate, hsn, is_system)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`
    )
    .run(input.name, input.groupId, input.openingBalance, input.gstin, input.stateCode, input.address,
      input.taxType, input.gstRate, input.hsn)
  const created = getLedger(db, Number(res.lastInsertRowid))!
  writeAudit(db, 'ledger', created.id, 'create', null, created)
  return created
}

export function updateLedger(db: DB, id: number, input: LedgerInput): Ledger {
  const existing = getLedger(db, id)
  if (!existing) throw new Error('Ledger not found')
  db.prepare(
    `UPDATE ledgers SET name = ?, group_id = ?, opening_balance = ?, gstin = ?, state_code = ?,
     address = ?, tax_type = ?, gst_rate = ?, hsn = ? WHERE id = ?`
  ).run(input.name, input.groupId, input.openingBalance, input.gstin, input.stateCode, input.address,
    input.taxType, input.gstRate, input.hsn, id)
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

interface VtRow { id: number; name: string; kind: VoucherType['kind']; numbering: 'auto' | 'manual'; prefix: string; is_system: number }
const mapVt = (r: VtRow): VoucherType => ({ id: r.id, name: r.name, kind: r.kind, numbering: r.numbering, prefix: r.prefix, isSystem: !!r.is_system })

export function listVoucherTypes(db: DB): VoucherType[] {
  return (db.prepare('SELECT * FROM voucher_types ORDER BY id').all() as VtRow[]).map(mapVt)
}

export function createVoucherType(db: DB, input: VoucherTypeInput): VoucherType {
  const res = db.prepare('INSERT INTO voucher_types (name, kind, numbering, prefix, is_system) VALUES (?, ?, ?, ?, 0)')
    .run(input.name, input.kind, input.numbering, input.prefix)
  const created = mapVt(db.prepare('SELECT * FROM voucher_types WHERE id = ?').get(res.lastInsertRowid) as VtRow)
  writeAudit(db, 'voucherType', created.id, 'create', null, created)
  return created
}

export function updateVoucherType(db: DB, id: number, input: VoucherTypeInput): VoucherType {
  const existing = db.prepare('SELECT * FROM voucher_types WHERE id = ?').get(id) as VtRow | undefined
  if (!existing) throw new Error('Voucher type not found')
  const kind = existing.is_system ? existing.kind : input.kind
  db.prepare('UPDATE voucher_types SET name = ?, kind = ?, numbering = ?, prefix = ? WHERE id = ?')
    .run(existing.is_system ? existing.name : input.name, kind, input.numbering, input.prefix, id)
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

interface StockGroupRow { id: number; name: string; parent_id: number | null }

export function listStockGroups(db: DB): StockGroup[] {
  return (db.prepare('SELECT * FROM stock_groups ORDER BY name').all() as StockGroupRow[])
    .map((r) => ({ id: r.id, name: r.name, parentId: r.parent_id }))
}

export function createStockGroup(db: DB, input: StockGroupInput): StockGroup {
  const res = db.prepare('INSERT INTO stock_groups (name, parent_id) VALUES (?, ?)').run(input.name, input.parentId)
  const r = db.prepare('SELECT * FROM stock_groups WHERE id = ?').get(res.lastInsertRowid) as StockGroupRow
  const created = { id: r.id, name: r.name, parentId: r.parent_id }
  writeAudit(db, 'stockGroup', created.id, 'create', null, created)
  return created
}

interface StockItemRow {
  id: number; name: string; group_id: number | null; unit_id: number; hsn: string | null
  gst_rate: number | null; cess_rate: number | null; opening_qty_milli: number; opening_value: number
}
const mapItem = (r: StockItemRow): StockItem => ({
  id: r.id, name: r.name, groupId: r.group_id, unitId: r.unit_id, hsn: r.hsn,
  gstRate: r.gst_rate, cessRate: r.cess_rate, openingQtyMilli: r.opening_qty_milli, openingValue: r.opening_value
})

export function listStockItems(db: DB): StockItem[] {
  return (db.prepare('SELECT * FROM stock_items ORDER BY name').all() as StockItemRow[]).map(mapItem)
}

export function createStockItem(db: DB, input: StockItemInput): StockItem {
  const res = db.prepare(
    `INSERT INTO stock_items (name, group_id, unit_id, hsn, gst_rate, cess_rate, opening_qty_milli, opening_value)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(input.name, input.groupId, input.unitId, input.hsn, input.gstRate, input.cessRate,
    input.openingQtyMilli, input.openingValue)
  const created = mapItem(db.prepare('SELECT * FROM stock_items WHERE id = ?').get(res.lastInsertRowid) as StockItemRow)
  writeAudit(db, 'stockItem', created.id, 'create', null, created)
  return created
}

export function updateStockItem(db: DB, id: number, input: StockItemInput): StockItem {
  const existing = db.prepare('SELECT * FROM stock_items WHERE id = ?').get(id) as StockItemRow | undefined
  if (!existing) throw new Error('Stock item not found')
  db.prepare(
    `UPDATE stock_items SET name = ?, group_id = ?, unit_id = ?, hsn = ?, gst_rate = ?, cess_rate = ?,
     opening_qty_milli = ?, opening_value = ? WHERE id = ?`
  ).run(input.name, input.groupId, input.unitId, input.hsn, input.gstRate, input.cessRate,
    input.openingQtyMilli, input.openingValue, id)
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
  const res = db.prepare('INSERT INTO godowns (name) VALUES (?)').run(input.name)
  const created = db.prepare('SELECT * FROM godowns WHERE id = ?').get(res.lastInsertRowid) as Godown
  writeAudit(db, 'godown', created.id, 'create', null, created)
  return created
}
