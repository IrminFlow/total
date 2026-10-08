/**
 * Import engine for the Excel / CSV wizard, Busy and Zoho exports and the Books workbook
 * (WP 6.3). Pure parsing lives in @shared/dataImport; this file resolves names to ids, applies
 * the duplicate strategy, and writes through the EXISTING services — masters create / update,
 * saveVoucher (every voucher passes the posting rules and is audited), saveTradeDoc,
 * priceLevels — so an import can never store something the screens could not.
 *
 * Transactions. A run is ONE transaction; each record is applied in its own savepoint (a nested
 * better-sqlite3 transaction), so a bad row is rolled back and reported while the rest go in.
 * A DRY RUN executes exactly the same code and then rolls the whole transaction back — the
 * preview's counts and errors are the real ones (posting rules, duplicate numbers, locks), not a
 * guess. An applied run records an import_batches row plus one import_batch_items row per record
 * created or updated (migration 037), and one 'csv_import' summary audit row; undoImport bins /
 * deletes / restores from those items.
 */
import type { DB } from '../db/connection'
import type { VoucherKind } from '@shared/domain'
import { ledgerInputSchema, type VoucherInput } from '@shared/schemas'
import { toUqc } from '@shared/gst/uqc'
import { fyOf } from '@shared/dates'
import { kindFromWord, defaultDirection, type GroupRow, type ItemRow, type LedgerRow, type RowError, type TargetId, type TargetRows, type TradeDocDraft, type VoucherDraft } from '@shared/dataImport/targets'
import { isSpecial, SPECIAL, type SpecialLedger } from '@shared/dataImport/invoiceBuild'
import * as masters from './masters'
import { saveVoucher, deleteVoucher } from './vouchers'
import { saveTradeDoc, deleteTradeDoc } from './tradeDocs'
import { listTradeDocTypes } from './tradeDocTypes'
import * as priceLevels from './priceLevels'
import { importStatement } from './banking'
import { writeAudit } from './audit'
import { readCompanyInfo, writeCompanyInfo } from '../db/seed'

export type DuplicateStrategy = 'skip' | 'update' | 'create'

export interface ImportOptions {
  /** A record whose name (or voucher type + number) already exists. */
  duplicate: DuplicateStrategy
  /** Create referenced masters that are missing (units, stock groups, godowns, parties,
   *  items on vouchers); unknown account groups then fall back to Suspense A/c with a warning. */
  createMissing: boolean
  /** Opening balances that do not tie: refuse, post the difference to a suspense ledger, or
   *  leave it (the balance sheet then shows "Difference in Opening Balances"). */
  openingDifference: 'block' | 'suspense' | 'leave'
  /** Bank statement target: the bank ledger to reconcile. */
  bankLedgerId?: number
  /** Books workbook: set the company's books-from year from the manifest when it has no vouchers. */
  applyBooksFrom?: number | null
}

export const DEFAULT_OPTIONS: ImportOptions = { duplicate: 'skip', createMissing: true, openingDifference: 'block' }

export type OutcomeAction = 'create' | 'update' | 'skip' | 'error'
export interface RowOutcome {
  line: number
  target: TargetId
  label: string
  action: OutcomeAction
  message?: string
}

export interface StepResult {
  target: TargetId
  sheet?: string
  created: number
  updated: number
  skipped: number
  errors: RowError[]
  warnings: string[]
}

export interface ImportRunResult {
  dryRun: boolean
  batchId: number | null
  steps: StepResult[]
  outcomes: RowOutcome[]
  /** Outcomes beyond the cap are counted, not listed. */
  outcomesTruncated: number
  /** Opening-balance check (openings / ledgers / books), Dr-positive paise. */
  openingCheck: { debit: number; credit: number; difference: number; stockOpening: number } | null
  bank?: { statementRows: number; matched: number; alreadyReconciled: number; unmatched: number }
}

export interface PlanStep {
  rows: TargetRows
  /** Parse errors already found for this step (shown with the rest). */
  errors?: RowError[]
  sheet?: string
}

export interface RunMeta {
  source: string
  profileId: string | null
  fileName: string | null
}

const OUTCOME_CAP = 5000
const DIFF_LEDGER = 'Difference in Opening Balances'

class DryRunRollback extends Error {}

// ---------- context ----------

interface Ctx {
  db: DB
  opts: ImportOptions
  batchId: number
  dryRun: boolean
  outcomes: RowOutcome[]
  truncated: number
  step: StepResult
  target: TargetId
  cache: Map<string, Map<string, number>>
}

function outcome(ctx: Ctx, line: number, label: string, action: OutcomeAction, message?: string): void {
  if (action === 'create') ctx.step.created++
  else if (action === 'update') ctx.step.updated++
  else if (action === 'skip') ctx.step.skipped++
  else ctx.step.errors.push({ line, message: message ?? 'Failed' })
  if (ctx.outcomes.length < OUTCOME_CAP) ctx.outcomes.push({ line, target: ctx.target, label, action, ...(message ? { message } : {}) })
  else ctx.truncated++
}

function track(ctx: Ctx, entity: string, id: number, action: 'create' | 'update', before: unknown, line: number | null): void {
  ctx.db
    .prepare('INSERT INTO import_batch_items (batch_id, entity, entity_id, action, before_json, source_line) VALUES (?, ?, ?, ?, ?, ?)')
    .run(ctx.batchId, entity, id, action, before === null || before === undefined ? null : JSON.stringify(before), line)
}

/** Case-insensitive name → id lookups, cached per table and invalidated on create. */
function lookup(ctx: Ctx, table: 'groups' | 'ledgers' | 'units' | 'stock_groups' | 'godowns' | 'stock_items' | 'voucher_types' | 'price_levels', name: string): number | null {
  let m = ctx.cache.get(table)
  if (!m) {
    m = new Map()
    const rows = ctx.db.prepare(`SELECT id, name${table === 'units' ? ', symbol' : ''} FROM ${table}`).all() as { id: number; name: string; symbol?: string }[]
    for (const r of rows) {
      m.set(r.name.toLowerCase(), r.id)
      if (r.symbol && !m.has(r.symbol.toLowerCase())) m.set(r.symbol.toLowerCase(), r.id)
    }
    ctx.cache.set(table, m)
  }
  return m.get(name.trim().toLowerCase()) ?? null
}
const forget = (ctx: Ctx, table: string): void => void ctx.cache.delete(table)

/** Run `fn` in a savepoint; an exception rolls just this record back and is reported. */
function attempt(ctx: Ctx, line: number, label: string, fn: () => void): void {
  try {
    ctx.db.transaction(fn)()
  } catch (err) {
    // A failed savepoint may have created rows we cached: drop every cache.
    ctx.cache.clear()
    outcome(ctx, line, label, 'error', (err as Error).message)
  }
}

/** "Acme" → "Acme (2)", "Acme (3)" … — the first free name (duplicate strategy 'create'). */
function freeName(ctx: Ctx, table: Parameters<typeof lookup>[1], name: string): string {
  for (let n = 2; n < 1000; n++) {
    const candidate = `${name} (${n})`
    if (lookup(ctx, table, candidate) === null) return candidate
  }
  throw new Error(`No free name for "${name}"`)
}

// ---------- special ledgers (invoice builders) ----------

function groupIdByName(ctx: Ctx, name: string): number {
  const id = lookup(ctx, 'groups', name)
  if (id === null) throw new Error(`Group "${name}" is missing from the chart of accounts`)
  return id
}

function ensureLedger(ctx: Ctx, name: string, groupName: string, extra: Partial<{ taxType: LedgerRow['taxType'] }> = {}, line: number | null = null): number {
  const existing = lookup(ctx, 'ledgers', name)
  if (existing !== null) return existing
  const created = masters.createLedger(ctx.db, ledgerInputSchema.parse({ name, groupId: groupIdByName(ctx, groupName), taxType: extra.taxType ?? null, pan: null }))
  track(ctx, 'ledger', created.id, 'create', null, line)
  forget(ctx, 'ledgers')
  ctx.step.warnings.push(`Created ledger "${name}" under ${groupName}`)
  return created.id
}

function resolveSpecialLedger(ctx: Ctx, token: string): number {
  const s = token.slice(SPECIAL.length) as SpecialLedger
  const firstIn = (groupNames: string[], prefer: RegExp): number | null => {
    const ids = masters.descendantIdsByName(ctx.db, groupNames)
    const rows = (ctx.db.prepare('SELECT id, name, group_id FROM ledgers ORDER BY id').all() as { id: number; name: string; group_id: number }[]).filter((r) => ids.has(r.group_id))
    return (rows.find((r) => prefer.test(r.name)) ?? rows[0])?.id ?? null
  }
  if (s === 'sales') return firstIn(['Sales Accounts'], /^sales/i) ?? ensureLedger(ctx, 'Sales A/c', 'Sales Accounts')
  if (s === 'purchase') return firstIn(['Purchase Accounts'], /^purchase/i) ?? ensureLedger(ctx, 'Purchase A/c', 'Purchase Accounts')
  if (s === 'roundoff') {
    const row = ctx.db.prepare("SELECT id FROM ledgers WHERE name LIKE 'round%off%' COLLATE NOCASE ORDER BY id LIMIT 1").get() as { id: number } | undefined
    return row?.id ?? ensureLedger(ctx, 'Round Off', 'Indirect Expenses')
  }
  if (s === 'charges-income') return ensureLedger(ctx, 'Freight & Packing Recovered', 'Indirect Incomes')
  if (s === 'charges-expense') return ensureLedger(ctx, 'Freight Inward', 'Direct Expenses')
  const m = /^tax:(output|input):(cgst|sgst|igst|cess)$/.exec(s)
  if (m) {
    const [, dir, type] = m as unknown as [string, 'output' | 'input', 'cgst' | 'sgst' | 'igst' | 'cess']
    const rows = ctx.db.prepare('SELECT id, name FROM ledgers WHERE tax_type = ? ORDER BY id').all(type) as { id: number; name: string }[]
    const want = new RegExp(dir, 'i')
    const other = new RegExp(dir === 'output' ? 'input' : 'output', 'i')
    const hit = rows.find((r) => want.test(r.name)) ?? rows.find((r) => !other.test(r.name))
    if (hit) return hit.id
    return ensureLedger(ctx, `${type.toUpperCase()} ${dir === 'output' ? 'Output' : 'Input'}`, 'Duties & Taxes', { taxType: type })
  }
  throw new Error(`Unknown special ledger ${token}`)
}

// ---------- masters ----------

function applyGroups(ctx: Ctx, rows: GroupRow[]): void {
  let pending = rows
  for (let pass = 0; pass < 20 && pending.length; pass++) {
    const next: GroupRow[] = []
    for (const r of pending) {
      const existing = lookup(ctx, 'groups', r.name)
      const parentId = lookup(ctx, 'groups', r.parent)
      if (parentId === null) {
        // The parent may be further down the file — try again next pass.
        if (rows.some((x) => x.name.toLowerCase() === r.parent.toLowerCase()) && pass < 19) next.push(r)
        else outcome(ctx, r.line, r.name, 'error', `Unknown parent group "${r.parent}"`)
        continue
      }
      if (existing !== null && ctx.opts.duplicate !== 'create') {
        if (ctx.opts.duplicate === 'skip') {
          outcome(ctx, r.line, r.name, 'skip', 'Already exists')
          continue
        }
        attempt(ctx, r.line, r.name, () => {
          const before = masters.listGroups(ctx.db).find((g) => g.id === existing)!
          if (before.isSystem) {
            outcome(ctx, r.line, r.name, 'skip', 'Default group — left as it is')
            return
          }
          if (before.parentId === parentId) {
            outcome(ctx, r.line, r.name, 'skip', 'Unchanged')
            return
          }
          masters.updateGroup(ctx.db, existing, { name: before.name, parentId })
          track(ctx, 'group', existing, 'update', before, r.line)
          outcome(ctx, r.line, r.name, 'update')
        })
        continue
      }
      attempt(ctx, r.line, r.name, () => {
        const name = existing !== null ? freeName(ctx, 'groups', r.name) : r.name
        const g = masters.createGroup(ctx.db, { name, parentId })
        track(ctx, 'group', g.id, 'create', null, r.line)
        forget(ctx, 'groups')
        outcome(ctx, r.line, name, 'create')
      })
    }
    pending = next
  }
}

function resolveLedgerGroup(ctx: Ctx, r: LedgerRow): number {
  if (r.group) {
    const id = lookup(ctx, 'groups', r.group)
    if (id !== null) return id
    if (!ctx.opts.createMissing) throw new Error(`Unknown group "${r.group}" — import the groups first`)
    ctx.step.warnings.push(`Line ${r.line}: group "${r.group}" not found — "${r.name}" placed under Suspense A/c`)
    return groupIdByName(ctx, 'Suspense A/c')
  }
  if (r.partyType) return groupIdByName(ctx, r.partyType === 'vendor' ? 'Sundry Creditors' : 'Sundry Debtors')
  throw new Error('Group is missing')
}

function ledgerInput(r: LedgerRow, groupId: number, name: string, existing: ReturnType<typeof masters.getLedger>): ReturnType<typeof ledgerInputSchema.parse> {
  const stateCode = r.stateCode ?? (r.gstin ? r.gstin.slice(0, 2) : null)
  return ledgerInputSchema.parse({
    name,
    groupId,
    openingBalance: r.opening ?? existing?.openingBalance ?? 0,
    gstin: r.gstin ?? existing?.gstin ?? null,
    stateCode: stateCode ?? existing?.stateCode ?? null,
    address: r.address ?? existing?.address ?? null,
    taxType: r.taxType ?? existing?.taxType ?? null,
    gstRate: r.gstRate ?? existing?.gstRate ?? null,
    hsn: r.hsn ?? existing?.hsn ?? null,
    tdsSectionId: existing?.tdsSectionId ?? null,
    // A GSTIN's characters 3–12 are the holder's PAN.
    pan: r.pan ?? existing?.pan ?? (r.gstin ? r.gstin.slice(2, 12) : null),
    creditDays: r.creditDays ?? existing?.creditDays ?? null,
    creditLimit: r.creditLimit ?? existing?.creditLimit ?? null,
    exportType: existing?.exportType ?? null,
    rcm: existing?.rcm ?? false,
    itcEligibility: existing?.itcEligibility ?? 'eligible'
  })
}

function applyLedgers(ctx: Ctx, rows: LedgerRow[]): void {
  for (const r of rows) {
    const existing = lookup(ctx, 'ledgers', r.name)
    if (existing !== null && ctx.opts.duplicate === 'skip') {
      outcome(ctx, r.line, r.name, 'skip', 'Already exists')
      continue
    }
    attempt(ctx, r.line, r.name, () => {
      if (existing !== null && ctx.opts.duplicate === 'update') {
        const before = masters.getLedger(ctx.db, existing)!
        const groupId = r.group || r.partyType ? resolveLedgerGroup(ctx, r) : before.groupId
        // System ledgers (Cash) keep their group.
        const input = ledgerInput(r, before.isSystem ? before.groupId : groupId, before.name, before)
        masters.updateLedger(ctx.db, existing, input)
        track(ctx, 'ledger', existing, 'update', before, r.line)
        outcome(ctx, r.line, r.name, 'update')
        return
      }
      const name = existing !== null ? freeName(ctx, 'ledgers', r.name) : r.name
      const created = masters.createLedger(ctx.db, ledgerInput(r, resolveLedgerGroup(ctx, r), name, null))
      track(ctx, 'ledger', created.id, 'create', null, r.line)
      forget(ctx, 'ledgers')
      outcome(ctx, r.line, name, 'create')
    })
  }
}

function applyUnits(ctx: Ctx, rows: { line: number; name: string; symbol: string | null; decimals: number | null; uqc: string | null }[]): void {
  for (const r of rows) {
    if (lookup(ctx, 'units', r.name) !== null || (r.symbol && lookup(ctx, 'units', r.symbol) !== null)) {
      outcome(ctx, r.line, r.name, 'skip', 'Already exists (units are never overwritten)')
      continue
    }
    attempt(ctx, r.line, r.name, () => {
      createUnit(ctx, r.name, r.symbol, r.decimals, r.uqc, r.line)
      outcome(ctx, r.line, r.name, 'create')
    })
  }
}

function createUnit(ctx: Ctx, name: string, symbol: string | null, decimals: number | null, uqc: string | null, line: number | null): number {
  const sym = (symbol || name).slice(0, 12)
  const code = uqc ? toUqc(uqc) : toUqc(sym)
  const u = masters.createUnit(ctx.db, { name: name.slice(0, 60), symbol: sym, decimals: decimals ?? 0, uqc: code.uqc })
  track(ctx, 'unit', u.id, 'create', null, line)
  forget(ctx, 'units')
  return u.id
}

function ensureStockGroup(ctx: Ctx, name: string, line: number | null): number {
  const id = lookup(ctx, 'stock_groups', name)
  if (id !== null) return id
  if (!ctx.opts.createMissing) throw new Error(`Unknown stock group "${name}"`)
  const g = masters.createStockGroup(ctx.db, { name, parentId: null })
  track(ctx, 'stockGroup', g.id, 'create', null, line)
  forget(ctx, 'stock_groups')
  return g.id
}

function applyStockGroups(ctx: Ctx, rows: { line: number; name: string; parent: string | null }[]): void {
  let pending = rows
  for (let pass = 0; pass < 20 && pending.length; pass++) {
    const next: typeof rows = []
    for (const r of pending) {
      if (lookup(ctx, 'stock_groups', r.name) !== null) {
        outcome(ctx, r.line, r.name, 'skip', 'Already exists')
        continue
      }
      const parentId = r.parent ? lookup(ctx, 'stock_groups', r.parent) : null
      if (r.parent && parentId === null) {
        if (rows.some((x) => x.name.toLowerCase() === r.parent!.toLowerCase()) && pass < 19) {
          next.push(r)
          continue
        }
      }
      attempt(ctx, r.line, r.name, () => {
        const pid = r.parent ? (parentId ?? ensureStockGroup(ctx, r.parent, r.line)) : null
        const g = masters.createStockGroup(ctx.db, { name: r.name, parentId: pid })
        track(ctx, 'stockGroup', g.id, 'create', null, r.line)
        forget(ctx, 'stock_groups')
        outcome(ctx, r.line, r.name, 'create')
      })
    }
    pending = next
  }
}

function ensureGodown(ctx: Ctx, name: string, line: number | null): number {
  const id = lookup(ctx, 'godowns', name)
  if (id !== null) return id
  if (!ctx.opts.createMissing) throw new Error(`Unknown godown "${name}"`)
  const g = masters.createGodown(ctx.db, { name })
  track(ctx, 'godown', g.id, 'create', null, line)
  forget(ctx, 'godowns')
  return g.id
}

function applyGodowns(ctx: Ctx, rows: { line: number; name: string; address: string | null }[]): void {
  for (const r of rows) {
    const existing = lookup(ctx, 'godowns', r.name)
    if (existing !== null && ctx.opts.duplicate !== 'update') {
      outcome(ctx, r.line, r.name, 'skip', 'Already exists')
      continue
    }
    attempt(ctx, r.line, r.name, () => {
      if (existing !== null) {
        const before = masters.listGodowns(ctx.db).find((g) => g.id === existing)!
        masters.updateGodown(ctx.db, existing, { name: before.name, address: r.address ?? before.address })
        track(ctx, 'godown', existing, 'update', before, r.line)
        outcome(ctx, r.line, r.name, 'update')
        return
      }
      const g = masters.createGodown(ctx.db, { name: r.name, address: r.address })
      track(ctx, 'godown', g.id, 'create', null, r.line)
      forget(ctx, 'godowns')
      outcome(ctx, r.line, r.name, 'create')
    })
  }
}

function resolveUnit(ctx: Ctx, name: string | null, line: number): number {
  if (!name) {
    const def = lookup(ctx, 'units', 'Nos') ?? (ctx.db.prepare('SELECT id FROM units ORDER BY id LIMIT 1').get() as { id: number } | undefined)?.id
    if (def === undefined || def === null) throw new Error('Unit is missing and the company has no units')
    return def
  }
  const id = lookup(ctx, 'units', name)
  if (id !== null) return id
  if (!ctx.opts.createMissing) throw new Error(`Unknown unit "${name}"`)
  return createUnit(ctx, name, null, null, null, line)
}

type StockItemRowDb = { id: number; name: string; group_id: number | null; unit_id: number; hsn: string | null; gst_rate: number | null; cess_rate: number | null; opening_qty_milli: number; opening_value: number; barcode: string | null; reorder_level_milli: number | null; mrp_paise: number | null }

function itemOpeningValue(r: { openingQtyMilli: number | null; openingValue: number | null; openingRate: number | null }): number | null {
  if (r.openingValue !== null) return r.openingValue
  if (r.openingRate !== null && r.openingQtyMilli !== null) return Math.round((r.openingQtyMilli * r.openingRate) / 1000)
  return null
}

function applyItems(ctx: Ctx, rows: ItemRow[]): void {
  for (const r of rows) {
    const existing = lookup(ctx, 'stock_items', r.name)
    if (existing !== null && ctx.opts.duplicate === 'skip') {
      outcome(ctx, r.line, r.name, 'skip', 'Already exists')
      continue
    }
    attempt(ctx, r.line, r.name, () => {
      const before = existing !== null ? (ctx.db.prepare('SELECT * FROM stock_items WHERE id = ?').get(existing) as StockItemRowDb) : null
      const update = before !== null && ctx.opts.duplicate === 'update'
      const input = {
        name: update ? before!.name : before ? freeName(ctx, 'stock_items', r.name) : r.name,
        groupId: r.group ? ensureStockGroup(ctx, r.group, r.line) : (update ? before!.group_id : null),
        unitId: r.unit ? resolveUnit(ctx, r.unit, r.line) : update ? before!.unit_id : resolveUnit(ctx, null, r.line),
        hsn: r.hsn ?? (update ? before!.hsn : null),
        gstRate: r.gstRate ?? (update ? before!.gst_rate : null),
        cessRate: r.cessRate ?? (update ? before!.cess_rate : null),
        openingQtyMilli: r.openingQtyMilli ?? (update ? before!.opening_qty_milli : 0),
        openingValue: itemOpeningValue(r) ?? (update ? before!.opening_value : 0),
        barcode: r.barcode ?? (update ? before!.barcode : null),
        reorderLevelMilli: r.reorderLevelMilli ?? (update ? before!.reorder_level_milli : null),
        mrpPaise: r.mrpPaise ?? (update ? before!.mrp_paise : null)
      }
      if (update) {
        masters.updateStockItem(ctx.db, existing!, input)
        track(ctx, 'stockItem', existing!, 'update', before, r.line)
        outcome(ctx, r.line, r.name, 'update')
      } else {
        const created = masters.createStockItem(ctx.db, input)
        track(ctx, 'stockItem', created.id, 'create', null, r.line)
        forget(ctx, 'stock_items')
        outcome(ctx, r.line, input.name, 'create')
      }
    })
  }
}

function itemIdOrThrow(ctx: Ctx, name: string): number {
  const id = lookup(ctx, 'stock_items', name)
  if (id === null) throw new Error(`Unknown stock item "${name}" — import the items first`)
  return id
}

function applyBatches(ctx: Ctx, rows: { line: number; item: string; name: string; mfgDate: string | null; expiryDate: string | null }[]): void {
  for (const r of rows) {
    attempt(ctx, r.line, `${r.item} / ${r.name}`, () => {
      const itemId = itemIdOrThrow(ctx, r.item)
      const exists = ctx.db.prepare('SELECT id FROM batches WHERE stock_item_id = ? AND name = ?').get(itemId, r.name)
      if (exists) {
        outcome(ctx, r.line, `${r.item} / ${r.name}`, 'skip', 'Already exists')
        return
      }
      const b = masters.createBatch(ctx.db, { stockItemId: itemId, name: r.name, mfgDate: r.mfgDate, expiryDate: r.expiryDate })
      track(ctx, 'batch', b.id, 'create', null, r.line)
      outcome(ctx, r.line, `${r.item} / ${r.name}`, 'create')
    })
  }
}

function applyPriceLists(ctx: Ctx, rows: { line: number; level: string; item: string; rate: number; from: string | null; minQtyMilli: number | null }[], booksFromDate: string): void {
  for (const r of rows) {
    const label = `${r.level} · ${r.item}`
    attempt(ctx, r.line, label, () => {
      let levelId = lookup(ctx, 'price_levels', r.level)
      if (levelId === null) {
        if (!ctx.opts.createMissing) throw new Error(`Unknown price level "${r.level}"`)
        const lvl = priceLevels.savePriceLevel(ctx.db, { name: r.level })
        track(ctx, 'priceLevel', lvl.id, 'create', null, r.line)
        forget(ctx, 'price_levels')
        levelId = lvl.id
      }
      const itemId = itemIdOrThrow(ctx, r.item)
      const from = r.from ?? booksFromDate
      const existing = ctx.db
        .prepare("SELECT * FROM price_list_rates WHERE price_level_id = ? AND stock_item_id = ? AND currency = 'INR' AND min_qty_milli = ? AND effective_from = ?")
        .get(levelId, itemId, r.minQtyMilli ?? 0, from) as { id: number; rate: number } | undefined
      if (existing && ctx.opts.duplicate !== 'update') {
        outcome(ctx, r.line, label, 'skip', 'A rate from that date already exists')
        return
      }
      const saved = priceLevels.saveRate(ctx.db, { priceLevelId: levelId, stockItemId: itemId, rate: r.rate, effectiveFrom: from, minQtyMilli: r.minQtyMilli ?? 0 }, existing?.id)
      track(ctx, 'priceRate', saved.id, existing ? 'update' : 'create', existing ?? null, r.line)
      outcome(ctx, r.line, label, existing ? 'update' : 'create')
    })
  }
}

function applyVoucherTypes(ctx: Ctx, rows: { line: number; name: string; kind: VoucherKind | null; prefix: string | null }[]): void {
  for (const r of rows) {
    if (lookup(ctx, 'voucher_types', r.name) !== null) {
      outcome(ctx, r.line, r.name, 'skip', 'Already exists')
      continue
    }
    attempt(ctx, r.line, r.name, () => {
      if (!r.kind) throw new Error('Kind is missing')
      const vt = masters.createVoucherType(ctx.db, { name: r.name, kind: r.kind, numbering: 'auto', prefix: r.prefix ?? '', suffix: '', padWidth: 0, restartFy: true })
      track(ctx, 'voucherType', vt.id, 'create', null, r.line)
      forget(ctx, 'voucher_types')
      outcome(ctx, r.line, r.name, 'create')
    })
  }
}

// ---------- balances ----------

/** Dr / Cr totals of the ledger openings + the opening stock the balance sheet adds (when no
 *  Stock-in-Hand ledger carries it) — the same sum reports.balanceSheet shows as the
 *  "Difference in Opening Balances". */
export function openingTotals(db: DB): { debit: number; credit: number; difference: number; stockOpening: number } {
  const r = db.prepare('SELECT COALESCE(SUM(CASE WHEN opening_balance > 0 THEN opening_balance END), 0) AS dr, COALESCE(SUM(CASE WHEN opening_balance < 0 THEN -opening_balance END), 0) AS cr FROM ledgers').get() as { dr: number; cr: number }
  const stockIds = masters.descendantIdsByName(db, ['Stock-in-Hand'])
  const stockLedger = (db.prepare('SELECT group_id, opening_balance FROM ledgers').all() as { group_id: number; opening_balance: number }[]).some((l) => stockIds.has(l.group_id) && l.opening_balance !== 0)
  const stock = stockLedger ? 0 : (db.prepare('SELECT COALESCE(SUM(opening_value), 0) AS v FROM stock_items').get() as { v: number }).v
  return { debit: r.dr + stock, credit: r.cr, difference: r.dr + stock - r.cr, stockOpening: stock }
}

function setLedgerOpening(ctx: Ctx, id: number, opening: number, line: number | null): boolean {
  const before = masters.getLedger(ctx.db, id)!
  if (before.openingBalance === opening) return false
  masters.updateLedger(ctx.db, id, ledgerInputSchema.parse({ ...before, openingBalance: opening }))
  track(ctx, 'ledger', id, 'update', before, line)
  return true
}

function applyOpenings(ctx: Ctx, rows: { line: number; ledger: string; opening: number }[]): void {
  for (const r of rows) {
    const id = lookup(ctx, 'ledgers', r.ledger)
    if (id === null) {
      outcome(ctx, r.line, r.ledger, 'error', `Unknown ledger "${r.ledger}" — import the ledgers first`)
      continue
    }
    attempt(ctx, r.line, r.ledger, () => {
      outcome(ctx, r.line, r.ledger, setLedgerOpening(ctx, id, r.opening, r.line) ? 'update' : 'skip', undefined)
    })
  }
  settleOpeningDifference(ctx)
}

/** The trial-balance check after openings change: Dr must equal Cr. 'suspense' posts the gap to
 *  an explicit "Difference in Opening Balances" ledger under Suspense A/c; 'block' fails the
 *  step (the whole step is rolled back by the caller); 'leave' only warns. */
function settleOpeningDifference(ctx: Ctx): void {
  const t = openingTotals(ctx.db)
  if (t.difference === 0) return
  const amount = `₹${(Math.abs(t.difference) / 100).toFixed(2)} ${t.difference > 0 ? 'Dr' : 'Cr'}`
  if (ctx.opts.openingDifference === 'suspense') {
    const id = ensureLedger(ctx, DIFF_LEDGER, 'Suspense A/c')
    const current = masters.getLedger(ctx.db, id)!.openingBalance
    setLedgerOpening(ctx, id, current - t.difference, null)
    ctx.step.warnings.push(`Openings did not tie: ${amount} posted to "${DIFF_LEDGER}" (Suspense A/c)`)
  } else if (ctx.opts.openingDifference === 'leave') {
    ctx.step.warnings.push(`Opening balances differ by ${amount} — the balance sheet will show "Difference in Opening Balances"`)
  } else {
    throw new OpeningsDontTie(`Opening balances do not tie: Dr ₹${(t.debit / 100).toFixed(2)} vs Cr ₹${(t.credit / 100).toFixed(2)} (difference ${amount}). Fix the file, or choose to post the difference to a suspense ledger.`)
  }
}

class OpeningsDontTie extends Error {}

function applyStockOpenings(ctx: Ctx, rows: { line: number; item: string; qtyMilli: number; value: number | null; rate: number | null }[]): void {
  for (const r of rows) {
    attempt(ctx, r.line, r.item, () => {
      const id = itemIdOrThrow(ctx, r.item)
      const before = ctx.db.prepare('SELECT * FROM stock_items WHERE id = ?').get(id) as StockItemRowDb
      const value = r.value ?? (r.rate !== null ? Math.round((r.qtyMilli * r.rate) / 1000) : null)
      if (value === null) throw new Error('Value or rate is missing')
      if (r.qtyMilli === 0 && value !== 0) throw new Error('A value without a quantity cannot be valued — give the quantity')
      if (before.opening_qty_milli === r.qtyMilli && before.opening_value === value) {
        outcome(ctx, r.line, r.item, 'skip', 'Unchanged')
        return
      }
      masters.updateStockItem(ctx.db, id, {
        name: before.name, groupId: before.group_id, unitId: before.unit_id, hsn: before.hsn, gstRate: before.gst_rate, cessRate: before.cess_rate,
        openingQtyMilli: r.qtyMilli, openingValue: value, barcode: before.barcode, reorderLevelMilli: before.reorder_level_milli
      })
      track(ctx, 'stockItem', id, 'update', before, r.line)
      outcome(ctx, r.line, r.item, 'update')
    })
  }
}

// ---------- vouchers ----------

function resolveVoucherType(ctx: Ctx, d: VoucherDraft): { id: number; kind: VoucherKind } {
  const byName = d.typeName ? (ctx.db.prepare('SELECT id, kind FROM voucher_types WHERE name = ? COLLATE NOCASE').get(d.typeName) as { id: number; kind: VoucherKind } | undefined) : undefined
  if (byName) return byName
  const kind = d.kind ?? (d.typeName ? kindFromWord(d.typeName) : null)
  if (!kind) throw new Error(`Unknown voucher type "${d.typeName}"`)
  // A kind word ("Sale", "Rcpt", "credit_note") → the company's default type of that kind.
  const isKindWord = kindFromWord(d.typeName) === kind && d.typeName.trim().length <= 16
  if (isKindWord || !ctx.opts.createMissing) {
    const def = ctx.db.prepare('SELECT id, kind FROM voucher_types WHERE kind = ? ORDER BY is_system DESC, id LIMIT 1').get(kind) as { id: number; kind: VoucherKind } | undefined
    if (def) return def
  }
  const vt = masters.createVoucherType(ctx.db, { name: d.typeName, kind, numbering: 'auto', prefix: '', suffix: '', padWidth: 0, restartFy: true })
  track(ctx, 'voucherType', vt.id, 'create', null, d.lines[0] ?? null)
  forget(ctx, 'voucher_types')
  ctx.step.warnings.push(`Created voucher type "${d.typeName}" (${kind})`)
  return { id: vt.id, kind }
}

const PARTY_DEBTOR_KINDS: VoucherKind[] = ['sales', 'receipt', 'credit_note', 'delivery_note']

function resolveLedgerName(ctx: Ctx, name: string, kind: VoucherKind, party: string | null, line: number): number {
  if (isSpecial(name)) return resolveSpecialLedger(ctx, name)
  const id = lookup(ctx, 'ledgers', name)
  if (id !== null) return id
  if (ctx.opts.createMissing && party && name.toLowerCase() === party.toLowerCase()) {
    return ensureLedger(ctx, name, PARTY_DEBTOR_KINDS.includes(kind) ? 'Sundry Debtors' : 'Sundry Creditors', {}, line)
  }
  throw new Error(`Unknown ledger "${name}"${ctx.opts.createMissing ? ' — import the ledgers / chart of accounts first' : ''}`)
}

function resolveItem(ctx: Ctx, name: string, line: number): number {
  const id = lookup(ctx, 'stock_items', name)
  if (id !== null) return id
  if (!ctx.opts.createMissing) throw new Error(`Unknown stock item "${name}"`)
  const created = masters.createStockItem(ctx.db, { name, groupId: null, unitId: resolveUnit(ctx, null, line), hsn: null, gstRate: null, cessRate: null, openingQtyMilli: 0, openingValue: 0, barcode: null, reorderLevelMilli: null })
  track(ctx, 'stockItem', created.id, 'create', null, line)
  forget(ctx, 'stock_items')
  ctx.step.warnings.push(`Created stock item "${name}" (unit and HSN to be completed)`)
  return created.id
}

function withholdingFor(ctx: Ctx, w: { section: string; base: number; amount: number } | null, kind: 'tds' | 'tcs'): { sectionId: number; baseAmount: number; isManual: true; autoPayable: false; tdsAmount?: number; tcsAmount?: number } | null {
  if (!w) return null
  const row = ctx.db.prepare('SELECT id FROM tds_sections WHERE code = ? COLLATE NOCASE AND kind = ?').get(w.section, kind) as { id: number } | undefined
  if (!row) throw new Error(`Unknown ${kind.toUpperCase()} section "${w.section}"`)
  return { sectionId: row.id, baseAmount: w.base, isManual: true, autoPayable: false, ...(kind === 'tds' ? { tdsAmount: w.amount } : { tcsAmount: w.amount }) }
}

function voucherInputFor(ctx: Ctx, d: VoucherDraft, vt: { id: number; kind: VoucherKind }): VoucherInput {
  const line = d.lines[0] ?? 0
  const partyId = d.party ? resolveLedgerName(ctx, d.party, vt.kind, d.party, line) : null
  const lines = d.ledgerLines.map((l) => ({ ledgerId: resolveLedgerName(ctx, l.ledger, vt.kind, d.party, l.line), drCr: l.drCr, amount: l.amount, costAllocations: [] }))
  const partyAmount = partyId !== null ? lines.filter((l) => l.ledgerId === partyId).reduce((s, l) => s + l.amount, 0) : 0
  const inventory = d.items.map((it) => {
    const stockItemId = resolveItem(ctx, it.item, it.line)
    const amount = it.amount ?? Math.round((it.qtyMilli * (it.ratePaise ?? 0)) / 1000)
    const godownId = it.godown ? ensureGodown(ctx, it.godown, it.line) : null
    let batchId: number | null = null
    if (it.batch) {
      const b = ctx.db.prepare('SELECT id FROM batches WHERE stock_item_id = ? AND name = ?').get(stockItemId, it.batch) as { id: number } | undefined
      if (b) batchId = b.id
      else {
        const created = masters.createBatch(ctx.db, { stockItemId, name: it.batch, mfgDate: null, expiryDate: null })
        track(ctx, 'batch', created.id, 'create', null, it.line)
        batchId = created.id
      }
    }
    return {
      stockItemId, godownId, batchId, qtyMilli: it.qtyMilli,
      ratePaise: it.ratePaise ?? (it.qtyMilli > 0 ? Math.round((amount * 1000) / it.qtyMilli) : 0),
      amount, direction: it.direction ?? defaultDirection(vt.kind)
    }
  })
  const billRefs = d.bills.map((b) => ({ kind: b.kind, name: b.name.slice(0, 80), amount: b.amount ?? partyAmount, dueDate: b.dueDate })).filter((b) => b.amount > 0)
  const tds = withholdingFor(ctx, d.tds, 'tds')
  const tcs = withholdingFor(ctx, d.tcs, 'tcs')
  return {
    voucherTypeId: vt.id,
    date: d.date,
    number: d.number ?? undefined,
    partyLedgerId: partyId,
    narration: d.narration ? d.narration.slice(0, 1000) : null,
    reference: d.reference ? d.reference.slice(0, 120) : null,
    posOverride: d.posOverride,
    currencyCode: d.currencyCode,
    exchangeRate: d.exchangeRate,
    isOptional: d.isOptional || undefined,
    postDated: d.postDated || undefined,
    lines,
    inventory,
    billRefs,
    tds: tds ? { sectionId: tds.sectionId, baseAmount: tds.baseAmount, tdsAmount: tds.tdsAmount!, isManual: true, autoPayable: false } : null,
    tcs: tcs ? { sectionId: tcs.sectionId, baseAmount: tcs.baseAmount, tcsAmount: tcs.tcsAmount!, isManual: true, autoPayable: false } : null,
    ...(vt.kind === 'delivery_note' ? { trade: { purpose: 'supply' as const } } : vt.kind === 'receipt_note' ? { trade: { purpose: 'purchase' as const } } : {})
  }
}

function applyVouchers(ctx: Ctx, drafts: VoucherDraft[]): void {
  for (const d of drafts) {
    const line = d.lines[0] ?? 0
    const label = `${d.typeName || d.kind} ${d.number ?? ''} · ${d.date}`.trim()
    attempt(ctx, line, label, () => {
      const vt = resolveVoucherType(ctx, d)
      const dup = d.number
        ? (ctx.db.prepare('SELECT id FROM vouchers WHERE voucher_type_id = ? AND number = ? AND deleted_at IS NULL ORDER BY id LIMIT 1').get(vt.id, d.number) as { id: number } | undefined)
        : undefined
      if (dup && ctx.opts.duplicate === 'skip') {
        outcome(ctx, line, label, 'skip', 'A voucher with this type and number already exists')
        return
      }
      const input = voucherInputFor(ctx, d, vt)
      if (dup && ctx.opts.duplicate === 'update') {
        const before = ctx.db.prepare('SELECT * FROM vouchers WHERE id = ?').get(dup.id)
        saveVoucher(ctx.db, input, dup.id)
        track(ctx, 'voucher', dup.id, 'update', before, line)
        outcome(ctx, line, label, 'update')
        return
      }
      const saved = saveVoucher(ctx.db, input)
      track(ctx, 'voucher', saved.id, 'create', null, line)
      outcome(ctx, line, label, 'create', d.notes.length ? d.notes.join('; ') : undefined)
    })
  }
}

function applyTradeDocs(ctx: Ctx, drafts: TradeDocDraft[]): void {
  const types = listTradeDocTypes(ctx.db)
  for (const d of drafts) {
    const line = d.lines[0] ?? 0
    const label = `${d.kind.replace('_', ' ')} ${d.number ?? ''} · ${d.date}`
    attempt(ctx, line, label, () => {
      const type = (d.series ? types.find((t) => t.name.toLowerCase() === d.series!.toLowerCase() && t.kind === d.kind) : undefined) ?? types.find((t) => t.kind === d.kind)
      if (!type) throw new Error(`No ${d.kind} series`)
      const dup = d.number ? (ctx.db.prepare('SELECT id FROM trade_docs WHERE doc_type_id = ? AND number = ? AND deleted_at IS NULL').get(type.id, d.number) as { id: number } | undefined) : undefined
      if (dup && ctx.opts.duplicate !== 'create') {
        outcome(ctx, line, label, 'skip', 'A document with this number already exists')
        return
      }
      const partyId = resolveLedgerName(ctx, d.party, d.kind === 'purchase_order' ? 'purchase' : 'sales', d.party, line)
      const saved = saveTradeDoc(ctx.db, {
        docTypeId: type.id, date: d.date, number: dup ? undefined : (d.number ?? undefined), partyLedgerId: partyId, validUntil: d.validUntil,
        dueDate: d.dueDate, reference: d.reference, narration: d.narration,
        lines: d.items.map((it) => ({
          stockItemId: resolveItem(ctx, it.item, it.line), godownId: it.godown ? ensureGodown(ctx, it.godown, it.line) : null,
          qtyMilli: it.qtyMilli, ratePaise: it.ratePaise, discountPaise: it.discountPaise, amount: it.amount, dueDate: it.dueDate
        }))
      })
      track(ctx, 'trade_doc', saved.doc.id, 'create', null, line)
      outcome(ctx, line, label, 'create')
    })
  }
}

function applyBank(ctx: Ctx, rows: { line: number; date: string; description: string; reference: string; deposit: number; withdrawal: number }[], result: ImportRunResult): void {
  if (!ctx.opts.bankLedgerId) throw new Error('Choose the bank ledger the statement belongs to')
  const q = (s: string): string => `"${s.replace(/"/g, '""')}"`
  const plain = (p: number): string => (p ? (p / 100).toFixed(2) : '')
  // The banking service's own statement format (banking.parseStatementCsv): Date, Description,
  // Reference, Withdrawal, Deposit — ISO dates, plain decimals.
  const csv = ['Date,Description,Reference,Withdrawal,Deposit', ...rows.map((r) => [r.date, q(r.description), q(r.reference), plain(r.withdrawal), plain(r.deposit)].join(','))].join('\n')
  const r = importStatement(ctx.db, ctx.opts.bankLedgerId, csv, { apply: !ctx.dryRun })
  result.bank = { statementRows: r.statementRows, matched: r.matched, alreadyReconciled: r.alreadyReconciled, unmatched: r.unmatched.length }
  for (const row of rows) outcome(ctx, row.line, `${row.date} ${row.description}`.trim(), 'skip', 'Handed to Banking')
  ctx.step.skipped = 0
  ctx.step.warnings.push(`Banking matched ${r.matched} of ${r.statementRows} statement rows${r.unmatched.length ? `; ${r.unmatched.length} unmatched — reconcile them in Banking` : ''}`)
}

// ---------- run ----------

export function runImport(db: DB, plan: PlanStep[], rawOpts: Partial<ImportOptions>, meta: RunMeta, dryRun: boolean): ImportRunResult {
  const opts: ImportOptions = { ...DEFAULT_OPTIONS, ...rawOpts }
  const result: ImportRunResult = { dryRun, batchId: null, steps: [], outcomes: [], outcomesTruncated: 0, openingCheck: null }
  const info = readCompanyInfo(db)
  const booksFromDate = `${info.booksFrom}-04-01`
  const exec = db.transaction(() => {
    const batchId = Number(
      db.prepare('INSERT INTO import_batches (source, profile_id, file_name, options_json) VALUES (?, ?, ?, ?)').run(meta.source, meta.profileId, meta.fileName, JSON.stringify(opts)).lastInsertRowid
    )
    const cache = new Map<string, Map<string, number>>()
    if (opts.applyBooksFrom && opts.applyBooksFrom !== info.booksFrom) {
      const hasVouchers = db.prepare('SELECT 1 FROM vouchers LIMIT 1').get()
      if (!hasVouchers) {
        writeCompanyInfo(db, { ...info, booksFrom: opts.applyBooksFrom })
        writeAudit(db, 'company', 0, 'update', info, { ...info, booksFrom: opts.applyBooksFrom })
      }
    }
    for (const s of plan) {
      const step: StepResult = { target: s.rows.target, sheet: s.sheet, created: 0, updated: 0, skipped: 0, errors: [...(s.errors ?? [])], warnings: [] }
      result.steps.push(step)
      const ctx: Ctx = { db, opts, batchId, dryRun, outcomes: result.outcomes, truncated: 0, step, target: s.rows.target, cache }
      for (const e of s.errors ?? []) if (result.outcomes.length < OUTCOME_CAP) result.outcomes.push({ line: e.line, target: s.rows.target, label: e.field ?? '', action: 'error', message: e.message })
      try {
        // A step that must hold together (openings tie) runs in its own savepoint.
        db.transaction(() => applyStep(ctx, s.rows, result, booksFromDate))()
      } catch (err) {
        if (!(err instanceof OpeningsDontTie)) throw err
        step.errors.push({ line: 0, message: err.message })
        step.created = 0
        step.updated = 0
        cache.clear()
      }
      result.outcomesTruncated += ctx.truncated
    }
    if (plan.some((s) => s.rows.target === 'openings' || s.rows.target === 'ledgers' || s.rows.target === 'parties' || s.rows.target === 'items' || s.rows.target === 'stockOpenings')) {
      result.openingCheck = openingTotals(db)
    }
    const summary = {
      steps: result.steps.map((s) => ({ target: s.target, sheet: s.sheet, created: s.created, updated: s.updated, skipped: s.skipped, errors: s.errors.length })),
      openingCheck: result.openingCheck,
      bank: result.bank ?? null
    }
    const errorCount = result.steps.reduce((n, s) => n + s.errors.length, 0)
    db.prepare('UPDATE import_batches SET summary_json = ?, error_count = ? WHERE id = ?').run(JSON.stringify(summary), errorCount, batchId)
    // WP 3.8: each record is audited by the service that wrote it; this row ties them to the import.
    writeAudit(db, 'csv_import', batchId, 'import', null, { source: meta.source, profile: meta.profileId, file: meta.fileName, ...summary, errors: errorCount })
    if (dryRun) throw new DryRunRollback()
    result.batchId = batchId
  })
  try {
    exec()
  } catch (err) {
    if (!(err instanceof DryRunRollback)) throw err
  }
  return result
}

function applyStep(ctx: Ctx, rows: TargetRows, result: ImportRunResult, booksFromDate: string): void {
  switch (rows.target) {
    case 'groups':
      return applyGroups(ctx, rows.rows)
    case 'ledgers':
    case 'parties':
      applyLedgers(ctx, rows.rows)
      if (rows.rows.some((r) => r.opening !== null) && ctx.opts.openingDifference === 'suspense') settleOpeningDifference(ctx)
      return
    case 'units':
      return applyUnits(ctx, rows.rows)
    case 'stockGroups':
      return applyStockGroups(ctx, rows.rows)
    case 'godowns':
      return applyGodowns(ctx, rows.rows)
    case 'items':
      return applyItems(ctx, rows.rows)
    case 'batches':
      return applyBatches(ctx, rows.rows)
    case 'priceLists':
      return applyPriceLists(ctx, rows.rows, booksFromDate)
    case 'openings':
      return applyOpenings(ctx, rows.rows)
    case 'stockOpenings':
      return applyStockOpenings(ctx, rows.rows)
    case 'voucherTypes':
      return applyVoucherTypes(ctx, rows.rows)
    case 'vouchers':
      return applyVouchers(ctx, rows.rows)
    case 'tradeDocs':
      return applyTradeDocs(ctx, rows.rows)
    case 'bank':
      return applyBank(ctx, rows.rows, result)
  }
}

// ---------- batches & undo ----------

export interface ImportBatchRow {
  id: number
  source: string
  profileId: string | null
  fileName: string | null
  status: 'applied' | 'undone' | 'partly_undone'
  createdAt: string
  createdBy: string | null
  undoneAt: string | null
  errorCount: number
  created: number
  updated: number
  summary: unknown
}

export function listBatches(db: DB): ImportBatchRow[] {
  const rows = db
    .prepare(
      `SELECT b.*, (SELECT COUNT(*) FROM import_batch_items i WHERE i.batch_id = b.id AND i.action = 'create') AS created,
              (SELECT COUNT(*) FROM import_batch_items i WHERE i.batch_id = b.id AND i.action = 'update') AS updated
         FROM import_batches b ORDER BY b.id DESC`
    )
    .all() as { id: number; source: string; profile_id: string | null; file_name: string | null; status: ImportBatchRow['status']; created_at: string; created_by: string | null; undone_at: string | null; error_count: number; created: number; updated: number; summary_json: string }[]
  return rows.map((r) => ({
    id: r.id, source: r.source, profileId: r.profile_id, fileName: r.file_name, status: r.status, createdAt: r.created_at, createdBy: r.created_by,
    undoneAt: r.undone_at, errorCount: r.error_count, created: r.created, updated: r.updated, summary: JSON.parse(r.summary_json || '{}')
  }))
}

export interface UndoResult {
  binned: number
  deleted: number
  restored: number
  kept: { entity: string; id: number; reason: string }[]
}

/** Undo an import batch: bin the vouchers / orders it created, delete created masters that
 *  nothing else uses (a binned voucher still references its ledgers — those stay until the bin
 *  is purged), and restore the before-image of ledgers / items it updated. Newest first. */
export function undoImport(db: DB, batchId: number): UndoResult {
  const batch = db.prepare('SELECT * FROM import_batches WHERE id = ?').get(batchId) as { id: number; status: string } | undefined
  if (!batch) throw new Error('Import batch not found')
  if (batch.status === 'undone') throw new Error('This import was already undone')
  const items = db.prepare('SELECT * FROM import_batch_items WHERE batch_id = ? ORDER BY id DESC').all(batchId) as { id: number; entity: string; entity_id: number; action: 'create' | 'update'; before_json: string | null }[]
  const res: UndoResult = { binned: 0, deleted: 0, restored: 0, kept: [] }
  const used = (sql: string, id: number): boolean => !!db.prepare(sql).get(id)
  const rawDelete = (table: string, entity: string, id: number, inUse: string[]): void => {
    for (const sql of inUse) if (used(sql, id)) throw new Error('in use')
    const before = db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id)
    if (!before) return
    db.prepare(`DELETE FROM ${table} WHERE id = ?`).run(id)
    writeAudit(db, entity, id, 'delete', before, null)
  }
  db.transaction(() => {
    for (const it of items) {
      try {
        db.transaction(() => {
          if (it.action === 'update') {
            const before = it.before_json ? JSON.parse(it.before_json) : null
            if (!before) return
            if (it.entity === 'ledger') {
              masters.updateLedger(db, it.entity_id, ledgerInputSchema.parse(before))
              res.restored++
            } else if (it.entity === 'stockItem') {
              const b = before as StockItemRowDb
              masters.updateStockItem(db, it.entity_id, {
                name: b.name, groupId: b.group_id, unitId: b.unit_id, hsn: b.hsn, gstRate: b.gst_rate, cessRate: b.cess_rate,
                openingQtyMilli: b.opening_qty_milli, openingValue: b.opening_value, barcode: b.barcode, reorderLevelMilli: b.reorder_level_milli, mrpPaise: b.mrp_paise
              })
              res.restored++
            } else res.kept.push({ entity: it.entity, id: it.entity_id, reason: 'updates of this kind are not reverted — see the audit trail for the before-image' })
            return
          }
          switch (it.entity) {
            case 'voucher': {
              const v = db.prepare('SELECT deleted_at FROM vouchers WHERE id = ?').get(it.entity_id) as { deleted_at: string | null } | undefined
              if (v && !v.deleted_at) {
                deleteVoucher(db, it.entity_id)
                res.binned++
              }
              return
            }
            case 'trade_doc': {
              const d = db.prepare('SELECT deleted_at FROM trade_docs WHERE id = ?').get(it.entity_id) as { deleted_at: string | null } | undefined
              if (d && !d.deleted_at) {
                deleteTradeDoc(db, it.entity_id)
                res.binned++
              }
              return
            }
            case 'ledger':
              masters.deleteLedger(db, it.entity_id)
              break
            case 'stockItem':
              masters.deleteStockItem(db, it.entity_id)
              break
            case 'group':
              masters.deleteGroup(db, it.entity_id)
              break
            case 'godown':
              masters.deleteGodown(db, it.entity_id)
              break
            case 'priceRate':
              priceLevels.deleteRate(db, it.entity_id)
              break
            case 'priceLevel':
              priceLevels.deletePriceLevel(db, it.entity_id)
              break
            case 'unit':
              rawDelete('units', 'unit', it.entity_id, ['SELECT 1 FROM stock_items WHERE unit_id = ?'])
              break
            case 'stockGroup':
              rawDelete('stock_groups', 'stockGroup', it.entity_id, ['SELECT 1 FROM stock_items WHERE group_id = ?', 'SELECT 1 FROM stock_groups WHERE parent_id = ?'])
              break
            case 'batch':
              rawDelete('batches', 'batch', it.entity_id, ['SELECT 1 FROM inventory_lines WHERE batch_id = ?'])
              break
            case 'voucherType':
              rawDelete('voucher_types', 'voucherType', it.entity_id, ['SELECT 1 FROM vouchers WHERE voucher_type_id = ?'])
              break
            default:
              res.kept.push({ entity: it.entity, id: it.entity_id, reason: 'not undoable' })
              return
          }
          res.deleted++
        })()
      } catch (err) {
        const msg = (err as Error).message
        res.kept.push({ entity: it.entity, id: it.entity_id, reason: msg === 'in use' || /vouchers|in use|movements/i.test(msg) ? 'still in use (purge the bin to remove it)' : msg })
      }
    }
    const status = res.kept.length ? 'partly_undone' : 'undone'
    db.prepare("UPDATE import_batches SET status = ?, undone_at = datetime('now'), undo_summary_json = ? WHERE id = ?").run(status, JSON.stringify(res), batchId)
    writeAudit(db, 'import_batch', batchId, 'update', { status: batch.status }, { status, ...res })
  })()
  return res
}

// ---------- templates ----------

export interface ImportTemplate {
  id: number
  name: string
  profileId: string
  target: string
  headerSignature: string
  mapping: Record<string, string | null>
  options: Record<string, unknown>
  updatedAt: string
  lastUsedAt: string | null
}

type TemplateRow = { id: number; name: string; profile_id: string; target: string; header_signature: string; mapping_json: string; options_json: string; updated_at: string; last_used_at: string | null }
const mapTemplate = (r: TemplateRow): ImportTemplate => ({
  id: r.id, name: r.name, profileId: r.profile_id, target: r.target, headerSignature: r.header_signature,
  mapping: JSON.parse(r.mapping_json), options: JSON.parse(r.options_json || '{}'), updatedAt: r.updated_at, lastUsedAt: r.last_used_at
})

export function listTemplates(db: DB, filter: { profileId?: string; headerSignature?: string } = {}): ImportTemplate[] {
  const rows = db.prepare('SELECT * FROM import_templates ORDER BY COALESCE(last_used_at, updated_at) DESC, id DESC').all() as TemplateRow[]
  return rows
    .filter((r) => (!filter.profileId || r.profile_id === filter.profileId) && (!filter.headerSignature || r.header_signature === filter.headerSignature))
    .map(mapTemplate)
}

export function saveTemplate(db: DB, t: { name: string; profileId: string; target: string; headerSignature: string; mapping: Record<string, string | null>; options: Record<string, unknown> }): ImportTemplate {
  const existing = db.prepare('SELECT * FROM import_templates WHERE profile_id = ? AND name = ?').get(t.profileId, t.name) as TemplateRow | undefined
  if (existing) {
    db.prepare("UPDATE import_templates SET target = ?, header_signature = ?, mapping_json = ?, options_json = ?, updated_at = datetime('now') WHERE id = ?").run(
      t.target, t.headerSignature, JSON.stringify(t.mapping), JSON.stringify(t.options), existing.id
    )
  } else {
    db.prepare('INSERT INTO import_templates (name, profile_id, target, header_signature, mapping_json, options_json) VALUES (?, ?, ?, ?, ?, ?)').run(
      t.name, t.profileId, t.target, t.headerSignature, JSON.stringify(t.mapping), JSON.stringify(t.options)
    )
  }
  const saved = mapTemplate(db.prepare('SELECT * FROM import_templates WHERE profile_id = ? AND name = ?').get(t.profileId, t.name) as TemplateRow)
  writeAudit(db, 'import_template', saved.id, existing ? 'update' : 'create', existing ? mapTemplate(existing) : null, saved)
  return saved
}

export function touchTemplate(db: DB, id: number): void {
  db.prepare("UPDATE import_templates SET last_used_at = datetime('now') WHERE id = ?").run(id)
}

export function deleteTemplate(db: DB, id: number): void {
  const existing = db.prepare('SELECT * FROM import_templates WHERE id = ?').get(id) as TemplateRow | undefined
  if (!existing) throw new Error('Template not found')
  db.prepare('DELETE FROM import_templates WHERE id = ?').run(id)
  writeAudit(db, 'import_template', id, 'delete', mapTemplate(existing), null)
}

/** FY start of a date — exported for the books export's manifest. */
export const fyStartYear = (date: string): number => fyOf(date).startYear
