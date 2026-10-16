// simple:post / simple:preview (WP 9.1, plan 2026-10-13 §0.1 / §3): the ONE way simple screens
// write the books. An intent (shared/simple/intents.ts — Zod + the pure mapping to the editors'
// own form state) becomes 1–2 voucher payloads built by the accountant editors' builders, saved
// through saveVoucher inside ONE transaction — so lock dates, credit holds, the GST registration
// rule, stock rules and trade-link rules all apply unchanged, and the full editor opens what was
// saved and round-trips it.
//
// - preview rehearses the very same run (WP 5.3 rehearse: a transaction that is always rolled
//   back), so every refusal surfaces before the user saves and nothing persists;
// - post runs it for real; any failure rolls the whole intent back (no voucher, no ledger the
//   editor would create on first use, no audit row, no number used);
// - a saveVoucher refusal is re-thrown with the INTENT's field (WP 8.5 AppError), so a simple
//   screen can show it under the question that caused it;
// - `clientId` makes a retry idempotent (simple_posts): the same id returns the same vouchers;
// - the vouchers are returned together, so the save card's Undo bins them as ONE undo group
//   (voucher:undoSave) and Restore brings them back together.
import { createHash } from 'crypto'
import type { DB } from '../db/connection'
import type Database from 'better-sqlite3-multiple-ciphers'
import type { CompanyInfo, SaveVoucherWarnings, VoucherKind } from '@shared/domain'
import { gstRegistrationOf } from '@shared/gst/registration'
import { addBreakups, computeGst, supplyTypeFor } from '@shared/gst/calc'
import { addDaysISO, fyOf, toDisplayDate } from '@shared/dates'
import { AppError, ERROR_MAP, isAppError, isErrorCode, type ErrorIssue } from '@shared/errors'
import { normalizeInvoiceNumber } from '@shared/gst/recon2b'
import {
  intentSentences, mapIntent, NeedTaxLedgers, normaliseIntent, simpleIntentSchema, SIMPLE_MAX_DAYS_AHEAD,
  type IntentContext, type IntentFacts, type IntentLedger, type IntentOriginal, type IntentVoucherType, type MappedEntry,
  type NormalIntent, type PreviewEntry, type SimplePostResult, type SimplePreview
} from '@shared/simple/intents'
import { pickTaxLedger, taxLedgerIdsFrom, taxSideOf, voucherCarriesGst, voucherTaxLedgers, type TaxLedgerIds, type TaxSide } from '@shared/voucherEdit'
import { companyT } from '../i18n'
import { createLedger, findOrCreateLedger, listLedgers, listStockItems, listVoucherTypes } from './masters'
import { getLockDate, getVoucher, IN_BOOKS, lockedError, nextVoucherNumber, NOT_DELETED, saveVoucher } from './vouchers'
import { counterAccounts, ensureWalkIn, WALK_IN_NAME } from './counter'
import { pricingLoader, rememberSalePrices } from './pricing'
import { openBills, partyAllocation, partyAllocationWithCredits } from './analysis'
import { fyIsClosed } from './cashFinanceCommon'
import { writeAudit } from './audit'
import { saveSummary } from './undo'
import { ledgerClassifier } from '../ai/ledgerClass'
import { rehearse } from '../ai/drafting/rehearse'
import { getFeatures } from './config'
import { tdsEligible } from './tdsWorkbench'
import { stockSummary } from './stockAnalysis'
import { listBomVersions } from './bom'
import { costPreview, saveManufacture, suggestedSaleRate } from './manufacture'
import { recipeRows } from '@shared/simple/stock'
import { sanitiseHandoffEntry, type HandoffCreate, type HandoffEntry, type IntentFormResult } from '@shared/simple/handoff'
import { LABOUR_CREDIT_GROUP, LABOUR_CREDIT_LEDGER, LABOUR_EXPENSE_GROUP, LABOUR_EXPENSE_LEDGER } from '@shared/manufacture'

// ---------------------------------------------------------------- context

const KINDS_FOR: Record<NormalIntent['kind'], VoucherKind[]> = {
  sale: ['sales', 'receipt'],
  purchase: ['purchase', 'payment'],
  money_in: ['receipt'],
  money_out: ['payment'],
  move_money: ['contra'],
  return_sale: ['credit_note', 'payment'],
  return_purchase: ['debit_note', 'receipt'],
  stock_count: ['physical_stock'],
  make_goods: ['stock_journal']
}

/** WP 9.7: the stock and recipe facts the stock intents map from — the same services the
 *  accountant screens read (Stock summary's valuation pass, the Manufacture screen's cost
 *  preview, its sale-rate prefill and its labour accounts). */
function loadStockContext(db: DB, n: NormalIntent): Pick<IntentContext, 'stock' | 'make'> {
  if (n.kind !== 'stock_count' && n.kind !== 'make_goods') return {}
  const stock = new Map(stockSummary(db, n.date).map((r) => [r.stockItemId, { name: r.name, unit: r.unitSymbol, qtyMilli: r.closingQtyMilli, value: r.closingValue }]))
  if (n.kind === 'stock_count') return { stock }
  const versions = listBomVersions(db)
  const recipe = recipeRows(n.itemId, n.qtyMilli, versions, n.date)
  const preview = recipe ? costPreview(db, { date: n.date, finishedItemId: n.itemId, lines: recipe.rows.map((r) => ({ itemId: r.componentId, qtyMilli: r.qtyMilli })) }) : null
  // Labour recorded here (wages still to pay) posts on the editor's own accounts, found or
  // created exactly as saveManufacture does (rolled back with a rehearsal).
  const postLabour = n.labour > 0 && !n.labourRecorded
  return {
    stock,
    make: {
      versions,
      suggestedPrice: suggestedSaleRate(db, n.itemId, n.date).ratePaise,
      priced: preview ? { lines: preview.lines.map((l) => ({ itemId: l.itemId, qtyMilli: l.qtyMilli, costPaise: l.costPaise, onHandQtyMilli: l.onHandQtyMilli })), totalPaise: preview.totalPaise } : { lines: [], totalPaise: 0 },
      labour: {
        expenseId: postLabour ? findOrCreateLedger(db, LABOUR_EXPENSE_LEDGER, LABOUR_EXPENSE_GROUP) : null,
        creditId: postLabour ? findOrCreateLedger(db, LABOUR_CREDIT_LEDGER, LABOUR_CREDIT_GROUP) : null
      }
    }
  }
}

function byCategory(db: DB, ...keys: string[]): number | null {
  for (const k of keys) {
    const r = db.prepare('SELECT id FROM ledgers WHERE simple_category = ? ORDER BY id LIMIT 1').get(k) as { id: number } | undefined
    if (r) return r.id
  }
  return null
}

function firstUnder(db: DB, group: string, nameLike?: RegExp): number | null {
  const rows = db
    .prepare(
      `WITH RECURSIVE g(id) AS (SELECT id FROM groups WHERE name = ? UNION ALL SELECT c.id FROM groups c JOIN g ON c.parent_id = g.id)
       SELECT id, name FROM ledgers WHERE group_id IN (SELECT id FROM g) ORDER BY id`
    )
    .all(group) as { id: number; name: string }[]
  return rows.find((r) => !nameLike || nameLike.test(r.name))?.id ?? null
}

function partyOf(n: NormalIntent, walkInId: number | null): number | null {
  switch (n.kind) {
    case 'sale':
      return n.customerId ?? walkInId
    case 'purchase':
      return n.supplierId
    case 'money_in':
      return n.customerId ?? n.supplierId
    case 'money_out':
      return n.supplierId ?? n.customerId
    default:
      return null
  }
}

/** WP 9.5: the in-books credit / debit notes a bill "owns" through their `reference` (a return of
 *  just an amount carries the bill's number — a purchase: the supplier's bill number): notes of the
 *  same party, dated on or after the bill, that are NOT linked to any bill's lines as a `return`
 *  (those belong to the bill they are linked to), and with no later bill of the same party and the
 *  same number in between — numbers restart every year, so a note on this year's bill "1" must not
 *  also count against last year's bill "1". */
// An explicit statement type: `ReturnType<DB['prepare']>` of the generic prepare() resolved its
// bind parameters differently as the program grew (tsc then refused the 11 arguments below).
type NotesStmt = Database.Statement<unknown[]>
const notesByRefStmts = new WeakMap<DB, Map<string, NotesStmt>>()
export function notesByReference(db: DB, kind: 'sales' | 'purchase', bill: { id: number; partyId: number; date: string; ref: string }): number[] {
  const key = (a: string): string => (kind === 'sales' ? `${a}.number` : `COALESCE(NULLIF(TRIM(${a}.reference), ''), ${a}.number)`)
  const cache = notesByRefStmts.get(db) ?? new Map<string, NotesStmt>()
  notesByRefStmts.set(db, cache)
  const stmt: NotesStmt =
    cache.get(kind) ??
    db.prepare<unknown[]>(
      `SELECT v.id FROM vouchers v JOIN voucher_types vt ON vt.id = v.voucher_type_id
       WHERE vt.kind = ? AND v.party_ledger_id = ? AND TRIM(v.reference) = ? AND v.date >= ? AND v.id <> ? AND ${IN_BOOKS}
         AND NOT EXISTS (SELECT 1 FROM line_links ll WHERE ll.to_voucher_id = v.id AND ll.link_type = 'return')
         AND NOT EXISTS (
           SELECT 1 FROM vouchers b2 JOIN voucher_types t2 ON t2.id = b2.voucher_type_id
           WHERE t2.kind = ? AND b2.party_ledger_id = v.party_ledger_id AND b2.id <> ? AND ${key('b2')} = ?
             AND (b2.date > ? OR (b2.date = ? AND b2.id > ?)) AND b2.date <= v.date
             AND b2.deleted_at IS NULL AND b2.post_dated = 0 AND b2.is_optional = 0)
       ORDER BY v.date, v.id`
    )
  cache.set(kind, stmt)
  return (stmt.all(kind === 'sales' ? 'credit_note' : 'debit_note', bill.partyId, bill.ref, bill.date, bill.id, kind, bill.id, bill.ref, bill.date, bill.date, bill.id) as { id: number }[]).map((r) => r.id)
}

/** The bill a return is made against, as on the return's date (WP 9.1; WP 9.5's return screens
 *  read it too — services/simpleReturns.ts): what is pending on it, its GST rates as it posted
 *  them, each item line with what is left to return (live `return` links), and — for a bill
 *  without item lines — the value before GST still returnable. */
export function loadOriginal(db: DB, company: CompanyInfo, ledgers: ReturnType<typeof listLedgers>, billId: number, date: string): IntentOriginal | null {
  const v = getVoucher(db, billId)
  if (!v || v.deletedAt || v.partyLedgerId == null) return null
  const kind = (db.prepare('SELECT kind FROM voucher_types WHERE id = ?').get(v.voucherTypeId) as { kind: VoucherKind } | undefined)?.kind
  if (kind !== 'sales' && kind !== 'purchase') return null
  const tax = voucherTaxLedgers(v, ledgers, taxSideOf(kind))
  const taxIds = new Set([tax.cgst, tax.sgst, tax.igst, tax.cess, tax.roundOff].filter((x): x is number => x != null))
  const counter = kind === 'sales' ? 'cr' : 'dr'
  const accountIds = [...new Set(v.lines.filter((l) => l.ledgerId !== v.partyLedgerId && l.drCr === counter && !taxIds.has(l.ledgerId)).map((l) => l.ledgerId))]
  const billName = v.billRefs.find((r) => r.kind === 'new')?.name ?? v.number
  // Its OWN bill (by voucher, never just the name — another open bill may share it).
  const pending = openBills(db, v.partyLedgerId, date).find((b) => b.voucherId === v.id && b.number === billName)?.pending ?? 0
  const items = new Map(listStockItems(db).map((i) => [i.id, i]))
  // The rates as the BILL posted them: the item rates only while they still give the tax the bill
  // carries (a rate changed since = unknown → the return asks / refuses), a ledger-line bill's own
  // rate only when computeGst at that rate gives its tax back exactly.
  const partyState = ledgers.find((l) => l.id === v.partyLedgerId)?.stateCode ?? company.stateCode
  const supply = supplyTypeFor(company.stateCode, v.posOverride ?? partyState)
  const stored = v.lines.filter((l) => l.ledgerId === tax.cgst || l.ledgerId === tax.sgst || l.ledgerId === tax.igst || l.ledgerId === tax.cess).reduce((s, l) => s + l.amount, 0)
  const taxOf = (g: { cgst: number; sgst: number; igst: number; cess: number }): number => g.cgst + g.sgst + g.igst + g.cess
  let rates: number[] | null
  let amountLeft: number | null = null
  const noteReference = kind === 'sales' ? v.number : (v.reference?.trim() || v.number)
  if (v.inventory.length) {
    const buckets = new Map<string, { rate: number; cess: number; taxable: number }>()
    for (const l of v.inventory) {
      const it = items.get(l.stockItemId)
      const rate = it?.gstRate ?? 0
      const cess = it?.cessRate ?? 0
      const b = buckets.get(`${rate}|${cess}`) ?? { rate, cess, taxable: 0 }
      b.taxable += l.amount
      buckets.set(`${rate}|${cess}`, b)
    }
    const recomputed = taxOf(addBreakups([...buckets.values()].map((b) => computeGst(b.taxable, b.rate, supply, b.cess))))
    rates = stored === 0 ? [0] : recomputed === stored ? [...new Set([...buckets.values()].map((b) => b.rate))] : null
  } else {
    // A ledger-line bill: its tax over its taxable value (a percentage, never an amount), checked.
    const taxable = v.lines.filter((l) => accountIds.includes(l.ledgerId)).reduce((s, l) => s + l.amount, 0)
    const r = taxable > 0 ? Math.round((stored * 10_000) / taxable) / 100 : 0
    rates = stored === 0 ? [0] : taxOf(computeGst(taxable, r, supply)) === stored ? [r] : null
    // WP 9.5: less what earlier returns took back — in-books notes of this party that carry the
    // bill as their reference, on the same account(s) (the note's side of them).
    if (accountIds.length) {
      const notes = notesByReference(db, kind, { id: v.id, partyId: v.partyLedgerId, date: v.date, ref: noteReference })
      const returnedTaxable = notes.length
        ? (db
            .prepare(
              `SELECT COALESCE(SUM(amount), 0) AS t FROM voucher_lines WHERE voucher_id IN (${notes.map(() => '?').join(',')})
               AND dr_cr = ? AND ledger_id IN (${accountIds.map(() => '?').join(',')})`
            )
            .get(...notes, kind === 'sales' ? 'dr' : 'cr', ...accountIds) as { t: number }).t
        : 0
      amountLeft = Math.max(0, taxable - returnedTaxable)
    }
  }
  const returned = db.prepare(
    `SELECT COALESCE(SUM(ll.qty_milli), 0) AS q FROM line_links ll JOIN vouchers v ON v.id = ll.to_voucher_id
     WHERE ll.from_line_uid = ? AND ll.link_type = 'return' AND ${NOT_DELETED}`
  )
  return {
    voucherId: v.id,
    kind,
    date: v.date,
    number: v.number,
    partyId: v.partyLedgerId,
    accountId: accountIds.length === 1 ? accountIds[0]! : null,
    billName,
    pending,
    carriesGst: voucherCarriesGst(v, tax),
    rates,
    noteReference,
    amountLeft,
    lines: v.inventory
      .filter((l) => !!l.lineUid)
      .map((l) => ({
        lineUid: l.lineUid!, itemId: l.stockItemId, qtyMilli: l.qtyMilli, ratePaise: l.ratePaise, discountPaise: l.discountPaise,
        godownId: l.godownId, batchId: l.batchId, leftMilli: l.qtyMilli - (returned.get(l.lineUid) as { q: number }).q
      }))
  }
}

/** Everything the pure mapping reads, from the books as they are now (inside the transaction). */
export function loadIntentContext(db: DB, company: CompanyInfo, n: NormalIntent): IntentContext {
  const ledgers = listLedgers(db)
  const cls = ledgerClassifier(db)
  const items = listStockItems(db)
  const types: IntentContext['types'] = {}
  const allTypes = listVoucherTypes(db)
  for (const k of KINDS_FOR[n.kind]) {
    const t = allTypes.filter((x) => x.kind === k).sort((a, b) => a.id - b.id)[0]
    if (t) types[k] = { id: t.id, name: t.name, numbering: t.numbering, next: t.numbering === 'manual' ? '' : nextVoucherNumber(db, t.id, n.date) } satisfies IntentVoucherType
  }
  // The walk-in customer is created on first use, like the counter (rolled back with a rehearsal).
  const walkInId = n.kind === 'sale' && n.customerId == null ? ensureWalkIn(db) : null
  const acc = counterAccounts(db)
  const bankId = ledgers.find((l) => cls.cls(l.id) === 'bank')?.id ?? null
  const ledgerMap = new Map<number, IntentLedger>(
    ledgers.map((l) => [l.id, { id: l.id, name: l.name, cls: cls.cls(l.id), stateCode: l.stateCode, gstRate: l.gstRate, creditDays: l.creditDays }])
  )
  if (walkInId != null && !ledgerMap.has(walkInId)) {
    const w = db.prepare('SELECT id, name FROM ledgers WHERE id = ?').get(walkInId) as { id: number; name: string }
    ledgerMap.set(w.id, { id: w.id, name: w.name, cls: 'debtor', stateCode: null, gstRate: null, creditDays: null })
  }
  const partyId = partyOf(n, walkInId)
  const prices = new Map<number, { ratePaise: number; discountPaise: number }>()
  if ((n.kind === 'sale' || n.kind === 'purchase') && n.items) {
    const price = pricingLoader(db)
    const partyState = (partyId != null ? ledgerMap.get(partyId)?.stateCode : null) ?? company.stateCode
    const supply = supplyTypeFor(company.stateCode, partyState)
    n.items.forEach((l, i) => {
      if (l.rate != null) return
      const p = price({ date: n.date, partyLedgerId: partyId, currency: 'INR', supply }, l.itemId, l.qtyMilli)
      if (p.ratePaise != null && p.ratePaise > 0) prices.set(i, { ratePaise: p.ratePaise, discountPaise: p.discountPaise })
    })
  }
  // Names still open per party (bills + named credits), over every date — a new bill never reuses one.
  const original = n.kind === 'return_sale' || n.kind === 'return_purchase' ? loadOriginal(db, company, ledgers, n.billId, n.date) : null
  const takenNames = new Map<number, Set<string>>()
  for (const pid of [partyId, original?.partyId].filter((x): x is number => x != null)) {
    const a = partyAllocationWithCredits(db, pid, '9999-12-31')
    takenNames.set(pid, new Set([...a.bills.filter((b) => b.pending > 0).map((b) => b.number), ...a.credits.map((c) => c.name)]))
  }
  // WP 9.5: a return's own bill (its credit) never reuses ANY name the party's bills have had — a
  // note numbered like a settled sale ("1" and "1") would otherwise look settled by that sale's
  // receipt (by name), so Undo would call it "already used" and a later refund-by-name could land
  // on the wrong bill.
  if (original) {
    const used = db
      .prepare(`SELECT DISTINCT br.name FROM bill_refs br JOIN vouchers v ON v.id = br.voucher_id WHERE br.party_ledger_id = ? AND ${NOT_DELETED}`)
      .all(original.partyId) as { name: string }[]
    const set = takenNames.get(original.partyId)!
    for (const u of used) set.add(u.name)
  }
  const bills = new Map<number, { name: string; date: string; pending: number; voucherId: number | null }[]>()
  if ((n.kind === 'money_in' || n.kind === 'money_out') && partyId != null) {
    bills.set(partyId, openBills(db, partyId, n.date).filter((b) => b.pending > 0).map((b) => ({ name: b.number, date: b.date, pending: b.pending, voucherId: b.voucherId })))
  }
  // WP 9.4: a supplier's refund is set against their named credits (oldest first).
  // A refund needs credit held with us at all (named or not): `heldCredit` (simple_refund_no_credit).
  const openCredits = new Map<number, { name: string; amount: number }[]>()
  const heldCredit = new Map<number, number>()
  const refundParty = n.kind === 'money_in' ? n.supplierId : n.kind === 'money_out' ? n.customerId : null
  if (refundParty != null) {
    const a = partyAllocationWithCredits(db, refundParty, n.date)
    openCredits.set(refundParty, a.credits)
    heldCredit.set(refundParty, a.unappliedCredit)
  }
  return {
    invoice: {
      companyStateCode: company.stateCode,
      ...gstRegistrationOf(company),
      items: new Map(items.map((i) => [i.id, { gstRate: i.gstRate, cessRate: i.cessRate }])),
      ledgers: new Map(ledgers.map((l) => [l.id, { stateCode: l.stateCode, gstRate: l.gstRate, tdsPayableSectionId: l.tdsPayableSectionId, tcsPayableSectionId: l.tcsPayableSectionId ?? null }]))
    },
    ledgers: ledgerMap,
    items: new Map(items.map((i) => [i.id, { id: i.id, name: i.name }])),
    types,
    taxLedgers: { output: taxLedgerIdsFrom(ledgers, 'output'), input: taxLedgerIdsFrom(ledgers, 'input') },
    defaults: {
      walkInId,
      cashId: acc.cashLedgerId,
      upiId: acc.upiLedgerId,
      cardId: acc.cardLedgerId,
      bankId,
      salesId: byCategory(db, 'sales', 'service_income') ?? acc.salesLedgerId,
      purchaseId: byCategory(db, 'purchases') ?? firstUnder(db, 'Purchase Accounts'),
      drawingsId: byCategory(db, 'owner_drawings') ?? firstUnder(db, 'Capital Account', /drawing/i)
    },
    prices,
    openBills: bills,
    openCredits,
    heldCredit,
    original,
    takenNames,
    ...loadStockContext(db, n)
  }
}

/** The GST / round-off ledgers an entry needs, created as the editor does on first use (named
 *  CGST / SGST / IGST / CESS under Duties & Taxes, "Round Off" under Indirect Expenses). */
function ensureTaxLedgers(db: DB, side: TaxSide, keys: (keyof TaxLedgerIds)[]): void {
  const groupId = (name: string): number => {
    const g = db.prepare('SELECT id FROM groups WHERE name = ?').get(name) as { id: number } | undefined
    if (!g) throw new Error(`${name} group missing`)
    return g.id
  }
  const base = { openingBalance: 0, gstin: null, stateCode: null, address: null, gstRate: null, hsn: null, tdsSectionId: null, pan: null, creditDays: null, exportType: null }
  for (const k of keys) {
    if (k === 'roundOff') {
      if (!db.prepare("SELECT 1 FROM ledgers WHERE lower(name) = 'round off'").get()) createLedger(db, { ...base, name: 'Round Off', groupId: groupId('Indirect Expenses'), taxType: null })
      continue
    }
    const all = db.prepare('SELECT id, name, tax_type AS taxType FROM ledgers WHERE tax_type = ?').all(k) as { id: number; name: string; taxType: string }[]
    if (pickTaxLedger(all, k, side) == null) createLedger(db, { ...base, name: k.toUpperCase(), groupId: groupId('Duties & Taxes'), taxType: k })
  }
}

// ---------------------------------------------------------------- refusals → the intent's fields

/** A voucher field (WP 8.5 codes.ts paths) as the intent's question. */
function intentField(n: NormalIntent, role: MappedEntry['role'], field: string | undefined): string | undefined {
  if (!field) return undefined
  const head = field.split('.')[0]!
  const trade = n.kind === 'sale' || n.kind === 'purchase'
  const isReturn = n.kind === 'return_sale' || n.kind === 'return_purchase'
  if (head === 'date') return 'date'
  // WP 9.7: a count's products are its `counts`; a batch made is refused on how many were made.
  if (n.kind === 'stock_count') return head === 'number' ? 'number' : 'counts'
  if (n.kind === 'make_goods') return head === 'number' ? 'number' : 'qty'
  if (role === 'payment' || role === 'refund') {
    if (head === 'party') return isReturn ? 'bill' : 'party'
    return role
  }
  switch (head) {
    case 'party':
      return isReturn ? 'bill' : 'party'
    case 'number':
      return 'number'
    case 'items':
      return 'items'
    case 'account':
      return 'account'
    case 'lines':
      return trade || isReturn ? ((n as { amount?: unknown }).amount ? 'amount' : 'items') : 'amount'
    case 'billRefs':
      return trade ? (n.kind === 'purchase' ? 'billNo' : undefined) : n.kind === 'money_in' || n.kind === 'money_out' ? 'bills' : undefined
    default:
      return undefined
  }
}

export function remapSaveError(err: unknown, n: NormalIntent, entry: MappedEntry): never {
  // A refusal raised as a plain Error (trade-link rules I1–I7, TDS / pricing guards …): kept as
  // the message, placed on the items when the entry moves goods, else on the form.
  if (!isAppError(err)) {
    if (!(err instanceof Error) || err instanceof NeedTaxLedgers) throw err
    const onItems = (entry.payload.inventory ?? []).length > 0
    const field = n.kind === 'stock_count' ? 'counts' : n.kind === 'make_goods' ? 'qty' : onItems ? 'items' : null
    throw new AppError('simple_save_refused', err.message, { ...(field ? { field } : {}), params: { part: entry.role } })
  }
  const templ = (code: string, line?: number): string | undefined => {
    const f = isErrorCode(code) ? (ERROR_MAP[code] as { field?: string }).field : undefined
    return f ? f.replace('{line}', String(line ?? 0)) : undefined
  }
  const issues: ErrorIssue[] | undefined = err.issues?.map((i) => {
    const f = intentField(n, entry.role, i.field ?? templ(i.code, i.line))
    const { line: _line, field: _field, ...rest } = i
    return { ...rest, ...(f ? { field: f } : {}) }
  })
  const field = intentField(n, entry.role, err.field ?? templ(err.code))
  throw new AppError(err.code, err.message, {
    ...(field ? { field } : {}),
    params: { ...(err.params ?? {}), part: entry.role },
    ...(issues ? { issues } : {})
  })
}

// ---------------------------------------------------------------- idempotency

/** Keys sorted at every level, so two equal intents hash the same whatever the key order. */
function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`
  if (v && typeof v === 'object') {
    return `{${Object.keys(v as object).sort().filter((k) => (v as Record<string, unknown>)[k] !== undefined).map((k) => `${JSON.stringify(k)}:${canonicalJson((v as Record<string, unknown>)[k])}`).join(',')}}`
  }
  return JSON.stringify(v)
}

/** SHA-256 of the Zod-parsed intent without its clientId (the answers as asked). */
export function intentHash(raw: unknown): string {
  const { clientId: _c, ...answers } = simpleIntentSchema.parse(raw)
  return createHash('sha256').update(canonicalJson(answers)).digest('hex')
}

// ---------------------------------------------------------------- the run

interface Saved { entry: MappedEntry; id: number; number: string }
interface RunOut { saved: Saved[]; facts: IntentFacts; warnings: SaveVoucherWarnings }

/** How far ahead a simple entry may be dated (a typo guard; the accountant editor has none). */
export { SIMPLE_MAX_DAYS_AHEAD }

/** Simple mode is stricter than the editor on dates: not inside the lock, not in a closed year
 *  (saveVoucher itself relies on the lock the year-end close sets), not before the books begin,
 *  and not more than 30 days after the working date. */
function guardDate(db: DB, company: CompanyInfo, date: string, today: string): void {
  const lock = getLockDate(db)
  if (lock && date <= lock) throw lockedError(lock)
  const fy = fyOf(date)
  if (fyIsClosed(db, fy.startYear)) throw new AppError('simple_year_closed', `FY ${fy.label} is closed — bin its closing journal to reopen the year`, { field: 'date' })
  const begin = company.booksBeginDate ?? `${company.booksFrom}-04-01`
  if (date < begin) throw new AppError('simple_before_books', `The books begin on ${toDisplayDate(begin)}`, { field: 'date', params: { date: begin } }) // ISO: mapError writes it in the reader's language
  const latest = addDaysISO(today, SIMPLE_MAX_DAYS_AHEAD)
  if (date > latest) throw new AppError('simple_far_future', `${toDisplayDate(date)} is more than ${SIMPLE_MAX_DAYS_AHEAD} days ahead`, { field: 'date' })
}

/** Capture's rule: the same supplier's bill number in the same financial year is already in the books. */
function guardDuplicateBill(db: DB, supplierId: number, billNo: string, date: string): void {
  const want = normalizeInvoiceNumber(billNo)
  if (!want) return
  const fy = fyOf(date)
  const rows = db
    .prepare(
      `SELECT v.id, v.number, v.reference,
              (SELECT group_concat(br.name, char(31)) FROM bill_refs br WHERE br.voucher_id = v.id AND br.kind = 'new') AS bills
       FROM vouchers v JOIN voucher_types vt ON vt.id = v.voucher_type_id
       WHERE vt.kind = 'purchase' AND v.party_ledger_id = ? AND v.date BETWEEN ? AND ? AND ${NOT_DELETED}`
    )
    .all(supplierId, fy.from, fy.to) as { id: number; number: string; reference: string | null; bills: string | null }[]
  const dup = rows.find((r) => [r.reference, ...(r.bills ? r.bills.split('\u001f') : [])].some((x) => x && normalizeInvoiceNumber(x) === want))
  if (dup) {
    throw new AppError('simple_duplicate_bill', `Bill ${billNo} from this supplier is already in the books (purchase ${dup.number})`, {
      field: 'billNo', params: { number: dup.number, voucherId: dup.id }
    })
  }
}

function mapWithLedgers(db: DB, company: CompanyInfo, n: NormalIntent): ReturnType<typeof mapIntent> {
  for (let attempt = 0; ; attempt++) {
    try {
      return mapIntent(n, loadIntentContext(db, company, n))
    } catch (err) {
      if (!(err instanceof NeedTaxLedgers) || attempt >= 4) throw err
      ensureTaxLedgers(db, err.side, err.keys)
    }
  }
}

function mergeWarnings(all: SaveVoucherWarnings[]): SaveVoucherWarnings {
  const out: SaveVoucherWarnings = { negativeStock: [], creditLimitExceeded: null }
  for (const w of all) {
    out.negativeStock.push(...w.negativeStock)
    out.creditLimitExceeded ??= w.creditLimitExceeded
    if (w.linkDates?.length) out.linkDates = [...(out.linkDates ?? []), ...w.linkDates]
  }
  return out
}

const PARTY_SIDE_KINDS = new Set(['sale', 'purchase', 'money_in', 'money_out', 'return_sale', 'return_purchase'])

/** Map and save every entry (call inside a transaction). */
function execute(db: DB, company: CompanyInfo, n: NormalIntent, today: string): RunOut {
  guardDate(db, company, n.date, today)
  if (n.kind === 'purchase' && n.billNo) guardDuplicateBill(db, n.supplierId, n.billNo, n.date)
  const mapped = mapWithLedgers(db, company, n)
  const valueBefore = n.kind === 'stock_count' ? new Map(stockSummary(db, n.date).map((r) => [r.stockItemId, r.closingValue])) : null
  const warnings: SaveVoucherWarnings[] = []
  const saved = mapped.entries.map((entry) => {
    try {
      // WP 9.7: a batch made saves the way the Manufacture screen saves it (saveManufacture →
      // saveVoucher, with its manufacture_details row); every other entry through saveVoucher.
      const r = entry.form === 'manufacture' ? saveManufacture(db, entry.input) : saveVoucher(db, entry.payload)
      warnings.push(r.warnings)
      return { entry, id: r.id, number: r.number }
    } catch (err) {
      return remapSaveError(err, n, entry)
    }
  })
  // Where the party stands NOW — the Outstandings allocation after these saves (an earlier credit
  // or bill counts), never "bill − paid".
  const facts = { ...mapped.facts }
  const partyId = mapped.entries[0]?.payload.partyLedgerId ?? null
  if (PARTY_SIDE_KINDS.has(n.kind) && facts.side && partyId != null) {
    const a = partyAllocation(db, partyId, n.date)
    facts.balance = a.bills.reduce((t, b) => t + b.pending, 0) - a.unappliedCredit
    facts.due = Math.max(0, facts.balance)
  }
  // WP 9.7: what the count did to the stock's value — the valuation engine's figure from the
  // books as saved (the pass after the count vs the position the count was mapped from).
  if (n.kind === 'stock_count' && facts.count) {
    const after = new Map(stockSummary(db, n.date).map((r) => [r.stockItemId, r.closingValue]))
    const before = valueBefore ?? new Map<number, number>()
    facts.count = { lines: facts.count.lines.map((l) => ({ ...l, valueChange: (after.get(l.itemId) ?? 0) - (before.get(l.itemId) ?? 0) })) }
  }
  return { saved, facts, warnings: mergeWarnings(warnings) }
}

function previewEntries(db: DB, saved: Saved[]): PreviewEntry[] {
  const name = db.prepare('SELECT name FROM ledgers WHERE id = ?')
  const itemName = db.prepare('SELECT name FROM stock_items WHERE id = ?')
  const typeName = db.prepare('SELECT name FROM voucher_types WHERE id = ?')
  return saved.map(({ entry, number }) => {
    const p = entry.payload
    return {
      role: entry.role,
      kind: entry.kind,
      typeName: (typeName.get(entry.voucherTypeId) as { name: string } | undefined)?.name ?? entry.kind,
      number,
      date: p.date,
      lines: p.lines.map((l) => ({ ledgerId: l.ledgerId, name: (name.get(l.ledgerId) as { name: string } | undefined)?.name ?? `#${l.ledgerId}`, drCr: l.drCr, amount: l.amount })),
      billRefs: (p.billRefs ?? []).map((b) => ({ kind: b.kind, name: b.name, amount: b.amount, dueDate: b.dueDate ?? null })),
      items: (p.inventory ?? []).map((l) => ({
        itemId: l.stockItemId, name: (itemName.get(l.stockItemId) as { name: string } | undefined)?.name ?? `#${l.stockItemId}`,
        qtyMilli: l.qtyMilli, ratePaise: l.ratePaise, amount: l.amount, direction: l.direction
      }))
    }
  })
}

/** simple:preview — what the intent would record, rehearsed (always rolled back). */
export function previewIntent(db: DB, company: CompanyInfo, raw: unknown, today: string): SimplePreview {
  const n = normaliseIntent(raw, today)
  return rehearse(db, () => {
    const out = execute(db, company, n, today)
    const preview: SimplePreview = { kind: n.kind, sentences: intentSentences(out.facts, companyT(db)), facts: out.facts, entries: previewEntries(db, out.saved), warnings: out.warnings }
    // WP 9.4: with TDS on, the EXISTING eligibility rules (tdsWorkbench.tdsEligible) run over the
    // rehearsed entries — a read-only hint for the simple screen; no TDS is added here.
    if ((n.kind === 'money_out' || n.kind === 'purchase') && getFeatures(db).tds) {
      const ids = new Set(out.saved.map((s) => s.id))
      const hits = tdsEligible(db, n.date, n.date).filter((r) => ids.has(r.voucherId))
      if (hits.length) preview.tds = hits.map((r) => ({ partyName: r.partyName, sectionCode: r.sectionCode, tdsPaise: r.tdsPaise }))
    }
    return preview
  })
}

/** simple:post — save the intent's vouchers in ONE transaction (idempotent by clientId). */
export function postIntent(db: DB, company: CompanyInfo, raw: unknown, today: string): SimplePostResult {
  const n = normaliseIntent(raw, today)
  const hash = intentHash(raw)
  const prior = db.prepare('SELECT id, intent_hash AS hash, voucher_ids_json AS ids, facts_json AS facts FROM simple_posts WHERE client_id = ?').get(n.clientId) as
    | { id: number; hash: string; ids: string; facts: string }
    | undefined
  if (prior) {
    // The same id with OTHER answers is a screen bug, never a retry: refused, nothing saved.
    if (prior.hash !== hash) throw new AppError('simple_client_reused', 'This clientId was already used for a different entry')
    const stored = JSON.parse(prior.ids) as SimplePostResult['entries']
    const ids = stored.map((e) => e.voucherId)
    const live = ids.filter((id) => !!db.prepare(`SELECT 1 FROM vouchers v WHERE v.id = ? AND ${NOT_DELETED}`).get(id))
    if (live.length > 0) {
      const facts = JSON.parse(prior.facts) as IntentFacts
      return { voucherIds: ids, entries: stored, replayed: true, summary: saveSummary(db, ids), sentences: intentSentences(facts, companyT(db)), facts, warnings: { negativeStock: [], creditLimitExceeded: null } }
    }
    // Every voucher it saved was undone (binned) or purged since: the intent no longer stands in
    // the books, so the same answers post again as a NEW entry (the old record goes).
    db.prepare('DELETE FROM simple_posts WHERE id = ?').run(prior.id)
  }
  const out = db.transaction(() => {
    const r = execute(db, company, n, today)
    const entries = r.saved.map((s) => ({ role: s.entry.role, voucherId: s.id, kind: s.entry.kind, number: s.number }))
    const postId = Number(
      db.prepare('INSERT INTO simple_posts (client_id, kind, intent_hash, voucher_ids_json, facts_json) VALUES (?, ?, ?, ?, ?)').run(n.clientId, n.kind, hash, JSON.stringify(entries), JSON.stringify(r.facts)).lastInsertRowid
    )
    // The vouchers log themselves; this row is the intent as one event — the whole intent as asked
    // (Zod-parsed), as read (amounts / dates), and the vouchers it became.
    writeAudit(db, 'simple_intent', postId, 'create', null, {
      clientId: n.clientId, kind: n.kind, intent: simpleIntentSchema.parse(raw), read: n, voucherIds: entries.map((e) => e.voucherId), entries
    })
    return { ...r, entries }
  })()
  // WP 2.6 "remember last price" (a no-op unless on); never fails the post — as voucher:save.
  for (const s of out.saved) {
    if (s.entry.kind !== 'sales') continue
    try {
      rememberSalePrices(db, s.id, { skipLedgerId: n.kind === 'sale' && n.customerId == null ? (s.entry.payload.partyLedgerId ?? null) : null })
    } catch {
      /* never fails the post */
    }
  }
  const ids = out.entries.map((e) => e.voucherId)
  return {
    voucherIds: ids, entries: out.entries, replayed: false, summary: saveSummary(db, ids),
    sentences: intentSentences(out.facts, companyT(db)), facts: out.facts, warnings: out.warnings
  }
}

// ---------------------------------------------------------------- WP 9.10 hand-off

/** The total an entry moves (its debits) — what the hand-off says about the parts it leaves out. */
const entryAmount = (entry: MappedEntry): number => entry.payload.lines.filter((l) => l.drCr === 'dr').reduce((t, l) => t + l.amount, 0)

interface CreatedLedger {
  id: number
  name: string
  taxType: string | null
  groupName: string
}

/** How the full editor makes a ledger the rehearsal created, the way it does on first use (null =
 *  the user picks or creates it there): the counter's walk-in customer (ensureWalkIn's name and
 *  group), a GST ledger of the entry's side and the Round Off ledger (ensureTaxLedgers above = the
 *  editor's useTaxLedgers: same names, groups and side pick). */
function createdOnFirstUse(r: CreatedLedger, kind: VoucherKind): HandoffCreate | null {
  if (r.name === WALK_IN_NAME && r.groupName === 'Sundry Debtors') return { kind: 'walkIn' }
  if (r.groupName === 'Duties & Taxes' && (r.taxType === 'cgst' || r.taxType === 'sgst' || r.taxType === 'igst' || r.taxType === 'cess')) {
    return { kind: 'tax', taxType: r.taxType, side: taxSideOf(kind) }
  }
  if (r.name.toLowerCase() === 'round off' && r.groupName === 'Indirect Expenses') return { kind: 'roundOff' }
  return null
}

/**
 * simple:intentForm (WP 9.10) — the editors' own form state for the CURRENT answers of a simple
 * screen, so its "Accountant view" opens the full editor pre-filled. The same mapping simple:post
 * saves through (mapIntent over loadIntentContext, tax ledgers created as the editor does), run in
 * a rehearsal that is always rolled back; no save is rehearsed (the editor's own save applies every
 * rule when the user saves there). References to rows the rehearsal created (walk-in customer, GST
 * / round-off ledgers) are cleared and named (`missing`). Writes nothing.
 */
export function intentForm(db: DB, company: CompanyInfo, raw: unknown, today: string): IntentFormResult {
  const n = normaliseIntent(raw, today)
  const before = new Set((db.prepare('SELECT id FROM ledgers').all() as { id: number }[]).map((r) => r.id))
  const { mapped, created } = rehearse(db, () => {
    const m = mapWithLedgers(db, company, n)
    const rows = db
      .prepare('SELECT l.id, l.name, l.tax_type AS taxType, g.name AS groupName FROM ledgers l JOIN groups g ON g.id = l.group_id')
      .all() as CreatedLedger[]
    return { mapped: m, created: new Map(rows.filter((r) => !before.has(r.id)).map((r) => [r.id, r])) }
  })
  const missing: string[] = []
  const addedOnSave: string[] = []
  const entries = mapped.entries.map((e) => {
    const entry = { role: e.role, kind: e.kind, voucherTypeId: e.voucherTypeId, form: e.form, state: e.state, amount: entryAmount(e) } as HandoffEntry
    const out = sanitiseHandoffEntry(entry, (id) => before.has(id), (id) => {
      const r = created.get(id)
      return r ? { name: r.name, create: createdOnFirstUse(r, e.kind) } : null
    })
    for (const m of out.missing) if (!missing.includes(m)) missing.push(m)
    for (const m of out.addedOnSave) if (!addedOnSave.includes(m)) addedOnSave.push(m)
    return out.entry
  })
  return { kind: n.kind, entries, missing, addedOnSave }
}
