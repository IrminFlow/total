import { describe, it, expect, beforeAll } from 'vitest'
import { seededDb } from '../db/testdb'
import type { DB } from '../db/connection'
import { createGroup, createLedger, createStockGroup, createStockItem } from './masters'
import { saveVoucher, deleteVoucher } from './vouchers'
import { globalSearch, search, SEARCH_LIMIT, type SearchOptions } from './search'
import type { VoucherKind } from '@shared/domain'

function group(db: DB, name: string): number {
  return (db.prepare('SELECT id FROM groups WHERE name = ?').get(name) as { id: number }).id
}

function unit(db: DB): number {
  return (db.prepare('SELECT id FROM units LIMIT 1').get() as { id: number }).id
}

function ledgerId(db: DB, name: string): number {
  return (db.prepare('SELECT id FROM ledgers WHERE name = ?').get(name) as { id: number }).id
}

interface LedgerOpts { group?: string; gstin?: string; pan?: string; address?: string; stateCode?: string; hsn?: string }

function ledger(db: DB, name: string, o: LedgerOpts = {}): number {
  return createLedger(db, {
    name, groupId: group(db, o.group ?? 'Sundry Debtors'), openingBalance: 0, gstin: o.gstin ?? null,
    stateCode: o.stateCode ?? null, address: o.address ?? null, taxType: null, gstRate: null, hsn: o.hsn ?? null,
    tdsSectionId: null, pan: o.pan ?? null, creditDays: null, exportType: null
  }).id
}

function item(db: DB, name: string, o: { hsn?: string; barcode?: string; groupId?: number } = {}): number {
  return createStockItem(db, {
    name, groupId: o.groupId ?? null, unitId: unit(db), hsn: o.hsn ?? null, gstRate: null, cessRate: null,
    openingQtyMilli: 0, openingValue: 0, barcode: o.barcode ?? null, reorderLevelMilli: null
  }).id
}

function journal(db: DB, number: string, narration: string | null): ReturnType<typeof saveVoucher> {
  const vt = db.prepare("SELECT id FROM voucher_types WHERE kind = 'journal'").get() as { id: number }
  const cash = ledgerId(db, 'Cash')
  const other = ledger(db, `Other for ${number}`)
  return saveVoucher(db, {
    voucherTypeId: vt.id, date: '2025-04-01', number, partyLedgerId: null, narration, reference: null,
    instrumentNo: null, instrumentDate: null, transporterId: null, vehicleNo: null, transportDistanceKm: null,
    currencyCode: null, exchangeRate: null,
    lines: [
      { ledgerId: cash, drCr: 'dr', amount: 100, costAllocations: [] },
      { ledgerId: other, drCr: 'cr', amount: 100, costAllocations: [] }
    ],
    inventory: [], billRefs: [], tds: null
  })
}

interface VOpts {
  kind?: VoucherKind
  date?: string
  number: string
  party?: number | null
  narration?: string | null
  reference?: string | null
  /** [ledgerId, dr|cr, paise] */
  lines: [number, 'dr' | 'cr', number][]
  postDated?: boolean
  isOptional?: boolean
}

/** A balanced voucher of any kind posted through saveVoucher (journal-shaped lines). */
function voucher(db: DB, o: VOpts): number {
  const vt = db.prepare('SELECT id FROM voucher_types WHERE kind = ?').get(o.kind ?? 'journal') as { id: number }
  return saveVoucher(db, {
    voucherTypeId: vt.id, date: o.date ?? '2026-04-10', number: o.number, partyLedgerId: o.party ?? null,
    narration: o.narration ?? null, reference: o.reference ?? null,
    instrumentNo: null, instrumentDate: null, transporterId: null, vehicleNo: null, transportDistanceKm: null,
    currencyCode: null, exchangeRate: null, postDated: o.postDated, isOptional: o.isOptional,
    lines: o.lines.map(([ledgerId, drCr, amount]) => ({ ledgerId, drCr, amount, costAllocations: [] })),
    inventory: [], billRefs: [], tds: null
  }).id
}

const OPTS: SearchOptions = { today: '2026-10-07', fyStartYear: 2026 }
const s = (db: DB, q: string, o: SearchOptions = {}): ReturnType<typeof search> => search(db, q, { ...OPTS, ...o })
const vids = (db: DB, q: string, o: SearchOptions = {}): number[] => (s(db, q, o).vouchers?.rows ?? []).map((r) => r.id)
const lnames = (db: DB, q: string): string[] => (s(db, q).ledgers?.rows ?? []).map((r) => r.name)
const inames = (db: DB, q: string): string[] => (s(db, q).items?.rows ?? []).map((r) => r.name)

describe('globalSearch (legacy shape, now backed by search)', () => {
  it('matches ledgers by name substring, sub = group name', () => {
    const db = seededDb()
    ledger(db, 'Acme Traders')
    ledger(db, 'Beta Corp')
    const hits = globalSearch(db, 'acme')
    expect(hits).toContainEqual({ kind: 'ledger', id: expect.any(Number), label: 'Acme Traders', sub: 'Sundry Debtors' })
    expect(hits.find((h) => h.label === 'Beta Corp')).toBeUndefined()
  })

  it('matches stock items, sub = "Stock item"', () => {
    const db = seededDb()
    item(db, 'Widget Pro')
    const hits = globalSearch(db, 'widget')
    expect(hits).toContainEqual({ kind: 'item', id: expect.any(Number), label: 'Widget Pro', sub: 'Stock item' })
  })

  it('matches vouchers by number or narration, excludes soft-deleted', () => {
    const db = seededDb()
    const v1 = journal(db, 'JV-100', 'Rent for April')
    journal(db, 'JV-200', null)
    const hits = globalSearch(db, 'jv-1')
    expect(hits.some((h) => h.kind === 'voucher' && h.label.includes('JV-100'))).toBe(true)

    const byNarration = globalSearch(db, 'rent')
    expect(byNarration.some((h) => h.kind === 'voucher' && h.id === v1.id)).toBe(true)

    deleteVoucher(db, v1.id)
    const afterDelete = globalSearch(db, 'jv-1')
    expect(afterDelete.some((h) => h.kind === 'voucher' && h.id === v1.id)).toBe(false)
  })

  it('escapes % and _ so they behave as literals, not wildcards', () => {
    const db = seededDb()
    ledger(db, '50% Off Ltd')
    ledger(db, '50X Off Ltd')
    ledger(db, 'A_B Co')
    ledger(db, 'AxB Co')
    expect(globalSearch(db, '50%').map((h) => h.label)).toEqual(['50% Off Ltd'])
    expect(globalSearch(db, 'a_b').map((h) => h.label)).toEqual(['A_B Co'])
  })

  it('caps each category at SEARCH_LIMIT (20) results', () => {
    const db = seededDb()
    for (let i = 0; i < 25; i++) ledger(db, `Zeta Client ${String(i).padStart(2, '0')}`)
    const hits = globalSearch(db, 'zeta')
    expect(SEARCH_LIMIT).toBe(20)
    expect(hits.filter((h) => h.kind === 'ledger').length).toBe(20)
  })

  it('ranks prefix matches before substring matches', () => {
    const db = seededDb()
    ledger(db, 'Alpha Sale Co')
    ledger(db, 'Sale Corp')
    const labels = globalSearch(db, 'sale').filter((h) => h.kind === 'ledger').map((h) => h.label)
    expect(labels.indexOf('Sale Corp')).toBeGreaterThanOrEqual(0)
    expect(labels.indexOf('Sale Corp')).toBeLessThan(labels.indexOf('Alpha Sale Co'))
  })
})

describe('search — ledgers', () => {
  it('matches name, group, ancestor group, GSTIN, PAN, address and state', () => {
    const db = seededDb()
    const sub = createGroup(db, { name: 'Pune Debtors', parentId: group(db, 'Sundry Debtors') }).id
    ledger(db, 'Umbrella Retail', { gstin: '27AABCD1234E1Z8', pan: 'AABCD1234E', address: 'Shop 4, FC Road', stateCode: '27' })
    createLedger(db, {
      name: 'Nested Party', groupId: sub, openingBalance: 0, gstin: null, stateCode: '29', address: null, taxType: null,
      gstRate: null, hsn: null, tdsSectionId: null, pan: null, creditDays: null, exportType: null
    })
    expect(lnames(db, 'umbrella')).toEqual(['Umbrella Retail'])
    expect(lnames(db, '27AABCD')).toEqual(['Umbrella Retail'])
    expect(lnames(db, 'aabcd1234e')).toEqual(['Umbrella Retail'])
    expect(lnames(db, 'fc road')).toEqual(['Umbrella Retail'])
    expect(lnames(db, 'maharashtra')).toEqual(['Umbrella Retail'])
    expect(lnames(db, 'karnataka')).toEqual(['Nested Party'])
    // Ancestor group: Nested Party sits in Pune Debtors under Sundry Debtors.
    expect(lnames(db, 'sundry debtors')).toEqual(expect.arrayContaining(['Umbrella Retail', 'Nested Party']))
    const nested = s(db, 'sundry debtors').ledgers!.rows.find((r) => r.name === 'Nested Party')!
    expect(nested.groupName).toBe('Pune Debtors')
    expect(nested.matchField).toBe('group')
    expect(nested.matchText).toBe('Sundry Debtors')
    const byGstin = s(db, '27AABCD').ledgers!.rows[0]!
    expect(byGstin.matchField).toBe('gstin')
    expect(byGstin.gstin).toBe('27AABCD1234E1Z8')
  })

  it('gstin: / pan: / hsn: / group: tokens', () => {
    const db = seededDb()
    ledger(db, 'Umbrella Retail', { gstin: '27AABCD1234E1Z8', pan: 'AABCD1234E' })
    ledger(db, 'Krishna Enterprises', { gstin: '29AABCF9012G1ZQ' })
    ledger(db, 'Consulting Income', { group: 'Direct Incomes', hsn: '998311' })
    expect(lnames(db, 'gstin:29aabcf')).toEqual(['Krishna Enterprises'])
    expect(lnames(db, 'pan:AABCD1234E')).toEqual(['Umbrella Retail'])
    expect(lnames(db, 'hsn:9983')).toEqual(['Consulting Income'])
    expect(lnames(db, 'hsn:8311')).toEqual([]) // hsn is a prefix match
    expect(lnames(db, 'group:"direct incomes"')).toEqual(['Consulting Income'])
    // gstin: excludes items entirely
    expect(s(db, 'gstin:27').items!.total).toBe(0)
    expect(s(db, 'gstin:27').kinds).toEqual(['ledger', 'voucher'])
  })

  it('free-text terms AND together', () => {
    const db = seededDb()
    ledger(db, 'Acme Pune', { address: 'Pune' })
    ledger(db, 'Acme Mumbai', { address: 'Mumbai' })
    expect(lnames(db, 'acme pune')).toEqual(['Acme Pune'])
    expect(lnames(db, '"acme mumbai"')).toEqual(['Acme Mumbai'])
  })

  it('ranking: exact > prefix > word-start > substring, then name', () => {
    const db = seededDb()
    ledger(db, 'Xsteelx Works') // substring
    ledger(db, 'Bharat Steel') // word-start
    ledger(db, 'Steel Corp') // prefix
    ledger(db, 'Steel') // exact
    ledger(db, 'Anand (Steel)') // word-start after "("
    expect(lnames(db, 'steel')).toEqual(['Steel', 'Steel Corp', 'Anand (Steel)', 'Bharat Steel', 'Xsteelx Works'])
  })

  it('counts and pagination are consistent and stable', () => {
    const db = seededDb()
    for (let i = 0; i < 45; i++) ledger(db, `Page Party ${String(i).padStart(2, '0')}`)
    const first = s(db, 'page party', { limitPerKind: 20 })
    expect(first.ledgers!.total).toBe(45)
    expect(first.ledgers!.rows).toHaveLength(20)
    const all: string[] = []
    for (let off = 0; off < 45; off += 20) {
      all.push(...s(db, 'page party', { limitPerKind: 20, offset: off, kind: 'ledger' }).ledgers!.rows.map((r) => r.name))
    }
    expect(all).toHaveLength(45)
    expect(new Set(all).size).toBe(45)
    expect(all).toEqual([...all].sort())
    // Past the end → empty rows, true total.
    expect(s(db, 'page party', { offset: 100, kind: 'ledger' }).ledgers).toEqual({ rows: [], total: 45, offset: 100 })
  })
})

describe('search — stock items', () => {
  it('matches name, HSN, barcode and stock group (with ancestors); hsn: is a prefix', () => {
    const db = seededDb()
    const furniture = createStockGroup(db, { name: 'Furniture', parentId: null }).id
    const chairs = createStockGroup(db, { name: 'Chairs', parentId: furniture }).id
    item(db, 'Office Chair', { hsn: '9401', barcode: '8901234567890', groupId: chairs })
    item(db, 'Laptop 14"', { hsn: '84713010' })
    expect(inames(db, 'office')).toEqual(['Office Chair'])
    expect(inames(db, '9401')).toEqual(['Office Chair'])
    expect(inames(db, '89012345')).toEqual(['Office Chair'])
    expect(inames(db, 'furniture')).toEqual(['Office Chair'])
    expect(inames(db, 'hsn:8471')).toEqual(['Laptop 14"'])
    expect(inames(db, 'group:furn')).toEqual(['Office Chair'])
    const hit = s(db, 'furniture').items!.rows[0]!
    expect(hit).toMatchObject({ groupName: 'Chairs', matchField: 'group', matchText: 'Furniture', hsn: '9401', barcode: '8901234567890' })
    expect(s(db, '89012345').items!.rows[0]!.matchField).toBe('barcode')
  })
})

describe('search — vouchers', () => {
  let db: DB
  let cash: number, umbrella: number, krishna: number, sales: number, rent: number
  const ids: Record<string, number> = {}

  beforeAll(() => {
    db = seededDb()
    cash = ledgerId(db, 'Cash')
    umbrella = ledger(db, 'Umbrella Retail', { gstin: '27AABCD1234E1Z8', pan: 'AABCD1234E' })
    krishna = ledger(db, 'Krishna Enterprises', { gstin: '29AABCF9012G1ZQ' })
    sales = ledger(db, 'Sales A/c', { group: 'Sales Accounts' })
    rent = ledger(db, 'Office Rent', { group: 'Indirect Expenses' })
    ids.big = voucher(db, {
      kind: 'receipt', number: 'RC-1', date: '2026-04-12', party: umbrella, narration: 'Received against invoice INV-12',
      lines: [[cash, 'dr', 140_50_613_00], [umbrella, 'cr', 140_50_613_00]]
    })
    // Journal with two debit lines: total 7,500 ≠ any single line.
    ids.split = voucher(db, {
      number: 'JV-7', date: '2026-05-03', narration: 'Quarterly rent split', reference: 'LEASE-77',
      lines: [[rent, 'dr', 5000_00], [rent, 'dr', 2500_00], [cash, 'cr', 7500_00]]
    })
    ids.k = voucher(db, {
      kind: 'receipt', number: 'RC-2', date: '2026-06-20', party: krishna, narration: 'Advance',
      lines: [[cash, 'dr', 60000_00], [krishna, 'cr', 60000_00]]
    })
    ids.noParty = voucher(db, {
      number: 'JV-8', date: '2026-04-30', narration: 'Cash sale',
      lines: [[cash, 'dr', 1200_00], [sales, 'cr', 1200_00]]
    })
    ids.pdc = voucher(db, {
      kind: 'receipt', number: 'RC-PDC', date: '2026-12-01', party: umbrella, narration: 'Cheque post dated', postDated: true,
      lines: [[cash, 'dr', 999_00], [umbrella, 'cr', 999_00]]
    })
    ids.optional = voucher(db, {
      number: 'JV-OPT', date: '2026-07-01', narration: 'Memo only', isOptional: true,
      lines: [[rent, 'dr', 888_00], [cash, 'cr', 888_00]]
    })
    ids.deleted = voucher(db, {
      number: 'JV-DEL', date: '2026-07-02', narration: 'Deleted rent memo',
      lines: [[rent, 'dr', 5000_00], [cash, 'cr', 5000_00]]
    })
    deleteVoucher(db, ids.deleted)
    // Inventory line straight into the table so we can search by item / HSN without a full invoice.
    const laptop = item(db, 'Laptop 14"', { hsn: '84713010' })
    db.prepare(
      `INSERT INTO inventory_lines (voucher_id, stock_item_id, qty_milli, rate_paise, amount, direction) VALUES (?, ?, 1000, 120000, 120000, 'out')`
    ).run(ids.noParty, laptop)
  })

  it('number, narration, reference, party name and any line ledger name', () => {
    expect(vids(db, 'rc-1')).toEqual([ids.big])
    expect(vids(db, 'quarterly')).toEqual([ids.split])
    expect(vids(db, 'lease-77')).toEqual([ids.split])
    expect(vids(db, 'krishna')).toEqual([ids.k])
    // "office rent" is a line ledger on split + optional (deleted one never shows).
    expect(vids(db, '"office rent"').sort()).toEqual([ids.split, ids.optional].sort())
    expect(vids(db, 'sales a/c')).toEqual([ids.noParty])
    const r = s(db, 'lease').vouchers!.rows[0]!
    expect(r.matchField).toBe('reference')
    expect(s(db, '"office rent"').vouchers!.rows.find((x) => x.id === ids.split)!.matchField).toBe('ledger')
  })

  it('stock item names and hsn: reach vouchers through their inventory lines', () => {
    expect(vids(db, 'laptop')).toEqual([ids.noParty])
    expect(s(db, 'laptop').vouchers!.rows[0]!.matchField).toBe('item')
    expect(vids(db, 'hsn:8471')).toEqual([ids.noParty])
  })

  it('exact amount matches the voucher total and any single line, Indian grouping included', () => {
    expect(vids(db, 'amt:1,40,50,613')).toEqual([ids.big])
    expect(vids(db, 'amt:7500')).toEqual([ids.split]) // total only
    expect(vids(db, 'amt:2500')).toEqual([ids.split]) // a line only
    expect(vids(db, 'amt:5000')).toEqual([ids.split]) // deleted 5000 voucher excluded
    const row = s(db, 'amt:2500').vouchers!.rows[0]!
    expect(row.matchField).toBe('amount')
    expect(row.matchText).toBe('₹2,500 · Office Rent')
    expect(row.amount).toBe(7500_00)
  })

  it('amount comparators and ranges', () => {
    expect(vids(db, 'amt:>50000').sort()).toEqual([ids.big, ids.k].sort())
    expect(vids(db, 'amt:>60000')).toEqual([ids.big])
    expect(vids(db, 'amt:>=60000').sort()).toEqual([ids.big, ids.k].sort())
    expect(vids(db, 'amt:<1000').sort()).toEqual([ids.pdc, ids.optional].sort())
    expect(vids(db, 'amt:1000..2000')).toEqual([ids.noParty])
    // ₹1.5 lakh – ₹2 crore: k (₹60,000) is below, big (₹1.4 crore) inside.
    expect(vids(db, 'amt:1.5L..2cr')).toEqual([ids.big])
    expect(vids(db, 'amt:1.5cr..')).toEqual([])
    expect(vids(db, 'amt:50k..15cr').sort()).toEqual([ids.big, ids.k].sort())
  })

  it('a bare number matches amounts as well as text, ranking the amount match first', () => {
    expect(vids(db, '60000')).toEqual([ids.k])
    expect(vids(db, '7500')).toEqual([ids.split])
    // "12" is in RC-1's narration (INV-12) — text; no voucher totals ₹12.
    expect(vids(db, '12')).toContain(ids.big)
  })

  it('date filters: day, display format, month, FY month name, range, fy:', () => {
    expect(vids(db, 'date:2026-04-12')).toEqual([ids.big])
    expect(vids(db, 'date:12-04-2026')).toEqual([ids.big])
    expect(vids(db, 'date:12-Apr-26')).toEqual([ids.big])
    expect(vids(db, 'date:apr').sort()).toEqual([ids.big, ids.noParty].sort())
    expect(vids(db, 'date:2026-05')).toEqual([ids.split])
    expect(vids(db, 'date:2026-04-13..2026-06-30').sort()).toEqual([ids.split, ids.k, ids.noParty].sort())
    expect(s(db, 'fy:2026').vouchers!.total).toBe(6)
    expect(s(db, 'fy:2025').vouchers!.total).toBe(0)
  })

  it('type:, no:, party:, gstin:, pan:, group: filters', () => {
    expect(vids(db, 'type:receipt').sort()).toEqual([ids.big, ids.k, ids.pdc].sort())
    expect(vids(db, 'type:jv').sort()).toEqual([ids.split, ids.noParty, ids.optional].sort())
    expect(vids(db, 'type:Rec')).toHaveLength(3) // voucher type NAME prefix
    expect(vids(db, 'type:sales')).toEqual([])
    expect(vids(db, 'no:jv-')).toHaveLength(3)
    expect(vids(db, 'party:umbrella').sort()).toEqual([ids.big, ids.pdc].sort())
    expect(vids(db, 'gstin:29AABCF9012G1ZQ')).toEqual([ids.k])
    const g = s(db, 'gstin:29AABCF9012G1ZQ').vouchers!.rows[0]!
    expect(g).toMatchObject({ matchField: 'gstin', matchText: '29AABCF9012G1ZQ', party: 'Krishna Enterprises' })
    expect(vids(db, 'pan:AABCD1234E').sort()).toEqual([ids.big, ids.pdc].sort())
    expect(vids(db, 'group:"indirect expenses"').sort()).toEqual([ids.split, ids.optional].sort())
    expect(vids(db, 'gstin:00XXXX')).toEqual([])
  })

  it('tokens combine with AND', () => {
    expect(vids(db, 'type:receipt amt:>50000 date:apr')).toEqual([ids.big])
    expect(vids(db, 'umbrella amt:999')).toEqual([ids.pdc])
    expect(vids(db, 'umbrella amt:1')).toEqual([])
    expect(vids(db, 'in:ledgers amt:999')).toEqual([])
  })

  it('soft-deleted vouchers never appear; optional and post-dated do, flagged', () => {
    expect(vids(db, 'jv-del')).toEqual([])
    expect(vids(db, 'deleted')).toEqual([])
    const pdc = s(db, 'rc-pdc').vouchers!.rows[0]!
    expect(pdc).toMatchObject({ id: ids.pdc, postDated: true, isOptional: false })
    const opt = s(db, 'jv-opt').vouchers!.rows[0]!
    expect(opt).toMatchObject({ id: ids.optional, postDated: false, isOptional: true })
  })

  it('result shape: type, number, date, party (or first ledger), total, narration snippet', () => {
    const big = s(db, 'rc-1').vouchers!.rows[0]!
    expect(big).toMatchObject({
      kind: 'voucher', typeName: 'Receipt', voucherKind: 'receipt', number: 'RC-1', date: '2026-04-12',
      party: 'Umbrella Retail', amount: 140_50_613_00, narration: 'Received against invoice INV-12', matchField: 'number'
    })
    // No party ledger → first ledger line.
    expect(s(db, 'jv-8').vouchers!.rows[0]!.party).toBe('Cash')
  })

  it('ranks exact number > prefix > word-start > substring, then most recent first', () => {
    const d = seededDb()
    const c = ledgerId(d, 'Cash')
    const o = ledger(d, 'Other')
    const mk = (number: string, date: string): number => voucher(d, { number, date, lines: [[c, 'dr', 100], [o, 'cr', 100]] })
    const sub = mk('X55Y', '2026-09-01')
    const word = mk('INV-55', '2026-08-01')
    const pre2 = mk('55-B', '2026-05-01')
    const pre1 = mk('55-A', '2026-07-01')
    const exact = mk('55', '2026-04-01')
    // Exact first even though oldest; prefixes by recency; then word-start; then substring.
    expect(vids(d, 'no:55 55').slice(0, 5)).toEqual([exact, pre1, pre2, word, sub])
  })

  it('counts per kind, kind restriction and pagination over vouchers', () => {
    const d = seededDb()
    const c = ledgerId(d, 'Cash')
    const o = ledger(d, 'Paging Ledger')
    for (let i = 0; i < 30; i++) {
      voucher(d, { number: `PG-${i}`, date: `2026-04-${String((i % 28) + 1).padStart(2, '0')}`, lines: [[c, 'dr', 100 + i], [o, 'cr', 100 + i]] })
    }
    const r = search(d, 'paging', { ...OPTS })
    expect(r.ledgers!.total).toBe(1)
    expect(r.vouchers!.total).toBe(30)
    expect(r.vouchers!.rows).toHaveLength(20)
    const page2 = search(d, 'paging', { ...OPTS, kind: 'voucher', offset: 20 })
    expect(page2.ledgers).toBeNull()
    expect(page2.items).toBeNull()
    expect(page2.vouchers!.rows).toHaveLength(10)
    const seen = new Set([...r.vouchers!.rows, ...page2.vouchers!.rows].map((x) => x.id))
    expect(seen.size).toBe(30)
    // Stable: dates non-increasing across the page boundary.
    const dates = [...r.vouchers!.rows, ...page2.vouchers!.rows].map((x) => x.date)
    expect(dates).toEqual([...dates].sort().reverse())
  })

  it('empty / in:-only queries search nothing; unknown tokens are reported', () => {
    expect(s(db, '').vouchers).toEqual({ rows: [], total: 0, offset: 0 })
    expect(s(db, 'in:vouchers').kinds).toEqual([])
    const r = s(db, 'colour:red')
    expect(r.unknown).toEqual(['colour:red'])
    expect(r.vouchers!.total).toBe(0)
  })
})
