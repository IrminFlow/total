// Record a purchase / Purchase list (WP 9.3, plan 2026-10-13 §3): the READ side of the simple Buy
// screens. Writing goes through simple:post only (services/simplePost.ts); these three reads give
// the form its choices and the list its rows — every figure from the services the accountant
// screens use:
//
// - buySetup: suppliers (creditors), the cash / bank accounts and, per way of paying, the default
//   account: the WP 5.6 memory "Pay from" preference (purpose `payment`, only while Settings → AI
//   "Use memory" is on, and only when it is a bank account), else the counter's accounts (Counter
//   options, else the first bank) — the same defaults simple:post falls back to; and the
//   purchase account simple:post uses by default ("Purchases" by category, else the first
//   purchase account);
// - purchasesList: every in-books purchase bill dated from…to, with what is still due on each
//   from the Outstandings allocation (outstandingsWithAdvances, payable side, as on today) —
//   paid = total − due, never stored;
// - purchaseView: one bill as the simple view shows it (read-only), from getVoucher + the same
//   allocation for its supplier.
import type { DB } from '../db/connection'
import type { MoneyHow } from '@shared/simple/intents'
import type { BuySetup, PurchaseRow, PurchaseView } from '@shared/simple/buy'
import { getVoucher, IN_BOOKS } from './vouchers'
import { counterAccounts } from './counter'
import { outstandingsWithAdvances, partyAllocation } from './analysis'
import { ledgerClassifier } from '../ai/ledgerClass'
import { memoryContextFor } from '../ai/memory'
import { getAiSettings } from '../ai/settings'

function purchaseAccount(db: DB): number | null {
  const cat = db.prepare("SELECT id FROM ledgers WHERE simple_category = 'purchases' ORDER BY id LIMIT 1").get() as { id: number } | undefined
  if (cat) return cat.id
  // simplePost's fallback: the first ledger under Purchase Accounts (at any depth).
  const r = db
    .prepare(
      `WITH RECURSIVE g(id) AS (SELECT id FROM groups WHERE name = 'Purchase Accounts' UNION ALL SELECT c.id FROM groups c JOIN g ON c.parent_id = g.id)
       SELECT id FROM ledgers WHERE group_id IN (SELECT id FROM g) ORDER BY id LIMIT 1`
    )
    .get() as { id: number } | undefined
  return r?.id ?? null
}

export function buySetup(db: DB): BuySetup {
  const cls = ledgerClassifier(db)
  const all = db.prepare('SELECT id, name, state_code AS stateCode, gstin, phone FROM ledgers ORDER BY name COLLATE NOCASE').all() as {
    id: number; name: string; stateCode: string | null; gstin: string | null; phone: string | null
  }[]
  const acc = counterAccounts(db)
  const suppliers = all.filter((l) => cls.cls(l.id) === 'creditor').map((l) => ({ id: l.id, name: l.name, stateCode: l.stateCode, gstin: l.gstin, phone: l.phone }))
  const moneyAccounts = all.flatMap((l) => {
    const c = cls.cls(l.id)
    return c === 'cash' || c === 'bank' ? [{ id: l.id, name: l.name, kind: c }] : []
  })
  const isBank = (id: number | null): boolean => id != null && moneyAccounts.some((a) => a.id === id && a.kind === 'bank')
  const isCash = (id: number | null): boolean => id != null && moneyAccounts.some((a) => a.id === id && a.kind === 'cash')
  const firstBank = moneyAccounts.find((a) => a.kind === 'bank')?.id ?? null
  const defaults: Record<MoneyHow, number | null> = {
    cash: isCash(acc.cashLedgerId) ? acc.cashLedgerId : (moneyAccounts.find((a) => a.kind === 'cash')?.id ?? null),
    upi: acc.upiLedgerId ?? firstBank,
    card: acc.cardLedgerId ?? firstBank,
    bank: firstBank
  }
  let memoryId: number | null = null
  const memo = memoryContextFor(db, getAiSettings(db).useMemory).preferredLedger('payment')
  if (memo && isBank(memo.ledgerId)) {
    defaults.upi = memo.ledgerId
    defaults.card = memo.ledgerId
    defaults.bank = memo.ledgerId
    memoryId = memo.memoryId
  }
  return { suppliers, moneyAccounts, defaults, memoryId, purchaseAccountId: purchaseAccount(db) }
}

interface BillRow {
  id: number
  number: string
  reference: string | null
  date: string
  partyId: number | null
  partyName: string | null
  total: number
  tax: number
}

/** In-books purchase bills (IN_BOOKS: not binned, not optional, not unmatured post-dated). The
 *  total is the supplier's side of the bill (what is owed), the tax its input-tax lines. */
function bills(db: DB, where: string, ...args: unknown[]): BillRow[] {
  return db
    .prepare(
      `SELECT v.id, v.number, v.reference, v.date, v.party_ledger_id AS partyId, p.name AS partyName,
              COALESCE((SELECT SUM(vl.amount) FROM voucher_lines vl WHERE vl.voucher_id = v.id AND vl.ledger_id = v.party_ledger_id AND vl.dr_cr = 'cr'), 0) AS total,
              COALESCE((SELECT SUM(vl.amount) FROM voucher_lines vl JOIN ledgers t ON t.id = vl.ledger_id WHERE vl.voucher_id = v.id AND vl.dr_cr = 'dr' AND t.tax_type IS NOT NULL), 0) AS tax
       FROM vouchers v
       JOIN voucher_types vt ON vt.id = v.voucher_type_id
       LEFT JOIN ledgers p ON p.id = v.party_ledger_id
       WHERE vt.kind = 'purchase' AND ${where} AND ${IN_BOOKS}
       ORDER BY v.date DESC, v.id DESC`
    )
    .all(...args) as BillRow[]
}

/** Every in-books purchase bill dated `from`…`to`, newest first, with what is still due on it. */
export function purchasesList(db: DB, from: string, to: string, today: string): PurchaseRow[] {
  const open = new Map<number, { pending: number; dueDate: string | null; overdueDays: number }>()
  for (const p of outstandingsWithAdvances(db, 'payable', today).parties) {
    for (const b of p.bills) if (b.voucherId != null) open.set(b.voucherId, { pending: b.pending, dueDate: b.dueDate, overdueDays: b.overdueDays })
  }
  return bills(db, 'v.date BETWEEN ? AND ?', from, to).map((r) => {
    const o = open.get(r.id)
    const due = Math.min(o?.pending ?? 0, r.total)
    return {
      voucherId: r.id,
      number: r.number,
      billNo: r.reference,
      date: r.date,
      partyId: r.partyId,
      partyName: r.partyName ?? '',
      total: r.total,
      tax: r.tax,
      paid: r.total - due,
      due,
      dueDate: o?.dueDate ?? null,
      overdueDays: o?.overdueDays ?? 0
    }
  })
}

/** One purchase bill as the simple view shows it; null when it is not an in-books purchase bill. */
export function purchaseView(db: DB, id: number, today: string): PurchaseView | null {
  const row = bills(db, 'v.id = ?', id)[0]
  const v = row ? getVoucher(db, id) : null
  if (!row || !v) return null
  const ledger = db.prepare('SELECT name, tax_type AS taxType FROM ledgers WHERE id = ?')
  const item = db.prepare('SELECT s.name, u.symbol FROM stock_items s LEFT JOIN units u ON u.id = s.unit_id WHERE s.id = ?')
  const amounts: PurchaseView['amounts'] = []
  if (v.inventory.length === 0) {
    for (const l of v.lines) {
      if (l.drCr !== 'dr' || l.ledgerId === v.partyLedgerId) continue
      const lg = ledger.get(l.ledgerId) as { name: string; taxType: string | null } | undefined
      if (!lg?.taxType && !/^round ?off$/i.test(lg?.name ?? '')) amounts.push({ name: lg?.name ?? '', amount: l.amount })
    }
  }
  const billName = v.billRefs.find((r) => r.kind === 'new')?.name ?? v.number
  const open = v.partyLedgerId != null ? partyAllocation(db, v.partyLedgerId, today).bills.find((b) => b.voucherId === v.id && b.number === billName) : undefined
  const due = Math.min(open?.pending ?? 0, row.total)
  return {
    voucherId: v.id,
    number: v.number,
    billNo: v.reference,
    date: v.date,
    partyId: v.partyLedgerId,
    partyName: row.partyName ?? '',
    total: row.total,
    tax: row.tax,
    paid: row.total - due,
    due,
    dueDate: open?.dueDate ?? null,
    overdueDays: open?.overdueDays ?? 0,
    items: v.inventory.map((l) => {
      const it = item.get(l.stockItemId) as { name: string; symbol: string | null } | undefined
      return { name: it?.name ?? '', qtyMilli: l.qtyMilli, unit: it?.symbol ?? '', ratePaise: l.ratePaise, discountPaise: l.discountPaise, amount: l.amount }
    }),
    amounts,
    note: v.narration
  }
}
