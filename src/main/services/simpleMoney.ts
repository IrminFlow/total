// Money in / out / move and the money list (WP 9.4, plan 2026-10-13 §3): the READ side of the
// simple Money screens. Writing goes through simple:post only (services/simplePost.ts); these
// reads give the forms their choices and the list its rows — every figure from the services the
// accountant screens use:
//
// - moneySetup: customers (debtors, the counter's walk-in left out) and suppliers, the cash / bank
//   accounts and, per way of paying, the default account — money in: the WP 5.6 memory "Receive
//   into" preference (purpose receipt), money out: the memory for payments (only while Settings →
//   AI "Use memory" is on, and only when it is a bank); else the counter's accounts / first bank —
//   the owner's money / drawings accounts (category, else by group), loans taken, and whether
//   TDS / Payroll are on;
// - moneyBills: a party's open bills oldest first, as on the entry's date — the Outstandings
//   allocation (analysis.openBills), the same list simple:post settles;
// - moneyList / moneyEntry: in-books receipts, payments and moves between accounts with who / how
//   and what they settled (their bill refs), never stored. A payment of a GST-bill expense (a
//   purchase on an expense account outside Purchase Accounts — Money out's "Do you have a GST
//   bill?") also names that account (`forWhat`, "Electricity (Bharat Power)") and carries the
//   expense chip: read from the bill its `against` refs settle, never a stored label.
import type { DB } from '../db/connection'
import type { MoneyHow } from '@shared/simple/intents'
import type { MoneyChip, MoneyEntryView, MoneyOpenBill, MoneyRow, MoneySetup } from '@shared/simple/money'
import type { VoucherKind } from '@shared/domain'
import { todayISO } from '@shared/dates'
import { IN_BOOKS, getVoucher } from './vouchers'
import { counterAccounts, WALK_IN_NAME } from './counter'
import { openBills, outstandingsWithAdvances } from './analysis'
import { descendantIdsByName } from './masters'
import { getFeatures } from './config'
import { ledgerClassifier, type LedgerClass } from '../ai/ledgerClass'
import { memoryContextFor } from '../ai/memory'
import { getAiSettings } from '../ai/settings'

const MONEY_KINDS: readonly VoucherKind[] = ['receipt', 'payment', 'contra']

function byCategory(db: DB, key: string): number | null {
  return (db.prepare('SELECT id FROM ledgers WHERE simple_category = ? ORDER BY id LIMIT 1').get(key) as { id: number } | undefined)?.id ?? null
}

/** `customerCredits` (Money out's "A customer (refund)") runs the receivables allocation, so only
 *  the caller that shows it asks (`{ customerCredits: true }`); Money in / Move money don't. */
export function moneySetup(db: DB, opts: { customerCredits?: boolean } = {}): MoneySetup {
  const cls = ledgerClassifier(db)
  const byCategoryOf = (id: number): string | null => (db.prepare('SELECT simple_category AS c FROM ledgers WHERE id = ?').get(id) as { c: string | null } | undefined)?.c ?? null
  const all = db.prepare('SELECT id, name, group_id AS groupId, state_code AS stateCode, phone FROM ledgers ORDER BY name COLLATE NOCASE').all() as {
    id: number; name: string; groupId: number; stateCode: string | null; phone: string | null
  }[]
  const acc = counterAccounts(db)
  const walkInId = acc.walkInLedgerId
  const party = (l: (typeof all)[number]): MoneySetup['customers'][number] => ({ id: l.id, name: l.name, stateCode: l.stateCode, phone: l.phone })
  const customers = all.filter((l) => cls.cls(l.id) === 'debtor' && l.id !== walkInId && l.name !== WALK_IN_NAME).map(party)
  const suppliers = all.filter((l) => cls.cls(l.id) === 'creditor').map(party)
  const moneyAccounts = all.flatMap((l) => {
    const c = cls.cls(l.id)
    return c === 'cash' || c === 'bank' ? [{ id: l.id, name: l.name, kind: c }] : []
  })
  const isKind = (id: number | null, kind: 'cash' | 'bank'): boolean => id != null && moneyAccounts.some((a) => a.id === id && a.kind === kind)
  const firstBank = moneyAccounts.find((a) => a.kind === 'bank')?.id ?? null
  const cashId = isKind(acc.cashLedgerId, 'cash') ? acc.cashLedgerId : (moneyAccounts.find((a) => a.kind === 'cash')?.id ?? null)
  const counter: Record<MoneyHow, number | null> = {
    cash: cashId,
    upi: isKind(acc.upiLedgerId, 'bank') ? acc.upiLedgerId : firstBank,
    card: isKind(acc.cardLedgerId, 'bank') ? acc.cardLedgerId : firstBank,
    bank: firstBank
  }
  const memory = memoryContextFor(db, getAiSettings(db).useMemory)
  const withMemory = (purpose: 'receipt' | 'payment'): { defaults: Record<MoneyHow, number | null>; memoryId: number | null } => {
    const m = memory.preferredLedger(purpose)
    if (!m || !isKind(m.ledgerId, 'bank')) return { defaults: { ...counter }, memoryId: null }
    return { defaults: { ...counter, upi: m.ledgerId, card: m.ledgerId, bank: m.ledgerId }, memoryId: m.memoryId }
  }
  const mIn = withMemory('receipt')
  const mOut = withMemory('payment')

  // The owner's accounts: by category, else — as the WP 8.7 openings choose the capital account —
  // a ledger DIRECTLY under Capital Account, oldest first (never one under Reserves & Surplus,
  // such as the year-end close's Retained Earnings).
  const capitalGroup = (db.prepare("SELECT id FROM groups WHERE name = 'Capital Account'").get() as { id: number } | undefined)?.id
  const underCapital = all.filter((l) => l.groupId === capitalGroup).sort((x, y) => x.id - y.id)
  const ownerId = byCategory(db, 'owner_capital') ?? underCapital.find((l) => !/drawing/i.test(l.name) && byCategoryOf(l.id) !== 'owner_drawings')?.id ?? null
  const drawingsId = byCategory(db, 'owner_drawings') ?? underCapital.find((l) => /drawing/i.test(l.name))?.id ?? null
  const loanGroups = descendantIdsByName(db, ['Loans (Liability)'])
  const loans = all.filter((l) => loanGroups.has(l.groupId) && cls.cls(l.id) === 'other').map((l) => ({ id: l.id, name: l.name }))
  const features = getFeatures(db)
  // Customers whose money we hold (advances, returns kept for the next bill) — the Outstandings
  // allocation as on today, one run (simple People's `ahead`) — only when asked.
  let customerCredits: MoneySetup['customerCredits']
  if (opts.customerCredits) {
    const held = outstandingsWithAdvances(db, 'receivable', todayISO()).advanceByParty
    customerCredits = customers
      .filter((c) => (held.get(c.id) ?? 0) > 0)
      .map((c) => ({ id: c.id, name: c.name, credit: held.get(c.id)! }))
      .sort((a, b) => b.credit - a.credit || a.name.localeCompare(b.name))
  }
  return {
    customers,
    suppliers,
    moneyAccounts,
    defaultsIn: mIn.defaults,
    defaultsOut: mOut.defaults,
    memoryIn: mIn.memoryId,
    memoryOut: mOut.memoryId,
    ownerId,
    drawingsId,
    loans,
    tds: features.tds,
    payroll: features.payroll,
    ...(customerCredits ? { customerCredits } : {})
  }
}

/** A party's open bills (oldest first, still due) as on `date` — the Outstandings allocation. */
export function moneyBills(db: DB, partyId: number, date: string): MoneyOpenBill[] {
  return openBills(db, partyId, date)
    .filter((b) => b.pending > 0)
    .sort((a, b) => a.date.localeCompare(b.date))
    .map((b) => ({ name: b.number, date: b.date, pending: b.pending, voucherId: b.voucherId, dueDate: b.dueDate, overdueDays: b.overdueDays }))
}

interface Head { id: number; number: string; date: string; kind: VoucherKind; party: number | null; narration: string | null; instrument: string | null }

const OTHER_CHIP: Partial<Record<LedgerClass, MoneyChip>> = { expense: 'expense', income: 'income' }

/** One money entry as the list / its view show it (from its own lines and bill refs). */
/** The expense account a GST bill was booked on (WP 9.4 Money out → a purchase of just an amount
 *  on an expense account): the purchase whose `new` ref the payment's `against` ref names — the
 *  party's latest in-books purchase of that name dated on / before the payment — and its one
 *  expense account outside Purchase Accounts (biggest debit). Null for goods / Purchases bills. */
function billExpenseAccount(db: DB, partyId: number, name: string, onOrBefore: string, cls: ReturnType<typeof ledgerClassifier>, groupOf: (id: number) => number | undefined, purchaseGroups: Set<number>): number | null {
  const bill = db
    .prepare(
      `SELECT v.id FROM bill_refs br JOIN vouchers v ON v.id = br.voucher_id JOIN voucher_types vt ON vt.id = v.voucher_type_id
       WHERE br.party_ledger_id = ? AND br.name = ? AND br.kind = 'new' AND vt.kind = 'purchase' AND v.date <= ? AND ${IN_BOOKS}
       ORDER BY v.date DESC, v.id DESC LIMIT 1`
    )
    .get(partyId, name, onOrBefore) as { id: number } | undefined
  if (!bill) return null
  const lines = db.prepare("SELECT ledger_id AS ledgerId, amount FROM voucher_lines WHERE voucher_id = ? AND dr_cr = 'dr' ORDER BY amount DESC, line_order").all(bill.id) as { ledgerId: number; amount: number }[]
  const exp = lines.find((l) => cls.cls(l.ledgerId) === 'expense')
  if (!exp) return null
  const g = groupOf(exp.ledgerId)
  return g != null && purchaseGroups.has(g) ? null : exp.ledgerId
}

function describe(db: DB, h: Head, cls: ReturnType<typeof ledgerClassifier>, groupOf: (id: number) => number | undefined, groups: { capital: Set<number>; loans: Set<number>; purchases: Set<number> }): MoneyEntryView {
  const lines = db.prepare('SELECT ledger_id AS ledgerId, dr_cr AS drCr, amount FROM voucher_lines WHERE voucher_id = ? ORDER BY line_order').all(h.id) as { ledgerId: number; drCr: 'dr' | 'cr'; amount: number }[]
  const refs = db.prepare('SELECT kind, name, amount, party_ledger_id AS partyId FROM bill_refs WHERE voucher_id = ? ORDER BY id').all(h.id) as { kind: 'new' | 'against'; name: string; amount: number; partyId: number }[]
  const name = (id: number): string => cls.name(id) ?? ''
  const money = (l: { ledgerId: number }): boolean => {
    const c = cls.cls(l.ledgerId)
    return c === 'cash' || c === 'bank'
  }
  const direction = h.kind === 'receipt' ? 'in' : h.kind === 'payment' ? 'out' : 'move'
  // The cash / bank side: Dr on money in, Cr on money out; a move: from = Cr, to = Dr.
  const moneySide = direction === 'in' ? 'dr' : 'cr'
  const accountLine = lines.find((l) => l.drCr === moneySide && money(l)) ?? lines.find((l) => money(l))
  const amount = accountLine ? lines.filter((l) => l.drCr === accountLine.drCr && l.ledgerId === accountLine.ledgerId).reduce((s, l) => s + l.amount, 0) : lines.filter((l) => l.drCr === 'dr').reduce((s, l) => s + l.amount, 0)
  const otherLines = lines.filter((l) => l.drCr !== moneySide && (direction === 'move' ? money(l) : true))
  const other = h.party != null ? h.party : ([...otherLines].sort((a, b) => b.amount - a.amount)[0]?.ledgerId ?? null)
  const chips: MoneyChip[] = []
  const against = refs.filter((r) => r.kind === 'against')
  const advance = refs.filter((r) => r.kind === 'new')
  let forWhat: string | null = null
  if (direction !== 'move') {
    const c = other != null ? cls.cls(other) : 'other'
    if (c === 'debtor' || c === 'creditor') {
      if (against.length) chips.push('bills')
      // Paying a supplier's GST bill for an expense: say what it was for (one account for all its bills).
      if (c === 'creditor' && direction === 'out' && against.length) {
        const accounts = new Set(against.map((r) => billExpenseAccount(db, r.partyId, r.name, h.date, cls, groupOf, groups.purchases)))
        const only = accounts.size === 1 ? [...accounts][0] : null
        if (only != null) {
          forWhat = name(only)
          chips.push('expense')
        }
      }
      if (advance.length) chips.push('advance')
      if (!refs.length) chips.push('onAccount')
      if ((c === 'creditor' && direction === 'in') || (c === 'debtor' && direction === 'out')) chips.push('refund')
    } else if (other != null) {
      const g = groupOf(other)
      if (g != null && groups.capital.has(g)) chips.push('owner')
      else if (g != null && groups.loans.has(g)) chips.push('loan')
      else if (OTHER_CHIP[c]) chips.push(OTHER_CHIP[c]!)
    }
  }
  return {
    voucherId: h.id,
    number: h.number,
    date: h.date,
    direction,
    kind: h.kind as MoneyEntryView['kind'],
    who: other != null ? name(other) : '',
    ...(forWhat ? { forWhat } : {}),
    partyId: h.party,
    account: accountLine ? name(accountLine.ledgerId) : '',
    amount,
    chips,
    billCount: against.length,
    bills: refs.map((r) => ({ name: r.name, amount: r.amount, advance: r.kind === 'new' })),
    note: h.narration,
    reference: h.instrument
  }
}

function context(db: DB): { cls: ReturnType<typeof ledgerClassifier>; groupOf: (id: number) => number | undefined; groups: { capital: Set<number>; loans: Set<number>; purchases: Set<number> } } {
  const gmap = new Map((db.prepare('SELECT id, group_id AS g FROM ledgers').all() as { id: number; g: number }[]).map((r) => [r.id, r.g]))
  return {
    cls: ledgerClassifier(db),
    groupOf: (id) => gmap.get(id),
    groups: { capital: descendantIdsByName(db, ['Capital Account']), loans: descendantIdsByName(db, ['Loans (Liability)']), purchases: descendantIdsByName(db, ['Purchase Accounts']) }
  }
}

const HEAD_SQL = `SELECT v.id, v.number, v.date, vt.kind, v.party_ledger_id AS party, v.narration, v.instrument_no AS instrument
  FROM vouchers v JOIN voucher_types vt ON vt.id = v.voucher_type_id`

/** Every in-books receipt, payment and move between accounts dated `from`…`to`, newest first;
 *  rows dated after `today` say so (`ahead`). */
export function moneyList(db: DB, from: string, to: string, today: string = todayISO()): MoneyRow[] {
  const heads = db
    .prepare(`${HEAD_SQL} WHERE vt.kind IN (${MONEY_KINDS.map(() => '?').join(',')}) AND v.date BETWEEN ? AND ? AND v.is_year_end_close = 0 AND ${IN_BOOKS} ORDER BY v.date DESC, v.id DESC`)
    .all(...MONEY_KINDS, from, to) as Head[]
  const ctx = context(db)
  return heads.map((h) => {
    const { kind: _k, bills: _b, note: _n, reference: _r, ...row } = describe(db, h, ctx.cls, ctx.groupOf, ctx.groups)
    return h.date > today ? { ...row, ahead: true as const } : row
  })
}

/** One money entry's simple view; null when it is not an in-books receipt / payment / move. */
export function moneyEntry(db: DB, id: number): MoneyEntryView | null {
  const h = db.prepare(`${HEAD_SQL} WHERE v.id = ? AND vt.kind IN ('receipt', 'payment', 'contra') AND ${IN_BOOKS}`).get(id) as Head | undefined
  if (!h || !getVoucher(db, id)) return null
  const ctx = context(db)
  return describe(db, h, ctx.cls, ctx.groupOf, ctx.groups)
}
