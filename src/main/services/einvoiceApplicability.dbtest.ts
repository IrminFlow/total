// To-do §4 — e-invoice applicability from the business profile: meta gstProfile.turnover (PAN-level
// aggregate turnover per FY, owner-entered) + gstProfile.einvoiceExemption, set through the
// existing gstProfile:set (a patch, audited as a company update with the whole before / after),
// read by gst.einvoiceStatus (Company details, the Gateway / simple Taxes chip, the e-Invoice
// list). It never switches e-invoicing on: einvoicingOn is unchanged; the doc-no warning (#140)
// also fires while the profile says required.
import { describe, expect, it } from 'vitest'
import { postSimpleVoucher, seededDb, TEST_INFO } from '../db/testdb'
import { createLedger } from './masters'
import { saveVoucher } from './vouchers'
import type { VoucherInput } from '@shared/schemas'
import { getGstProfile, setGstProfile } from './config'
import { einvoiceStatus, einvoicingOn, gstValidate, setEinvoicing } from './gst'

const CR = 1_000_000_000
const REGULAR = { ...TEST_INFO, gstRegistrationType: 'regular' as const, gstin: '27AAPFU0939F1ZV' }
type Db = ReturnType<typeof seededDb>
const companyAudits = (db: Db): { before_json: string | null; after_json: string | null }[] =>
  db.prepare("SELECT before_json, after_json FROM audit_log WHERE entity = 'company' ORDER BY id").all() as { before_json: string | null; after_json: string | null }[]
const metaRow = (db: Db): unknown => {
  const r = db.prepare("SELECT value FROM meta WHERE key = 'gstProfile'").get() as { value: string } | undefined
  return r ? JSON.parse(r.value) : undefined
}

describe('gstProfile turnover: the setting round trip', () => {
  it('stores the turnover beside the filing frequency; audited with the whole before / after; unchanged writes nothing', () => {
    const db = seededDb()
    const n0 = companyAudits(db).length
    const turnover = { years: [{ fy: '2024-25', paise: 6 * CR }, { fy: '2023-24', paise: 4 * CR }], otherGstins: true }
    expect(setGstProfile(db, { turnover })).toEqual({ filing: 'monthly', turnover })
    expect(metaRow(db)).toEqual({ filing: 'monthly', turnover })
    const rows = companyAudits(db)
    expect(rows.length).toBe(n0 + 1)
    expect(JSON.parse(rows.at(-1)!.before_json!)).toEqual({ gstProfile: null })
    expect(JSON.parse(rows.at(-1)!.after_json!)).toEqual({ gstProfile: { filing: 'monthly', turnover } })
    // the filing picker alone keeps the turnover (a patch)
    setGstProfile(db, { filing: 'quarterly' })
    expect(getGstProfile(db)).toEqual({ filing: 'quarterly', turnover })
    expect(JSON.parse(companyAudits(db).at(-1)!.before_json!)).toEqual({ gstProfile: { filing: 'monthly', turnover } })
    const n = companyAudits(db).length
    setGstProfile(db, { turnover, filing: 'quarterly' }) // unchanged
    expect(companyAudits(db).length).toBe(n)
    setGstProfile(db, { einvoiceExemption: 'sez_unit' })
    expect(getGstProfile(db)).toEqual({ filing: 'quarterly', turnover, einvoiceExemption: 'sez_unit' })
    // null clears
    setGstProfile(db, { turnover: null, einvoiceExemption: null })
    expect(getGstProfile(db)).toEqual({ filing: 'quarterly' })
    expect(companyAudits(db).length).toBe(n + 2)
  })

  it('refuses a malformed turnover (FY label, fractional paise, a year twice, unknown keys)', () => {
    const db = seededDb()
    expect(() => setGstProfile(db, { turnover: { years: [{ fy: '2024', paise: 1 }] } })).toThrow()
    expect(() => setGstProfile(db, { turnover: { years: [{ fy: '2024-25', paise: 0.5 }] } })).toThrow()
    expect(() => setGstProfile(db, { turnover: { years: [{ fy: '2024-25', paise: 1 }, { fy: '2024-25', paise: 2 }] } })).toThrow()
    expect(() => setGstProfile(db, { turnover: { years: [] }, extra: true })).toThrow()
    expect(metaRow(db)).toBeUndefined()
    // an empty patch writes nothing (no default stored, no audit row)
    const n = companyAudits(db).length
    expect(setGstProfile(db, {})).toEqual({ filing: 'monthly' })
    expect(metaRow(db)).toBeUndefined()
    expect(companyAudits(db).length).toBe(n)
  })
})

describe('einvoiceStatus: the chip facts', () => {
  it('no profile: nothing required, no notice — exactly as before', () => {
    const db = seededDb()
    expect(einvoiceStatus(db, REGULAR, '2026-10-17')).toEqual({ enabled: false, applicability: { required: false, reason: 'no_turnover' }, turnOn: null, reportingWindowDays: null })
  })

  it('required + switch off → "applies from" notice; never switches on; the switch on → the 30-day window', () => {
    const db = seededDb()
    setGstProfile(db, { turnover: { years: [{ fy: '2025-26', paise: 12 * CR }] } })
    // FY 2025-26 counts from 1 April 2026 ("any preceding financial year")
    expect(einvoiceStatus(db, REGULAR, '2026-03-31')).toMatchObject({ enabled: false, turnOn: null, applicability: { required: false, reason: 'exceeded_from_later', since: '2026-04-01' } })
    const s = einvoiceStatus(db, REGULAR, '2026-10-17')
    expect(s.turnOn).toEqual({ since: '2026-04-01', fy: '2025-26', thresholdPaise: 5 * CR, notification: '10/2023-CT' })
    expect(s.reportingWindowDays).toBeNull() // only while the switch is on
    expect(einvoicingOn(db, REGULAR)).toBe(false) // never auto-switched
    expect(db.prepare("SELECT 1 FROM meta WHERE key = 'einvoicing'").get()).toBeUndefined()
    setEinvoicing(db, REGULAR, { enabled: true })
    expect(einvoiceStatus(db, REGULAR, '2026-10-17')).toMatchObject({ enabled: true, turnOn: null, reportingWindowDays: 30 })
    // a composition business: nothing
    expect(einvoiceStatus(db, { gstRegistrationType: 'composition' }, '2026-10-17')).toMatchObject({ enabled: false, turnOn: null, applicability: { reason: 'not_regular' } })
  })

  it('an exempt registrant type is never told to turn it on', () => {
    const db = seededDb()
    setGstProfile(db, { turnover: { years: [{ fy: '2024-25', paise: 900 * CR }] }, einvoiceExemption: 'insurer_bank_fi' })
    expect(einvoiceStatus(db, REGULAR, '2026-10-17')).toMatchObject({ turnOn: null, applicability: { required: false, reason: 'exempt' } })
  })
})

describe('the e-invoice doc-no warning (#140) also fires when the profile says required', () => {
  it('switch off, profile required → warning; profile below → none', () => {
    const db = seededDb()
    postSimpleVoucher(db, { date: '2025-04-10', amount: 50000, kind: 'sales' }) // a B2C bill (never checked); creates the Sales Account
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
    setEinvoicing(db, REGULAR, { enabled: false })
    const issue = (): unknown => gstValidate(db, REGULAR, '2025-04-01', '2025-04-30').find((i) => i.code === 'einvoice_doc_no')
    expect(issue()).toBeUndefined()
    setGstProfile(db, { turnover: { years: [{ fy: '2023-24', paise: 5 * CR }] } }) // exactly ₹5 cr: not over
    expect(issue()).toBeUndefined()
    setGstProfile(db, { turnover: { years: [{ fy: '2023-24', paise: 5 * CR + 100 }] } })
    expect(issue()).toMatchObject({ severity: 'warning', voucherIds: [sale] })
    // decided on the period's last day (30 Apr 2025): FY 2025-26's turnover counts only from 1 Apr 2026
    setGstProfile(db, { turnover: { years: [{ fy: '2025-26', paise: 9 * CR }] } })
    expect(issue()).toBeUndefined()
  })
})
