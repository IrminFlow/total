// WP 2.5b — "does this company e-invoice?" (services/gst.ts einvoicingOn). Review follow-up: an
// explicit switch (meta `einvoicing: { enabled }`, owner-only einvoicing:set, audited as a company
// update) whose default is PR #140's history heuristic (einvoicingFromHistory: a REGULAR
// registration plus any sign of use — NIC live filing set up for e-invoices, an IRN on a voucher in
// the books, or an e-invoice JSON exported), computed ONCE at the first read and stored. Only while
// it is on does gstValidate warn about a sales number the IRP refuses (NIC schema DocDtls.No).
import { describe, expect, it } from 'vitest'
import { postSimpleVoucher, seededDb, TEST_INFO } from '../db/testdb'
import { writeAudit } from './audit'
import { createLedger } from './masters'
import { saveVoucher } from './vouchers'
import type { VoucherInput } from '@shared/schemas'
import { einvoicingFromHistory as einvoicingOn, einvoicingOn as switchOn, getEinvoicing, setEinvoicing, gstValidate } from './gst'

const REGULAR = { ...TEST_INFO, gstRegistrationType: 'regular' as const, gstin: '27AAPFU0939F1ZV' }

describe('einvoicingFromHistory (the default)', () => {
  it('is off by default and for a company that is not regular', () => {
    const db = seededDb()
    expect(einvoicingOn(db, REGULAR)).toBe(false)
    db.prepare("INSERT INTO meta (key, value) VALUES ('nic', ?)").run(JSON.stringify({ mode: 'einvoice' }))
    expect(einvoicingOn(db, { gstRegistrationType: 'composition' })).toBe(false)
    expect(einvoicingOn(db, { gstRegistrationType: 'unregistered' })).toBe(false)
  })

  it('NIC set up for e-invoices (mode or base URL) — not for e-way bills only', () => {
    const db = seededDb()
    db.prepare("INSERT INTO meta (key, value) VALUES ('nic', ?)").run(JSON.stringify({ mode: 'ewb', baseUrlEinvoice: '' }))
    expect(einvoicingOn(db, REGULAR)).toBe(false)
    db.prepare("UPDATE meta SET value = ? WHERE key = 'nic'").run(JSON.stringify({ baseUrlEinvoice: 'https://einv-apisandbox.nic.in' }))
    expect(einvoicingOn(db, REGULAR)).toBe(true)
    db.prepare("UPDATE meta SET value = 'not json' WHERE key = 'nic'").run()
    expect(einvoicingOn(db, REGULAR)).toBe(false)
  })

  it('an IRN on a voucher in the books, or an e-invoice export', () => {
    const db = seededDb()
    const id = postSimpleVoucher(db, { date: '2025-04-10', amount: 50000, kind: 'receipt' }).id
    db.prepare("UPDATE vouchers SET irn = 'abc' WHERE id = ?").run(id)
    expect(einvoicingOn(db, REGULAR)).toBe(true)
    db.prepare("UPDATE vouchers SET deleted_at = datetime('now') WHERE id = ?").run(id)
    expect(einvoicingOn(db, REGULAR)).toBe(false) // binned: not in the books
    writeAudit(db, 'export', 0, 'export', null, { kind: 'ewb' })
    expect(einvoicingOn(db, REGULAR)).toBe(false)
    writeAudit(db, 'export', 0, 'export', null, { kind: 'einvoice', period: '042025' })
    expect(einvoicingOn(db, REGULAR)).toBe(true)
  })

  it('gstValidate passes it on: a long number on a B2B sale is a warning only once the company e-invoices; a B2C bill never', () => {
    const db = seededDb()
    const b2c = postSimpleVoucher(db, { date: '2025-04-10', amount: 50000, kind: 'sales' }).id
    db.prepare("UPDATE vouchers SET number = 'B2C/2025-26/000001' WHERE id = ?").run(b2c)
    // PR #140 review: only documents that are e-invoiced (a registered buyer / an export) are checked.
    const group = (db.prepare("SELECT id FROM groups WHERE name = 'Sundry Debtors'").get() as { id: number }).id
    const buyer = createLedger(db, {
      name: 'Umbrella Retail', groupId: group, openingBalance: 0, gstin: '27AABCG3456H1ZN', stateCode: '27', address: null,
      taxType: null, gstRate: null, hsn: null, tdsSectionId: null, pan: null, creditDays: null, exportType: null
    }).id
    const salesAc = (db.prepare("SELECT id FROM ledgers WHERE name = 'Sales Account'").get() as { id: number }).id
    const vt = (db.prepare("SELECT id FROM voucher_types WHERE kind = 'sales'").get() as { id: number }).id
    const sale = saveVoucher(db, {
      voucherTypeId: vt, date: '2025-04-11', partyLedgerId: buyer, narration: null, reference: null,
      instrumentNo: null, instrumentDate: null, transporterId: null, vehicleNo: null,
      transportDistanceKm: null, currencyCode: null, exchangeRate: null,
      lines: [
        { ledgerId: buyer, drCr: 'dr', amount: 50000, costAllocations: [] },
        { ledgerId: salesAc, drCr: 'cr', amount: 50000, costAllocations: [] }
      ],
      inventory: [], billRefs: [], tds: null
    } as VoucherInput).id
    db.prepare("UPDATE vouchers SET number = 'INV/2025-26/000001' WHERE id = ?").run(sale)
    const issue = (): unknown => gstValidate(db, REGULAR, '2025-04-01', '2025-04-30').find((i) => i.code === 'einvoice_doc_no')
    expect(issue()).toBeUndefined()
    // the default was stored at that first read (off): a later e-invoice export no longer turns it on
    writeAudit(db, 'export', 0, 'export', null, { kind: 'einvoice', period: '042025' })
    expect(issue()).toBeUndefined()
    setEinvoicing(db, REGULAR, { enabled: true })
    expect(issue()).toMatchObject({ severity: 'warning', voucherIds: [sale] })
  })
})

describe('the e-invoicing switch (meta einvoicing)', () => {
  const metaRow = (db: ReturnType<typeof seededDb>): string | undefined =>
    (db.prepare("SELECT value FROM meta WHERE key = 'einvoicing'").get() as { value: string } | undefined)?.value
  const companyAudits = (db: ReturnType<typeof seededDb>): { before_json: string | null; after_json: string | null }[] =>
    db.prepare("SELECT before_json, after_json FROM audit_log WHERE entity = 'company' ORDER BY id").all() as { before_json: string | null; after_json: string | null }[]

  it('the first read stores the history answer once (no audit row); the scan never decides again', () => {
    const db = seededDb()
    const id = postSimpleVoucher(db, { date: '2025-04-10', amount: 50000, kind: 'receipt' }).id
    db.prepare("UPDATE vouchers SET irn = 'abc' WHERE id = ?").run(id)
    const audits = companyAudits(db).length
    expect(getEinvoicing(db, REGULAR)).toEqual({ enabled: true }) // was already e-invoicing: stays on
    expect(metaRow(db)).toBe('{"enabled":true}')
    expect(companyAudits(db).length).toBe(audits)
    // the history changes; the stored setting does not
    db.prepare("UPDATE vouchers SET deleted_at = datetime('now') WHERE id = ?").run(id)
    expect(switchOn(db, REGULAR)).toBe(true)

    const fresh = seededDb()
    expect(getEinvoicing(fresh, REGULAR)).toEqual({ enabled: false }) // no sign of use: off
    writeAudit(fresh, 'export', 0, 'export', null, { kind: 'einvoice', period: '042025' })
    expect(getEinvoicing(fresh, REGULAR)).toEqual({ enabled: false })
  })

  it('set is audited as a company update with the whole before / after; unchanged writes nothing; regular only takes effect', () => {
    const db = seededDb()
    expect(setEinvoicing(db, REGULAR, { enabled: false })).toEqual({ enabled: false }) // seeds, unchanged
    const n = companyAudits(db).length
    expect(setEinvoicing(db, REGULAR, { enabled: true })).toEqual({ enabled: true })
    const rows = companyAudits(db)
    expect(rows.length).toBe(n + 1)
    expect(JSON.parse(rows.at(-1)!.before_json!)).toEqual({ einvoicing: { enabled: false } })
    expect(JSON.parse(rows.at(-1)!.after_json!)).toEqual({ einvoicing: { enabled: true } })
    setEinvoicing(db, REGULAR, { enabled: true })
    expect(companyAudits(db).length).toBe(n + 1)
    expect(switchOn(db, REGULAR)).toBe(true)
    expect(switchOn(db, { gstRegistrationType: 'composition' })).toBe(false)
    // an unreadable row reads as missing and is re-seeded from history
    db.prepare("UPDATE meta SET value = 'nope' WHERE key = 'einvoicing'").run()
    expect(getEinvoicing(db, REGULAR)).toEqual({ enabled: false })
  })
})
