// WP 8.0 — the registration rule in the pure engine, the state-code order, compliance applicability
// and the print title.
import { describe, expect, it } from 'vitest'
import { chargesGst, chargesGstOn, BILL_OF_SUPPLY_TITLE, gstNotChargedMessage, nonTaxInvoiceTitle, registrationOn } from './registration'
import { nonClaimableCosts, rateForCost } from '../capture/nonClaimable'
import { GST_STATE_LIST, GST_STATES } from './states'
import { buildInvoicePayload, computeInvoice, emptyInvoiceState, invoiceRepresentation, type InvoiceContext, type TaxLedgerIds } from '../voucherEdit'
import type { Voucher } from '../domain'
import { complianceApplicability, upcomingDeadlines } from '../compliance'

const TAX: TaxLedgerIds = { cgst: 40, sgst: 41, igst: 42, cess: 43, roundOff: 44 }
const ctxFor = (gstRegistrationType: InvoiceContext['gstRegistrationType']): InvoiceContext => ({
  kind: 'sales', companyStateCode: '27', gstRegistrationType,
  items: new Map([[100, { gstRate: 18, cessRate: 1 }]]),
  ledgers: new Map([[7, { stateCode: '27', gstRate: null }], [8, { stateCode: null, gstRate: 12 }]])
})
const state = { ...emptyInvoiceState('2025-05-10'), partyId: 7, accountId: 8, billName: 'B-1', rows: [{ itemId: 100, qtyText: '2', rate: 10_050, discount: null, godownId: null, batchId: null }] }

describe('chargesGst', () => {
  it('only a regular registration charges GST', () => {
    expect(chargesGst('regular')).toBe(true)
    expect(chargesGst('composition')).toBe(false)
    expect(chargesGst('unregistered')).toBe(false)
    expect(gstNotChargedMessage('unregistered')).toMatch(/not registered for GST.*Company details/)
    expect(gstNotChargedMessage('composition')).toMatch(/composition scheme/)
    expect(BILL_OF_SUPPLY_TITLE).toBe('BILL OF SUPPLY')
  })
})

describe('computeInvoice and the registration (WP 8.0)', () => {
  it('a regular company is unchanged: item GST + cess, round off', () => {
    const c = computeInvoice(state, ctxFor('regular'))
    expect(c.chargesGst).toBe(true)
    expect(c.gst).toMatchObject({ taxable: 20_100, cgst: 1809, sgst: 1809, cess: 201 })
  })
  for (const t of ['unregistered', 'composition'] as const) {
    it(`${t}: no GST on any line (item and ledger rates ignored), no tax lines in the payload`, () => {
      const c = computeInvoice(state, ctxFor(t))
      expect(c.chargesGst).toBe(false)
      expect(c.gst).toMatchObject({ taxable: 20_100, cgst: 0, sgst: 0, igst: 0, cess: 0 })
      expect(c.detail[0]).toMatchObject({ rate: 0, cessRate: 0 })
      const r = buildInvoicePayload(state, ctxFor(t), 1, TAX)
      expect(r.ok && r.payload.lines.map((l) => [l.ledgerId, l.drCr, l.amount])).toEqual([[7, 'dr', 20_100], [8, 'cr', 20_100]])
    })
  }

  it('a taxed voucher saved while regular round-trips in an unregistered company (legacyTax), a fresh one does not get it', () => {
    const built = buildInvoicePayload(state, ctxFor('regular'), 1, TAX)
    if (!built.ok) throw new Error(built.error)
    const p = built.payload
    const v = {
      id: 1, voucherTypeId: 1, date: p.date, number: 'S-1', partyLedgerId: p.partyLedgerId, narration: p.narration, reference: null,
      instrumentNo: null, instrumentDate: null, transporterId: null, vehicleNo: null, transportDistanceKm: null, posOverride: null,
      currencyCode: null, exchangeRate: null, isOptional: false, postDated: false, deletedAt: null, irn: null,
      lines: p.lines.map((l, i) => ({ id: i + 1, ...l })),
      inventory: p.inventory.map((l, i) => ({ id: i + 1, isAbsolute: false, ...l })),
      billRefs: p.billRefs, tds: null, tcs: null
    } as unknown as Voucher
    const legacy = invoiceRepresentation(v, ctxFor('unregistered'), TAX)
    expect(legacy.ok).toBe(true)
    expect(legacy.ok && legacy.state.legacyTax).toBe(true)
    const regular = invoiceRepresentation(v, ctxFor('regular'), TAX)
    expect(regular.ok && regular.state.legacyTax).toBeUndefined()
  })
})

describe('GST state list order (WP 8.0)', () => {
  it('runs by state code 01 → 38, then 96 / 97, and lists every state once', () => {
    const codes = GST_STATE_LIST.map(([c]) => c)
    expect(codes.slice(0, 3)).toEqual(['01', '02', '03'])
    expect(codes.indexOf('09')).toBe(8)
    expect(codes.indexOf('10')).toBe(9)
    expect(codes.slice(-3)).toEqual(['38', '96', '97'])
    expect([...codes].sort((a, b) => Number(a) - Number(b))).toEqual(codes)
    expect(codes).toHaveLength(Object.keys(GST_STATES).length)
    expect(GST_STATE_LIST[0]).toEqual(['01', 'Jammu & Kashmir'])
  })
})

describe('compliance applicability (WP 8.0)', () => {
  it('GST only for regular; TDS only when on and something was deducted', () => {
    expect(complianceApplicability({ gstRegistrationType: 'unregistered', tdsOn: true, tdsActivity: false, hasPayroll: false })).toEqual({ gst: false, tds: false, payroll: false })
    expect(complianceApplicability({ gstRegistrationType: 'regular', tdsOn: false, tdsActivity: true, hasPayroll: true })).toEqual({ gst: true, tds: false, payroll: true })
    expect(complianceApplicability({ gstRegistrationType: 'composition', tdsOn: true, tdsActivity: true, hasPayroll: false })).toEqual({ gst: false, tds: true, payroll: false })
  })
  it('tds: false drops the TDS deposit date; absent keeps it (unchanged callers)', () => {
    const kinds = (o?: { tds?: boolean }): string[] => upcomingDeadlines('2026-01-01', 'unregistered', false, 30, o).map((d) => d.kind)
    expect(kinds()).toContain('tds')
    expect(kinds({ tds: false })).not.toContain('tds')
    expect(kinds({ tds: false })).not.toContain('gst')
  })
})

describe('effective-dated registration (WP 8.0 review)', () => {
  const c = { gstRegistrationType: 'composition' as const, gstRegistrationSince: '2025-10-01', gstPreviousRegistrationType: 'regular' as const }
  it('the voucher date decides', () => {
    expect(registrationOn(c, '2025-09-30')).toBe('regular')
    expect(registrationOn(c, '2025-10-01')).toBe('composition')
    expect(chargesGstOn(c, '2025-09-30')).toBe(true)
    expect(chargesGstOn({ gstRegistrationType: 'unregistered' }, '2000-01-01')).toBe(false)
    expect(nonTaxInvoiceTitle('composition')).toBe('BILL OF SUPPLY')
    expect(nonTaxInvoiceTitle('unregistered')).toBe('INVOICE')
    expect(nonTaxInvoiceTitle('regular')).toBeNull()
  })
})

describe('non-claimable GST on a captured bill (WP 8.0 review)', () => {
  it('each line costs taxable + its tax; the printed total tax is met exactly', () => {
    const costs = nonClaimableCosts([
      { taxable: 2_000_000, rateBp: 1800, printedTax: null },
      { taxable: 950_000, rateBp: 1200, printedTax: null }
    ], 474_000)
    expect(costs).toEqual([{ tax: 360_000, cost: 2_360_000 }, { tax: 114_000, cost: 1_064_000 }])
    // A rounding difference goes to the line with the largest tax.
    expect(nonClaimableCosts([{ taxable: 333, rateBp: 1800, printedTax: null }, { taxable: 333, rateBp: 1800, printedTax: null }], 121))
      .toEqual([{ tax: 61, cost: 394 }, { tax: 60, cost: 393 }])
  })
  it('a rate that comes to exactly the cost (rounded up, the rest as a discount)', () => {
    for (const [cost, qty] of [[2_360_000, 4000], [1_000_001, 3000], [10, 7000]] as const) {
      const { ratePaise, discountPaise } = rateForCost(cost, qty)
      expect(Math.round((qty * ratePaise) / 1000) - discountPaise).toBe(cost)
      expect(discountPaise).toBeGreaterThanOrEqual(0)
    }
  })
})
