// WP 8.7 (plan 2026-10-13 §3 "Opening setup"): what a continuing business had on day one, in
// plain questions — money (cash, each bank), what customers owe (bill by bill), what the business
// owes suppliers, stock on hand (quantity × what it cost) and, behind "More…", loans and things
// used for years. Pure: the payload schema `simple:openings` parses, the per-step checks the
// screen shows under each field, the payload builder and the day-one figures.
//
// Rules:
// - Amounts are integer paise and never below zero (the side is the question: a customer owes
//   you, you owe a supplier). Quantities are integer thousandths; a stock line's value is
//   quantity × rate, rounded half up to the paisa (BigInt — no float touches the amount).
// - A party's bills: number optional (blank → "Opening", "Opening 2" …), date optional (blank =
//   the books-begin day), no two with the same number for one party (stableBillKey `o:<name>`).
// - The difference (what you have − what you owe) is the owner's money at the start; the user
//   confirms it and it goes to the capital account — never to a suspense account.
import { z } from 'zod'
import { isoDate } from '../schemas'

export const OPENING_STEPS = ['money', 'customers', 'suppliers', 'stock', 'confirm'] as const
export type OpeningStep = (typeof OPENING_STEPS)[number]

/** The steps a company sees (stock only while stock is on). */
export function openingSteps(stockOn: boolean): OpeningStep[] {
  return OPENING_STEPS.filter((s) => s !== 'stock' || stockOn)
}

/** "More…" balances: what kind of thing, which standard group it lives under, which side. */
export const OPENING_OTHER_KINDS = ['loan_taken', 'loan_given', 'fixed_asset'] as const
export type OpeningOtherKind = (typeof OPENING_OTHER_KINDS)[number]
export const OTHER_KIND_GROUP: Record<OpeningOtherKind, string> = {
  loan_taken: 'Loans (Liability)',
  loan_given: 'Loans & Advances (Asset)',
  fixed_asset: 'Fixed Assets'
}
/** +1 = something the business has (debit), −1 = something it owes (credit). */
export const OTHER_KIND_SIDE: Record<OpeningOtherKind, 1 | -1> = { loan_taken: -1, loan_given: 1, fixed_asset: 1 }

/** The bill number given to a bill typed without one. */
export const OPENING_BILL_NAME = 'Opening'
/** Reserved for the part of an opening its bills don't cover (never a user's bill number). */
export const OPENING_BALANCE_NAME = 'Opening (balance)'
const isReserved = (ref: string): boolean => ref.trim().toLowerCase() === OPENING_BALANCE_NAME.toLowerCase()

// ---------- payload (simple:openings / simple:openings:preview) ----------

const paise = z.number().int().safe()
const amount = paise.min(0)
const id = z.number().int().positive()
const name = z.string().trim().max(120)

const moneyRowSchema = z.object({
  ledgerId: id.nullable().default(null),
  name: name.default(''),
  amount,
  /** The account's opening when the screen loaded it (null = a new row) — a value changed
   *  elsewhere since is left alone with a warning. */
  base: paise.nullable().default(null)
})
const billSchema = z.object({
  ref: z.string().trim().max(60).default(''),
  /** Null = the books-begin day. */
  date: isoDate.nullable().default(null),
  amount: paise.positive()
})
const partySchema = z.object({
  ledgerId: id.nullable().default(null),
  name: name.default(''),
  base: paise.nullable().default(null),
  bills: z.array(billSchema).max(500)
})
const itemSchema = z.object({
  itemId: id.nullable().default(null),
  name: name.default(''),
  unitId: id.nullable().default(null),
  qtyMilli: z.number().int().min(0),
  ratePaise: amount,
  /** The stored value, sent back when quantity and rate are as loaded (a rate worked out from a
   *  stored value may not multiply back to it exactly). Absent = quantity × rate. */
  value: amount.optional(),
  base: z.object({ qtyMilli: z.number().int(), value: paise }).nullable().default(null)
})
const otherSchema = moneyRowSchema.extend({ kind: z.enum(OPENING_OTHER_KINDS) })

const refKey = (s: string): string => s.trim().toLowerCase()

export const simpleOpeningsSchema = z
  .object({
    cash: z.object({ amount, base: paise.nullable().default(null) }),
    banks: z.array(moneyRowSchema).max(200).default([]),
    /** Bank overdrafts: what the business owes its bank (amount owed ≥ 0; the account's opening
     *  becomes −amount). */
    overdrafts: z.array(moneyRowSchema).max(200).default([]),
    customers: z.array(partySchema).max(5000).default([]),
    suppliers: z.array(partySchema).max(5000).default([]),
    items: z.array(itemSchema).max(5000).default([]),
    others: z.array(otherSchema).max(200).default([]),
    /** The owner's-money figure the confirm step showed (paise, dr-positive like every opening).
     *  `simple:openings` refuses to write when the books now give a different one. */
    confirmCapital: paise.optional(),
    /** Which capital account takes the owner's money (one of OpeningsState.capitals); absent = the first. */
    capitalLedgerId: id.optional()
  })
  .strict()
  .superRefine((v, ctx) => {
    const rows = (list: { ledgerId: number | null; name: string }[], path: string): void => {
      const seen = new Set<string>()
      list.forEach((r, i) => {
        if (r.ledgerId == null && !r.name) ctx.addIssue({ code: 'custom', path: [path, i, 'name'], message: 'A new row needs a name' })
        const k = r.ledgerId != null ? `#${r.ledgerId}` : `n:${refKey(r.name)}`
        if (seen.has(k)) ctx.addIssue({ code: 'custom', path: [path, i, 'name'], message: 'The same name is in the list twice' })
        seen.add(k)
      })
    }
    rows([...v.banks, ...v.overdrafts], 'banks')
    rows(v.customers, 'customers')
    rows(v.suppliers, 'suppliers')
    rows(v.others, 'others')
    rows(v.items.map((r) => ({ ledgerId: r.itemId, name: r.name })), 'items')
    for (const side of ['customers', 'suppliers'] as const) {
      v[side].forEach((p, i) => {
        const refs = new Set<string>()
        p.bills.forEach((b, j) => {
          if (!b.ref) return
          if (isReserved(b.ref)) ctx.addIssue({ code: 'custom', path: [side, i, 'bills', j, 'ref'], message: `"${OPENING_BALANCE_NAME}" is kept for the part of an opening its bills don't cover` })
          if (refs.has(refKey(b.ref))) ctx.addIssue({ code: 'custom', path: [side, i, 'bills', j, 'ref'], message: 'Two bills of one party have the same number' })
          refs.add(refKey(b.ref))
        })
      })
    }
  })
export type SimpleOpeningsInput = z.input<typeof simpleOpeningsSchema>
export type SimpleOpenings = z.infer<typeof simpleOpeningsSchema>

// ---------- arithmetic ----------

/** Quantity (thousandths) × rate (paise per unit) → paise, rounded half up. */
export function stockLineValue(qtyMilli: number, ratePaise: number): number {
  const p = BigInt(qtyMilli) * BigInt(ratePaise)
  return Number((p + 500n) / 1000n)
}

/** Rate (paise per unit) back from a stored quantity and value, rounded half up; 0 when no quantity. */
export function stockLineRate(qtyMilli: number, value: number): number {
  if (qtyMilli <= 0) return 0
  return Number((BigInt(value) * 1000n + BigInt(qtyMilli) / 2n) / BigInt(qtyMilli))
}

/** Bill numbers for a party's bills: typed numbers kept; blank ones get "Opening", "Opening 2" …
 *  in DATE order (blank date = `booksBegin`; ties keep their order), skipping typed numbers. */
export function billNames(refs: readonly string[], dates: readonly (string | null)[] = [], booksBegin = ''): string[] {
  const taken = new Set(refs.filter((r) => r.trim()).map(refKey))
  const out = refs.map((r) => r.trim())
  const blanks = refs
    .map((r, i) => ({ i, blank: !r.trim(), date: dates[i] || booksBegin }))
    .filter((x) => x.blank)
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.i - b.i))
  let n = 1
  for (const { i } of blanks) {
    for (;;) {
      const candidate = n === 1 ? OPENING_BILL_NAME : `${OPENING_BILL_NAME} ${n}`
      n++
      if (!taken.has(refKey(candidate))) {
        taken.add(refKey(candidate))
        out[i] = candidate
        break
      }
    }
  }
  return out
}

export interface OpeningFigures {
  /** Money + what customers owe + stock + loans given + things used for years (paise). */
  have: number
  /** What the business owes suppliers + loans taken (paise). */
  owe: number
  /** have − owe: the owner's money at the start (negative = the business owes more than it has). */
  difference: number
}

/** The day-one figures of the answers alone (the screen's running totals; the confirm step shows
 *  the service's figures, which also count balances entered elsewhere in the books). */
export function openingFigures(input: Pick<SimpleOpenings, 'cash' | 'banks' | 'overdrafts' | 'customers' | 'suppliers' | 'items' | 'others'>): OpeningFigures {
  let have = input.cash.amount
  let owe = 0
  for (const b of input.banks) have += b.amount
  for (const b of input.overdrafts) owe += b.amount
  for (const p of input.customers) for (const b of p.bills) have += b.amount
  for (const p of input.suppliers) for (const b of p.bills) owe += b.amount
  for (const it of input.items) have += it.value ?? stockLineValue(it.qtyMilli, it.ratePaise)
  for (const o of input.others) {
    if (OTHER_KIND_SIDE[o.kind] > 0) have += o.amount
    else owe += o.amount
  }
  return { have, owe, difference: have - owe }
}

/** Which sentence the confirm step says about the difference. */
export function differenceKind(difference: number): 'more' | 'less' | 'even' {
  return difference > 0 ? 'more' : difference < 0 ? 'less' : 'even'
}

// ---------- the screen's answers (as typed) and their checks ----------

export interface MoneyRowDraft {
  key: string
  ledgerId: number | null
  name: string
  amount: number | null
  base: number | null
}
export interface BillDraft {
  key: string
  ref: string
  /** '' = the start day. */
  date: string
  amount: number | null
}
export interface PartyDraft {
  key: string
  ledgerId: number | null
  name: string
  base: number | null
  bills: BillDraft[]
}
export interface ItemDraft {
  key: string
  itemId: number | null
  name: string
  unitId: number | null
  qty: string
  rate: number | null
  base: { qtyMilli: number; value: number } | null
}
export interface OtherDraft extends MoneyRowDraft {
  kind: OpeningOtherKind
}
export interface OpeningsDraft {
  cash: { amount: number | null; base: number | null }
  banks: MoneyRowDraft[]
  /** Bank accounts that are overdrawn — shown with what you owe (amount owed). */
  overdrafts: MoneyRowDraft[]
  customers: PartyDraft[]
  suppliers: PartyDraft[]
  items: ItemDraft[]
  others: OtherDraft[]
}

export type OpeningsErrorKey =
  | 'errors.openings.negative'
  | 'errors.openings.nameNeeded'
  | 'errors.openings.amountNeeded'
  | 'errors.openings.duplicateName'
  | 'errors.openings.duplicateBill'
  | 'errors.openings.dateAfterStart'
  | 'errors.openings.qtyNeeded'
  | 'errors.openings.qtyInvalid'
  | 'errors.openings.reservedName'

/** Errors by field path ('banks.0.amount', 'customers.1.bills.0.ref' …). */
export type OpeningsErrors = Record<string, OpeningsErrorKey>

/** "2.5" → 2500 thousandths; null for blank or unreadable text (digits and one point, ≤ 3 decimals). */
export function parseQtyText(text: string): number | null {
  const t = text.trim().replace(/,/g, '')
  if (!/^\d+(\.\d{1,3})?$/.test(t) && !/^\.\d{1,3}$/.test(t)) return null
  const [whole = '0', frac = ''] = t.split('.')
  return Number(whole || '0') * 1000 + Number(frac.padEnd(3, '0') || '0')
}

const blankBill = (b: BillDraft): boolean => !b.ref.trim() && !b.date && b.amount == null
const blankParty = (p: PartyDraft): boolean => p.ledgerId == null && !p.name.trim() && p.bills.every(blankBill)
const blankItem = (r: ItemDraft): boolean => r.itemId == null && !r.name.trim() && !r.qty.trim() && r.rate == null
const blankMoney = (r: MoneyRowDraft): boolean => r.ledgerId == null && !r.name.trim() && r.amount == null

function checkMoneyRows(rows: MoneyRowDraft[], path: string, e: OpeningsErrors): void {
  const names = new Set<string>()
  rows.forEach((r, i) => {
    if (blankMoney(r)) return
    if (r.amount != null && r.amount < 0) e[`${path}.${i}.amount`] = 'errors.openings.negative'
    if (r.ledgerId == null) {
      if (!r.name.trim()) e[`${path}.${i}.name`] = 'errors.openings.nameNeeded'
      else if (names.has(refKey(r.name))) e[`${path}.${i}.name`] = 'errors.openings.duplicateName'
    }
    if (r.name.trim()) names.add(refKey(r.name))
  })
}

function checkParties(rows: PartyDraft[], path: string, booksBegin: string, e: OpeningsErrors): void {
  const names = new Set<string>()
  rows.forEach((p, i) => {
    if (blankParty(p)) return
    if (!p.name.trim()) e[`${path}.${i}.name`] = 'errors.openings.nameNeeded'
    else if (names.has(refKey(p.name))) e[`${path}.${i}.name`] = 'errors.openings.duplicateName'
    if (p.name.trim()) names.add(refKey(p.name))
    const refs = new Set<string>()
    p.bills.forEach((b, j) => {
      if (blankBill(b)) return
      const at = `${path}.${i}.bills.${j}`
      if (b.amount == null || b.amount === 0) e[`${at}.amount`] = 'errors.openings.amountNeeded'
      else if (b.amount < 0) e[`${at}.amount`] = 'errors.openings.negative'
      if (b.ref.trim()) {
        if (isReserved(b.ref)) e[`${at}.ref`] = 'errors.openings.reservedName'
        else if (refs.has(refKey(b.ref))) e[`${at}.ref`] = 'errors.openings.duplicateBill'
        refs.add(refKey(b.ref))
      }
      if (b.date && b.date > booksBegin) e[`${at}.date`] = 'errors.openings.dateAfterStart'
    })
  })
}

function checkItems(rows: ItemDraft[], e: OpeningsErrors): void {
  const names = new Set<string>()
  rows.forEach((r, i) => {
    if (blankItem(r)) return
    if (r.itemId == null) {
      if (!r.name.trim()) e[`items.${i}.name`] = 'errors.openings.nameNeeded'
      else if (names.has(refKey(r.name))) e[`items.${i}.name`] = 'errors.openings.duplicateName'
    }
    if (r.name.trim()) names.add(refKey(r.name))
    const qty = r.qty.trim() ? parseQtyText(r.qty) : null
    if (r.qty.trim() && qty == null) e[`items.${i}.qty`] = r.qty.trim().startsWith('-') ? 'errors.openings.negative' : 'errors.openings.qtyInvalid'
    else if (!r.qty.trim() && (r.rate ?? 0) > 0) e[`items.${i}.qty`] = 'errors.openings.qtyNeeded'
    if (r.rate != null && r.rate < 0) e[`items.${i}.rate`] = 'errors.openings.negative'
  })
}

/** The problems on one step (empty = can go on). The confirm step checks everything. */
export function openingsStepErrors(d: OpeningsDraft, step: OpeningStep, booksBegin: string): OpeningsErrors {
  const e: OpeningsErrors = {}
  if (step === 'money' || step === 'confirm') {
    if (d.cash.amount != null && d.cash.amount < 0) e['cash.amount'] = 'errors.openings.negative'
    checkMoneyRows(d.banks, 'banks', e)
  }
  if (step === 'customers' || step === 'confirm') checkParties(d.customers, 'customers', booksBegin, e)
  if (step === 'suppliers' || step === 'confirm') {
    checkParties(d.suppliers, 'suppliers', booksBegin, e)
    checkMoneyRows(d.overdrafts, 'overdrafts', e)
  }
  if (step === 'stock' || step === 'confirm') checkItems(d.items, e)
  if (step === 'confirm') checkMoneyRows(d.others, 'others', e)
  return e
}

/** The answers → the payload (call once the checks are clean). Blank new rows are dropped; a row
 *  the screen loaded is always sent (at zero when emptied), so clearing it clears the books. */
export function openingsPayload(d: OpeningsDraft, confirmCapital?: number, capitalLedgerId?: number): SimpleOpeningsInput {
  const money = (r: MoneyRowDraft): { ledgerId: number | null; name: string; amount: number; base: number | null } => ({
    ledgerId: r.ledgerId, name: r.name.trim(), amount: r.amount ?? 0, base: r.base
  })
  const party = (p: PartyDraft): NonNullable<SimpleOpeningsInput['customers']>[number] => ({
    ledgerId: p.ledgerId,
    name: p.name.trim(),
    base: p.base,
    bills: p.bills.filter((b) => !blankBill(b) && (b.amount ?? 0) > 0).map((b) => ({ ref: b.ref.trim(), date: b.date || null, amount: b.amount! }))
  })
  const keepParty = (p: PartyDraft): boolean => p.ledgerId != null || (!blankParty(p) && p.bills.some((b) => (b.amount ?? 0) > 0))
  return {
    cash: { amount: d.cash.amount ?? 0, base: d.cash.base },
    banks: d.banks.filter((r) => r.ledgerId != null || (!blankMoney(r) && (r.amount ?? 0) > 0)).map(money),
    overdrafts: d.overdrafts.filter((r) => r.ledgerId != null || (!blankMoney(r) && (r.amount ?? 0) > 0)).map(money),
    customers: d.customers.filter(keepParty).map(party),
    suppliers: d.suppliers.filter(keepParty).map(party),
    items: d.items
      .filter((r) => r.itemId != null || !blankItem(r))
      .map((r) => {
        const qtyMilli = parseQtyText(r.qty) ?? 0
        const ratePaise = r.rate ?? 0
        const asLoaded = r.base != null && qtyMilli === r.base.qtyMilli && ratePaise === stockLineRate(r.base.qtyMilli, r.base.value)
        return { itemId: r.itemId, name: r.name.trim(), unitId: r.unitId, qtyMilli, ratePaise, ...(asLoaded ? { value: r.base!.value } : {}), base: r.base }
      })
      .filter((r) => r.itemId != null || r.qtyMilli > 0),
    others: d.others.filter((r) => r.ledgerId != null || (!blankMoney(r) && (r.amount ?? 0) > 0)).map((r) => ({ ...money(r), kind: r.kind })),
    ...(confirmCapital !== undefined ? { confirmCapital } : {}),
    ...(capitalLedgerId !== undefined ? { capitalLedgerId } : {})
  }
}

// ---------- what the screen loads / what a run returns ----------

export interface OpeningsState {
  /** The day the openings are dated on (CompanyInfo.booksBeginDate, else the first FY's start). */
  booksBegin: string
  /** meta ui.startedFresh (null when setup didn't ask). */
  startedFresh: boolean | null
  stockOn: boolean
  /** When the opening setup was last confirmed (null = never). */
  appliedAt: string | null
  cash: { ledgerId: number; name: string; amount: number }
  banks: { ledgerId: number; name: string; amount: number }[]
  /** Overdrawn bank accounts (and accounts under Bank OD): `amount` = what is owed to the bank. */
  overdrafts: { ledgerId: number; name: string; amount: number }[]
  customers: OpeningPartyState[]
  suppliers: OpeningPartyState[]
  items: { itemId: number; name: string; unitId: number; qtyMilli: number; value: number; ratePaise: number }[]
  others: { kind: OpeningOtherKind; ledgerId: number; name: string; amount: number }[]
  /** Pickers: every customer / supplier / item / unit by name. */
  pick: {
    customers: { id: number; name: string }[]
    suppliers: { id: number; name: string }[]
    items: { id: number; name: string; unitId: number }[]
    units: { id: number; name: string; symbol: string }[]
  }
  /** Capital accounts the owner's money can go to (the first is the default). */
  capitals: { ledgerId: number; name: string; amount: number }[]
  /** Parts of the setup that hold a figure (money, customers, suppliers, stock while on). */
  progress: { done: number; total: number }
}

export interface OpeningPartyState {
  ledgerId: number
  name: string
  amount: number
  /** What Outstandings shows: the stored opening bills, plus an unnamed bill for any part of the
   *  opening they don't cover (or one unnamed bill for the whole opening — ref '' / date null). */
  bills: { ref: string; date: string | null; amount: number }[]
  /** The stored bills add up to MORE than the opening (it was lowered elsewhere) — the screen
   *  warns; saving puts the bills you see. */
  mismatch: boolean
}

export interface OpeningsWarning {
  /** What was left alone: an account, an item. */
  kind: 'account' | 'item'
  name: string
  /** Its opening now (paise; an item's value). */
  kept: number
}

export interface OpeningsResult {
  booksBegin: string
  /** Every figure counted for day one (paise). */
  have: number
  owe: number
  difference: number
  capital: { ledgerId: number | null; name: string; before: number; after: number }
  /** Rows changed elsewhere since the screen loaded them — left as they are. */
  warnings: OpeningsWarning[]
  /** Accounts / items / bills the run changed (0 = it changed nothing). */
  changed: number
  /** True when the books' opening balances agree (debit = credit) after the run. */
  balanced: boolean
}

/** The screen's starting answers: every figure as the books hold it (bases = those figures). */
export function draftFromState(st: OpeningsState, formatQty: (qtyMilli: number) => string): OpeningsDraft {
  let n = 0
  const key = (): string => `k${++n}`
  const party = (p: OpeningPartyState, sign: 1 | -1): PartyDraft => ({
    key: key(),
    ledgerId: p.ledgerId,
    name: p.name,
    base: sign * p.amount,
    bills: p.bills.map((b) => ({ key: key(), ref: b.ref, date: b.date ?? '', amount: b.amount }))
  })
  return {
    cash: { amount: st.cash.amount, base: st.cash.amount },
    banks: st.banks.map((b) => ({ key: key(), ledgerId: b.ledgerId, name: b.name, amount: b.amount, base: b.amount })),
    overdrafts: st.overdrafts.map((b) => ({ key: key(), ledgerId: b.ledgerId, name: b.name, amount: b.amount, base: -b.amount })),
    customers: st.customers.map((p) => party(p, 1)),
    suppliers: st.suppliers.map((p) => party(p, -1)),
    items: st.items.map((i) => ({ key: key(), itemId: i.itemId, name: i.name, unitId: i.unitId, qty: formatQty(i.qtyMilli), rate: i.ratePaise, base: { qtyMilli: i.qtyMilli, value: i.value } })),
    others: st.others.map((o) => ({ key: key(), kind: o.kind, ledgerId: o.ledgerId, name: o.name, amount: o.amount, base: OTHER_KIND_SIDE[o.kind] * o.amount }))
  }
}
