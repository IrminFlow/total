import { describe, it, expect } from 'vitest'
import { readFileSync, mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  assertExportable, exportGstr1Csv, extractOutwardDocs, extractDocSeries, gstValidate,
  itcBreakdown, rcmInwardSummary, turnover
} from './gst'
import { companyExportsDir, ensureCompanyTree } from '../paths'
import type { Gstr1Result } from '@shared/gst/returns'
import type { DrCr } from '@shared/domain'
import { seededDb, TEST_INFO } from '../db/testdb'
import { createLedger } from './masters'
import { saveVoucher, deleteVoucher } from './vouchers'

describe('gst service — exportGstr1Csv', () => {
  it('writes plain (integer-math) rupee decimals — no float division artifacts, zero pads to "0.00"', () => {
    // dataRoot() reads TOTAL_DATA_DIR verbatim when set — the hermetic override that avoids
    // touching Electron's app.getPath('documents'), which isn't available under electron-as-node.
    process.env.TOTAL_DATA_DIR = mkdtempSync(join(tmpdir(), 'total-gst-test-'))
    const slug = 'gst-export-test'
    ensureCompanyTree(slug)

    const result: Gstr1Result = {
      period: '072026',
      gstin: '27AAAAA0000A1Z5',
      json: {},
      summary: [
        // 3333 paise / 3 lines-worth is a classic float-division trap (33.33 repeating) — pure
        // integer math must still land on an exact 2-decimal string.
        { section: 'B2B', label: 'B2B Invoices', docs: 3, taxable: 3333, igst: 0, cgst: 300, sgst: 300, cess: 0 },
        // A row with every tax column at exactly zero used to print bare "0" (a JS number
        // stringified), not the "0.00" a portal CSV column expects.
        { section: 'NIL', label: 'Nil rated', docs: 1, taxable: 0, igst: 0, cgst: 0, sgst: 0, cess: 0 }
      ]
    }

    const path = exportGstr1Csv(slug, result)
    expect(path).toBe(`${companyExportsDir(slug)}/gstr1-072026-summary.csv`)
    const csv = readFileSync(path, 'utf8')
    const lines = csv.split('\n')
    expect(lines[0]).toBe('Section,Documents,Taxable Value,IGST,CGST,SGST,Cess')
    expect(lines[1]).toBe('B2B Invoices,3,33.33,0.00,3.00,3.00,0.00')
    expect(lines[2]).toBe('Nil rated,1,0.00,0.00,0.00,0.00,0.00')
  })
})

describe('gst service — extraction (G1)', () => {
  const FROM = '2026-07-01'
  const TO = '2026-07-31'

  function setup() {
    const db = seededDb()
    const groupId = (name: string): number =>
      (db.prepare('SELECT id FROM groups WHERE name = ?').get(name) as { id: number }).id
    const vtId = (kind: string): number =>
      (db.prepare('SELECT id FROM voucher_types WHERE kind = ?').get(kind) as { id: number }).id
    const L = (input: Parameters<typeof createLedger>[1]): number => createLedger(db, input).id

    const buyer = L({ name: 'Buyer 27', groupId: groupId('Sundry Debtors'), gstin: '27AAPFU0939F1ZV', stateCode: '27' })
    const sales = L({ name: 'Sales 18', groupId: groupId('Sales Accounts'), gstRate: 18, hsn: '9983' })
    const cgstL = L({ name: 'CGST', groupId: groupId('Duties & Taxes'), taxType: 'cgst' })
    const sgstL = L({ name: 'SGST', groupId: groupId('Duties & Taxes'), taxType: 'sgst' })
    const igstL = L({ name: 'IGST', groupId: groupId('Duties & Taxes'), taxType: 'igst' })
    const purchases = L({ name: 'Purchases 18', groupId: groupId('Purchase Accounts'), gstRate: 18 })
    const plainVendor = L({ name: 'Plain Vendor', groupId: groupId('Sundry Creditors'), stateCode: '27' })
    const rcmVendor = L({ name: 'RCM Vendor', groupId: groupId('Sundry Creditors'), stateCode: '27', rcm: true })
    const blockedVendor = L({
      name: 'Blocked Vendor', groupId: groupId('Sundry Creditors'), stateCode: '27', itcEligibility: 'blocked'
    })
    const importVendor = L({ name: 'Import Vendor', groupId: groupId('Sundry Creditors'), stateCode: '96' })

    const post = (
      kind: string, date: string, partyId: number | null,
      lines: { ledgerId: number; drCr: DrCr; amount: number }[],
      posOverride: string | null = null
    ) =>
      saveVoucher(db, {
        voucherTypeId: vtId(kind), date, partyLedgerId: partyId,
        posOverride,
        lines: lines.map((l) => ({ ...l, costAllocations: [] })),
        inventory: [], billRefs: [], tds: null
      })

    return { db, buyer, sales, cgstL, sgstL, igstL, purchases, plainVendor, rcmVendor, blockedVendor, importVendor, post }
  }

  it('extracts sales + outward debit notes with POS override, classification and validation payload', () => {
    const s = setup()
    // Sales with a POS override to 29 — inter-state, so tax recomputes as IGST 18000.
    s.post('sales', '2026-07-05', s.buyer, [
      { ledgerId: s.buyer, drCr: 'dr', amount: 118000 },
      { ledgerId: s.sales, drCr: 'cr', amount: 100000 },
      { ledgerId: s.igstL, drCr: 'cr', amount: 18000 }
    ], '29')
    // Outward debit note (credits an income ledger) — must be extracted with kind debit_note.
    s.post('debit_note', '2026-07-06', s.buyer, [
      { ledgerId: s.buyer, drCr: 'dr', amount: 11800 },
      { ledgerId: s.sales, drCr: 'cr', amount: 10000 },
      { ledgerId: s.cgstL, drCr: 'cr', amount: 900 },
      { ledgerId: s.sgstL, drCr: 'cr', amount: 900 }
    ])
    // Purchase-return debit note (credits Purchases) — purchase-side, must NOT be extracted.
    s.post('debit_note', '2026-07-07', s.plainVendor, [
      { ledgerId: s.plainVendor, drCr: 'dr', amount: 5900 },
      { ledgerId: s.purchases, drCr: 'cr', amount: 5000 },
      { ledgerId: s.cgstL, drCr: 'cr', amount: 450 },
      { ledgerId: s.sgstL, drCr: 'cr', amount: 450 }
    ])

    const docs = extractOutwardDocs(s.db, TEST_INFO, FROM, TO)
    expect(docs).toHaveLength(2)

    const inv = docs[0]!
    expect(inv.kind).toBe('sales')
    expect(inv.pos).toBe('29') // pos_override wins over party state 27
    expect(inv.invTyp).toBe('R')
    expect(inv.rchrg).toBe(false)
    expect(inv.items).toEqual([{ rate: 18, taxable: 100000, cgst: 0, sgst: 0, igst: 18000, cess: 0 }])
    expect(inv.hsnLines[0]).toMatchObject({ hsn: '9983', uqc: 'OTH', rate: 18, taxable: 100000, igst: 18000 })
    expect(inv.validation).toEqual({ valDiff: 0, missingHsnCount: 0, missingGstin: false })

    const dbn = docs[1]!
    expect(dbn.kind).toBe('debit_note')
    expect(dbn.pos).toBe('27')
    expect(dbn.items).toEqual([{ rate: 18, taxable: 10000, cgst: 900, sgst: 900, igst: 0, cess: 0 }])
  })

  it('itemises ITC: blocked vendors → 4(D), import vendors → IMPG, RCM computed at master rates → ISRC + 3.1(d)', () => {
    const s = setup()
    s.post('purchase', '2026-07-10', s.blockedVendor, [
      { ledgerId: s.purchases, drCr: 'dr', amount: 10000 },
      { ledgerId: s.cgstL, drCr: 'dr', amount: 900 },
      { ledgerId: s.sgstL, drCr: 'dr', amount: 900 },
      { ledgerId: s.blockedVendor, drCr: 'cr', amount: 11800 }
    ])
    s.post('purchase', '2026-07-11', s.importVendor, [
      { ledgerId: s.purchases, drCr: 'dr', amount: 30000 },
      { ledgerId: s.igstL, drCr: 'dr', amount: 5400 },
      { ledgerId: s.importVendor, drCr: 'cr', amount: 35400 }
    ])
    // RCM purchase books no tax lines — tax is computed from the purchase ledger's 18% rate.
    s.post('purchase', '2026-07-12', s.rcmVendor, [
      { ledgerId: s.purchases, drCr: 'dr', amount: 20000 },
      { ledgerId: s.rcmVendor, drCr: 'cr', amount: 20000 }
    ])

    const rcm = rcmInwardSummary(s.db, TEST_INFO, FROM, TO)
    expect(rcm).toEqual({ taxable: 20000, igst: 0, cgst: 1800, sgst: 1800, cess: 0 })

    const itc = itcBreakdown(s.db, TEST_INFO, FROM, TO)
    expect(itc.blocked).toEqual({ igst: 0, cgst: 900, sgst: 900, cess: 0 })
    expect(itc.impg).toEqual({ igst: 5400, cgst: 0, sgst: 0, cess: 0 })
    expect(itc.isrc).toEqual({ igst: 0, cgst: 1800, sgst: 1800, cess: 0 })
    expect(itc.oth).toEqual({ igst: 0, cgst: 0, sgst: 0, cess: 0 })
  })

  it('doc series (Table 13) counts deleted vouchers as cancelled; turnover excludes them', () => {
    const s = setup()
    s.post('sales', '2026-07-05', s.buyer, [
      { ledgerId: s.buyer, drCr: 'dr', amount: 118000 },
      { ledgerId: s.sales, drCr: 'cr', amount: 100000 },
      { ledgerId: s.cgstL, drCr: 'cr', amount: 9000 },
      { ledgerId: s.sgstL, drCr: 'cr', amount: 9000 }
    ])
    const doomed = s.post('sales', '2026-07-06', s.buyer, [
      { ledgerId: s.buyer, drCr: 'dr', amount: 59000 },
      { ledgerId: s.sales, drCr: 'cr', amount: 50000 },
      { ledgerId: s.cgstL, drCr: 'cr', amount: 4500 },
      { ledgerId: s.sgstL, drCr: 'cr', amount: 4500 }
    ])
    deleteVoucher(s.db, doomed.id)

    const series = extractDocSeries(s.db, FROM, TO)
    expect(series).toEqual([{ category: 1, from: '1', to: '2', totnum: 2, cancel: 1 }])

    // Turnover (gt/cur_gt) computes from active income-side lines only.
    expect(turnover(s.db, FROM, TO)).toBe(100000)
    // The binned voucher is also gone from extraction itself.
    expect(extractOutwardDocs(s.db, TEST_INFO, FROM, TO)).toHaveLength(1)
  })

  it('gstValidate flags missing HSN (blocking) and assertExportable refuses the export (G7 gate)', () => {
    const s = setup()
    // A sales ledger line with no HSN — value present but absent from Table 12.
    const noHsn = createLedger(s.db, {
      name: 'Sales no HSN',
      groupId: (s.db.prepare("SELECT id FROM groups WHERE name = 'Sales Accounts'").get() as { id: number }).id,
      gstRate: 18
    }).id
    s.post('sales', '2026-07-05', s.buyer, [
      { ledgerId: s.buyer, drCr: 'dr', amount: 118000 },
      { ledgerId: noHsn, drCr: 'cr', amount: 100000 },
      { ledgerId: s.cgstL, drCr: 'cr', amount: 9000 },
      { ledgerId: s.sgstL, drCr: 'cr', amount: 9000 }
    ])

    const issues = gstValidate(s.db, TEST_INFO, FROM, TO)
    const missing = issues.find((i) => i.code === 'missing_hsn')!
    expect(missing.severity).toBe('blocking')
    expect(missing.voucherIds).toHaveLength(1)

    expect(() => assertExportable(s.db, TEST_INFO, FROM, TO)).toThrow(/GSTR-1 export blocked/)

    // Composition companies are refused outright, with an explanation.
    expect(() =>
      assertExportable(s.db, { ...TEST_INFO, gstRegistrationType: 'composition' }, FROM, TO)
    ).toThrow(/composition/)
  })
})
