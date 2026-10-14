// Make a bill / Sales list (WP 9.2, plan 2026-10-13 §3): the READ side of the simple Sell screens.
// Writing goes through simple:post only (services/simplePost.ts); these three reads give the form
// its choices and the list its rows — every figure from the services the accountant screens use:
//
// - sellSetup: customers (debtors, the walk-in "Cash sale" left out — it is the form's "Cash
//   customer"), the cash / bank accounts and, per way of being paid, the default account: the
//   WP 5.6 memory "Receive into" preference (only while Settings → AI "Use memory" is on, and only
//   when it is a cash / bank account), else the counter's accounts (Counter options, else the
//   first bank) — the same defaults simple:post falls back to;
// - salesList: the sales register's in-books bills (registerVoucherRows) with what is still due
//   on each from the Outstandings allocation (outstandingsWithAdvances, as on today) — paid =
//   total − due, never stored;
// - saleView: one bill as the simple view shows it (read-only), from getVoucher + the same
//   allocation for its customer.
import type { DB } from '../db/connection'
import type { MoneyHow } from '@shared/simple/intents'
import type { SaleRow, SaleView, SellSetup } from '@shared/simple/sell'
import { billAmount } from '@shared/simple/saveCard'
import { getVoucher, IN_BOOKS } from './vouchers'
import { counterAccounts, WALK_IN_NAME } from './counter'
import { outstandingsWithAdvances, partyAllocation, registerVoucherRows } from './analysis'
import { ledgerClassifier } from '../ai/ledgerClass'
import { memoryContextFor } from '../ai/memory'
import { getAiSettings } from '../ai/settings'

export function sellSetup(db: DB): SellSetup {
  const cls = ledgerClassifier(db)
  const all = db.prepare('SELECT id, name, state_code AS stateCode, phone, credit_hold AS hold FROM ledgers ORDER BY name COLLATE NOCASE').all() as {
    id: number; name: string; stateCode: string | null; phone: string | null; hold: number | null
  }[]
  const acc = counterAccounts(db)
  const walkInId = acc.walkInLedgerId
  const customers = all
    .filter((l) => cls.cls(l.id) === 'debtor' && l.id !== walkInId && l.name !== WALK_IN_NAME)
    .map((l) => ({ id: l.id, name: l.name, stateCode: l.stateCode, phone: l.phone, creditHold: !!l.hold }))
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
  const memo = memoryContextFor(db, getAiSettings(db).useMemory).preferredLedger('receipt')
  if (memo && isBank(memo.ledgerId)) {
    defaults.upi = memo.ledgerId
    defaults.card = memo.ledgerId
    defaults.bank = memo.ledgerId
    memoryId = memo.memoryId
  }
  const byCategory = (key: string): number | null =>
    (db.prepare('SELECT id FROM ledgers WHERE simple_category = ? ORDER BY id LIMIT 1').get(key) as { id: number } | undefined)?.id ?? null
  return {
    walkInId,
    customers,
    moneyAccounts,
    defaults,
    memoryId,
    salesAccountId: byCategory('sales') ?? byCategory('service_income') ?? acc.salesLedgerId
  }
}

/** Every in-books sales bill dated `from`…`to`, newest first, with what is still due on it. */
export function salesList(db: DB, from: string, to: string, today: string): SaleRow[] {
  const rows = registerVoucherRows(db, 'sales', from, to)
  const open = new Map<number, { pending: number; dueDate: string | null; overdueDays: number }>()
  for (const p of outstandingsWithAdvances(db, 'receivable', today).parties) {
    for (const b of p.bills) if (b.voucherId != null) open.set(b.voucherId, { pending: b.pending, dueDate: b.dueDate, overdueDays: b.overdueDays })
  }
  const walkInId = counterAccounts(db).walkInLedgerId
  const info = db.prepare('SELECT v.number, l.name FROM vouchers v LEFT JOIN ledgers l ON l.id = v.party_ledger_id WHERE v.id = ?')
  const partyLines = db.prepare('SELECT ledger_id AS ledgerId, dr_cr AS drCr, amount FROM voucher_lines WHERE voucher_id = ?')
  return rows
    .map((r) => {
      const v = info.get(r.voucherId) as { number: string; name: string | null }
      const o = open.get(r.voucherId)
      // The bill as the customer owes it — the register's debit side is the UNROUNDED total on a
      // rounded-down bill (its round-off sits on the customer's side).
      const total = billAmount(partyLines.all(r.voucherId) as { ledgerId: number; drCr: 'dr' | 'cr'; amount: number }[], r.partyLedgerId)
      const due = Math.min(o?.pending ?? 0, total)
      return {
        voucherId: r.voucherId,
        number: v.number,
        date: r.date,
        partyId: r.partyLedgerId,
        partyName: v.name ?? '',
        walkIn: r.partyLedgerId != null && (r.partyLedgerId === walkInId || v.name === WALK_IN_NAME),
        total,
        tax: r.tax,
        paid: total - due,
        due,
        dueDate: o?.dueDate ?? null,
        overdueDays: o?.overdueDays ?? 0
      }
    })
    .sort((a, b) => b.date.localeCompare(a.date) || b.voucherId - a.voucherId)
}

/** One sales bill as the simple view shows it; null when it is not an in-books sales bill. */
export function saleView(db: DB, id: number, today: string): SaleView | null {
  const v = getVoucher(db, id)
  if (!v) return null
  const inBooks = db
    .prepare(`SELECT 1 FROM vouchers v JOIN voucher_types vt ON vt.id = v.voucher_type_id WHERE v.id = ? AND vt.kind = 'sales' AND ${IN_BOOKS}`)
    .get(id)
  if (!inBooks) return null
  const ledger = db.prepare('SELECT name, tax_type AS taxType FROM ledgers WHERE id = ?')
  const item = db.prepare('SELECT s.name, u.symbol FROM stock_items s LEFT JOIN units u ON u.id = s.unit_id WHERE s.id = ?')
  const cls = ledgerClassifier(db)
  const walkInId = counterAccounts(db).walkInLedgerId
  const party = v.partyLedgerId != null ? (ledger.get(v.partyLedgerId) as { name: string } | undefined)?.name ?? '' : ''
  const total = billAmount(v.lines, v.partyLedgerId)
  let tax = 0
  // The round-off the editor posted (the "Round Off" ledger it picks by name): + rounded up.
  let rounding = 0
  const amounts: SaleView['amounts'] = []
  for (const l of v.lines) {
    const lg = ledger.get(l.ledgerId) as { name: string; taxType: string | null } | undefined
    if (lg && lg.name.trim().toLowerCase() === 'round off') {
      rounding += l.drCr === 'cr' ? l.amount : -l.amount
      continue
    }
    if (l.drCr !== 'cr') continue
    if (lg?.taxType) tax += l.amount
    else if (cls.cls(l.ledgerId) === 'income' && v.inventory.length === 0) amounts.push({ name: lg?.name ?? '', amount: l.amount })
  }
  // This bill's own row in the allocation (by voucher id — another bill may share its name).
  const open = v.partyLedgerId != null ? partyAllocation(db, v.partyLedgerId, today).bills.find((b) => b.voucherId === v.id) : undefined
  const due = Math.min(open?.pending ?? 0, total)
  return {
    voucherId: v.id,
    number: v.number,
    date: v.date,
    partyId: v.partyLedgerId,
    partyName: party,
    walkIn: v.partyLedgerId != null && (v.partyLedgerId === walkInId || party === WALK_IN_NAME),
    items: v.inventory.map((l) => {
      const it = item.get(l.stockItemId) as { name: string; symbol: string | null } | undefined
      return { name: it?.name ?? '', qtyMilli: l.qtyMilli, unit: it?.symbol ?? '', ratePaise: l.ratePaise, discountPaise: l.discountPaise, amount: l.amount }
    }),
    amounts,
    note: v.narration,
    total,
    tax,
    rounding,
    paid: total - due,
    due,
    dueDate: open?.dueDate ?? null,
    overdueDays: open?.overdueDays ?? 0
  }
}
