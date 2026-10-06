/**
 * WP 1.8 drill-down: every service row the renderer shows a ledger / party / item name on now
 * carries that record's id, so a click on the NAME can open it. These tests pin the ids (and that
 * a binned voucher is still excluded) for each extended row type.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import type { DB } from '../db/connection'
import { seededDb } from '../db/testdb'
import { createLedger } from './masters'
import { saveVoucher, deleteVoucher, listVouchers, pdcRegister } from './vouchers'
import { voucherInputSchema } from '@shared/schemas'
import { dayBook, dashboard, exceptions, ledgerStatement } from './reports'
import { bankRecon, brs } from './banking'
import { saveCostCentre, ccStatement } from './costCentres'
import { extractPurchaseDocs } from './gst'
import { listSalesInvoices } from './edocs'
import { search } from './search'
import { saveBudget, budgetVarianceReport } from './budgets'

const LEDGER_DEFAULTS = {
  gstin: null, stateCode: null, address: null, taxType: null, gstRate: null, hsn: null,
  tdsSectionId: null, pan: null, creditDays: null, exportType: null
}

interface PostOpts {
  kind: string
  date: string
  number?: string
  partyLedgerId?: number | null
  postDated?: boolean
  lines: { ledgerId: number; drCr: 'dr' | 'cr'; amount: number; costAllocations?: { costCentreId: number; amount: number }[] }[]
  inventory?: { stockItemId: number; qtyMilli: number; ratePaise: number; amount: number; direction: 'in' | 'out' }[]
}

function post(db: DB, o: PostOpts): number {
  const vt = db.prepare('SELECT id FROM voucher_types WHERE kind = ?').get(o.kind) as { id: number }
  const input = voucherInputSchema.parse({
    voucherTypeId: vt.id,
    date: o.date,
    ...(o.number ? { number: o.number } : {}),
    partyLedgerId: o.partyLedgerId ?? null,
    narration: null,
    reference: null,
    postDated: o.postDated ?? false,
    lines: o.lines.map((l) => ({ ...l, costAllocations: l.costAllocations ?? [] })),
    inventory: (o.inventory ?? []).map((inv) => ({ ...inv, godownId: null })),
    billRefs: [],
    tds: null
  })
  return saveVoucher(db, input).id
}

let db: DB
const ids: Record<string, number> = {}

beforeEach(() => {
  db = seededDb()
  const groupId = (name: string): number => (db.prepare('SELECT id FROM groups WHERE name = ?').get(name) as { id: number }).id
  const ledger = (name: string, group: string): number =>
    createLedger(db, { ...LEDGER_DEFAULTS, name, groupId: groupId(group), openingBalance: 0 }).id
  ids.acme = ledger('Acme Traders', 'Sundry Debtors')
  ids.binned = ledger('Binned Party', 'Sundry Debtors')
  ids.supplier = ledger('Supplier Co', 'Sundry Creditors')
  ids.bank = ledger('HDFC Bank', 'Bank Accounts')
  ids.rent = ledger('Rent', 'Indirect Expenses')
  ids.sales = ledger('Sales Local', 'Sales Accounts')
  ids.purchases = ledger('Purchases', 'Purchase Accounts')
  ids.cash = (db.prepare("SELECT id FROM ledgers WHERE name = 'Cash'").get() as { id: number }).id
  const unitId = (db.prepare("SELECT id FROM units WHERE symbol = 'Nos'").get() as { id: number }).id
  ids.widget = Number(db.prepare('INSERT INTO stock_items (name, unit_id, opening_qty_milli, opening_value) VALUES (?, ?, 0, 0)').run('Widget', unitId).lastInsertRowid)
  ids.centre = saveCostCentre(db, { name: 'Pune Branch', parentId: null, active: true }).id

  // Sales to Acme (party voucher) — also drives Widget negative (no opening stock).
  ids.sale = post(db, {
    kind: 'sales', date: '2026-04-05', partyLedgerId: ids.acme,
    lines: [
      { ledgerId: ids.acme, drCr: 'dr', amount: 118000 },
      { ledgerId: ids.sales, drCr: 'cr', amount: 118000 }
    ],
    inventory: [{ stockItemId: ids.widget, qtyMilli: 2000, ratePaise: 59000, amount: 118000, direction: 'out' }]
  })
  // Receipt from Acme into the bank (party voucher).
  ids.receipt = post(db, {
    kind: 'receipt', date: '2026-04-10', partyLedgerId: ids.acme,
    lines: [
      { ledgerId: ids.bank, drCr: 'dr', amount: 50000 },
      { ledgerId: ids.acme, drCr: 'cr', amount: 50000 }
    ]
  })
  // Journal with no party ledger: the "account" is its first line's ledger (Rent), cost-allocated.
  ids.journal = post(db, {
    kind: 'journal', date: '2026-04-12',
    lines: [
      { ledgerId: ids.rent, drCr: 'dr', amount: 20000, costAllocations: [{ costCentreId: ids.centre, amount: 20000 }] },
      { ledgerId: ids.bank, drCr: 'cr', amount: 20000 }
    ]
  })
  // Purchase from the supplier.
  ids.purchase = post(db, {
    kind: 'purchase', date: '2026-04-15', partyLedgerId: ids.supplier,
    lines: [
      { ledgerId: ids.purchases, drCr: 'dr', amount: 30000 },
      { ledgerId: ids.supplier, drCr: 'cr', amount: 30000 }
    ]
  })
  // Post-dated receipt — PDC register only.
  ids.pdc = post(db, {
    kind: 'receipt', date: '2026-06-01', partyLedgerId: ids.acme, postDated: true,
    lines: [
      { ledgerId: ids.bank, drCr: 'dr', amount: 9000 },
      { ledgerId: ids.acme, drCr: 'cr', amount: 9000 }
    ]
  })
  // A binned sale + receipt for "Binned Party": must never surface in any of the lists below.
  ids.binnedSale = post(db, {
    kind: 'sales', date: '2026-04-20', partyLedgerId: ids.binned,
    lines: [
      { ledgerId: ids.binned, drCr: 'dr', amount: 7000 },
      { ledgerId: ids.sales, drCr: 'cr', amount: 7000 }
    ]
  })
  ids.binnedReceipt = post(db, {
    kind: 'receipt', date: '2026-04-21', partyLedgerId: ids.binned,
    lines: [
      { ledgerId: ids.bank, drCr: 'dr', amount: 7000, costAllocations: [] },
      { ledgerId: ids.binned, drCr: 'cr', amount: 7000 }
    ]
  })
  deleteVoucher(db, ids.binnedSale)
  deleteVoucher(db, ids.binnedReceipt)
})

const FROM = '2026-04-01'
const TO = '2027-03-31'

describe('WP 1.8 — service rows carry the ids their names drill to', () => {
  it('day book: accountLedgerId is the party ledger, else the first line; binned vouchers stay out', () => {
    for (const rows of [dayBook(db, FROM, TO), dayBook(db, FROM, TO, { includeOutOfBooks: true })]) {
      const by = new Map(rows.map((r) => [r.voucherId, r]))
      expect(by.get(ids.sale)).toMatchObject({ account: 'Acme Traders', accountLedgerId: ids.acme })
      expect(by.get(ids.receipt)).toMatchObject({ account: 'Acme Traders', accountLedgerId: ids.acme })
      expect(by.get(ids.journal)).toMatchObject({ account: 'Rent', accountLedgerId: ids.rent })
      expect(by.get(ids.purchase)).toMatchObject({ account: 'Supplier Co', accountLedgerId: ids.supplier })
      expect(by.has(ids.binnedSale)).toBe(false)
      expect(by.has(ids.binnedReceipt)).toBe(false)
    }
    // Post-dated: only in the out-of-books scope, still with its id.
    expect(dayBook(db, FROM, TO).some((r) => r.voucherId === ids.pdc)).toBe(false)
    expect(dayBook(db, FROM, TO, { includeOutOfBooks: true }).find((r) => r.voucherId === ids.pdc)?.accountLedgerId).toBe(ids.acme)
  })

  it('voucher list + dashboard recent entries: accountLedgerId', () => {
    const list = listVouchers(db, FROM, TO)
    expect(list.find((v) => v.id === ids.journal)?.accountLedgerId).toBe(ids.rent)
    expect(list.find((v) => v.id === ids.sale)?.accountLedgerId).toBe(ids.acme)
    expect(list.some((v) => v.id === ids.binnedSale)).toBe(false)
    const recent = dashboard(db, '2026-04-30', FROM).recentVouchers
    expect(recent.find((v) => v.voucherId === ids.purchase)?.accountLedgerId).toBe(ids.supplier)
    expect(recent.some((v) => v.voucherId === ids.binnedSale)).toBe(false)
  })

  it('ledger statement: particularsLedgerId is the first counter-side ledger', () => {
    const bank = ledgerStatement(db, ids.bank, FROM, TO)
    const by = new Map(bank.rows.map((r) => [r.voucherId, r]))
    expect(by.get(ids.receipt)).toMatchObject({ particulars: 'Acme Traders', particularsLedgerId: ids.acme })
    expect(by.get(ids.journal)).toMatchObject({ particulars: 'Rent', particularsLedgerId: ids.rent })
    expect(by.has(ids.binnedReceipt)).toBe(false)
    const acme = ledgerStatement(db, ids.acme, FROM, TO)
    expect(acme.rows.find((r) => r.voucherId === ids.sale)?.particularsLedgerId).toBe(ids.sales)
  })

  it('banking: recon and BRS lines carry the counter-party ledger; PDC rows the party', () => {
    const recon = bankRecon(db, ids.bank, FROM, TO)
    const byV = new Map(recon.rows.map((r) => [r.voucherId, r]))
    expect(byV.get(ids.receipt)).toMatchObject({ particulars: 'Acme Traders', particularsLedgerId: ids.acme })
    expect(byV.get(ids.journal)).toMatchObject({ particulars: 'Rent', particularsLedgerId: ids.rent })
    expect(byV.has(ids.binnedReceipt)).toBe(false)

    const report = brs(db, ids.bank, '2026-04-30')
    expect(report.uncredited.find((r) => r.voucherId === ids.receipt)?.particularsLedgerId).toBe(ids.acme)
    expect(report.unpresented.find((r) => r.voucherId === ids.journal)?.particularsLedgerId).toBe(ids.rent)
    expect([...report.uncredited, ...report.unpresented].some((r) => r.voucherId === ids.binnedReceipt)).toBe(false)

    const pdc = pdcRegister(db)
    expect(pdc.map((r) => [r.id, r.partyLedgerId, r.partyName])).toEqual([[ids.pdc, ids.acme, 'Acme Traders']])
  })

  it('cost-centre postings carry the ledger id', () => {
    expect(ccStatement(db, ids.centre, FROM, TO)).toEqual([
      expect.objectContaining({ voucherId: ids.journal, ledgerId: ids.rent, ledgerName: 'Rent' })
    ])
  })

  it('exceptions: negative-stock rows carry the stock item id', () => {
    const neg = exceptions(db, FROM, TO).sections.find((s) => s.key === 'negativeStock')!
    expect(neg.rows).toEqual([expect.objectContaining({ label: 'Widget', stockItemId: ids.widget })])
  })

  it('GSTR-2B books side and e-docs carry the party ledger id', () => {
    const docs = extractPurchaseDocs(db, FROM, TO)
    expect(docs.map((d) => [d.voucherId, d.partyLedgerId])).toEqual([[ids.purchase, ids.supplier]])
    const edocs = listSalesInvoices(db, FROM, TO)
    expect(edocs.map((d) => [d.voucherId, d.partyLedgerId, d.partyName])).toEqual([[ids.sale, ids.acme, 'Acme Traders']])
  })

  it('search: a voucher result carries the ledger its party names (party, else first line)', () => {
    const opts = { today: '2026-04-30', fyStartYear: 2026 }
    const acmeRows = search(db, 'Acme', opts).vouchers!.rows
    expect(acmeRows.length).toBeGreaterThan(0)
    for (const r of acmeRows) expect(r.partyLedgerId).toBe(ids.acme)
    const rentRow = search(db, 'Rent', opts).vouchers!.rows.find((r) => r.id === ids.journal)!
    expect(rentRow).toMatchObject({ party: 'Rent', partyLedgerId: ids.rent })
    expect(search(db, 'Binned', opts).vouchers!.rows).toEqual([])
  })

  it('budget variance: ledger lines carry the ledger id, group lines null', () => {
    const groupId = (db.prepare("SELECT id FROM groups WHERE name = 'Indirect Expenses'").get() as { id: number }).id
    const b = saveBudget(db, {
      name: 'FY27',
      fyStartYear: 2026,
      lines: [
        { ledgerId: ids.rent, groupId: null, month: null, amount: 100000 },
        { ledgerId: null, groupId, month: null, amount: 200000 }
      ]
    })
    const rows = budgetVarianceReport(db, b.id, '2027-03')
    expect(rows.map((r) => [r.targetName, r.ledgerId])).toEqual([
      ['Rent', ids.rent],
      ['Indirect Expenses', null]
    ])
  })
})
