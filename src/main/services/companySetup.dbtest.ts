// WP 8.3: the setup wizard's presets. Each preset seeds the expected rows in one transaction with
// a valid audit chain and a zero trial balance; features are written explicitly; an unregistered
// business gets no GST accounts; every seeded account agrees with the WP 5.6 classifier; and the
// accountant path (seedCompany) is byte-identical to before (snapshot).
import { describe, expect, it } from 'vitest'
import { freshDb, TEST_INFO } from '../db/testdb'
import { seedCompany } from '../db/seed'
import { applySetup } from './companySetup'
import { verifyAudit } from './audit'
import { trialBalance } from './reports'
import { getFeatures, getGstProfile, getUi } from './config'
import { ledgerClassifier } from '../ai/ledgerClass'
import { canonicalDump } from './canonicalDump.testutil'
import { CATEGORIES, isCategoryKey } from '@shared/simple/categories'
import { BUSINESS_TYPES, PRESETS, presetAccounts, presetFeatures } from '@shared/simple/presets'
import type { SimpleSetupInput } from '@shared/simple/setup'
import { saveVoucher } from './vouchers'

const TODAY = '2026-10-13'
const GSTIN = '27AAPFU0939F1ZV'

const answers = (over: Partial<SimpleSetupInput> = {}): SimpleSetupInput => ({
  name: 'Ramesh Kirana', stateCode: '27', businessType: 'retail', gst: 'no', gstin: null, filing: null,
  stock: true, startDate: '2026-04-01', fresh: true, ...over
})

const meta = (db: ReturnType<typeof freshDb>, key: string): unknown => {
  const r = db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined
  return r ? JSON.parse(r.value) : null
}

describe('applySetup — each preset', () => {
  for (const businessType of BUSINESS_TYPES) {
    for (const gst of ['no', 'regular'] as const) {
      it(`${businessType}, GST ${gst}`, () => {
        const db = freshDb()
        const stock = PRESETS[businessType].stockDefault
        const r = applySetup(db, answers({ businessType, gst, stock, gstin: gst === 'regular' ? GSTIN : null, filing: gst === 'regular' ? 'quarterly' : null }), TODAY)

        // The accounts: exactly the preset's, each under its group, carrying its category.
        const rows = db.prepare('SELECT l.id, l.name, l.simple_category AS cat, l.tax_type, g.name AS grp FROM ledgers l JOIN groups g ON g.id = l.group_id WHERE l.is_system = 0 ORDER BY l.id').all() as { id: number; name: string; cat: string | null; tax_type: string | null; grp: string }[]
        const keys = presetAccounts(businessType, gst === 'regular')
        expect(rows.map((x) => x.cat)).toEqual(keys)
        const cls = ledgerClassifier(db)
        for (const row of rows) {
          expect(isCategoryKey(row.cat)).toBe(true)
          const c = CATEGORIES[row.cat as keyof typeof CATEGORIES]
          expect([row.name, row.grp, row.tax_type]).toEqual([c.name, c.group, 'taxType' in c ? c.taxType : null])
          expect(cls.cls(row.id), row.name).toBe(c.cls)
        }
        expect(Object.keys(r.accounts)).toEqual(keys)
        // Only the system Cash account besides them.
        expect(db.prepare('SELECT name FROM ledgers WHERE is_system = 1').all()).toEqual([{ name: 'Cash' }])
        if (gst === 'no') expect(db.prepare("SELECT COUNT(*) AS n FROM ledgers WHERE tax_type IS NOT NULL OR group_id = (SELECT id FROM groups WHERE name = 'Duties & Taxes')").get()).toEqual({ n: 0 })

        // Units: the preset's all exist.
        for (const u of PRESETS[businessType].units) expect(db.prepare('SELECT 1 AS x FROM units WHERE symbol = ?').get(u)).toEqual({ x: 1 })

        // Features written EXPLICITLY (every key, manufacturing included), GST profile only when regular.
        const stored = meta(db, 'features') as Record<string, boolean>
        expect(stored).toEqual(presetFeatures(businessType, stock))
        expect(getFeatures(db)).toEqual(presetFeatures(businessType, stock))
        expect(meta(db, 'gstProfile')).toEqual(gst === 'regular' ? { filing: 'quarterly' } : null)
        expect(getGstProfile(db).filing).toBe(gst === 'regular' ? 'quarterly' : 'monthly')
        expect(getUi(db)).toEqual({ mode: 'simple', setup: { businessType, gst, stock }, startedFresh: true })

        // Company details: the registration from the start date.
        expect(meta(db, 'company')).toMatchObject({
          name: 'Ramesh Kirana', gstRegistrationType: gst === 'regular' ? 'regular' : 'unregistered',
          gstin: gst === 'regular' ? GSTIN : null, gstRegistrationSince: '2026-04-01', booksFrom: 2026
        })

        // Audit chain valid; one row per seeded thing; nothing posted → zero TB.
        expect(verifyAudit(db).ok).toBe(true)
        const audit = db.prepare('SELECT entity, action, COUNT(*) AS n FROM audit_log WHERE entity <> ? GROUP BY entity, action ORDER BY entity, action').all('migration')
        expect(audit).toEqual(
          [
            { entity: 'company', action: 'create', n: 1 },
            { entity: 'company', action: 'update', n: gst === 'regular' ? 3 : 2 },
            { entity: 'ledger', action: 'create', n: keys.length },
            ...(businessType === 'restaurant' ? [{ entity: 'unit', action: 'create', n: 1 }] : [])
          ]
        )
        const tb = trialBalance(db, '2027-03-31')
        expect([tb.totalDebit, tb.totalCredit]).toEqual([0, 0])
        expect(db.prepare('SELECT COUNT(*) AS n FROM vouchers').get()).toEqual({ n: 0 })
        db.close()
      })
    }
  }
})

describe('applySetup — rules', () => {
  it('composition: registered without GST accounts or a filing frequency; GSTIN optional', () => {
    const db = freshDb()
    applySetup(db, answers({ gst: 'composition' }), TODAY)
    expect(meta(db, 'company')).toMatchObject({ gstRegistrationType: 'composition', gstin: null })
    expect(db.prepare('SELECT COUNT(*) AS n FROM ledgers WHERE tax_type IS NOT NULL').get()).toEqual({ n: 0 })
    expect(meta(db, 'gstProfile')).toBeNull()
  })

  it('"not sure" is treated as no; "I have an accountant" opens the full app with the same preset', () => {
    const db = freshDb()
    applySetup(db, answers({ gst: 'not_sure', mode: 'accountant', fresh: false }), TODAY)
    expect(meta(db, 'company')).toMatchObject({ gstRegistrationType: 'unregistered', gstin: null })
    expect(getUi(db)).toEqual({ mode: 'accountant', setup: { businessType: 'retail', gst: 'not_sure', stock: true }, startedFresh: false })
  })

  it('refuses a regular registration without GSTIN, a GSTIN of another state, and a start after today — and leaves the file empty', () => {
    for (const bad of [
      answers({ gst: 'regular', filing: 'monthly' }),
      answers({ gst: 'regular', gstin: GSTIN, filing: null }),
      answers({ gst: 'regular', gstin: GSTIN, filing: 'monthly', stateCode: '29' }),
      answers({ startDate: '2026-10-14' })
    ]) {
      const db = freshDb()
      expect(() => applySetup(db, bad, TODAY)).toThrow()
      expect(db.prepare('SELECT COUNT(*) AS n FROM meta').get()).toEqual({ n: 0 })
      expect(db.prepare('SELECT COUNT(*) AS n FROM ledgers').get()).toEqual({ n: 0 })
    }
  })

  it('an unregistered kirana can save a sale with no GST through the normal save', () => {
    const db = freshDb()
    const r = applySetup(db, answers(), TODAY)
    const salesType = db.prepare("SELECT id FROM voucher_types WHERE kind = 'sales'").get() as { id: number }
    const cash = db.prepare("SELECT id FROM ledgers WHERE name = 'Cash'").get() as { id: number }
    const v = saveVoucher(db, {
      voucherTypeId: salesType.id, date: '2026-10-13', number: undefined, partyLedgerId: cash.id, narration: '', reference: null,
      instrumentNo: null, instrumentDate: null, transporterId: null, vehicleNo: null, transportDistanceKm: null, currencyCode: null, exchangeRate: null,
      lines: [
        { ledgerId: cash.id, drCr: 'dr', amount: 25000, costAllocations: [] },
        { ledgerId: r.accounts.sales!, drCr: 'cr', amount: 25000, costAllocations: [] }
      ],
      inventory: [], billRefs: [], tds: null
    })
    expect(v.id).toBeGreaterThan(0)
    expect(verifyAudit(db).ok).toBe(true)
  })
})

describe('accountant path unchanged', () => {
  it('seedCompany output is byte-identical (snapshot) and carries no ui / features / gstProfile meta', () => {
    const db = freshDb()
    seedCompany(db, TEST_INFO)
    const dump = canonicalDump(db)
    expect(dump).toMatchSnapshot()
    expect(db.prepare('SELECT key FROM meta ORDER BY key').all()).toEqual([{ key: 'company' }])
    expect(db.prepare('SELECT COUNT(*) AS n FROM ledgers WHERE simple_category IS NOT NULL').get()).toEqual({ n: 0 })
  })

  it('setup starts from exactly the accountant seed (groups, voucher types, standard units, godown, Cash)', () => {
    const plain = freshDb()
    seedCompany(plain, TEST_INFO)
    const setup = freshDb()
    applySetup(setup, answers({ businessType: 'other', stock: false }), TODAY)
    for (const t of ['groups', 'voucher_types', 'units', 'godowns']) expect(canonicalDump(setup)[t], t).toEqual(canonicalDump(plain)[t])
  })
})
