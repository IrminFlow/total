/**
 * Import engine for the Excel / CSV wizard, Busy and Zoho exports and the Books workbook
 * (WP 6.3). Pure parsing lives in @shared/dataImport; this file resolves names to ids, applies
 * the duplicate strategy, and writes through the EXISTING services — masters create / update,
 * saveVoucher (every voucher passes the posting rules and is audited), saveTradeDoc,
 * priceLevels, costCentres, receivables (credit hold), banking (bank dates), yearEnd (closing
 * journals) — so an import can never store something the screens could not.
 *
 * Transactions. A run is ONE transaction; each record is applied in its own savepoint (a nested
 * better-sqlite3 transaction), so a bad row is rolled back and reported while the rest go in.
 * A DRY RUN executes exactly the same code and then rolls the whole transaction back — the
 * preview's counts and errors are the real ones (posting rules, duplicate numbers, locks), not a
 * guess. An applied run records an import_batches row plus one import_batch_items row per record
 * created or updated (migration 038), and one 'csv_import' summary audit row; undoImport bins /
 * deletes / restores from those items.
 *
 * Opening balances are checked ONCE, after every step of the run (ledgers, parties, openings,
 * items, stock openings — whatever the file carries): Dr must equal Cr unless the difference was
 * already there before the import. Stop rolls the whole run back; suspense posts only the
 * difference the import introduced; leave warns.
 *
 * Books workbook fidelity: every schema field without its own column rides in a "… (JSON)" cell;
 * line uids are adopted so line links (orders → challans → invoices) are restored, and a line
 * whose link cannot be restored keeps moves_stock = 0 (with a warning) so stock never moves twice.
 * Closing journals are re-flagged only when they validate as closing journals (yearEnd).
 */
import type { DB } from '../db/connection'
import type { Voucher, VoucherKind } from '@shared/domain'
import { ledgerInputSchema, stockItemInputSchema, type VoucherInput } from '@shared/schemas'
import { toUqc } from '@shared/gst/uqc'
import { fyOf } from '@shared/dates'
import { plainRupees } from '@shared/money'
import {
  kindFromWord, defaultDirection, type CostCentreRow, type GroupRow, type ItemRow, type LedgerRow, type MoreFields, type PriceLevelRow, type RowError,
  type TargetId, type TargetRows, type TradeDocDraft, type VoucherDraft, type GodownRow
} from '@shared/dataImport/targets'
import { isSpecial, SPECIAL, type SpecialLedger } from '@shared/dataImport/invoiceBuild'
import * as masters from './masters'
import { saveVoucher, deleteVoucher, getVoucher, nextVoucherNumber, getLockDate, setLockDate } from './vouchers'
import { saveTradeDoc, deleteTradeDoc, closeTradeDoc, cancelTradeDoc } from './tradeDocs'
import { listTradeDocTypes } from './tradeDocTypes'
import { findLinkLine } from './tradeLinks'
import { closeStockNote } from './tradeClosure'
import * as priceLevels from './priceLevels'
import { saveCostCentre } from './costCentres'
import { importStatement, setBankDate } from './banking'
import { setCreditHold } from './receivables'
import { setBankDetails } from './bulkPayments'
import { markImportedClose } from './yearEnd'
import { writeAudit } from './audit'
import { readCompanyInfo, writeCompanyInfo } from '../db/seed'

export type DuplicateStrategy = 'skip' | 'update' | 'create'

export interface ImportOptions {
  /** A record whose name (or voucher type + number in its FY) already exists. */
  duplicate: DuplicateStrategy
  /** Create referenced masters that are missing (units, stock groups, godowns, parties,
   *  items on vouchers); unknown account groups then fall back to Suspense A/c with a warning. */
  createMissing: boolean
  /** Opening balances that do not tie after the run: refuse the whole run, post the difference to
   *  a suspense ledger, or leave it (the balance sheet then shows "Difference in Opening Balances"). */
  openingDifference: 'block' | 'suspense' | 'leave'
  /** Bank statement target: the bank ledger to reconcile. */
  bankLedgerId?: number
  /** Books workbook: set the company's books-from year from the manifest when it has no vouchers. */
  applyBooksFrom?: number | null
  /** Changing books-from is a company-details change: owner only (IPC passes the session's right). */
  canSetBooksFrom?: boolean
  /** Books workbook: the exporting company's key — Source IDs are matched within it. */
  sourceNamespace?: string | null
  /** Books workbook: the exporting company's lock date, restored when this company has none. */
  lockDate?: string | null
  /** Who ran the import (import_batches.created_by). */
  userName?: string | null
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
  /** Opening-balance check after the run, Dr-positive paise. */
  openingCheck: { debit: number; credit: number; difference: number; stockOpening: number } | null
  bank?: { statementRows: number; matched: number; alreadyReconciled: number; unmatched: number }
  /** The run was refused as a whole (openings did not tie under "Stop"); nothing was written. */
  blocked?: string
  /** FY start year the run set as the company's books-from (null = unchanged). */
  booksFromSet: number | null
  /** Run-level warnings (books-from, lock date, closing journals …). */
  warnings: string[]
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
class OpeningsDontTie extends Error {}

// ---------- context ----------

type NameTable = 'groups' | 'ledgers' | 'units' | 'stock_groups' | 'godowns' | 'stock_items' | 'voucher_types' | 'price_levels' | 'cost_centres'

interface Deferred {
  closingJournals: { voucherId: number; line: number; label: string }[]
  creditHolds: { ledgerId: number; reason: string }[]
  docStatus: { docId: number; status: 'closed' | 'cancelled'; reason: string | null }[]
  noteClosures: { voucherId: number; reason: string | null }[]
}

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
  /** "create renamed": old name → the new record's name, per table, for every later reference. */
  renames: Map<NameTable, Map<string, string>>
  deferred: Deferred
  unknownFields: Set<string>
}

function outcome(ctx: Ctx, line: number, label: string, action: OutcomeAction, message?: string): void {
  if (action === 'create') ctx.step.created++
  else if (action === 'update') ctx.step.updated++
  else if (action === 'skip') ctx.step.skipped++
  else ctx.step.errors.push({ line, message: message ?? 'Failed' })
  if (ctx.outcomes.length < OUTCOME_CAP) ctx.outcomes.push({ line, target: ctx.target, label, action, ...(message ? { message } : {}) })
  else ctx.truncated++
}

function track(ctx: Ctx, entity: string, id: number, action: 'create' | 'update', before: unknown, line: number | null, sourceKey: string | null = null): void {
  ctx.db
    .prepare('INSERT INTO import_batch_items (batch_id, entity, entity_id, action, before_json, source_line, source_key) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(ctx.batchId, entity, id, action, before === null || before === undefined ? null : JSON.stringify(before), line, sourceKey)
}

/** Case-insensitive name → id lookups, cached per table and invalidated on create. A name the
 *  batch renamed ("create renamed") resolves to the record it created. */
function lookup(ctx: Ctx, table: NameTable, name: string, raw = false): number | null {
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
  const key = name.trim().toLowerCase()
  const renamed = raw ? undefined : ctx.renames.get(table)?.get(key)
  return m.get(renamed ? renamed.toLowerCase() : key) ?? null
}
const forget = (ctx: Ctx, table: string): void => void ctx.cache.delete(table)

function rename(ctx: Ctx, table: NameTable, from: string, to: string): void {
  const m = ctx.renames.get(table) ?? new Map<string, string>()
  m.set(from.trim().toLowerCase(), to)
  ctx.renames.set(table, m)
}

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
function freeName(ctx: Ctx, table: NameTable, name: string): string {
  for (let n = 2; n < 1000; n++) {
    const candidate = `${name} (${n})`
    if (lookup(ctx, table, candidate, true) === null) return candidate
  }
  throw new Error(`No free name for "${name}"`)
}

// ---------- "… (JSON)" extras: names ↔ ids ----------

const snakeToCamel = (k: string): string => k.replace(/_([a-z])/g, (_m, c: string) => c.toUpperCase())

/** FK columns the Books workbook writes as names / codes. */
const REF_COLUMNS: Record<string, 'section' | 'priceLevel' | 'ledger'> = {
  tds_section_id: 'section', tds_payable_section_id: 'section', tds_default_section_id: 'section',
  tcs_section_id: 'section', tcs_payable_section_id: 'section', tcs_default_section_id: 'section',
  price_level_id: 'priceLevel', party_ledger_id: 'ledger'
}
const BOOL_COLUMNS = new Set(['rcm', 'msme_registered', 'track_serials', 'credit_hold'])

function resolveRef(ctx: Ctx, kind: 'section' | 'priceLevel' | 'ledger', value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null
  const name = String(value)
  if (kind === 'section') {
    const row = ctx.db.prepare('SELECT id FROM tds_sections WHERE code = ? COLLATE NOCASE').get(name) as { id: number } | undefined
    if (!row) throw new Error(`Unknown TDS/TCS section "${name}"`)
    return row.id
  }
  const id = lookup(ctx, kind === 'priceLevel' ? 'price_levels' : 'ledgers', name)
  if (id === null) throw new Error(`Unknown ${kind === 'priceLevel' ? 'price level' : 'ledger'} "${name}"`)
  return id
}

/** Extras → service-input fields (camelCase) for the keys the schema knows; the rest returned. */
function mapExtras(ctx: Ctx, more: MoreFields | null | undefined, known: readonly string[]): { input: Record<string, unknown>; rest: MoreFields } {
  const input: Record<string, unknown> = {}
  const rest: MoreFields = {}
  for (const [col, raw] of Object.entries(more ?? {})) {
    let v: unknown = raw
    if (REF_COLUMNS[col]) v = resolveRef(ctx, REF_COLUMNS[col]!, raw)
    else if (BOOL_COLUMNS.has(col)) v = raw === true || raw === 1 || raw === '1'
    const key = snakeToCamel(col.replace(/^transport_distance$/, 'transport_distance_km'))
    if (known.includes(key)) input[key] = v
    else rest[col] = raw
  }
  return { input, rest }
}

function noteUnknown(ctx: Ctx, fields: string[]): void {
  for (const f of fields) {
    if (ctx.unknownFields.has(`${ctx.target}.${f}`)) continue
    ctx.unknownFields.add(`${ctx.target}.${f}`)
    ctx.step.warnings.push(`Field "${f}" is not imported`)
  }
}

const LEDGER_INPUT_KEYS = Object.keys(ledgerInputSchema.shape)
const ITEM_INPUT_KEYS = Object.keys(stockItemInputSchema.shape)

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
      const existing = lookup(ctx, 'groups', r.name, true)
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
        if (name !== r.name) rename(ctx, 'groups', r.name, name)
        outcome(ctx, r.line, name, 'create', name !== r.name ? `Created as "${name}" — the file's references follow` : undefined)
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

function ledgerInput(ctx: Ctx, r: LedgerRow, groupId: number, name: string, existing: ReturnType<typeof masters.getLedger>): { input: ReturnType<typeof ledgerInputSchema.parse>; rest: MoreFields } {
  const stateCode = r.stateCode ?? (r.gstin ? r.gstin.slice(0, 2) : null)
  const { input: extra, rest } = mapExtras(ctx, r.more, LEDGER_INPUT_KEYS)
  const input = ledgerInputSchema.parse({
    ...(existing ?? {}),
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
    // (Not for a Books workbook: its PAN column is the record, blank included.)
    pan: r.pan ?? existing?.pan ?? (r.gstin && !ctx.opts.sourceNamespace ? r.gstin.slice(2, 12) : null),
    creditDays: r.creditDays ?? existing?.creditDays ?? null,
    creditLimit: r.creditLimit ?? existing?.creditLimit ?? null,
    exportType: existing?.exportType ?? null,
    rcm: existing?.rcm ?? false,
    itcEligibility: existing?.itcEligibility ?? 'eligible',
    ...extra
  })
  return { input, rest }
}

/** Ledger fields that have no ledgerInputSchema path: the credit hold (receivables.setCreditHold,
 *  applied at the END so the file's own invoices to the party still import), the learned ledger
 *  cess rate and the payroll statutory tag (both written with an audited update). */
function applyLedgerRest(ctx: Ctx, id: number, rest: MoreFields): void {
  const unknown: string[] = []
  const direct: Record<string, unknown> = {}
  const bank = ['bank_account_no', 'bank_ifsc', 'bank_account_name', 'bank_email']
  if (bank.some((k) => str(rest[k]))) {
    // Beneficiary details through WP 4.1's service (validated, audited).
    setBankDetails(ctx.db, id, { accountNo: str(rest.bank_account_no), ifsc: str(rest.bank_ifsc), accountName: str(rest.bank_account_name), email: str(rest.bank_email) })
  }
  for (const [k, v] of Object.entries(rest)) {
    if (bank.includes(k)) continue
    if (k === 'credit_hold') {
      if (v === true || v === 1 || v === '1') ctx.deferred.creditHolds.push({ ledgerId: id, reason: String(rest.credit_hold_reason ?? 'Imported') })
    } else if (k === 'credit_hold_reason' || k === 'credit_hold_at' || k === 'is_system') {
      // carried with credit_hold / a property of the chart, not a field to copy
    } else if (k === 'cess_rate' || k === 'statutory_kind') direct[k] = v
    else unknown.push(k)
  }
  if (Object.keys(direct).length) {
    const before = ctx.db.prepare('SELECT cess_rate, statutory_kind FROM ledgers WHERE id = ?').get(id)
    for (const [k, v] of Object.entries(direct)) ctx.db.prepare(`UPDATE ledgers SET ${k} = ? WHERE id = ?`).run(v ?? null, id)
    writeAudit(ctx.db, 'ledger', id, 'update', before, { ...(before as object), ...direct })
  }
  noteUnknown(ctx, unknown)
}

function applyLedgers(ctx: Ctx, rows: LedgerRow[]): void {
  for (const r of rows) {
    const existing = lookup(ctx, 'ledgers', r.name, true)
    if (existing !== null && ctx.opts.duplicate === 'skip') {
      outcome(ctx, r.line, r.name, 'skip', 'Already exists')
      continue
    }
    attempt(ctx, r.line, r.name, () => {
      if (existing !== null && ctx.opts.duplicate === 'update') {
        const before = masters.getLedger(ctx.db, existing)!
        let groupId = before.groupId
        if (r.group) {
          // An unknown group on an UPDATE never moves the ledger (to Suspense or anywhere).
          const g = lookup(ctx, 'groups', r.group)
          if (g === null) ctx.step.warnings.push(`Line ${r.line}: group "${r.group}" not found — "${r.name}" keeps its group`)
          else groupId = g
        } else if (r.partyType) groupId = resolveLedgerGroup(ctx, r)
        // System ledgers (Cash) keep their group.
        const { input, rest } = ledgerInput(ctx, r, before.isSystem ? before.groupId : groupId, before.name, before)
        masters.updateLedger(ctx.db, existing, input)
        applyLedgerRest(ctx, existing, rest)
        track(ctx, 'ledger', existing, 'update', before, r.line)
        outcome(ctx, r.line, r.name, 'update')
        return
      }
      const name = existing !== null ? freeName(ctx, 'ledgers', r.name) : r.name
      const { input, rest } = ledgerInput(ctx, r, resolveLedgerGroup(ctx, r), name, null)
      const created = masters.createLedger(ctx.db, input)
      applyLedgerRest(ctx, created.id, rest)
      track(ctx, 'ledger', created.id, 'create', null, r.line)
      forget(ctx, 'ledgers')
      if (name !== r.name) rename(ctx, 'ledgers', r.name, name)
      outcome(ctx, r.line, name, 'create', name !== r.name ? `Created as "${name}" — the file's references follow` : undefined)
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

function applyGodowns(ctx: Ctx, rows: GodownRow[]): void {
  for (const r of rows) {
    const existing = lookup(ctx, 'godowns', r.name, true)
    if (existing !== null && ctx.opts.duplicate !== 'update') {
      outcome(ctx, r.line, r.name, 'skip', 'Already exists')
      continue
    }
    attempt(ctx, r.line, r.name, () => {
      const kind = r.kind ?? undefined
      const partyLedgerId = r.party ? resolveRef(ctx, 'ledger', r.party) : undefined
      if (existing !== null) {
        const before = masters.listGodowns(ctx.db).find((g) => g.id === existing)!
        masters.updateGodown(ctx.db, existing, { name: before.name, address: r.address ?? before.address, kind, partyLedgerId })
        track(ctx, 'godown', existing, 'update', before, r.line)
        outcome(ctx, r.line, r.name, 'update')
        return
      }
      const g = masters.createGodown(ctx.db, { name: r.name, address: r.address, kind, partyLedgerId })
      track(ctx, 'godown', g.id, 'create', null, r.line)
      forget(ctx, 'godowns')
      outcome(ctx, r.line, r.name, 'create')
    })
  }
}

function applyPriceLevels(ctx: Ctx, rows: PriceLevelRow[]): void {
  for (const r of rows) {
    const existing = lookup(ctx, 'price_levels', r.name)
    if (existing !== null && ctx.opts.duplicate !== 'update') {
      outcome(ctx, r.line, r.name, 'skip', 'Already exists')
      continue
    }
    attempt(ctx, r.line, r.name, () => {
      const saved = priceLevels.savePriceLevel(ctx.db, { name: r.name, inclusiveOfTax: r.inclusive, isDefault: r.isDefault }, existing ?? undefined)
      track(ctx, 'priceLevel', saved.id, existing ? 'update' : 'create', null, r.line)
      forget(ctx, 'price_levels')
      outcome(ctx, r.line, r.name, existing ? 'update' : 'create')
    })
  }
}

function applyCostCentres(ctx: Ctx, rows: CostCentreRow[]): void {
  let pending = rows
  for (let pass = 0; pass < 20 && pending.length; pass++) {
    const next: CostCentreRow[] = []
    for (const r of pending) {
      if (lookup(ctx, 'cost_centres', r.name) !== null) {
        outcome(ctx, r.line, r.name, 'skip', 'Already exists')
        continue
      }
      const parentId = r.parent ? lookup(ctx, 'cost_centres', r.parent) : null
      if (r.parent && parentId === null) {
        if (rows.some((x) => x.name.toLowerCase() === r.parent!.toLowerCase()) && pass < 19) next.push(r)
        else outcome(ctx, r.line, r.name, 'error', `Unknown parent cost centre "${r.parent}"`)
        continue
      }
      attempt(ctx, r.line, r.name, () => {
        const cc = saveCostCentre(ctx.db, { name: r.name, parentId, active: r.active })
        track(ctx, 'costCentre', cc.id, 'create', null, r.line)
        forget(ctx, 'cost_centres')
        outcome(ctx, r.line, r.name, 'create')
      })
    }
    pending = next
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

type StockItemRowDb = {
  id: number; name: string; group_id: number | null; unit_id: number; hsn: string | null; gst_rate: number | null; cess_rate: number | null
  opening_qty_milli: number; opening_value: number; barcode: string | null; reorder_level_milli: number | null; mrp_paise: number | null
  valuation_method: 'weighted_avg' | 'fifo'; track_serials: number; tcs_section_id: number | null; standard_cost_paise: number | null
}

function itemOpeningValue(r: { openingQtyMilli: number | null; openingValue: number | null; openingRate: number | null }): number | null {
  if (r.openingValue !== null) return r.openingValue
  if (r.openingRate !== null && r.openingQtyMilli !== null) return Math.round((r.openingQtyMilli * r.openingRate) / 1000)
  return null
}

function itemInputFromRow(b: StockItemRowDb): Record<string, unknown> {
  return {
    name: b.name, groupId: b.group_id, unitId: b.unit_id, hsn: b.hsn, gstRate: b.gst_rate, cessRate: b.cess_rate,
    openingQtyMilli: b.opening_qty_milli, openingValue: b.opening_value, barcode: b.barcode, reorderLevelMilli: b.reorder_level_milli,
    mrpPaise: b.mrp_paise, valuationMethod: b.valuation_method, trackSerials: !!b.track_serials, tcsSectionId: b.tcs_section_id,
    standardCostPaise: b.standard_cost_paise
  }
}

function applyItems(ctx: Ctx, rows: ItemRow[]): void {
  for (const r of rows) {
    const existing = lookup(ctx, 'stock_items', r.name, true)
    if (existing !== null && ctx.opts.duplicate === 'skip') {
      outcome(ctx, r.line, r.name, 'skip', 'Already exists')
      continue
    }
    attempt(ctx, r.line, r.name, () => {
      const before = existing !== null ? (ctx.db.prepare('SELECT * FROM stock_items WHERE id = ?').get(existing) as StockItemRowDb) : null
      const update = before !== null && ctx.opts.duplicate === 'update'
      const { input: extra, rest } = mapExtras(ctx, r.more, ITEM_INPUT_KEYS)
      noteUnknown(ctx, Object.keys(rest))
      const input = stockItemInputSchema.parse({
        ...(update ? itemInputFromRow(before!) : {}),
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
        mrpPaise: r.mrpPaise ?? (update ? before!.mrp_paise : null),
        ...extra
      })
      if (update) {
        masters.updateStockItem(ctx.db, existing!, input)
        track(ctx, 'stockItem', existing!, 'update', before, r.line)
        outcome(ctx, r.line, r.name, 'update')
      } else {
        const created = masters.createStockItem(ctx.db, input)
        track(ctx, 'stockItem', created.id, 'create', null, r.line)
        forget(ctx, 'stock_items')
        if (input.name !== r.name) rename(ctx, 'stock_items', r.name, input.name)
        outcome(ctx, r.line, input.name, 'create', input.name !== r.name ? `Created as "${input.name}" — the file's references follow` : undefined)
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

function applyPriceLists(ctx: Ctx, rows: { line: number; level: string; item: string; rate: number; from: string | null; minQtyMilli: number | null; more?: MoreFields | null }[], booksFromDate: string): void {
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
      const m = r.more ?? {}
      const currency = str(m.currency) ?? 'INR'
      const existing = ctx.db
        .prepare('SELECT * FROM price_list_rates WHERE price_level_id = ? AND stock_item_id = ? AND currency = ? AND min_qty_milli = ? AND effective_from = ?')
        .get(levelId, itemId, currency, r.minQtyMilli ?? 0, from) as { id: number; rate: number } | undefined
      if (existing && ctx.opts.duplicate !== 'update') {
        outcome(ctx, r.line, label, 'skip', 'A rate from that date already exists')
        return
      }
      const saved = priceLevels.saveRate(ctx.db, {
        priceLevelId: levelId, stockItemId: itemId, rate: r.rate, effectiveFrom: from, minQtyMilli: r.minQtyMilli ?? 0,
        effectiveTo: str(m.effective_to), discountBp: num(m.discount_bp) ?? 0, currency
      }, existing?.id)
      track(ctx, 'priceRate', saved.id, existing ? 'update' : 'create', existing ?? null, r.line)
      outcome(ctx, r.line, label, existing ? 'update' : 'create')
    })
  }
}

function applyVoucherTypes(ctx: Ctx, rows: { line: number; name: string; kind: VoucherKind | null; prefix: string | null; more?: MoreFields | null }[]): void {
  for (const r of rows) {
    if (lookup(ctx, 'voucher_types', r.name) !== null) {
      outcome(ctx, r.line, r.name, 'skip', 'Already exists')
      continue
    }
    attempt(ctx, r.line, r.name, () => {
      if (!r.kind) throw new Error('Kind is missing')
      const m = r.more ?? {}
      const vt = masters.createVoucherType(ctx.db, {
        name: r.name, kind: r.kind, numbering: m.numbering === 'manual' ? 'manual' : 'auto', prefix: r.prefix ?? '', suffix: str(m.suffix) ?? '',
        padWidth: num(m.pad_width) ?? 0, restartFy: m.restart_fy === undefined ? true : !!m.restart_fy
      })
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
}

/** The trial-balance check, once after every step of the run. Only a difference the IMPORT
 *  introduced counts: a source that balanced never gets a suspense posting, and a company that
 *  was already out of balance is warned, not blocked. */
function settleOpenings(ctx: Ctx, before: number): string | null {
  const t = openingTotals(ctx.db)
  const introduced = t.difference - before
  if (introduced === 0) return t.difference === 0 ? null : `Opening balances already differed by ₹${plainRupees(Math.abs(t.difference))} before this import — left as it was`
  const amount = `₹${plainRupees(Math.abs(introduced))} ${introduced > 0 ? 'Dr' : 'Cr'}`
  if (ctx.opts.openingDifference === 'suspense') {
    const id = ensureLedger(ctx, DIFF_LEDGER, 'Suspense A/c')
    const current = masters.getLedger(ctx.db, id)!.openingBalance
    setLedgerOpening(ctx, id, current - introduced, null)
    return `Openings did not tie: ${amount} posted to "${DIFF_LEDGER}" (Suspense A/c)`
  }
  if (ctx.opts.openingDifference === 'leave') return `Opening balances differ by ${amount} — the balance sheet will show "Difference in Opening Balances"`
  throw new OpeningsDontTie(
    `Opening balances do not tie: Dr ₹${plainRupees(t.debit)} vs Cr ₹${plainRupees(t.credit)} (difference ${amount}). Nothing was imported — fix the file, or choose to post the difference to a suspense ledger.`
  )
}

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
      masters.updateStockItem(ctx.db, id, stockItemInputSchema.parse({ ...itemInputFromRow(before), openingQtyMilli: r.qtyMilli, openingValue: value }))
      track(ctx, 'stockItem', id, 'update', before, r.line)
      outcome(ctx, r.line, r.item, 'update')
    })
  }
}

// ---------- vouchers ----------

function resolveVoucherType(ctx: Ctx, d: VoucherDraft): { id: number; kind: VoucherKind; numbering: 'auto' | 'manual'; restartFy: boolean } {
  const pick = (row: { id: number; kind: VoucherKind; numbering: 'auto' | 'manual'; restart_fy: number } | undefined) =>
    row ? { id: row.id, kind: row.kind, numbering: row.numbering, restartFy: !!row.restart_fy } : undefined
  const cols = 'id, kind, numbering, restart_fy'
  const byName = d.typeName ? pick(ctx.db.prepare(`SELECT ${cols} FROM voucher_types WHERE name = ? COLLATE NOCASE`).get(d.typeName) as never) : undefined
  if (byName) return byName
  const kind = d.kind ?? (d.typeName ? kindFromWord(d.typeName) : null)
  if (!kind) throw new Error(`Unknown voucher type "${d.typeName}"`)
  // A kind word ("Sale", "Rcpt", "credit_note") → the company's default type of that kind.
  const isKindWord = kindFromWord(d.typeName) === kind && d.typeName.trim().length <= 16
  if (isKindWord || !ctx.opts.createMissing) {
    const def = pick(ctx.db.prepare(`SELECT ${cols} FROM voucher_types WHERE kind = ? ORDER BY is_system DESC, id LIMIT 1`).get(kind) as never)
    if (def) return def
  }
  const vt = masters.createVoucherType(ctx.db, { name: d.typeName, kind, numbering: 'auto', prefix: '', suffix: '', padWidth: 0, restartFy: true })
  track(ctx, 'voucherType', vt.id, 'create', null, d.lines[0] ?? null)
  forget(ctx, 'voucher_types')
  ctx.step.warnings.push(`Created voucher type "${d.typeName}" (${kind})`)
  return { id: vt.id, kind, numbering: 'auto', restartFy: true }
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

function sectionId(ctx: Ctx, code: string, kind: 'tds' | 'tcs'): number {
  const row = ctx.db.prepare('SELECT id FROM tds_sections WHERE code = ? COLLATE NOCASE AND kind = ?').get(code, kind) as { id: number } | undefined
  if (!row) throw new Error(`Unknown ${kind.toUpperCase()} section "${code}"`)
  return row.id
}

const str = (v: unknown): string | null => (v === null || v === undefined || v === '' ? null : String(v))
const num = (v: unknown): number | null => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v))

interface PostSave {
  bankDates: { lineOrder: number; date: string }[]
  frozen: { uid: string; line: number }[]
}

function voucherInputFor(ctx: Ctx, d: VoucherDraft, vt: { id: number; kind: VoucherKind }, number: string | undefined): { input: VoucherInput; post: PostSave } {
  const line = d.lines[0] ?? 0
  const vm = d.more ?? {}
  const partyId = d.party ? resolveLedgerName(ctx, d.party, vt.kind, d.party, line) : null
  const post: PostSave = { bankDates: [], frozen: [] }
  const lines = d.ledgerLines.map((l, i) => {
    const lm = l.more ?? {}
    if (str(lm.bank_date)) post.bankDates.push({ lineOrder: i, date: String(lm.bank_date) })
    const allocs = Array.isArray(lm.cost_allocations) ? (lm.cost_allocations as { centre: string; amount: number }[]) : []
    return {
      ledgerId: resolveLedgerName(ctx, l.ledger, vt.kind, d.party, l.line), drCr: l.drCr, amount: l.amount,
      costAllocations: allocs.map((a) => {
        const cc = lookup(ctx, 'cost_centres', a.centre)
        if (cc === null) throw new Error(`Unknown cost centre "${a.centre}"`)
        return { costCentreId: cc, amount: a.amount }
      })
    }
  })
  const partyAmount = partyId !== null ? lines.filter((l) => l.ledgerId === partyId).reduce((s, l) => s + l.amount, 0) : 0
  const inventory = d.items.map((it) => {
    const lm = it.more ?? {}
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
    // Line links: restored when the source line exists (it was imported earlier in id order);
    // otherwise a line that did not move stock is frozen at moves_stock = 0 after the save.
    const link = lm.link as { from_line_uid?: string; link_type?: 'fulfil' | 'return' } | undefined
    let source: { lineUid: string; linkType: 'fulfil' | 'return' } | null = null
    if (link?.from_line_uid) {
      if (findLinkLine(ctx.db, link.from_line_uid)) source = { lineUid: link.from_line_uid, linkType: link.link_type ?? 'fulfil' }
      else ctx.step.warnings.push(`Line ${it.line}: the order / challan line it was drawn from is not in this company — link not restored`)
    }
    if (!source && lm.moves_stock === 0 && str(lm.line_uid)) post.frozen.push({ uid: String(lm.line_uid), line: it.line })
    const discount = num(lm.discount_paise) ?? 0
    return {
      stockItemId, godownId, batchId, qtyMilli: it.qtyMilli,
      ratePaise: it.ratePaise ?? (it.qtyMilli > 0 ? Math.round(((amount + discount) * 1000) / it.qtyMilli) : 0),
      discountPaise: discount || undefined,
      amount, direction: it.direction ?? defaultDirection(vt.kind),
      isAbsolute: lm.is_absolute === 1 || lm.is_absolute === true || undefined,
      serials: Array.isArray(lm.serials) ? (lm.serials as string[]) : undefined,
      lineUid: str(lm.line_uid) ?? undefined,
      source
    }
  })
  const billRefs = d.bills.map((b) => ({ kind: b.kind, name: b.name.slice(0, 80), amount: b.amount ?? partyAmount, dueDate: b.dueDate })).filter((b) => b.amount > 0)
  const purpose = str((vm as Record<string, unknown>)['trade.purpose'])
  return {
    input: {
      voucherTypeId: vt.id,
      date: d.date,
      number,
      partyLedgerId: partyId,
      narration: d.narration ? d.narration.slice(0, 1000) : null,
      reference: d.reference ? d.reference.slice(0, 120) : null,
      instrumentNo: str(vm.instrument_no),
      instrumentDate: str(vm.instrument_date),
      transporterId: str(vm.transporter_id),
      vehicleNo: str(vm.vehicle_no),
      transportDistanceKm: num(vm.transport_distance),
      posOverride: d.posOverride,
      currencyCode: d.currencyCode,
      exchangeRate: d.exchangeRate,
      isOptional: d.isOptional || undefined,
      postDated: d.postDated || undefined,
      lines,
      inventory,
      billRefs,
      // A file's deduction is taken as typed (manual) unless a Books workbook says it was the rate table's.
      tds: d.tds ? { sectionId: sectionId(ctx, d.tds.section, 'tds'), baseAmount: d.tds.base, tdsAmount: d.tds.amount, isManual: vm['tds.is_manual'] !== 0, autoPayable: false } : null,
      tcs: d.tcs ? { sectionId: sectionId(ctx, d.tcs.section, 'tcs'), baseAmount: d.tcs.base, tcsAmount: d.tcs.amount, isManual: vm['tcs.is_manual'] !== 0, autoPayable: false } : null,
      ...(vt.kind === 'delivery_note' || vt.kind === 'receipt_note'
        ? { trade: { purpose: (purpose ?? (vt.kind === 'delivery_note' ? 'supply' : 'purchase')) as 'supply' } }
        : {})
    },
    post
  }
}

/** After the save: bank dates (banking.setBankDate), lines whose link did not survive frozen at
 *  moves_stock = 0, e-invoice / e-way facts, closing-journal flag and note closure (deferred). */
function afterVoucherSave(ctx: Ctx, voucherId: number, d: VoucherDraft, post: PostSave, label: string): void {
  if (post.bankDates.length) {
    const lineIds = ctx.db.prepare('SELECT id FROM voucher_lines WHERE voucher_id = ? ORDER BY line_order, id').all(voucherId) as { id: number }[]
    for (const b of post.bankDates) if (lineIds[b.lineOrder]) setBankDate(ctx.db, lineIds[b.lineOrder]!.id, b.date)
  }
  for (const f of post.frozen) {
    const res = ctx.db.prepare('UPDATE inventory_lines SET moves_stock = 0 WHERE voucher_id = ? AND line_uid = ?').run(voucherId, f.uid)
    if (res.changes) {
      writeAudit(ctx.db, 'voucher', voucherId, 'update', { lineUid: f.uid, movesStock: true }, { lineUid: f.uid, movesStock: false, via: 'books import' })
      ctx.step.warnings.push(`Line ${f.line}: its link could not be restored — kept as not moving stock (it moved on the original challan / GRN)`)
    }
  }
  const vm = (d.more ?? {}) as Record<string, unknown>
  const edoc = ['irn', 'irn_ack_no', 'irn_ack_date', 'ewb_no', 'ewb_valid_upto'].filter((k) => str(vm[k]))
  if (edoc.length) {
    for (const k of edoc) ctx.db.prepare(`UPDATE vouchers SET ${k} = ? WHERE id = ?`).run(String(vm[k]), voucherId)
    writeAudit(ctx.db, 'voucher', voucherId, 'update', null, Object.fromEntries(edoc.map((k) => [k, vm[k]])))
  }
  if (vm.is_year_end_close === 1 || vm.is_year_end_close === true) ctx.deferred.closingJournals.push({ voucherId, line: d.lines[0] ?? 0, label })
  if (str(vm['trade.closed_at'])) ctx.deferred.noteClosures.push({ voucherId, reason: str(vm['trade.close_reason']) })
}

/** The live record an import of this row duplicates: first by Source ID (within the exporting
 *  company), then by type + number in the same FY (whole history when the type never restarts). */
function findDuplicate(ctx: Ctx, entity: 'voucher' | 'trade_doc', sourceKey: string | null, typeId: number, restartFy: boolean, number: string | null, date: string): number | null {
  if (sourceKey) {
    const table = entity === 'voucher' ? 'vouchers' : 'trade_docs'
    const row = ctx.db
      .prepare(
        `SELECT i.entity_id AS id FROM import_batch_items i JOIN ${table} t ON t.id = i.entity_id
          WHERE i.entity = ? AND i.source_key = ? AND i.undone_at IS NULL AND t.deleted_at IS NULL ORDER BY i.id DESC LIMIT 1`
      )
      .get(entity, sourceKey) as { id: number } | undefined
    if (row) return row.id
  }
  if (!number) return null
  const fy = fyOf(date)
  const table = entity === 'voucher' ? 'vouchers' : 'trade_docs'
  const typeCol = entity === 'voucher' ? 'voucher_type_id' : 'doc_type_id'
  // A Books row has its own identity (Source ID): when that is new here, only the same number on
  // the same date is the same record (re-importing into the exporting company itself) — the
  // source may legitimately hold two vouchers with one number.
  const window = sourceKey ? ' AND date = ?' : restartFy ? ' AND date BETWEEN ? AND ?' : ''
  const params = sourceKey ? [date] : restartFy ? [fy.from, fy.to] : []
  const row = ctx.db
    .prepare(`SELECT id FROM ${table} WHERE ${typeCol} = ? AND number = ? AND deleted_at IS NULL${window} ORDER BY id LIMIT 1`)
    .get(typeId, number, ...params) as { id: number } | undefined
  return row?.id ?? null
}

const sourceKeyOf = (ctx: Ctx, sourceId: string | null | undefined): string | null =>
  sourceId ? `${ctx.opts.sourceNamespace ?? 'file'}#${sourceId}` : null

/** A free number for "create" on a duplicate: the series' next for auto numbering, else "N/2"… */
function freeVoucherNumber(ctx: Ctx, vt: { id: number; numbering: 'auto' | 'manual'; restartFy: boolean }, number: string, date: string): string {
  if (vt.numbering === 'auto') return nextVoucherNumber(ctx.db, vt.id, date)
  for (let n = 2; n < 1000; n++) {
    const candidate = `${number}/${n}`
    if (findDuplicate(ctx, 'voucher', null, vt.id, vt.restartFy, candidate, date) === null) return candidate
  }
  throw new Error(`No free number for ${number}`)
}

function applyVouchers(ctx: Ctx, drafts: VoucherDraft[]): void {
  for (const d of drafts) {
    const line = d.lines[0] ?? 0
    const label = `${d.typeName || d.kind} ${d.number ?? ''} · ${d.date}`.trim()
    attempt(ctx, line, label, () => {
      const vt = resolveVoucherType(ctx, d)
      const sourceKey = sourceKeyOf(ctx, d.sourceId)
      const dup = findDuplicate(ctx, 'voucher', sourceKey, vt.id, vt.restartFy, d.number, d.date)
      if (dup !== null && ctx.opts.duplicate === 'skip') {
        outcome(ctx, line, label, 'skip', 'A voucher with this type and number already exists in that year')
        return
      }
      if (dup !== null && ctx.opts.duplicate === 'update') {
        const before = getVoucher(ctx.db, dup)!
        const { input, post } = voucherInputFor(ctx, d, vt, d.number ?? undefined)
        saveVoucher(ctx.db, input, dup, { adoptLineUids: true })
        afterVoucherSave(ctx, dup, d, post, label)
        track(ctx, 'voucher', dup, 'update', before, line, sourceKey)
        outcome(ctx, line, label, 'update')
        return
      }
      const number = dup !== null && d.number ? freeVoucherNumber(ctx, vt, d.number, d.date) : (d.number ?? undefined)
      const { input, post } = voucherInputFor(ctx, d, vt, number)
      const saved = saveVoucher(ctx.db, input, undefined, { adoptLineUids: true })
      afterVoucherSave(ctx, saved.id, d, post, label)
      track(ctx, 'voucher', saved.id, 'create', null, line, sourceKey)
      const notes = [...d.notes, ...(dup !== null ? [`Numbered ${saved.number} — ${d.number} was taken`] : [])]
      outcome(ctx, line, label, 'create', notes.length ? notes.join('; ') : undefined)
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
      const sourceKey = sourceKeyOf(ctx, d.sourceId)
      const dup = findDuplicate(ctx, 'trade_doc', sourceKey, type.id, type.restartFy, d.number, d.date)
      if (dup !== null && ctx.opts.duplicate !== 'create') {
        outcome(ctx, line, label, 'skip', 'A document with this number already exists in that year')
        return
      }
      const dm = (d.more ?? {}) as Record<string, unknown>
      const partyId = resolveLedgerName(ctx, d.party, d.kind === 'purchase_order' ? 'purchase' : 'sales', d.party, line)
      const saved = saveTradeDoc(
        ctx.db,
        {
          docTypeId: type.id, date: d.date, number: dup !== null ? undefined : (d.number ?? undefined), partyLedgerId: partyId, validUntil: d.validUntil,
          dueDate: d.dueDate, reference: d.reference, narration: d.narration, terms: str(dm.terms), posOverride: str(dm.pos_override),
          currencyCode: str(dm.currency_code), exchangeRate: num(dm.exchange_rate),
          lines: d.items.map((it) => {
            const lm = (it.more ?? {}) as Record<string, unknown>
            const link = lm.link as { from_line_uid?: string; link_type?: 'fulfil' | 'return' } | undefined
            return {
              stockItemId: resolveItem(ctx, it.item, it.line), godownId: it.godown ? ensureGodown(ctx, it.godown, it.line) : null,
              qtyMilli: it.qtyMilli, ratePaise: it.ratePaise, discountPaise: it.discountPaise, amount: it.amount, dueDate: it.dueDate,
              description: str(lm.description), lineUid: str(lm.line_uid) ?? undefined,
              source: link?.from_line_uid && findLinkLine(ctx.db, link.from_line_uid) ? { lineUid: link.from_line_uid, linkType: link.link_type ?? 'fulfil' } : null
            }
          })
        },
        undefined,
        { adoptLineUids: true }
      )
      track(ctx, 'trade_doc', saved.doc.id, 'create', null, line, sourceKey)
      if (dm.status === 'closed' || dm.status === 'cancelled') ctx.deferred.docStatus.push({ docId: saved.doc.id, status: dm.status, reason: str(dm.close_reason) })
      outcome(ctx, line, label, 'create')
    })
  }
}

function applyBank(ctx: Ctx, rows: { line: number; date: string; description: string; reference: string; deposit: number; withdrawal: number }[], result: ImportRunResult): void {
  if (!ctx.opts.bankLedgerId) throw new Error('Choose the bank ledger the statement belongs to')
  const DQ = String.fromCharCode(34) // a double quote (CSV field quoting)
  const q = (s: string): string => DQ + s.split(DQ).join(DQ + DQ) + DQ
  const plain = (p: number): string => (p ? plainRupees(p) : '')
  // The banking service's own statement format (banking.parseStatementCsv): Date, Description,
  // Reference, Withdrawal, Deposit — ISO dates, plain decimals (integer formatting, money.ts).
  const csv = ['Date,Description,Reference,Withdrawal,Deposit', ...rows.map((r) => [r.date, q(r.description), q(r.reference), plain(r.withdrawal), plain(r.deposit)].join(','))].join('\n')
  const r = importStatement(ctx.db, ctx.opts.bankLedgerId, csv, { apply: !ctx.dryRun })
  // Recorded in the batch so undo clears the bank dates and bins the vouchers rules created.
  if (!ctx.dryRun) {
    for (const m of r.matches) track(ctx, 'bank_date', m.lineId, 'update', { bankDate: null }, null)
    for (const a of r.autoCreated) track(ctx, 'voucher', a.voucherId, 'create', null, null)
  }
  result.bank = { statementRows: r.statementRows, matched: r.matched, alreadyReconciled: r.alreadyReconciled, unmatched: r.unmatched.length }
  for (const row of rows) outcome(ctx, row.line, `${row.date} ${row.description}`.trim(), 'skip', 'Handed to Banking')
  ctx.step.skipped = 0
  ctx.step.warnings.push(`Banking matched ${r.matched} of ${r.statementRows} statement rows${r.unmatched.length ? `; ${r.unmatched.length} unmatched — reconcile them in Banking` : ''}`)
}

// ---------- run ----------

const OPENING_TARGETS: TargetId[] = ['openings', 'ledgers', 'parties', 'items', 'stockOpenings']

export function runImport(db: DB, plan: PlanStep[], rawOpts: Partial<ImportOptions>, meta: RunMeta, dryRun: boolean): ImportRunResult {
  const opts: ImportOptions = { ...DEFAULT_OPTIONS, ...rawOpts }
  const result: ImportRunResult = { dryRun, batchId: null, steps: [], outcomes: [], outcomesTruncated: 0, openingCheck: null, booksFromSet: null, warnings: [] }
  const info = readCompanyInfo(db)
  const booksFromDate = `${info.booksFrom}-04-01`
  const exec = db.transaction(() => {
    const batchId = Number(
      db.prepare('INSERT INTO import_batches (source, profile_id, file_name, options_json, created_by) VALUES (?, ?, ?, ?, ?)')
        .run(meta.source, meta.profileId, meta.fileName, JSON.stringify(opts), opts.userName ?? null).lastInsertRowid
    )
    const cache = new Map<string, Map<string, number>>()
    const renames = new Map<NameTable, Map<string, string>>()
    const deferred: Deferred = { closingJournals: [], creditHolds: [], docStatus: [], noteClosures: [] }
    const unknownFields = new Set<string>()
    if (opts.applyBooksFrom && opts.applyBooksFrom !== info.booksFrom) {
      if (opts.canSetBooksFrom === false) {
        result.warnings.push(`The workbook's books start in FY ${opts.applyBooksFrom} — only an owner can change this company's first year (Company details)`)
      } else if (db.prepare('SELECT 1 FROM vouchers LIMIT 1').get()) {
        result.warnings.push(`The workbook's books start in FY ${opts.applyBooksFrom}; this company already has vouchers, so its first year was left as it is`)
      } else {
        writeCompanyInfo(db, { ...info, booksFrom: opts.applyBooksFrom })
        writeAudit(db, 'company', 0, 'update', info, { ...info, booksFrom: opts.applyBooksFrom })
        result.booksFromSet = opts.applyBooksFrom
      }
    }
    const openingBefore = openingTotals(db).difference
    let lastCtx: Ctx | null = null
    for (const s of plan) {
      const step: StepResult = { target: s.rows.target, sheet: s.sheet, created: 0, updated: 0, skipped: 0, errors: [...(s.errors ?? [])], warnings: [] }
      result.steps.push(step)
      const ctx: Ctx = { db, opts, batchId, dryRun, outcomes: result.outcomes, truncated: 0, step, target: s.rows.target, cache, renames, deferred, unknownFields }
      lastCtx = ctx
      for (const e of s.errors ?? []) if (result.outcomes.length < OUTCOME_CAP) result.outcomes.push({ line: e.line, target: s.rows.target, label: e.field ?? '', action: 'error', message: e.message })
      applyStep(ctx, s.rows, result, booksFromDate)
      result.outcomesTruncated += ctx.truncated
    }
    if (lastCtx) {
      const ctx = lastCtx
      // Deferred to the end: closures (no new links after them), credit holds (the file's own
      // invoices to the party went in first), closing-journal flags (after the year's vouchers).
      for (const c of deferred.closingJournals) {
        try {
          db.transaction(() => markImportedClose(db, c.voucherId))()
        } catch (err) {
          result.warnings.push(`${c.label}: imported as an ordinary journal, not a closing entry — ${(err as Error).message}`)
        }
      }
      for (const s of deferred.docStatus) {
        if (s.status === 'closed') closeTradeDoc(db, s.docId, s.reason)
        else cancelTradeDoc(db, s.docId, s.reason)
      }
      for (const n of deferred.noteClosures) closeStockNote(db, n.voucherId, n.reason)
      for (const h of deferred.creditHolds) setCreditHold(db, h.ledgerId, true, h.reason)
      if (opts.lockDate && !getLockDate(db)) setLockDate(db, opts.lockDate)
      if (plan.some((s) => OPENING_TARGETS.includes(s.rows.target))) {
        const msg = settleOpenings(ctx, openingBefore)
        if (msg) result.warnings.push(msg)
        result.openingCheck = openingTotals(db)
      }
    }
    const summary = {
      steps: result.steps.map((s) => ({ target: s.target, sheet: s.sheet, created: s.created, updated: s.updated, skipped: s.skipped, errors: s.errors.length })),
      openingCheck: result.openingCheck,
      bank: result.bank ?? null,
      warnings: result.warnings
    }
    const errorCount = result.steps.reduce((n, s) => n + s.errors.length, 0)
    // WP 3.8: each record is audited by the service that wrote it; this row ties them to the import.
    writeAudit(db, 'csv_import', batchId, 'import', null, { source: meta.source, profile: meta.profileId, file: meta.fileName, ...summary, errors: errorCount })
    const lastAudit = (db.prepare('SELECT MAX(id) AS id FROM audit_log').get() as { id: number | null }).id
    db.prepare('UPDATE import_batches SET summary_json = ?, error_count = ?, last_audit_id = ? WHERE id = ?').run(JSON.stringify(summary), errorCount, lastAudit, batchId)
    if (dryRun) throw new DryRunRollback()
    result.batchId = batchId
  })
  try {
    exec()
  } catch (err) {
    if (err instanceof OpeningsDontTie) {
      // The whole run is refused: nothing it reported as created / updated exists.
      result.blocked = err.message
      result.batchId = null
      result.booksFromSet = null
      for (const o of result.outcomes) {
        if (o.action === 'create' || o.action === 'update') {
          o.action = 'skip'
          o.message = 'Not imported — opening balances do not tie'
        }
      }
      for (const s of result.steps) {
        s.skipped += s.created + s.updated
        s.created = 0
        s.updated = 0
      }
      result.steps[result.steps.length - 1]?.errors.push({ line: 0, message: err.message })
    } else if (!(err instanceof DryRunRollback)) throw err
  }
  return result
}

function applyStep(ctx: Ctx, rows: TargetRows, result: ImportRunResult, booksFromDate: string): void {
  switch (rows.target) {
    case 'groups':
      return applyGroups(ctx, rows.rows)
    case 'ledgers':
    case 'parties':
      return applyLedgers(ctx, rows.rows)
    case 'units':
      return applyUnits(ctx, rows.rows)
    case 'stockGroups':
      return applyStockGroups(ctx, rows.rows)
    case 'godowns':
      return applyGodowns(ctx, rows.rows)
    case 'priceLevels':
      return applyPriceLevels(ctx, rows.rows)
    case 'costCentres':
      return applyCostCentres(ctx, rows.rows)
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

/** A voucher as saveVoucher input — to put back the full before-image of an updated voucher. */
export function voucherToInput(v: Voucher): VoucherInput {
  return {
    voucherTypeId: v.voucherTypeId, date: v.date, number: v.number, partyLedgerId: v.partyLedgerId, narration: v.narration, reference: v.reference,
    instrumentNo: v.instrumentNo, instrumentDate: v.instrumentDate, transporterId: v.transporterId, vehicleNo: v.vehicleNo,
    transportDistanceKm: v.transportDistanceKm, posOverride: v.posOverride, currencyCode: v.currencyCode, exchangeRate: v.exchangeRate,
    postDated: v.postDated || undefined, isOptional: v.isOptional || undefined,
    lines: v.lines.map((l) => ({ ledgerId: l.ledgerId, drCr: l.drCr, amount: l.amount, costAllocations: l.costAllocations.map((a) => ({ costCentreId: a.costCentreId, amount: a.amount })) })),
    inventory: v.inventory.map((l) => ({
      stockItemId: l.stockItemId, godownId: l.godownId, batchId: l.batchId, qtyMilli: l.qtyMilli, ratePaise: l.ratePaise, discountPaise: l.discountPaise,
      amount: l.amount, direction: l.direction, isAbsolute: l.isAbsolute || undefined, serials: l.serials, lineUid: l.lineUid, source: l.source ?? null
    })),
    billRefs: v.billRefs.map((b) => ({ kind: b.kind, name: b.name, amount: b.amount, dueDate: b.dueDate })),
    tds: v.tds ? { sectionId: v.tds.sectionId, baseAmount: v.tds.baseAmount, tdsAmount: v.tds.tdsAmount, isManual: true, autoPayable: false } : null,
    tcs: v.tcs ? { sectionId: v.tcs.sectionId, baseAmount: v.tcs.baseAmount, tcsAmount: v.tcs.tcsAmount, isManual: true, autoPayable: false } : null,
    ...(v.trade ? { trade: v.trade } : {})
  }
}

const AUDIT_ENTITY_OF: Record<string, string> = { bank_date: 'voucher_line' }

/** Undo an import batch: bin the vouchers / orders it created, delete created masters that
 *  nothing else uses (a binned voucher still references its ledgers — those stay until the bin
 *  is purged), restore the full before-image of what it updated, and clear the bank dates a
 *  statement hand-off set. Newest first. A record a user edited after the import is left alone
 *  and reported. Idempotent: each item is marked undone, and a partly undone batch can be retried. */
export function undoImport(db: DB, batchId: number): UndoResult {
  const batch = db.prepare('SELECT * FROM import_batches WHERE id = ?').get(batchId) as { id: number; status: string; last_audit_id: number | null } | undefined
  if (!batch) throw new Error('Import batch not found')
  if (batch.status === 'undone') throw new Error('This import was already undone')
  const items = db.prepare('SELECT * FROM import_batch_items WHERE batch_id = ? AND undone_at IS NULL ORDER BY id DESC').all(batchId) as {
    id: number; entity: string; entity_id: number; action: 'create' | 'update'; before_json: string | null
  }[]
  const res: UndoResult = { binned: 0, deleted: 0, restored: 0, kept: [] }
  const used = (sql: string, id: number): boolean => !!db.prepare(sql).get(id)
  const rawDelete = (table: string, entity: string, id: number, inUse: string[]): void => {
    for (const sql of inUse) if (used(sql, id)) throw new Error('in use')
    const before = db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id)
    if (!before) return
    db.prepare(`DELETE FROM ${table} WHERE id = ?`).run(id)
    writeAudit(db, entity, id, 'delete', before, null)
  }
  const editedAfter = (entity: string, id: number): boolean =>
    batch.last_audit_id !== null &&
    !!db
      .prepare("SELECT 1 FROM audit_log WHERE entity = ? AND entity_id = ? AND id > ? AND action IN ('update', 'delete', 'restore', 'purge') LIMIT 1")
      .get(AUDIT_ENTITY_OF[entity] ?? entity, id, batch.last_audit_id)
  const markDone = db.prepare("UPDATE import_batch_items SET undone_at = datetime('now') WHERE id = ?")
  db.transaction(() => {
    for (const it of items) {
      if (editedAfter(it.entity, it.entity_id)) {
        res.kept.push({ entity: it.entity, id: it.entity_id, reason: 'edited after the import — left as it is' })
        continue
      }
      try {
        db.transaction(() => {
          if (it.action === 'update') {
            const before = it.before_json ? JSON.parse(it.before_json) : null
            if (!before) return
            if (it.entity === 'ledger') masters.updateLedger(db, it.entity_id, ledgerInputSchema.parse(before))
            else if (it.entity === 'stockItem') masters.updateStockItem(db, it.entity_id, stockItemInputSchema.parse(itemInputFromRow(before as StockItemRowDb)))
            else if (it.entity === 'voucher') saveVoucher(db, voucherToInput(before as Voucher), it.entity_id)
            else if (it.entity === 'bank_date') setBankDate(db, it.entity_id, (before as { bankDate: string | null }).bankDate)
            else if (it.entity === 'group') masters.updateGroup(db, it.entity_id, { name: before.name, parentId: before.parentId })
            else if (it.entity === 'godown') masters.updateGodown(db, it.entity_id, before)
            else if (it.entity === 'priceRate' && before.id) {
              priceLevels.saveRate(db, { priceLevelId: before.price_level_id, stockItemId: before.stock_item_id, rate: before.rate, effectiveFrom: before.effective_from, effectiveTo: before.effective_to, minQtyMilli: before.min_qty_milli, discountBp: before.discount_bp, currency: before.currency }, it.entity_id)
            } else throw new Error('updates of this kind are not reverted — see the audit trail for the before-image')
            res.restored++
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
            case 'costCentre':
              rawDelete('cost_centres', 'costCentre', it.entity_id, ['SELECT 1 FROM voucher_line_cost_allocations WHERE cost_centre_id = ?', 'SELECT 1 FROM cost_centres WHERE parent_id = ?'])
              break
            case 'batch':
              rawDelete('batches', 'batch', it.entity_id, ['SELECT 1 FROM inventory_lines WHERE batch_id = ?'])
              break
            case 'voucherType':
              rawDelete('voucher_types', 'voucherType', it.entity_id, ['SELECT 1 FROM vouchers WHERE voucher_type_id = ?'])
              break
            default:
              throw new Error('not undoable')
          }
          res.deleted++
        })()
        markDone.run(it.id)
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

export function deleteTemplate(db: DB, id: number): void {
  const existing = db.prepare('SELECT * FROM import_templates WHERE id = ?').get(id) as TemplateRow | undefined
  if (!existing) throw new Error('Template not found')
  db.prepare('DELETE FROM import_templates WHERE id = ?').run(id)
  writeAudit(db, 'import_template', id, 'delete', mapTemplate(existing), null)
}
