/**
 * WP 8.7 — the simple opening setup (plan 2026-10-13 §3): what a continuing business had on day
 * one, written through the EXISTING masters services in ONE transaction:
 *   - ledger openings (`ledgers.opening_balance`, dr-positive) via createLedger / updateLedger —
 *     cash, banks, customers, suppliers, loans, things used for years, and the capital account;
 *   - opening bills (`opening_bills`, migration 048): a party's opening split into the bills
 *     that make it up, so Outstandings ages each from its own date (blank = the books-begin day)
 *     and `stableBillKey` is `o:<bill number>`;
 *   - item openings (`stock_items.opening_qty_milli` / `opening_value` = qty × rate) via
 *     createStockItem / updateStockItem, which the one valuation pass reads.
 * Nothing new is posted: openings are the same columns the accountant view edits, so its
 * opening-balance screens show exactly these figures.
 *
 * The difference (everything the books open with on the debit side, stock included the way
 * the balance sheet counts it, minus the credit side — capital excluded) is the owner's money at
 * the start. It is shown first (`previewOpenings`, a rehearsal rolled back) and written to the
 * capital account only when the user confirms that very figure (`confirmCapital`); it never goes
 * to a suspense account. After a run the opening balances agree (Dr = Cr).
 *
 * Idempotent: each row carries the value the screen loaded (`base`). A row whose stored value
 * still equals its base (or already equals the answer) is replaced; one changed elsewhere since
 * the screen loaded it is left alone and reported as a warning. Running the same answers twice
 * changes nothing and writes no audit row. One `opening_batch` audit row per run records every
 * account / item / bill it changed (before → after); the services audit each account and item
 * as usual.
 */
import type { DB } from '../db/connection'
import { readCompanyInfo } from '../db/seed'
import { AppError } from '@shared/errors'
import { fyFromStartYear } from '@shared/dates'
import { ledgerInputSchema, stockItemInputSchema } from '@shared/schemas'
import { effectiveFeatures } from '@shared/features'
import {
  OTHER_KIND_GROUP, OTHER_KIND_SIDE, OPENING_OTHER_KINDS, billNames, simpleOpeningsSchema, stockLineRate, stockLineValue,
  type OpeningOtherKind, type OpeningPartyState, type OpeningsResult, type OpeningsState, type OpeningsWarning, type SimpleOpenings
} from '@shared/simple/openings'
import * as masters from './masters'
import { getFeatures, getUi, setUi } from './config'
import { writeAudit } from './audit'
import { openingTotals } from './dataImport'
import { openingBillsByParty, type OpeningBillRow } from './analysis'

const META_KEY = 'simpleOpenings'
const DEBTORS = 'Sundry Debtors'
const CREDITORS = 'Sundry Creditors'
const BANK_GROUPS = ['Bank Accounts', 'Bank OD A/c']
const CASH_GROUP = 'Cash-in-Hand'
const CAPITAL_GROUP = 'Capital Account'
const CAPITAL_NAME = "Owner's money"

interface LedgerLite { id: number; name: string; group_id: number; opening_balance: number; simple_category?: string | null }

/** The day the openings are dated on: CompanyInfo.booksBeginDate (WP 8.3), else the first FY's start. */
export function booksBeginOf(db: DB): string {
  const info = readCompanyInfo(db)
  return info.booksBeginDate ?? fyFromStartYear(info.booksFrom).from
}

const ledgersIn = (db: DB, groupNames: string[]): LedgerLite[] => {
  const ids = masters.descendantIdsByName(db, groupNames)
  return (db.prepare('SELECT * FROM ledgers ORDER BY name COLLATE NOCASE').all() as LedgerLite[]).filter((l) => ids.has(l.group_id))
}

function cashLedger(db: DB): LedgerLite | null {
  const all = ledgersIn(db, [CASH_GROUP])
  return all.find((l) => l.name === 'Cash') ?? all[0] ?? null
}

/** The capital account the difference goes to: the setup's "Owner's money", else the first
 *  account directly under Capital Account that isn't drawings. Null = none yet (created on write). */
function capitalLedger(db: DB): LedgerLite | null {
  const group = db.prepare('SELECT id FROM groups WHERE name = ?').get(CAPITAL_GROUP) as { id: number } | undefined
  if (!group) return null
  const rows = db.prepare('SELECT * FROM ledgers WHERE group_id = ? ORDER BY id').all(group.id) as LedgerLite[]
  return rows.find((l) => l.simple_category === 'owner_capital') ?? rows.find((l) => l.simple_category !== 'owner_drawings' && !/drawing/i.test(l.name)) ?? null
}

function storedMeta(db: DB): { appliedAt: string } | null {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(META_KEY) as { value: string } | undefined
  if (!row) return null
  try {
    const v = JSON.parse(row.value) as { appliedAt?: unknown }
    return typeof v.appliedAt === 'string' ? { appliedAt: v.appliedAt } : null
  } catch {
    return null
  }
}

function partyState(l: LedgerLite, sign: 1 | -1, bills: OpeningBillRow[] | undefined): OpeningPartyState {
  const amount = sign * l.opening_balance
  return {
    ledgerId: l.id,
    name: l.name,
    amount,
    bills: bills?.length ? bills.map((b) => ({ ref: b.name, date: b.date, amount: b.amount })) : amount > 0 ? [{ ref: '', date: null, amount }] : []
  }
}

/** What the screen loads: every figure as the books hold it now (so the screen starts from the
 *  truth, and its `base` values let a re-run tell untouched rows from edited ones). */
export function openingsState(db: DB): OpeningsState {
  const booksBegin = booksBeginOf(db)
  const stockOn = !!effectiveFeatures(getFeatures(db)).inventory
  const cash = cashLedger(db)
  if (!cash) throw new AppError('openings_no_cash', 'This company has no cash account')
  const banks = ledgersIn(db, BANK_GROUPS)
  const debtors = ledgersIn(db, [DEBTORS])
  const creditors = ledgersIn(db, [CREDITORS])
  const bills = openingBillsByParty(db)
  const customers = debtors.filter((l) => l.opening_balance > 0 || bills.has(l.id)).map((l) => partyState(l, 1, bills.get(l.id)))
  const suppliers = creditors.filter((l) => l.opening_balance < 0 || bills.has(l.id)).map((l) => partyState(l, -1, bills.get(l.id)))
  const itemRows = db.prepare('SELECT id, name, unit_id, opening_qty_milli, opening_value FROM stock_items ORDER BY name COLLATE NOCASE').all() as {
    id: number; name: string; unit_id: number; opening_qty_milli: number; opening_value: number
  }[]
  const items = itemRows
    .filter((r) => r.opening_qty_milli !== 0 || r.opening_value !== 0)
    .map((r) => ({ itemId: r.id, name: r.name, unitId: r.unit_id, qtyMilli: r.opening_qty_milli, value: r.opening_value, ratePaise: stockLineRate(r.opening_qty_milli, r.opening_value) }))
  const others: OpeningsState['others'] = []
  for (const kind of OPENING_OTHER_KINDS) {
    // Loans given sit under Current Assets (Loans & Advances); a bank OD is a bank, not a loan.
    const list = ledgersIn(db, [OTHER_KIND_GROUP[kind]]).filter((l) => kind !== 'loan_taken' || !masters.descendantIdsByName(db, ['Bank OD A/c']).has(l.group_id))
    for (const l of list) {
      const amount = OTHER_KIND_SIDE[kind] * l.opening_balance
      if (amount > 0) others.push({ kind, ledgerId: l.id, name: l.name, amount })
    }
  }
  const units = db.prepare('SELECT id, name, symbol FROM units ORDER BY id').all() as { id: number; name: string; symbol: string }[]
  const parts = [cash.opening_balance !== 0 || banks.some((b) => b.opening_balance !== 0), customers.length > 0, suppliers.length > 0, ...(stockOn ? [items.length > 0] : [])]
  const ui = getUi(db)
  return {
    booksBegin,
    startedFresh: typeof ui.startedFresh === 'boolean' ? ui.startedFresh : null,
    stockOn,
    appliedAt: storedMeta(db)?.appliedAt ?? null,
    cash: { ledgerId: cash.id, name: cash.name, amount: cash.opening_balance },
    banks: banks.map((b) => ({ ledgerId: b.id, name: b.name, amount: b.opening_balance })),
    customers,
    suppliers,
    items,
    others,
    pick: {
      customers: debtors.map((l) => ({ id: l.id, name: l.name })),
      suppliers: creditors.map((l) => ({ id: l.id, name: l.name })),
      items: itemRows.map((r) => ({ id: r.id, name: r.name, unitId: r.unit_id })),
      units
    },
    progress: { done: parts.filter(Boolean).length, total: parts.length }
  }
}

// ---------- the run ----------

interface Change { kind: 'account' | 'item' | 'bills'; id: number; name: string; before: unknown; after: unknown }

interface RunCtx {
  db: DB
  booksBegin: string
  warnings: OpeningsWarning[]
  changes: Change[]
}

function groupId(db: DB, name: string): number {
  const g = db.prepare('SELECT id FROM groups WHERE name = ?').get(name) as { id: number } | undefined
  if (!g) throw new AppError('group_missing', `Group ${name} missing`)
  return g.id
}

/** A row's account: the given id (which must sit under one of `groups`), an existing account of
 *  that name in those groups, or a new one under `createIn`. */
function resolveLedger(ctx: RunCtx, row: { ledgerId: number | null; name: string }, groups: string[], field: string): { id: number | null; ledger: LedgerLite | null; name: string } {
  const allowed = masters.descendantIdsByName(ctx.db, groups)
  if (row.ledgerId != null) {
    const l = ctx.db.prepare('SELECT * FROM ledgers WHERE id = ?').get(row.ledgerId) as LedgerLite | undefined
    if (!l) throw new AppError('ledger_not_found', 'Ledger not found', { field })
    if (!allowed.has(l.group_id)) throw new AppError('openings_wrong_kind', `"${l.name}" is a different kind of account`, { field, params: { name: l.name } })
    return { id: l.id, ledger: l, name: l.name }
  }
  const same = ctx.db.prepare('SELECT * FROM ledgers WHERE name = ? COLLATE NOCASE').get(row.name) as LedgerLite | undefined
  if (same) {
    if (!allowed.has(same.group_id)) throw new AppError('openings_name_taken', `"${row.name}" is already used for another account`, { field, params: { name: row.name } })
    return { id: same.id, ledger: same, name: same.name }
  }
  return { id: null, ledger: null, name: row.name }
}

const emptyLedgerInput = (name: string, gid: number, opening: number): Record<string, unknown> => ({
  name, groupId: gid, openingBalance: opening, gstin: null, stateCode: null, address: null, taxType: null, gstRate: null, hsn: null,
  tdsSectionId: null, pan: null, creditDays: null, exportType: null
})

/** Set one account's opening to `target` (dr-positive). Returns the ledger id, or null when it
 *  was left alone (changed elsewhere since the screen loaded it). */
function setOpening(ctx: RunCtx, row: { ledgerId: number | null; name: string; base: number | null }, groups: string[], createIn: string, target: number, field: string, extra: Record<string, unknown> = {}): number | null {
  const r = resolveLedger(ctx, row, groups, field)
  if (!r.ledger) {
    if (target === 0) return null
    const created = masters.createLedger(ctx.db, ledgerInputSchema.parse({ ...emptyLedgerInput(r.name, groupId(ctx.db, createIn), target), ...extra }))
    ctx.changes.push({ kind: 'account', id: created.id, name: created.name, before: null, after: target })
    return created.id
  }
  const current = r.ledger.opening_balance
  if (current === target) return r.ledger.id
  // A row the screen loaded at another value, or a row for an account it didn't load (base
  // null = it showed none) that already holds a figure: the books changed under the screen —
  // keep them.
  if (current !== (row.base ?? 0)) {
    ctx.warnings.push({ kind: 'account', name: r.ledger.name, kept: current })
    return null
  }
  const before = masters.getLedger(ctx.db, r.ledger.id)!
  masters.updateLedger(ctx.db, r.ledger.id, ledgerInputSchema.parse({ ...before, openingBalance: target }))
  ctx.changes.push({ kind: 'account', id: r.ledger.id, name: r.ledger.name, before: current, after: target })
  return r.ledger.id
}

/** Replace a party's opening bills with `bills` (already named and dated), unless they are the
 *  same — or the party has none stored and the answer is the one unnamed bill its opening
 *  already means (nothing to split). */
function setBills(ctx: RunCtx, ledgerId: number, name: string, bills: { name: string; date: string; amount: number; plain: boolean }[]): void {
  const stored = openingBillsByParty(ctx.db, [ledgerId]).get(ledgerId) ?? []
  const next = bills.map((b) => ({ name: b.name, date: b.date, dueDate: null as string | null, amount: b.amount }))
  if (!stored.length && bills.length <= 1 && bills.every((b) => b.plain)) return
  if (JSON.stringify(stored) === JSON.stringify(next)) return
  ctx.db.prepare('DELETE FROM opening_bills WHERE party_ledger_id = ?').run(ledgerId)
  const ins = ctx.db.prepare('INSERT INTO opening_bills (party_ledger_id, name, date, due_date, amount) VALUES (?, ?, ?, ?, ?)')
  for (const b of next) ins.run(ledgerId, b.name, b.date, b.dueDate, b.amount)
  ctx.changes.push({ kind: 'bills', id: ledgerId, name, before: stored, after: next })
}

function writeParties(ctx: RunCtx, input: SimpleOpenings, side: 'customers' | 'suppliers'): void {
  const sign = side === 'customers' ? 1 : -1
  const group = side === 'customers' ? DEBTORS : CREDITORS
  input[side].forEach((p, i) => {
    p.bills.forEach((b, j) => {
      if (b.date && b.date > ctx.booksBegin) {
        throw new AppError('openings_date_after_start', `A bill dated ${b.date} is after the day the books begin (${ctx.booksBegin})`, { field: `${side}.${i}.bills.${j}.date` })
      }
    })
    const total = p.bills.reduce((s, b) => s + b.amount, 0)
    const id = setOpening(ctx, p, [group], group, sign * total, `${side}.${i}.name`)
    if (id == null) return
    const names = billNames(p.bills.map((b) => b.ref))
    setBills(ctx, id, p.name, p.bills.map((b, j) => ({ name: names[j]!, date: b.date ?? ctx.booksBegin, amount: b.amount, plain: !b.ref && !b.date })))
  })
}

function itemInput(db: DB, id: number): Record<string, unknown> {
  const it = masters.getStockItem(db, id)!
  return { ...it }
}

function writeItems(ctx: RunCtx, input: SimpleOpenings): void {
  const defaultUnit = (ctx.db.prepare("SELECT id FROM units WHERE symbol IN ('Pcs', 'Nos') ORDER BY CASE symbol WHEN 'Pcs' THEN 0 ELSE 1 END LIMIT 1").get() as { id: number } | undefined)?.id
    ?? (ctx.db.prepare('SELECT id FROM units ORDER BY id LIMIT 1').get() as { id: number } | undefined)?.id
  input.items.forEach((r, i) => {
    const value = r.value ?? stockLineValue(r.qtyMilli, r.ratePaise)
    const field = `items.${i}.name`
    const existing = r.itemId != null
      ? (ctx.db.prepare('SELECT id, name, opening_qty_milli AS q, opening_value AS v FROM stock_items WHERE id = ?').get(r.itemId) as { id: number; name: string; q: number; v: number } | undefined)
      : (ctx.db.prepare('SELECT id, name, opening_qty_milli AS q, opening_value AS v FROM stock_items WHERE name = ? COLLATE NOCASE').get(r.name) as { id: number; name: string; q: number; v: number } | undefined)
    if (r.itemId != null && !existing) throw new AppError('item_not_found', 'Stock item not found', { field })
    if (!existing) {
      if (r.qtyMilli === 0 && value === 0) return
      const unitId = r.unitId ?? defaultUnit
      if (!unitId) throw new AppError('openings_invalid', 'No unit to count this item in', { field: `items.${i}.unit` })
      const created = masters.createStockItem(ctx.db, stockItemInputSchema.parse({ name: r.name, unitId, openingQtyMilli: r.qtyMilli, openingValue: value }))
      ctx.changes.push({ kind: 'item', id: created.id, name: created.name, before: null, after: { qtyMilli: r.qtyMilli, value } })
      return
    }
    if (existing.q === r.qtyMilli && existing.v === value) return
    const base = r.base ?? { qtyMilli: 0, value: 0 }
    if (existing.q !== base.qtyMilli || existing.v !== base.value) {
      ctx.warnings.push({ kind: 'item', name: existing.name, kept: existing.v })
      return
    }
    masters.updateStockItem(ctx.db, existing.id, stockItemInputSchema.parse({ ...itemInput(ctx.db, existing.id), openingQtyMilli: r.qtyMilli, openingValue: value }))
    ctx.changes.push({ kind: 'item', id: existing.id, name: existing.name, before: { qtyMilli: existing.q, value: existing.v }, after: { qtyMilli: r.qtyMilli, value } })
  })
}

/** Every opening except the capital account's, on the balance sheet's basis (dr − cr, stock
 *  added unless a Stock-in-Hand account carries it). */
function figuresWithoutCapital(db: DB, capitalId: number | null): { have: number; owe: number } {
  const t = openingTotals(db)
  const cap = capitalId == null ? 0 : (db.prepare('SELECT opening_balance AS o FROM ledgers WHERE id = ?').get(capitalId) as { o: number }).o
  return { have: t.debit - (cap > 0 ? cap : 0), owe: t.credit - (cap < 0 ? -cap : 0) }
}

function run(db: DB, input: SimpleOpenings, confirm: boolean): OpeningsResult {
  const ctx: RunCtx = { db, booksBegin: booksBeginOf(db), warnings: [], changes: [] }
  const cash = cashLedger(db)
  if (!cash) throw new AppError('openings_no_cash', 'This company has no cash account')

  // Money you have.
  setOpening(ctx, { ledgerId: cash.id, name: cash.name, base: input.cash.base }, [CASH_GROUP], CASH_GROUP, input.cash.amount, 'cash.amount')
  input.banks.forEach((b, i) => setOpening(ctx, b, BANK_GROUPS, 'Bank Accounts', b.amount, `banks.${i}.name`))
  // What people owe you / what you owe.
  writeParties(ctx, input, 'customers')
  writeParties(ctx, input, 'suppliers')
  // Stock on hand.
  writeItems(ctx, input)
  // More…: loans and things used for years.
  input.others.forEach((o, i) => {
    const kind: OpeningOtherKind = o.kind
    setOpening(ctx, o, [OTHER_KIND_GROUP[kind]], OTHER_KIND_GROUP[kind], OTHER_KIND_SIDE[kind] * o.amount, `others.${i}.name`)
  })

  // The owner's money: whatever makes the openings agree.
  const capital = capitalLedger(db)
  const { have, owe } = figuresWithoutCapital(db, capital?.id ?? null)
  const target = -(have - owe)
  const before = capital?.opening_balance ?? 0
  if (confirm && input.confirmCapital !== target) {
    throw new AppError('openings_changed', 'The figures changed since you checked them — check the difference again')
  }
  let capitalId = capital?.id ?? null
  if (before !== target) {
    if (capital) {
      const l = masters.getLedger(db, capital.id)!
      masters.updateLedger(db, capital.id, ledgerInputSchema.parse({ ...l, openingBalance: target }))
    } else {
      capitalId = masters.createLedger(db, ledgerInputSchema.parse({ ...emptyLedgerInput(CAPITAL_NAME, groupId(db, CAPITAL_GROUP), target), simpleCategory: 'owner_capital' })).id
    }
    ctx.changes.push({ kind: 'account', id: capitalId!, name: capital?.name ?? CAPITAL_NAME, before, after: target })
  }

  const balanced = openingTotals(db).difference === 0
  if (!balanced) throw new Error('Opening balances do not agree after the opening setup') // cannot happen: capital = −difference
  const result: OpeningsResult = {
    booksBegin: ctx.booksBegin,
    have,
    owe,
    difference: have - owe,
    capital: { ledgerId: capitalId, name: capital?.name ?? CAPITAL_NAME, before, after: target },
    warnings: ctx.warnings,
    changed: ctx.changes.length,
    balanced
  }
  if (ctx.changes.length > 0) {
    const prev = db.prepare('SELECT value FROM meta WHERE key = ?').get(META_KEY) as { value: string } | undefined
    const meta = { appliedAt: new Date().toISOString(), booksBegin: ctx.booksBegin, have, owe, capital: target }
    db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(META_KEY, JSON.stringify(meta))
    writeAudit(db, 'opening_batch', 0, prev ? 'update' : 'create', prev ? JSON.parse(prev.value) : null, { ...meta, changes: ctx.changes, warnings: ctx.warnings })
  }
  return result
}

class Rehearsal extends Error {
  constructor(readonly result: OpeningsResult) {
    super('rehearsal')
  }
}

/** The confirm step's figures: the whole run rehearsed in a transaction that is always rolled
 *  back (nothing persists — no account, no audit row). */
export function previewOpenings(db: DB, raw: unknown): OpeningsResult {
  const input = simpleOpeningsSchema.parse(raw)
  try {
    db.transaction(() => {
      throw new Rehearsal(run(db, input, false))
    })()
  } catch (e) {
    if (e instanceof Rehearsal) return e.result
    throw e
  }
  throw new Error('unreachable')
}

/** `simple:openings`: write the answers (one transaction) once the user confirmed the owner's
 *  money the preview showed (`confirmCapital`, required). */
export function applyOpenings(db: DB, raw: unknown): OpeningsResult {
  const input = simpleOpeningsSchema.parse(raw)
  if (input.confirmCapital === undefined) throw new AppError('openings_changed', 'Check the difference before saving')
  return db.transaction(() => run(db, input, true))()
}

/** "I started fresh": nothing to bring in — meta ui.startedFresh (audited as a company update). */
export function skipOpenings(db: DB): { startedFresh: true } {
  setUi(db, { startedFresh: true })
  return { startedFresh: true }
}
