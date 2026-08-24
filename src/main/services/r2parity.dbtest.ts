/**
 * R2 parity lock: these snapshots were recorded against the PRE-rewrite implementations of the
 * report/analysis/intel/voucher queries on a deliberately varied seeded book. The R2 query
 * rewrites (single GROUP BY closing balances, shared inventory scan, batched outstandings,
 * SQL MAX voucher numbering, narrowed duplicate scan, SQL-side budget aggregation, consolidated
 * dashboard) must keep every one of them byte-identical. Do not re-record casually — a snapshot
 * diff here means the rewrite changed behavior.
 */
import { describe, it, expect } from 'vitest'
import type { DB } from '../db/connection'
import { seededDb } from '../db/testdb'
import { createLedger, updateVoucherType, listVoucherTypes } from './masters'
import { saveVoucher, nextVoucherNumber, findDuplicates } from './vouchers'
import { voucherInputSchema } from '@shared/schemas'
import type { VoucherInput } from '@shared/schemas'
import { trialBalance, profitAndLoss, balanceSheet, ledgerStatement, stockSummary, dashboard } from './reports'
import { outstandings, openBills, registerByMonth, registerByPeriod } from './analysis'
import { suggestLedgers, anomalyCheck } from './intel'
import { saveBudget, budgetVarianceReport } from './budgets'

const LEDGER_DEFAULTS = {
  gstin: null, stateCode: null, address: null, taxType: null, gstRate: null, hsn: null,
  tdsSectionId: null, pan: null, creditDays: null, exportType: null
}

interface PostOpts {
  kind: string
  date: string
  partyLedgerId?: number | null
  lines: { ledgerId: number; drCr: 'dr' | 'cr'; amount: number }[]
  inventory?: { stockItemId: number; qtyMilli: number; ratePaise: number; amount: number; direction: 'in' | 'out' }[]
  billRefs?: { kind: 'new' | 'against'; name: string; amount: number; dueDate: string | null }[]
}

function post(db: DB, opts: PostOpts): number {
  const vt = db.prepare('SELECT id FROM voucher_types WHERE kind = ?').get(opts.kind) as { id: number }
  const input: VoucherInput = {
    voucherTypeId: vt.id,
    date: opts.date,
    partyLedgerId: opts.partyLedgerId ?? null,
    narration: null,
    reference: null,
    instrumentNo: null,
    instrumentDate: null,
    transporterId: null,
    vehicleNo: null,
    transportDistanceKm: null,
    currencyCode: null,
    exchangeRate: null,
    lines: opts.lines.map((l) => ({ ...l, costAllocations: [] })),
    inventory: (opts.inventory ?? []).map((inv) => ({ ...inv, godownId: null })),
    billRefs: opts.billRefs ?? [],
    tds: null
  } as VoucherInput
  return saveVoucher(db, input).id
}

interface Book {
  db: DB
  ids: Record<string, number>
}

/** A varied book: opening balances, bill refs, inventory, all five core voucher kinds. */
function richBook(): Book {
  const db = seededDb()
  const groupId = (name: string): number =>
    (db.prepare('SELECT id FROM groups WHERE name = ?').get(name) as { id: number }).id

  const debtorA = createLedger(db, { ...LEDGER_DEFAULTS, name: 'Debtor A', groupId: groupId('Sundry Debtors'), openingBalance: 250000, creditDays: 30 }).id
  const debtorB = createLedger(db, { ...LEDGER_DEFAULTS, name: 'Debtor B', groupId: groupId('Sundry Debtors'), openingBalance: 0 }).id
  const creditorX = createLedger(db, { ...LEDGER_DEFAULTS, name: 'Creditor X', groupId: groupId('Sundry Creditors'), openingBalance: -100000 }).id
  const bank = createLedger(db, { ...LEDGER_DEFAULTS, name: 'HDFC Bank', groupId: groupId('Bank Accounts'), openingBalance: 500000 }).id
  const rent = createLedger(db, { ...LEDGER_DEFAULTS, name: 'Rent', groupId: groupId('Indirect Expenses'), openingBalance: 0 }).id
  const purchases = createLedger(db, { ...LEDGER_DEFAULTS, name: 'Purchases', groupId: groupId('Purchase Accounts'), openingBalance: 0 }).id
  const sales = createLedger(db, { ...LEDGER_DEFAULTS, name: 'Sales Local', groupId: groupId('Sales Accounts'), openingBalance: 0 }).id
  const capital = createLedger(db, { ...LEDGER_DEFAULTS, name: 'Capital', groupId: groupId('Capital Account'), openingBalance: -650000 }).id
  const cash = (db.prepare("SELECT id FROM ledgers WHERE name = 'Cash'").get() as { id: number }).id

  const unitId = (db.prepare("SELECT id FROM units WHERE symbol = 'Nos'").get() as { id: number }).id
  const widget = Number(
    db.prepare('INSERT INTO stock_items (name, unit_id, opening_qty_milli, opening_value) VALUES (?, ?, 10000, 500000)')
      .run('Widget', unitId).lastInsertRowid
  )

  post(db, {
    kind: 'sales', date: '2025-04-05', partyLedgerId: debtorA,
    lines: [
      { ledgerId: debtorA, drCr: 'dr', amount: 118000 },
      { ledgerId: sales, drCr: 'cr', amount: 118000 }
    ],
    inventory: [{ stockItemId: widget, qtyMilli: 2000, ratePaise: 59000, amount: 118000, direction: 'out' }],
    billRefs: [{ kind: 'new', name: 'INV-1', amount: 118000, dueDate: '2025-05-05' }]
  })
  post(db, {
    kind: 'receipt', date: '2025-04-20', partyLedgerId: debtorA,
    lines: [
      { ledgerId: bank, drCr: 'dr', amount: 50000 },
      { ledgerId: debtorA, drCr: 'cr', amount: 50000 }
    ],
    billRefs: [{ kind: 'against', name: 'INV-1', amount: 50000, dueDate: null }]
  })
  post(db, {
    kind: 'purchase', date: '2025-05-02', partyLedgerId: creditorX,
    lines: [
      { ledgerId: purchases, drCr: 'dr', amount: 82600 },
      { ledgerId: creditorX, drCr: 'cr', amount: 82600 }
    ],
    inventory: [{ stockItemId: widget, qtyMilli: 5000, ratePaise: 16520, amount: 82600, direction: 'in' }]
  })
  post(db, {
    kind: 'payment', date: '2025-05-10',
    lines: [
      { ledgerId: rent, drCr: 'dr', amount: 30000 },
      { ledgerId: cash, drCr: 'cr', amount: 30000 }
    ]
  })
  post(db, {
    kind: 'contra', date: '2025-05-15',
    lines: [
      { ledgerId: cash, drCr: 'dr', amount: 20000 },
      { ledgerId: bank, drCr: 'cr', amount: 20000 }
    ]
  })
  post(db, {
    kind: 'sales', date: '2025-06-01', partyLedgerId: debtorB,
    lines: [
      { ledgerId: debtorB, drCr: 'dr', amount: 59000 },
      { ledgerId: sales, drCr: 'cr', amount: 59000 }
    ]
  })
  post(db, {
    kind: 'receipt', date: '2025-06-20', partyLedgerId: debtorB,
    lines: [
      { ledgerId: cash, drCr: 'dr', amount: 20000 },
      { ledgerId: debtorB, drCr: 'cr', amount: 20000 }
    ]
  })

  return { db, ids: { debtorA, debtorB, creditorX, bank, rent, purchases, sales, capital, cash, widget } }
}

describe('R2 parity — statements', () => {
  it('trial balance / P&L / balance sheet / stock summary are unchanged by the rewrites', () => {
    const { db } = richBook()
    expect(trialBalance(db, '2025-06-30')).toMatchSnapshot('trialBalance')
    expect(profitAndLoss(db, '2025-04-01', '2025-06-30')).toMatchSnapshot('profitAndLoss')
    expect(balanceSheet(db, '2025-04-01', '2025-06-30')).toMatchSnapshot('balanceSheet')
    expect(stockSummary(db, '2025-06-30')).toMatchSnapshot('stockSummary')
  })

  it('ledger statements (incl. multi-name particulars) are unchanged', () => {
    const { db, ids } = richBook()
    // A three-line voucher so the "particulars" join has to aggregate two counterpart names.
    post(db, {
      kind: 'journal', date: '2025-06-25',
      lines: [
        { ledgerId: ids.rent!, drCr: 'dr', amount: 7000 },
        { ledgerId: ids.purchases!, drCr: 'dr', amount: 3000 },
        { ledgerId: ids.cash!, drCr: 'cr', amount: 10000 }
      ]
    })
    expect(ledgerStatement(db, ids.cash!, '2025-04-01', '2025-06-30')).toMatchSnapshot('cash statement')
    expect(ledgerStatement(db, ids.debtorA!, '2025-04-01', '2025-06-30')).toMatchSnapshot('debtorA statement')
  })

  it('registers by month are unchanged', () => {
    const { db } = richBook()
    expect(registerByMonth(db, 'sales', '2025-04-01', '2025-06-30')).toMatchSnapshot('sales register')
    expect(registerByMonth(db, 'purchase', '2025-04-01', '2025-06-30')).toMatchSnapshot('purchase register')
  })

  it('groups registers into Indian financial-year quarters and clips partial periods', () => {
    const { db, ids } = richBook()
    post(db, {
      kind: 'sales', date: '2025-07-05', partyLedgerId: ids.debtorB,
      lines: [
        { ledgerId: ids.debtorB!, drCr: 'dr', amount: 24000 },
        { ledgerId: ids.sales!, drCr: 'cr', amount: 24000 }
      ]
    })
    expect(registerByPeriod(db, 'sales', '2025-05-01', '2025-07-31', 'quarter')).toEqual([
      {
        key: '2025-26-Q1', label: 'Q1 2025-26', from: '2025-05-01', to: '2025-06-30',
        vouchers: 1, taxable: 59000, tax: 0, total: 59000
      },
      {
        key: '2025-26-Q2', label: 'Q2 2025-26', from: '2025-07-01', to: '2025-07-31',
        vouchers: 1, taxable: 24000, tax: 0, total: 24000
      }
    ])
  })
})

describe('R2 parity — outstandings', () => {
  it('receivables/payables and open bills are unchanged', () => {
    const { db, ids } = richBook()
    expect(outstandings(db, 'receivable', '2025-06-30')).toMatchSnapshot('receivables')
    expect(outstandings(db, 'payable', '2025-06-30')).toMatchSnapshot('payables')
    expect(openBills(db, ids.debtorA!, '2025-06-30')).toMatchSnapshot('debtorA open bills')
  })
})

describe('R2 parity — intel', () => {
  it('ledger suggestions (frequency ranking) are unchanged', () => {
    const { db } = richBook()
    expect(suggestLedgers(db, 'payment', '')).toMatchSnapshot('payment suggestions')
    expect(suggestLedgers(db, 'sales', 'deb')).toMatchSnapshot('sales deb suggestions')
  })
})

describe('R2 fix — anomaly median (improvement #50)', () => {
  it('uses the true middle of ALL line amounts, not the 500 smallest', () => {
    const db = seededDb()
    const cash = (db.prepare("SELECT id FROM ledgers WHERE name = 'Cash'").get() as { id: number }).id
    const vt = db.prepare("SELECT id FROM voucher_types WHERE kind = 'journal'").get() as { id: number }
    const vid = db
      .prepare("INSERT INTO vouchers (voucher_type_id, date, number) VALUES (?, '2025-04-01', 'RAW-1')")
      .run(vt.id).lastInsertRowid
    const ins = db.prepare('INSERT INTO voucher_lines (voucher_id, ledger_id, dr_cr, amount, line_order) VALUES (?, ?, ?, ?, 0)')
    const insertAll = db.transaction(() => {
      for (let i = 1; i <= 1000; i++) ins.run(vid, cash, 'dr', i)
    })
    insertAll()
    // 1000 amounts 1..1000: the (upper) median is 501. The old LIMIT-500 sample saw only
    // 1..500 and reported 251.
    expect(anomalyCheck(db, cash, 1).typicalAmount).toBe(501)
    expect(anomalyCheck(db, cash, 5011).unusual).toBe(true)
    expect(anomalyCheck(db, cash, 5010).unusual).toBe(false)
  })
})

describe('R2 parity — voucher numbering & duplicates', () => {
  it('nextVoucherNumber handles prefix/suffix/padding and foreign numbers identically', () => {
    const db = seededDb()
    const vts = listVoucherTypes(db)
    const salesVt = vts.find((v) => v.kind === 'sales')!
    updateVoucherType(db, salesVt.id, {
      name: salesVt.name, kind: 'sales', numbering: 'auto',
      prefix: 'INV-', suffix: '/25-26', padWidth: 3, restartFy: true
    })
    const cash = (db.prepare("SELECT id FROM ledgers WHERE name = 'Cash'").get() as { id: number }).id
    const groupId = (db.prepare("SELECT id FROM groups WHERE name = 'Sales Accounts'").get() as { id: number }).id
    const sales = createLedger(db, { ...LEDGER_DEFAULTS, name: 'Sales Local', groupId, openingBalance: 0 }).id

    post(db, { kind: 'sales', date: '2025-04-01', lines: [
      { ledgerId: cash, drCr: 'dr', amount: 100 }, { ledgerId: sales, drCr: 'cr', amount: 100 }
    ] })
    post(db, { kind: 'sales', date: '2025-04-02', lines: [
      { ledgerId: cash, drCr: 'dr', amount: 200 }, { ledgerId: sales, drCr: 'cr', amount: 200 }
    ] })
    // A number that doesn't follow the prefix/suffix shape at all, and one with a bigger core.
    db.prepare("INSERT INTO vouchers (voucher_type_id, date, number) VALUES (?, '2025-04-03', 'FREEFORM')").run(salesVt.id)
    db.prepare("INSERT INTO vouchers (voucher_type_id, date, number) VALUES (?, '2025-04-04', 'INV-041/25-26')").run(salesVt.id)
    // Previous-FY voucher must not count when restartFy is on.
    db.prepare("INSERT INTO vouchers (voucher_type_id, date, number) VALUES (?, '2025-03-30', 'INV-099/24-25')").run(salesVt.id)

    expect(nextVoucherNumber(db, salesVt.id, '2025-04-10')).toMatchSnapshot('restartFy next number')

    updateVoucherType(db, salesVt.id, {
      name: salesVt.name, kind: 'sales', numbering: 'auto',
      prefix: 'INV-', suffix: '', padWidth: 0, restartFy: false
    })
    expect(nextVoucherNumber(db, salesVt.id, '2025-04-10')).toMatchSnapshot('running next number')
  })

  it('findDuplicates matches type+total+party within ±3 days identically', () => {
    const { db, ids } = richBook()
    const vt = db.prepare("SELECT id FROM voucher_types WHERE kind = 'sales'").get() as { id: number }
    const probe = {
      voucherTypeId: vt.id, date: '2025-04-07', partyLedgerId: ids.debtorA!,
      narration: null, reference: null, instrumentNo: null, instrumentDate: null,
      transporterId: null, vehicleNo: null, transportDistanceKm: null, currencyCode: null, exchangeRate: null,
      lines: [
        { ledgerId: ids.debtorA!, drCr: 'dr' as const, amount: 118000, costAllocations: [] },
        { ledgerId: ids.sales!, drCr: 'cr' as const, amount: 118000, costAllocations: [] }
      ],
      inventory: [], billRefs: [], tds: null
    } as VoucherInput
    expect(findDuplicates(db, voucherInputSchema.parse(probe))).toMatchSnapshot('duplicates within window')
    expect(findDuplicates(db, voucherInputSchema.parse({ ...probe, date: '2025-04-20' }))).toEqual([])
  })

  it('findDuplicates catches repeated external and supplier bill references outside the date window', () => {
    const { db, ids } = richBook()
    const vt = db.prepare("SELECT id FROM voucher_types WHERE kind = 'sales'").get() as { id: number }
    const existing = db.prepare("SELECT id FROM vouchers WHERE voucher_type_id = ? AND number = '1'").get(vt.id) as { id: number }
    db.prepare("UPDATE vouchers SET reference = 'PO-8842' WHERE id = ?").run(existing.id)
    const base = {
      voucherTypeId: vt.id, date: '2025-08-19', partyLedgerId: ids.debtorA!,
      narration: null, reference: 'po-8842', instrumentNo: null, instrumentDate: null,
      transporterId: null, vehicleNo: null, transportDistanceKm: null, currencyCode: null, exchangeRate: null,
      lines: [
        { ledgerId: ids.debtorA!, drCr: 'dr' as const, amount: 99000, costAllocations: [] },
        { ledgerId: ids.sales!, drCr: 'cr' as const, amount: 99000, costAllocations: [] }
      ],
      inventory: [], billRefs: [{ kind: 'new' as const, name: 'inv-1', amount: 99000, dueDate: null }], tds: null
    }
    const matches = findDuplicates(db, voucherInputSchema.parse(base))
    expect(matches).toHaveLength(1)
    expect(matches[0]).toMatchObject({ voucherId: existing.id, reasons: ['same_reference', 'same_bill_reference'] })
  })
})

describe('R2 parity — budgets & dashboard', () => {
  it('budget variance is unchanged', () => {
    const { db, ids } = richBook()
    const indirectExpenses = (db.prepare("SELECT id FROM groups WHERE name = 'Indirect Expenses'").get() as { id: number }).id
    const budget = saveBudget(db, {
      name: 'FY26', fyStartYear: 2025,
      lines: [
        { ledgerId: ids.rent!, groupId: null, month: null, amount: 100000 },
        { ledgerId: null, groupId: indirectExpenses, month: '2025-05', amount: 50000 }
      ]
    })
    expect(budgetVarianceReport(db, budget.id, '2025-06')).toMatchSnapshot('budget variance')
  })

  it('dashboard is unchanged', () => {
    const { db } = richBook()
    expect(dashboard(db, '2025-06-30', '2025-04-01')).toMatchSnapshot('dashboard')
  })
})
