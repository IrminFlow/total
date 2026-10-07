/**
 * TCS (Tax Collected at Source) on sales — WP 3.3. Pure: no I/O, no DB. The rate / threshold /
 * certificate / rounding / quarter / validation machinery is shared with TDS in
 * src/shared/withholding.ts; this file holds only what differs when WE are the seller
 * collecting tax from the buyer:
 *
 *  - who the party is: the buyer (Sundry Debtors, or a ledger flagged ledgers.tcs_section_id);
 *  - what attracts TCS: the buyer's own section, the goods sold (stock_items.tcs_section_id —
 *    scrap, timber, minerals …) or the sales ledger (ledgers.tcs_default_section_id);
 *  - WHEN: "at the time of debiting of the amount payable by the buyer to the account of the
 *    buyer or at the time of receipt of such amount from the said buyer ..., whichever is
 *    earlier" (s.206C(1); the same first-of-debit-or-receipt walk as TDS's first-of-credit-or-
 *    payment, so src/shared/tdsEligibility.ts's walkTdsEvents is reused as is: a SALE is the
 *    "credit" event, a RECEIPT the "payment" event);
 *  - the BASE: the amount payable by the buyer — INCLUDING GST for the sections where the seeded
 *    rate row says so (tds_section_rates.base_includes_gst; citations in migration 027);
 *  - the LINES: TCS is collected ON TOP of the sale consideration — "collect from the buyer ... a
 *    sum equal to [x] per cent of such amount as income-tax" (s.206C(1)). A sales invoice debits
 *    the buyer with the invoice total PLUS the TCS and credits the section's tagged TCS payable
 *    ledger as its last line (Dr Buyer 1,18,118 / Cr Sales 1,00,000 / Cr GST 18,000 /
 *    Cr TCS Payable 118). A receipt that collects TCS is credited to the buyer for the
 *    consideration and to TCS payable for the tax, the bank receiving both.
 */
import type { VoucherKind } from './domain'
import type { PostingError } from './posting'
import {
  rupees, validateWithholdingEntries,
  type RateDeducteeType, type WithholdingEntryToValidate, type WithholdingLabels, type WithholdingRateRow, type WithholdingSectionFacts
} from './withholding'
import type { EligibleReason } from './tdsEligibility'

export const TCS_LABELS: WithholdingLabels = {
  prefix: 'tcs', name: 'TCS', noun: 'collection', party: 'the buyer', sectionsScreen: 'TCS › Sections'
}

export const COLLECTEE_TYPE_LABELS: Record<RateDeducteeType, string> = {
  individual_huf: 'Individual / HUF',
  company: 'Company',
  firm: 'Firm / LLP',
  other: 'Other (AOP, BOI, trust, …)',
  any: 'Any buyer'
}

/** s.206CC(1): without a PAN, TCS is the higher of "twice the rate specified" and 5% (the 5%
 *  is seeded as each row's no_pan_rate_bp; the multiple is applied by applicableRate). */
export const TCS_NO_PAN_MULTIPLE = 2

/** Kinds that can carry a TCS collection made by us as the seller. */
export const TCS_CREDIT_KINDS: readonly VoucherKind[] = ['sales']
export const TCS_KINDS: readonly VoucherKind[] = ['sales', 'receipt']

// ---------------------------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------------------------

export interface TcsLedgerFacts {
  /** Sundry Debtors tree, or flagged for a section — a possible collectee (buyer). */
  isCollecteeCandidate: boolean
  /** Buyer's own TCS section (ledgers.tcs_section_id). */
  tcsSectionId: number | null
  /** Sales ledger default section (ledgers.tcs_default_section_id). */
  defaultSectionId: number | null
  /** GST tax ledger (tax_type set). */
  isTax: boolean
  isTcsPayable: boolean
  isCashBank: boolean
}

export interface TcsClassifyVoucher {
  kind: VoucherKind
  partyLedgerId: number | null
  lines: readonly { ledgerId: number; drCr: 'dr' | 'cr'; amount: number }[]
  /** Inventory lines (outward on a sale) — goods flagged with a TCS section attract it. */
  inventory?: readonly { stockItemId: number; amount: number; direction: 'in' | 'out' }[]
}

export interface TcsVoucherClass {
  eventKind: 'credit' | 'payment'
  partyLedgerId: number
  /** null = a receipt from a buyer with no section of its own (joins its sales' section). */
  sectionId: number | null
  sectionFrom: 'party' | 'goods' | 'ledger' | 'credits'
  /** Taxable value (before GST) of the part of the sale that attracts the section, paise. For
   *  a receipt: the amount received from the buyer (the consideration). */
  taxablePaise: number
  /** GST (and round-off) attributable to that part, paise; 0 on a receipt. */
  gstPaise: number
  /** Amount payable by the buyer before any TCS (sale) / received (receipt), paise. */
  grossPaise: number
  /** The sales ledger (or, for goods, the stock item's sales ledger) credited with the most. */
  salesLedgerId: number | null
  /** Stock item that set the section (goods route), else null. */
  stockItemId: number | null
}

/** The base TCS is computed on for a classified event under a rate row: taxable value, plus
 *  the GST part when the row's base includes GST (citations in migration 027). */
export function tcsBasePaise(cls: Pick<TcsVoucherClass, 'taxablePaise' | 'gstPaise'>, row: Pick<WithholdingRateRow, 'baseIncludesGst'> | null): number {
  return cls.taxablePaise + (row?.baseIncludesGst ? cls.gstPaise : 0)
}

/**
 * What a voucher means for TCS: a sale to (debit of) or receipt from a buyer, with its base —
 * or null when it carries no TCS event (no buyer, no section, nothing taxable). Section
 * precedence on a sale: `sectionOverride` (the banner's / Eligible tab's choice) → the buyer's
 * own section → the goods sold (the flagged item with the largest value) → the sales ledger's
 * default. Goods / ledger routes take only the flagged part of the invoice as the base, with a
 * proportional share of its GST (an approximation on mixed-rate invoices, documented).
 */
export function classifyTcsVoucher(
  v: TcsClassifyVoucher,
  facts: (ledgerId: number) => TcsLedgerFacts | null,
  itemSection: (stockItemId: number) => number | null,
  sectionOverride?: number | null
): TcsVoucherClass | null {
  if (!TCS_KINDS.includes(v.kind)) return null
  const side: 'dr' | 'cr' = v.kind === 'receipt' ? 'cr' : 'dr'
  const candidates = new Set<number>()
  for (const l of v.lines) {
    if (l.drCr !== side) continue
    const f = facts(l.ledgerId)
    if (f && f.isCollecteeCandidate && !f.isTax && !f.isTcsPayable && !f.isCashBank) candidates.add(l.ledgerId)
  }
  const party = v.partyLedgerId != null && candidates.has(v.partyLedgerId) ? v.partyLedgerId : candidates.size === 1 ? [...candidates][0]! : null
  if (party == null) return null
  const pf = facts(party)
  if (!pf) return null
  const partyAmount = v.lines.filter((l) => l.drCr === side && l.ledgerId === party).reduce((s, l) => s + l.amount, 0)
  if (partyAmount <= 0) return null

  if (v.kind === 'receipt') {
    const sectionId = sectionOverride ?? pf.tcsSectionId
    return {
      eventKind: 'payment', partyLedgerId: party, sectionId,
      sectionFrom: sectionOverride != null || pf.tcsSectionId != null ? 'party' : 'credits',
      taxablePaise: partyAmount, gstPaise: 0, grossPaise: partyAmount, salesLedgerId: null, stockItemId: null
    }
  }

  // Sale: the buyer's debit less any TCS already on the voucher = the invoice value.
  const payableCredits = v.lines.filter((l) => l.drCr === 'cr' && facts(l.ledgerId)?.isTcsPayable).reduce((s, l) => s + l.amount, 0)
  const grossPaise = partyAmount - payableCredits
  const income = v.lines.filter((l) => {
    if (l.drCr !== 'cr' || l.ledgerId === party) return false
    const f = facts(l.ledgerId)
    return !!f && !f.isTax && !f.isTcsPayable && !f.isCashBank
  })
  // Debits other than the buyer (trade discount ledgers …) reduce the taxable value.
  const otherDebits = v.lines.filter((l) => {
    if (l.drCr !== 'dr' || l.ledgerId === party) return false
    const f = facts(l.ledgerId)
    return !!f && !f.isTax && !f.isTcsPayable && !f.isCashBank
  }).reduce((s, l) => s + l.amount, 0)
  const sum = (ls: readonly { amount: number }[]): number => ls.reduce((s, l) => s + l.amount, 0)
  const totalTaxable = sum(income) - otherDebits
  if (totalTaxable <= 0 || grossPaise <= 0) return null
  const largestLedger = (ls: readonly { ledgerId: number; amount: number }[]): number | null =>
    ls.length === 0 ? null : [...ls].sort((a, b) => b.amount - a.amount)[0]!.ledgerId

  const outward = (v.inventory ?? []).filter((i) => i.direction === 'out' && i.amount > 0)
  const byItemSection = new Map<number, { amount: number; topItem: number; topAmount: number }>()
  for (const i of outward) {
    const s = itemSection(i.stockItemId)
    if (s == null) continue
    const g = byItemSection.get(s) ?? { amount: 0, topItem: i.stockItemId, topAmount: 0 }
    g.amount += i.amount
    if (i.amount > g.topAmount) {
      g.topItem = i.stockItemId
      g.topAmount = i.amount
    }
    byItemSection.set(s, g)
  }
  const byLedgerSection = new Map<number, { ledgerId: number; amount: number }[]>()
  for (const l of income) {
    const s = facts(l.ledgerId)?.defaultSectionId
    if (s != null) byLedgerSection.set(s, [...(byLedgerSection.get(s) ?? []), l])
  }

  let sectionId: number | null = null
  let sectionFrom: TcsVoucherClass['sectionFrom'] = 'party'
  let subject = totalTaxable
  let stockItemId: number | null = null
  let salesLedgerId = largestLedger(income)
  const pickGoods = (s: number): void => {
    const g = byItemSection.get(s)!
    sectionId = s
    sectionFrom = 'goods'
    subject = g.amount
    stockItemId = g.topItem
  }
  const pickLedger = (s: number): void => {
    const ls = byLedgerSection.get(s)!
    sectionId = s
    sectionFrom = 'ledger'
    subject = sum(ls)
    salesLedgerId = largestLedger(ls)
  }
  if (sectionOverride != null) {
    if (sectionOverride !== pf.tcsSectionId && byItemSection.has(sectionOverride)) pickGoods(sectionOverride)
    else if (sectionOverride !== pf.tcsSectionId && byLedgerSection.has(sectionOverride)) pickLedger(sectionOverride)
    else sectionId = sectionOverride
  } else if (pf.tcsSectionId != null) {
    sectionId = pf.tcsSectionId
  } else if (byItemSection.size > 0) {
    pickGoods([...byItemSection.entries()].sort((a, b) => b[1].amount - a[1].amount || a[0] - b[0])[0]![0])
  } else if (byLedgerSection.size > 0) {
    pickLedger([...byLedgerSection.entries()].sort((a, b) => sum(b[1]) - sum(a[1]) || a[0] - b[0])[0]![0])
  }
  if (sectionId == null) return null
  subject = Math.min(subject, totalTaxable)
  if (subject <= 0) return null
  const gstAll = grossPaise - totalTaxable
  const gstPaise = subject === totalTaxable ? gstAll : Math.round((gstAll * subject) / totalTaxable)
  return {
    eventKind: 'credit', partyLedgerId: party, sectionId, sectionFrom,
    taxablePaise: subject, gstPaise, grossPaise, salesLedgerId, stockItemId
  }
}

/** Candidate sections for a voucher (the banner's / Eligible tab's choice): the buyer's own,
 *  then each flagged item's, then each credited sales ledger's default. */
export function candidateTcsSections(
  v: TcsClassifyVoucher,
  partyLedgerId: number,
  facts: (ledgerId: number) => TcsLedgerFacts | null,
  itemSection: (stockItemId: number) => number | null
): { sectionId: number; from: 'party' | 'goods' | 'ledger' }[] {
  const out: { sectionId: number; from: 'party' | 'goods' | 'ledger' }[] = []
  const own = facts(partyLedgerId)?.tcsSectionId
  if (own != null) out.push({ sectionId: own, from: 'party' })
  for (const i of v.inventory ?? []) {
    const s = i.direction === 'out' ? itemSection(i.stockItemId) : null
    if (s != null && !out.some((c) => c.sectionId === s)) out.push({ sectionId: s, from: 'goods' })
  }
  for (const l of v.lines) {
    if (l.drCr !== 'cr') continue
    const s = facts(l.ledgerId)?.defaultSectionId
    if (s != null && !out.some((c) => c.sectionId === s)) out.push({ sectionId: s, from: 'ledger' })
  }
  return out
}

// ---------------------------------------------------------------------------------------------
// Validation (saveVoucher)
// ---------------------------------------------------------------------------------------------

export interface TcsEntryToValidate {
  sectionId: number
  baseAmount: number
  tcsAmount: number
  isManual: boolean
}

/**
 * Checks a voucher's TCS entries against its own lines: the shared rules (party, amount ≤ base,
 * amount = rate table unless manual, a credit to the section's tagged TCS payable ledger equal to
 * the entries) plus the seller's side of it — on a sale the buyer's debit INCLUDES the TCS (it
 * is collected from the buyer on top of the base, so the buyer is debited at least base + TCS);
 * on a receipt the buyer is credited (the TCS rides in addition, to TCS payable). Only sales and
 * receipts carry TCS.
 */
export function validateTcsEntries(
  voucher: { kind: VoucherKind; partyLedgerId: number | null; lines: readonly { ledgerId: number; drCr: 'dr' | 'cr'; amount: number }[] },
  entries: readonly TcsEntryToValidate[],
  payableLedgerTagMap: ReadonlyMap<number, number>,
  sectionFacts: (entry: TcsEntryToValidate) => WithholdingSectionFacts | null
): PostingError[] {
  if (entries.length === 0) return []
  if (!TCS_KINDS.includes(voucher.kind)) {
    return [{ code: 'tcs_wrong_kind', message: `A ${voucher.kind.replace('_', ' ')} voucher can't carry a TCS collection — only sales and receipts do` }]
  }
  const byGeneric = new Map<object, TcsEntryToValidate>()
  const generic: WithholdingEntryToValidate[] = entries.map((e) => {
    const g = { sectionId: e.sectionId, baseAmount: e.baseAmount, amount: e.tcsAmount, isManual: e.isManual }
    byGeneric.set(g, e)
    return g
  })
  const errors = validateWithholdingEntries(voucher, generic, payableLedgerTagMap, (g) => sectionFacts(byGeneric.get(g)!), TCS_LABELS)
  if (voucher.partyLedgerId == null) return errors
  const party = voucher.partyLedgerId
  const total = entries.reduce((s, e) => s + e.tcsAmount, 0)
  const base = entries.reduce((s, e) => s + e.baseAmount, 0)
  if (voucher.kind === 'sales') {
    const debited = voucher.lines.filter((l) => l.drCr === 'dr' && l.ledgerId === party).reduce((s, l) => s + l.amount, 0)
    if (debited < base + total) {
      errors.push({
        code: 'tcs_party_debit',
        message: `The buyer's debit (${rupees(debited)}) must include the TCS collected — at least the base ${rupees(base)} plus TCS ${rupees(total)}`
      })
    }
  } else {
    const credited = voucher.lines.filter((l) => l.drCr === 'cr' && l.ledgerId === party).reduce((s, l) => s + l.amount, 0)
    if (credited <= 0) errors.push({ code: 'tcs_party_credit', message: 'A receipt that collects TCS must credit the buyer' })
  }
  return errors
}

// ---------------------------------------------------------------------------------------------
// Line edits: add / remove a collection on a saved SALE (tcs:applyToVoucher / removeFromVoucher)
// ---------------------------------------------------------------------------------------------

export interface TcsEditLine {
  ledgerId: number
  drCr: 'dr' | 'cr'
  amount: number
  costAllocations?: { costCentreId: number; amount: number }[]
}
export interface TcsEditBillRef {
  kind: 'new' | 'against'
  name: string
  amount: number
  dueDate: string | null
}
export type TcsLineEdit<L extends TcsEditLine, B extends TcsEditBillRef> =
  | { ok: true; lines: L[]; billRefs: B[]; targetLedgerId: number }
  | { ok: false; error: string }

/** The buyer's largest debit on a sale — the line that carries the TCS on top. */
export function tcsTargetIndex(lines: readonly TcsEditLine[], partyLedgerId: number): number {
  let best = -1
  lines.forEach((l, i) => {
    if (l.drCr === 'dr' && l.ledgerId === partyLedgerId && (best === -1 || l.amount > lines[best]!.amount)) best = i
  })
  return best
}

/** The buyer's 'new' bill refs total the buyer's debit — move the TCS through the last one. */
function adjustBillRefs<B extends TcsEditBillRef>(refs: readonly B[], partyAmountBefore: number, delta: number): B[] | null {
  const news = refs.map((r, i) => ({ r, i })).filter((x) => x.r.kind === 'new')
  const total = refs.reduce((s, r) => s + r.amount, 0)
  if (refs.length === 0 || total !== partyAmountBefore) return [...refs]
  if (news.length === 0) return null
  for (let k = news.length - 1; k >= 0; k--) {
    const { r, i } = news[k]!
    if (r.amount + delta > 0) return refs.map((x, j) => (j === i ? { ...x, amount: x.amount + delta } : x))
  }
  return null
}

const partyDebit = (lines: readonly TcsEditLine[], party: number): number =>
  lines.filter((l) => l.drCr === 'dr' && l.ledgerId === party).reduce((s, l) => s + l.amount, 0)

/** Add a collection to a saved sale: the buyer's debit grows by the TCS (its bill ref too); the
 *  payable credit is appended LAST by saveVoucher (tcs.autoPayable). Receipts are refused — the
 *  amount banked is a fact; collect on a receipt from the voucher editor. */
export function addTcsToLines<L extends TcsEditLine, B extends TcsEditBillRef>(
  kind: VoucherKind,
  lines: readonly L[],
  billRefs: readonly B[],
  opts: { partyLedgerId: number; tcsPaise: number }
): TcsLineEdit<L, B> {
  if (kind === 'receipt') {
    return { ok: false, error: "A saved receipt's amount banked is fixed — open the receipt and apply TCS from its banner" }
  }
  if (!TCS_CREDIT_KINDS.includes(kind)) return { ok: false, error: `A ${kind.replace('_', ' ')} voucher can't carry a TCS collection` }
  const idx = tcsTargetIndex(lines, opts.partyLedgerId)
  if (idx === -1) return { ok: false, error: "The voucher doesn't debit the buyer" }
  if ((lines[idx]!.costAllocations ?? []).length > 0) {
    return { ok: false, error: "The buyer's line has cost-centre allocations — add the collection in the voucher editor" }
  }
  const before = partyDebit(lines, opts.partyLedgerId)
  const refs = adjustBillRefs(billRefs, before, opts.tcsPaise)
  if (!refs) return { ok: false, error: "The buyer's bill references can't take the TCS — add it in the voucher editor" }
  const next = lines.map((l, i) => (i === idx ? { ...l, amount: l.amount + opts.tcsPaise } : { ...l }))
  return { ok: true, lines: next, billRefs: refs, targetLedgerId: lines[idx]!.ledgerId }
}

/** Remove a collection: drop the credits to the section's payable ledger(s) and take the amount
 *  back off the buyer's debit (sale) — or give it back to the buyer's credit (receipt, where the
 *  bank still received the whole amount). */
export function removeTcsFromLines<L extends TcsEditLine, B extends TcsEditBillRef>(
  kind: VoucherKind,
  lines: readonly L[],
  billRefs: readonly B[],
  opts: { partyLedgerId: number; isPayableLine: (l: L) => boolean }
): TcsLineEdit<L, B> & { restoredPaise?: number } {
  const payable = lines.filter((l) => l.drCr === 'cr' && opts.isPayableLine(l))
  if (payable.length === 0) return { ok: false, error: "The voucher's TCS payable credit can't be found — remove the collection in the voucher editor" }
  const restored = payable.reduce((s, l) => s + l.amount, 0)
  const kept = lines.filter((l) => !(l.drCr === 'cr' && opts.isPayableLine(l)))
  if (kind === 'receipt') {
    let best = -1
    kept.forEach((l, i) => {
      if (l.drCr === 'cr' && l.ledgerId === opts.partyLedgerId && (best === -1 || l.amount > kept[best]!.amount)) best = i
    })
    if (best === -1) return { ok: false, error: "The receipt doesn't credit the buyer" }
    if ((kept[best]!.costAllocations ?? []).length > 0) return { ok: false, error: "The buyer's line has cost-centre allocations — remove the collection in the voucher editor" }
    return { ok: true, lines: kept.map((l, i) => (i === best ? { ...l, amount: l.amount + restored } : { ...l })), billRefs: [...billRefs], targetLedgerId: kept[best]!.ledgerId, restoredPaise: restored }
  }
  const idx = tcsTargetIndex(kept, opts.partyLedgerId)
  if (idx === -1) return { ok: false, error: "The voucher doesn't debit the buyer" }
  if (kept[idx]!.amount <= restored) return { ok: false, error: "The buyer's debit is not more than the TCS — remove it in the voucher editor" }
  if ((kept[idx]!.costAllocations ?? []).length > 0) {
    return { ok: false, error: "The buyer's line has cost-centre allocations — remove the collection in the voucher editor" }
  }
  const before = partyDebit(kept, opts.partyLedgerId)
  const refs = adjustBillRefs(billRefs, before, -restored) ?? [...billRefs]
  return {
    ok: true, lines: kept.map((l, i) => (i === idx ? { ...l, amount: l.amount - restored } : { ...l })),
    billRefs: refs, targetLedgerId: kept[idx]!.ledgerId, restoredPaise: restored
  }
}

export const TCS_ELIGIBLE_REASON_LABELS: Record<EligibleReason, string> = {
  single: 'Single sale above the limit',
  aggregate: 'Aggregate crossed on this voucher',
  aggregate_later: 'Aggregate crossed later in the year',
  none: 'Section has no threshold',
  advance: 'Advance received (before the invoice)'
}

// ---------------------------------------------------------------------------------------------
// Deposit, interest, returns (citations: migration 027 [37CA] [R26] [206C] [31AA] [37D] [F27EQ] [F143])
// ---------------------------------------------------------------------------------------------

/** Collections from this date fall under the Income-tax Rules 2026 (Form 143 / Form 133, March
 *  deposited by 30 April). */
export const TCS_RULES_2026_FROM = '2026-04-01'

/**
 * Last date to deposit TCS collected on `collectedOn` (non-government collector): within one
 * week from the last day of the month of collection — rule 37CA(2) of the 1962 Rules, March
 * included (7 April); under the 2026 Rules (collections from 1 Apr 2026) rule 218(2): 7 days from
 * month-end, March by 30 April.
 */
export function tcsDepositDueDate(collectedOn: string): string {
  const [y, m] = collectedOn.split('-').map(Number) as [number, number]
  if (m === 3) return collectedOn >= TCS_RULES_2026_FROM ? `${y}-04-30` : `${y}-04-07`
  const ny = m === 12 ? y + 1 : y
  const nm = m === 12 ? 1 : m + 1
  return `${ny}-${String(nm).padStart(2, '0')}-07`
}

/** Interest on TCS (s.206C(7) as substituted w.e.f. 1-4-2025; 2025 Act s.398(3)(a)): 1% a month
 *  or part from when collectible to when collected, then 1.5% from collection to payment when
 *  paid after the due date — the same two tiers as TDS (src/shared/tdsInterest.ts). */
export const TCS_LATE_COLLECTION_RATE_BP = 100
export const TCS_LATE_PAYMENT_RATE_BP = 150

/** Due date of the quarterly statement: Form 27EQ 15 Jul / 15 Oct / 15 Jan / 15 May (rule 31AA)
 *  up to FY 2025-26; Form 143 31 Jul / 31 Oct / 31 Jan / 31 May (rule 219(4)) from tax year
 *  2026-27. The certificate (Form 27D / Form 133) is due 15 days after it (rule 37D / rule 215). */
export function tcsStatementDueDate(fyStartYear: number, q: 1 | 2 | 3 | 4): { statement: string; certificate: string; form: 'form27eq' | 'form143' } {
  const newRules = fyStartYear >= 2026
  const day = newRules ? 31 : 15
  const [y, m] = q === 1 ? [fyStartYear, 7] : q === 2 ? [fyStartYear, 10] : q === 3 ? [fyStartYear + 1, 1] : [fyStartYear + 1, 5]
  const statement = `${y}-${String(m).padStart(2, '0')}-${day}`
  const d = new Date(`${statement}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + 15)
  return { statement, certificate: d.toISOString().slice(0, 10), form: newRules ? 'form143' : 'form27eq' }
}

/**
 * Collectee code for the TCS statement, from the PAN's fourth character (Protean 27EQ v6.9 /
 * Form 143 v1.1, Annexure 8): 01 company, 02 individual, 03 HUF, 04 AOP, 07 firm, 08 BOI,
 * 09 artificial juridical person, 10 others (G / T / L). Codes 05 (AOP of companies) and 06
 * (co-operative society) can't be read off a PAN and are left to the user. Form 143 writes the
 * same codes without the leading zero. Without a PAN the ledger's collectee type is used.
 */
export function collecteeCodeForReturn(pan: string | null, type: string | null, layout: 'form27eq' | 'form143'): string {
  const byPan: Record<string, string> = { C: '01', P: '02', H: '03', A: '04', F: '07', B: '08', J: '09', G: '10', T: '10', L: '10' }
  let code = pan && /^[A-Z]{5}\d{4}[A-Z]$/.test(pan) ? (byPan[pan[3]!] ?? '') : ''
  if (!code) code = type === 'company' ? '01' : type === 'firm' ? '07' : type === 'individual_huf' ? '02' : type === 'other' ? '10' : ''
  return layout === 'form143' && code ? String(Number(code)) : code
}

/** Remarks for the collectee row (27EQ Annexure 6 / Form 143 field 32): A lower collection on a
 *  s.206C(9) / s.395(3) certificate, B no collection on a Form 27C / Form 127 declaration,
 *  C higher rate for want of PAN. */
export const TCS_REMARK_TEXT: Record<string, string> = {
  A: 'A — lower collection, certificate',
  B: 'B — no collection, buyer declaration',
  C: 'C — higher rate, no PAN'
}

/** A "not applicable" reason that is the buyer's Form 27C (s.206C(1A)) / Form 127 (s.394(2))
 *  declaration — reported in the statement with remark B. */
export const isDeclarationReason = (reason: string | null | undefined): boolean =>
  !!reason && /27C|form 127|206C\(1A\)|394\(2\)/i.test(reason)
