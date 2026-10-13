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
import type { CompanyInfo, SaveVoucherWarnings, VoucherKind } from '@shared/domain'
import { gstRegistrationOf } from '@shared/gst/registration'
import { addBreakups, computeGst, supplyTypeFor } from '@shared/gst/calc'
import { addDaysISO, fyOf, toDisplayDate } from '@shared/dates'
import { AppError, ERROR_MAP, isAppError, isErrorCode, type ErrorIssue } from '@shared/errors'
import { normalizeInvoiceNumber } from '@shared/gst/recon2b'
import {
  intentSentences, mapIntent, NeedTaxLedgers, normaliseIntent, simpleIntentSchema,
  type IntentContext, type IntentFacts, type IntentLedger, type IntentOriginal, type IntentVoucherType, type MappedEntry,
  type NormalIntent, type PreviewEntry, type SimplePostResult, type SimplePreview
} from '@shared/simple/intents'
import { pickTaxLedger, taxLedgerIdsFrom, taxSideOf, voucherCarriesGst, voucherTaxLedgers, type TaxLedgerIds, type TaxSide } from '@shared/voucherEdit'
import { companyT } from '../i18n'
import { createLedger, listLedgers, listStockItems, listVoucherTypes } from './masters'
import { getLockDate, getVoucher, lockedError, nextVoucherNumber, NOT_DELETED, saveVoucher } from './vouchers'
import { counterAccounts, ensureWalkIn } from './counter'
import { pricingLoader, rememberSalePrices } from './pricing'
import { openBills, partyAllocation, partyAllocationWithCredits } from './analysis'
import { fyIsClosed } from './cashFinanceCommon'
import { writeAudit } from './audit'
import { saveSummary } from './undo'
import { ledgerClassifier } from '../ai/ledgerClass'
import { rehearse } from '../ai/drafting/rehearse'

// ---------------------------------------------------------------- context

const KINDS_FOR: Record<NormalIntent['kind'], VoucherKind[]> = {
  sale: ['sales', 'receipt'],
  purchase: ['purchase', 'payment'],
  money_in: ['receipt'],
  money_out: ['payment'],
  move_money: ['contra'],
  return_sale: ['credit_note', 'payment'],
  return_purchase: ['debit_note', 'receipt']
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
      return n.customerId
    case 'money_out':
      return n.supplierId
    default:
      return null
  }
}

function loadOriginal(db: DB, company: CompanyInfo, ledgers: ReturnType<typeof listLedgers>, billId: number, date: string): IntentOriginal | null {
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
  const bills = new Map<number, { name: string; date: string; pending: number; voucherId: number | null }[]>()
  if ((n.kind === 'money_in' || n.kind === 'money_out') && partyId != null) {
    bills.set(partyId, openBills(db, partyId, n.date).filter((b) => b.pending > 0).map((b) => ({ name: b.number, date: b.date, pending: b.pending, voucherId: b.voucherId })))
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
    original,
    takenNames
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
    throw new AppError('simple_save_refused', err.message, { ...(onItems ? { field: 'items' } : {}), params: { part: entry.role } })
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
export const SIMPLE_MAX_DAYS_AHEAD = 30

/** Simple mode is stricter than the editor on dates: not inside the lock, not in a closed year
 *  (saveVoucher itself relies on the lock the year-end close sets), not before the books begin,
 *  and not more than 30 days after the working date. */
function guardDate(db: DB, company: CompanyInfo, date: string, today: string): void {
  const lock = getLockDate(db)
  if (lock && date <= lock) throw lockedError(lock)
  const fy = fyOf(date)
  if (fyIsClosed(db, fy.startYear)) throw new AppError('simple_year_closed', `FY ${fy.label} is closed — bin its closing journal to reopen the year`, { field: 'date' })
  const begin = company.booksBeginDate ?? `${company.booksFrom}-04-01`
  if (date < begin) throw new AppError('simple_before_books', `The books begin on ${toDisplayDate(begin)}`, { field: 'date', params: { date: toDisplayDate(begin) } })
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
  const warnings: SaveVoucherWarnings[] = []
  const saved = mapped.entries.map((entry) => {
    try {
      const r = saveVoucher(db, entry.payload)
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
    return { kind: n.kind, sentences: intentSentences(out.facts, companyT(db)), facts: out.facts, entries: previewEntries(db, out.saved), warnings: out.warnings }
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
