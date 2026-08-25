import { describe, it, expect } from 'vitest'
import type { DB } from '../db/connection'
import type { DrCr } from '@shared/domain'
import { freshPartialDb, seededDb, TEST_INFO } from '../db/testdb'
import { migrate } from '../db/migrate'
import { MIGRATIONS } from '../db/migrations'
import { createLedger, createGodown, listGodowns } from './masters'
import { saveVoucher, getVoucher } from './vouchers'
import { extractOutwardDocs, gstr1, gstr3b, extractDocSeries } from './gst'
import { filingRegister, recordFiling } from './filings'
import {
  crossRegistrationTransfers,
  deleteRegistration,
  ensureRegistrations,
  gstScope,
  listRegistrations,
  saveRegistration,
  setPrimaryRegistration
} from './registrations'
import { writeCompanyInfo, readCompanyInfo } from '../db/seed'
import { saveTransfer } from './inventoryTransfer'

// Checksum-valid GSTINs on one PAN: Maharashtra and Gujarat.
const MH = '27AAAPA1234A1ZT'
const GJ = '24AAAPA1234A1ZZ'

const FROM = '2026-07-01'
const TO = '2026-07-31'

function setup(gstin: string | null = MH): {
  db: DB
  buyerMh: number
  buyerGj: number
  sales: number
  cgstL: number
  sgstL: number
  igstL: number
  post: (
    kind: string,
    date: string,
    partyId: number | null,
    lines: { ledgerId: number; drCr: DrCr; amount: number }[],
    extra?: { gstRegistrationId?: number | null }
  ) => { id: number }
} {
  const db = seededDb()
  writeCompanyInfo(db, { ...TEST_INFO, gstin, stateCode: '27' })
  const groupId = (name: string): number =>
    (db.prepare('SELECT id FROM groups WHERE name = ?').get(name) as { id: number }).id
  const vtId = (kind: string): number =>
    (db.prepare('SELECT id FROM voucher_types WHERE kind = ?').get(kind) as { id: number }).id
  const L = (input: Parameters<typeof createLedger>[1]): number => createLedger(db, input).id

  const buyerMh = L({ name: 'Buyer MH', groupId: groupId('Sundry Debtors'), gstin: '27AAPFU0939F1ZV', stateCode: '27' })
  const buyerGj = L({ name: 'Buyer GJ', groupId: groupId('Sundry Debtors'), gstin: '24AAPFU0939F1Z1', stateCode: '24' })
  const sales = L({ name: 'Sales 18', groupId: groupId('Sales Accounts'), gstRate: 18, hsn: '9983' })
  const cgstL = L({ name: 'CGST', groupId: groupId('Duties & Taxes'), taxType: 'cgst' })
  const sgstL = L({ name: 'SGST', groupId: groupId('Duties & Taxes'), taxType: 'sgst' })
  const igstL = L({ name: 'IGST', groupId: groupId('Duties & Taxes'), taxType: 'igst' })

  const post = (
    kind: string,
    date: string,
    partyId: number | null,
    lines: { ledgerId: number; drCr: DrCr; amount: number }[],
    extra: { gstRegistrationId?: number | null } = {}
  ): { id: number } =>
    saveVoucher(db, {
      voucherTypeId: vtId(kind),
      date,
      partyLedgerId: partyId,
      gstRegistrationId: extra.gstRegistrationId ?? null,
      lines: lines.map((l) => ({ ...l, costAllocations: [] })),
      inventory: [],
      billRefs: [],
      tds: null
    })

  return { db, buyerMh, buyerGj, sales, cgstL, sgstL, igstL, post }
}

const addGujarat = (db: DB): number =>
  saveRegistration(db, {
    gstin: GJ,
    stateCode: '24',
    tradeName: 'Gujarat branch',
    address: null,
    registeredOn: null,
    surrenderedOn: null
  }).id

describe('the single registration every company already had', () => {
  it('seeding a company creates exactly one primary registration mirroring its GSTIN and state', () => {
    const { db } = setup()
    const regs = listRegistrations(db)
    expect(regs).toHaveLength(1)
    expect(regs[0]).toMatchObject({ gstin: MH, stateCode: '27', isPrimary: true })
  })

  it('migration 47 backfills an EXISTING company and stamps every voucher it already had', () => {
    // The real upgrade path: a database that stops one migration short of this feature, holding a
    // company and a voucher, then finishes migrating.
    const cut = MIGRATIONS.length - 3 // before 47, 48 and 49
    const db = freshPartialDb(cut)
    db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run(
      'company',
      JSON.stringify({ ...TEST_INFO, gstin: MH, stateCode: '27', name: 'Old Books' })
    )
    db.prepare("INSERT INTO voucher_types (name, kind, numbering, prefix, is_system) VALUES ('Sales', 'sales', 'auto', '', 1)").run()
    db.prepare("INSERT INTO vouchers (voucher_type_id, date, number) VALUES (1, '2026-05-01', '1')").run()
    db.prepare("INSERT INTO godowns (name) VALUES ('Main Location')").run()
    db.prepare(
      "INSERT INTO gst_filings (form, period, due_date, filed_at, arn, tax_paid, late_fee, interest) VALUES ('GSTR-3B', '2026-05', '2026-06-20', '2026-06-18', 'AA1', 500, 0, 0)"
    ).run()

    migrate(db)

    const regs = listRegistrations(db)
    expect(regs).toHaveLength(1)
    expect(regs[0]).toMatchObject({ gstin: MH, stateCode: '27', tradeName: 'Old Books', isPrimary: true })

    const v = db.prepare('SELECT gst_registration_id AS id FROM vouchers WHERE id = 1').get() as { id: number | null }
    expect(v.id).toBe(regs[0]!.id)
    const g = db.prepare('SELECT gst_registration_id AS id FROM godowns WHERE id = 1').get() as { id: number | null }
    expect(g.id).toBe(regs[0]!.id)
    // The rebuilt filing table kept its row, its ARN and its registration.
    const f = db.prepare("SELECT arn, registration_id AS regId FROM gst_filings WHERE form = 'GSTR-3B'").get() as
      { arn: string; regId: number }
    expect(f).toEqual({ arn: 'AA1', regId: regs[0]!.id })
  })

  it('a one-registration book runs the SAME SQL it ran before — no registration filter at all', () => {
    // Not a detail: the empty fragment is what makes "an existing company is untouched" a
    // structural fact rather than a hope about COALESCE and NULL handling.
    const { db } = setup()
    expect(gstScope(db, readCompanyInfo(db)).regScopeSql).toBe('')
  })

  it('editing the company GSTIN moves the primary registration with it, and back', () => {
    const { db } = setup()
    writeCompanyInfo(db, { ...TEST_INFO, gstin: '29AAAPA1234A1ZP', stateCode: '29' })
    expect(listRegistrations(db)[0]).toMatchObject({ gstin: '29AAAPA1234A1ZP', stateCode: '29' })

    const gj = addGujarat(db)
    setPrimaryRegistration(db, gj)
    expect(readCompanyInfo(db)).toMatchObject({ gstin: GJ, stateCode: '24' })
  })
})

describe('an existing single-GSTIN company computes exactly what it computed before', () => {
  /** The same three vouchers, posted the same way, in two books. */
  const book = (): ReturnType<typeof setup> => {
    const s = setup()
    s.post('sales', '2026-07-05', s.buyerMh, [
      { ledgerId: s.buyerMh, drCr: 'dr', amount: 118000 },
      { ledgerId: s.sales, drCr: 'cr', amount: 100000 },
      { ledgerId: s.cgstL, drCr: 'cr', amount: 9000 },
      { ledgerId: s.sgstL, drCr: 'cr', amount: 9000 }
    ])
    s.post('sales', '2026-07-09', s.buyerGj, [
      { ledgerId: s.buyerGj, drCr: 'dr', amount: 59000 },
      { ledgerId: s.sales, drCr: 'cr', amount: 50000 },
      { ledgerId: s.igstL, drCr: 'cr', amount: 9000 }
    ])
    return s
  }

  it('GSTR-1 and GSTR-3B are byte-identical with and without a scope object', () => {
    const s = book()
    const info = readCompanyInfo(s.db)
    // What every caller did before this feature: pass the plain CompanyInfo.
    const before1 = gstr1(s.db, info, FROM, TO, '072026')
    const before3 = gstr3b(s.db, info, FROM, TO, '072026')
    // What every caller does now: pass a scope built for the primary registration.
    const scope = gstScope(s.db, info, null)
    expect(gstr1(s.db, scope, FROM, TO, '072026')).toEqual(before1)
    expect(gstr3b(s.db, scope, FROM, TO, '072026')).toEqual(before3)
    expect(scope.gstin).toBe(MH)
    expect(scope.stateCode).toBe('27')
  })

  it('adding a SECOND registration does not move one rupee of the first one\'s return', () => {
    // The promise the roadmap item makes, tested directly.
    const s = book()
    const before = gstr1(s.db, gstScope(s.db, readCompanyInfo(s.db), null), FROM, TO, '072026')
    addGujarat(s.db)
    const after = gstr1(s.db, gstScope(s.db, readCompanyInfo(s.db), null), FROM, TO, '072026')
    expect(after).toEqual(before)
  })

  it('and a voucher with no registration recorded stays with the primary when the primary moves', () => {
    const s = book()
    // Force the pre-feature state: a voucher whose registration column is NULL.
    s.db.prepare('UPDATE vouchers SET gst_registration_id = NULL').run()
    const gj = addGujarat(s.db)
    const mh = listRegistrations(s.db).find((r) => r.id !== gj)!.id

    // Both documents answer to Maharashtra, none to Gujarat, even though Maharashtra is no
    // longer flagged primary.
    setPrimaryRegistration(s.db, gj)
    const info = readCompanyInfo(s.db)
    expect(extractOutwardDocs(s.db, gstScope(s.db, info, mh), FROM, TO)).toHaveLength(2)
    expect(extractOutwardDocs(s.db, gstScope(s.db, info, gj), FROM, TO)).toHaveLength(0)
  })
})

describe('place of supply is decided by the SUPPLYING registration', () => {
  it('a Gujarat registration billing a Gujarat customer charges CGST+SGST, not IGST', () => {
    // The correctness core. Computed against the company's Maharashtra state this same invoice
    // is IGST, which is the error every multi-state book makes silently.
    const s = setup()
    const gj = addGujarat(s.db)
    s.post('sales', '2026-07-05', s.buyerGj, [
      { ledgerId: s.buyerGj, drCr: 'dr', amount: 118000 },
      { ledgerId: s.sales, drCr: 'cr', amount: 100000 },
      { ledgerId: s.cgstL, drCr: 'cr', amount: 9000 },
      { ledgerId: s.sgstL, drCr: 'cr', amount: 9000 }
    ], { gstRegistrationId: gj })

    const info = readCompanyInfo(s.db)
    const [doc] = extractOutwardDocs(s.db, gstScope(s.db, info, gj), FROM, TO)
    expect(doc!.items).toEqual([{ rate: 18, taxable: 100000, cgst: 9000, sgst: 9000, igst: 0, cess: 0 }])

    // The head office would have taxed the very same voucher as inter-state.
    const mh = listRegistrations(s.db).find((r) => r.id !== gj)!.id
    s.db.prepare('UPDATE vouchers SET gst_registration_id = ?').run(mh)
    const [same] = extractOutwardDocs(s.db, gstScope(s.db, info, mh), FROM, TO)
    expect(same!.items).toEqual([{ rate: 18, taxable: 100000, cgst: 0, sgst: 0, igst: 18000, cess: 0 }])
  })
})

describe('returns are per GSTIN', () => {
  function twoRegistrations(): { s: ReturnType<typeof setup>; mh: number; gj: number } {
    const s = setup()
    const gj = addGujarat(s.db)
    const mh = listRegistrations(s.db).find((r) => r.id !== gj)!.id
    s.post('sales', '2026-07-05', s.buyerMh, [
      { ledgerId: s.buyerMh, drCr: 'dr', amount: 118000 },
      { ledgerId: s.sales, drCr: 'cr', amount: 100000 },
      { ledgerId: s.cgstL, drCr: 'cr', amount: 9000 },
      { ledgerId: s.sgstL, drCr: 'cr', amount: 9000 }
    ], { gstRegistrationId: mh })
    s.post('sales', '2026-07-09', s.buyerGj, [
      { ledgerId: s.buyerGj, drCr: 'dr', amount: 59000 },
      { ledgerId: s.sales, drCr: 'cr', amount: 50000 },
      { ledgerId: s.cgstL, drCr: 'cr', amount: 4500 },
      { ledgerId: s.sgstL, drCr: 'cr', amount: 4500 }
    ], { gstRegistrationId: gj })
    return { s, mh, gj }
  }

  it('GSTR-1 covers only its own registration, under its own GSTIN', () => {
    const { s, mh, gj } = twoRegistrations()
    const info = readCompanyInfo(s.db)
    const r1 = gstr1(s.db, gstScope(s.db, info, mh), FROM, TO, '072026')
    const r2 = gstr1(s.db, gstScope(s.db, info, gj), FROM, TO, '072026')
    expect(r1.gstin).toBe(MH)
    expect(r2.gstin).toBe(GJ)
    // The B2B section alone: the summary also carries an HSN roll-up of the same lines, so
    // summing every row would count each invoice twice.
    const b2b = (r: typeof r1): number => r.summary.find((x) => x.section === 'b2b')!.taxable
    expect(b2b(r1)).toBe(100000)
    expect(b2b(r2)).toBe(50000)
  })

  it('GSTR-3B output tax splits between the two registrations and re-adds to the whole', () => {
    const { s, mh, gj } = twoRegistrations()
    const info = readCompanyInfo(s.db)
    const a = gstr3b(s.db, gstScope(s.db, info, mh), FROM, TO, '072026')
    const b = gstr3b(s.db, gstScope(s.db, info, gj), FROM, TO, '072026')
    expect(a.outward.taxable + b.outward.taxable).toBe(150000)
    expect(a.outward.cgst).toBe(9000)
    expect(b.outward.cgst).toBe(4500)
  })

  it('the document series (Table 13) is per registration too — one series is not two', () => {
    const { s, mh, gj } = twoRegistrations()
    const info = readCompanyInfo(s.db)
    expect(extractDocSeries(s.db, FROM, TO, gstScope(s.db, info, mh))[0]!.totnum).toBe(1)
    expect(extractDocSeries(s.db, FROM, TO, gstScope(s.db, info, gj))[0]!.totnum).toBe(1)
  })

  it('two registrations file two GSTR-3Bs for the same month, each with its own ARN', () => {
    const { s, mh, gj } = twoRegistrations()
    const info = readCompanyInfo(s.db)
    const scopeMh = gstScope(s.db, info, mh)
    const scopeGj = gstScope(s.db, info, gj)
    recordFiling(s.db, scopeMh, {
      form: 'GSTR-3B', period: '2026-07', dueDate: '2026-08-20',
      filedAt: '2026-08-18', arn: 'AA27JUL', taxPaid: 18000, notes: null
    })
    recordFiling(s.db, scopeGj, {
      form: 'GSTR-3B', period: '2026-07', dueDate: '2026-08-20',
      filedAt: '2026-08-19', arn: 'AA24JUL', taxPaid: 9000, notes: null
    })
    const rowOf = (rows: ReturnType<typeof filingRegister>): string | null =>
      rows.find((r) => r.form === 'GSTR-3B' && r.period === '2026-07')?.record?.arn ?? null
    expect(rowOf(filingRegister(s.db, scopeMh, 2026, '2026-08-25'))).toBe('AA27JUL')
    expect(rowOf(filingRegister(s.db, scopeGj, 2026, '2026-08-25'))).toBe('AA24JUL')
  })
})

describe('saving a voucher records its registration rather than inferring one later', () => {
  it('a new voucher with no registration named is stamped with the primary', () => {
    const s = setup()
    const v = s.post('sales', '2026-07-05', s.buyerMh, [
      { ledgerId: s.buyerMh, drCr: 'dr', amount: 1000 },
      { ledgerId: s.sales, drCr: 'cr', amount: 1000 }
    ])
    expect(getVoucher(s.db, v.id)!.gstRegistrationId).toBe(listRegistrations(s.db)[0]!.id)
  })

  it('a voucher whose goods moved through a godown takes that godown\'s registration', () => {
    const s = setup()
    const gj = addGujarat(s.db)
    const godown = createGodown(s.db, { name: 'Surat warehouse', gstRegistrationId: gj })
    expect(listGodowns(s.db).find((g) => g.id === godown.id)!.gstRegistrationId).toBe(gj)

    const groupId = (name: string): number =>
      (s.db.prepare('SELECT id FROM groups WHERE name = ?').get(name) as { id: number }).id
    const unit = (s.db.prepare('SELECT id FROM units LIMIT 1').get() as { id: number }).id
    const item = s.db
      .prepare('INSERT INTO stock_items (name, unit_id, gst_rate) VALUES (?, ?, ?)')
      .run('Widget', unit, 18).lastInsertRowid as number
    void groupId

    const vtId = (s.db.prepare("SELECT id FROM voucher_types WHERE kind = 'sales'").get() as { id: number }).id
    const v = saveVoucher(s.db, {
      voucherTypeId: vtId,
      date: '2026-07-11',
      partyLedgerId: s.buyerGj,
      lines: [
        { ledgerId: s.buyerGj, drCr: 'dr', amount: 1000, costAllocations: [] },
        { ledgerId: s.sales, drCr: 'cr', amount: 1000, costAllocations: [] }
      ],
      inventory: [
        { stockItemId: item, godownId: godown.id, qtyMilli: 1000, ratePaise: 1000, amount: 1000, direction: 'out' }
      ],
      billRefs: [],
      tds: null
    })
    expect(getVoucher(s.db, v.id)!.gstRegistrationId).toBe(gj)
  })

  it('an edit that says nothing about the registration keeps the one the voucher had', () => {
    const s = setup()
    const gj = addGujarat(s.db)
    const v = s.post('sales', '2026-07-05', s.buyerGj, [
      { ledgerId: s.buyerGj, drCr: 'dr', amount: 1000 },
      { ledgerId: s.sales, drCr: 'cr', amount: 1000 }
    ], { gstRegistrationId: gj })
    const vtId = (s.db.prepare("SELECT id FROM voucher_types WHERE kind = 'sales'").get() as { id: number }).id
    saveVoucher(s.db, {
      voucherTypeId: vtId,
      date: '2026-07-06',
      partyLedgerId: s.buyerGj,
      lines: [
        { ledgerId: s.buyerGj, drCr: 'dr', amount: 2000, costAllocations: [] },
        { ledgerId: s.sales, drCr: 'cr', amount: 2000, costAllocations: [] }
      ],
      inventory: [], billRefs: [], tds: null
    }, v.id)
    expect(getVoucher(s.db, v.id)!.gstRegistrationId).toBe(gj)
  })
})

describe('deleting a registration', () => {
  it('refuses to delete the primary, or one any voucher is filed under', () => {
    const s = setup()
    const gj = addGujarat(s.db)
    const mh = listRegistrations(s.db).find((r) => r.id !== gj)!.id
    expect(() => deleteRegistration(s.db, mh)).toThrow(/primary/i)

    s.post('sales', '2026-07-05', s.buyerGj, [
      { ledgerId: s.buyerGj, drCr: 'dr', amount: 1000 },
      { ledgerId: s.sales, drCr: 'cr', amount: 1000 }
    ], { gstRegistrationId: gj })
    expect(() => deleteRegistration(s.db, gj)).toThrow(/surrender/i)
  })

  it('removes an unused one and detaches the godowns that pointed at it', () => {
    const s = setup()
    const gj = addGujarat(s.db)
    const godown = createGodown(s.db, { name: 'Surat warehouse', gstRegistrationId: gj })
    deleteRegistration(s.db, gj)
    expect(listRegistrations(s.db)).toHaveLength(1)
    expect(listGodowns(s.db).find((g) => g.id === godown.id)!.gstRegistrationId).toBeNull()
  })
})

describe('stock moved between two registrations of the same PAN', () => {
  /**
   * Schedule I para 2: a supply between two registrations of the same person is a supply, and it
   * is taxable, even though nothing was sold. This app does NOT raise that invoice — it finds the
   * movement and reports it. See services/registrations.ts and docs/roadmap.md #108.
   */
  function stockBook(): { db: DB; mh: number; gj: number; from: number; to: number; item: number } {
    const s = setup()
    const gj = addGujarat(s.db)
    const mh = listRegistrations(s.db).find((r) => r.id !== gj)!.id
    const mumbai = createGodown(s.db, { name: 'Mumbai godown', gstRegistrationId: mh })
    const surat = createGodown(s.db, { name: 'Surat godown', gstRegistrationId: gj })
    const unit = (s.db.prepare('SELECT id FROM units LIMIT 1').get() as { id: number }).id
    const item = Number(
      s.db.prepare('INSERT INTO stock_items (name, unit_id, gst_rate) VALUES (?, ?, ?)').run('Widget', unit, 18)
        .lastInsertRowid
    )
    // Stock in at Mumbai, through a purchase, so there is something to move.
    const vtId = (s.db.prepare("SELECT id FROM voucher_types WHERE kind = 'purchase'").get() as { id: number }).id
    const groupId = (s.db.prepare("SELECT id FROM groups WHERE name = 'Purchase Accounts'").get() as { id: number }).id
    const purchases = createLedger(s.db, { name: 'Purchases', groupId, openingBalance: 0 }).id
    const cash = (s.db.prepare("SELECT id FROM ledgers WHERE name = 'Cash'").get() as { id: number }).id
    saveVoucher(s.db, {
      voucherTypeId: vtId,
      date: '2026-07-01',
      partyLedgerId: null,
      lines: [
        { ledgerId: purchases, drCr: 'dr', amount: 100000, costAllocations: [] },
        { ledgerId: cash, drCr: 'cr', amount: 100000, costAllocations: [] }
      ],
      inventory: [
        { stockItemId: item, godownId: mumbai.id, qtyMilli: 10000, ratePaise: 10000, amount: 100000, direction: 'in' }
      ],
      billRefs: [],
      tds: null
    })
    return { db: s.db, mh, gj, from: mumbai.id, to: surat.id, item }
  }

  it('is reported as a taxable supply this app does not invoice, with both GSTINs named', () => {
    const b = stockBook()
    saveTransfer(b.db, {
      date: '2026-07-12',
      fromGodownId: b.from,
      toGodownId: b.to,
      items: [{ stockItemId: b.item, qtyMilli: 4000 }]
    })
    const found = crossRegistrationTransfers(b.db, FROM, TO)
    expect(found).toHaveLength(1)
    expect(found[0]).toMatchObject({
      fromRegistrationId: b.mh, fromGstin: MH, fromStateCode: '27',
      toRegistrationId: b.gj, toGstin: GJ, toStateCode: '24'
    })
    expect(found[0]!.valuePaise).toBe(40000)
  })

  it('a transfer WITHIN one registration is not a supply and is not reported', () => {
    const b = stockBook()
    const second = createGodown(b.db, { name: 'Pune godown', gstRegistrationId: b.mh })
    saveTransfer(b.db, {
      date: '2026-07-12',
      fromGodownId: b.from,
      toGodownId: second.id,
      items: [{ stockItemId: b.item, qtyMilli: 1000 }]
    })
    expect(crossRegistrationTransfers(b.db, FROM, TO)).toEqual([])
  })

  it('a single-registration company can never have one, so the check costs nothing', () => {
    const s = setup()
    ensureRegistrations(s.db)
    expect(crossRegistrationTransfers(s.db, FROM, TO)).toEqual([])
  })
})
