import { describe, it, expect } from 'vitest'
import { commissionBase, commissionOn, commissionStatements, type CollectionEvent } from './commission'

const event = (over: Partial<CollectionEvent> = {}): CollectionEvent => ({
  voucherId: 1,
  date: '2026-05-10',
  billNumber: 'SV-1',
  partyName: 'Kumar Stores',
  salesperson: 'Ravi',
  collectedPaise: 11_800_00,
  invoiceTotalPaise: 11_800_00,
  invoiceTaxablePaise: 10_000_00,
  ...over
})

describe('what the rate applies to', () => {
  it('is the whole receipt on a gross scheme', () => {
    expect(commissionBase(event(), 'gross')).toBe(11_800_00)
  })

  it('is the tax-exclusive share on a net scheme', () => {
    expect(commissionBase(event(), 'net_of_tax')).toBe(10_000_00)
  })

  it('pro-rates a part payment rather than treating the first rupees as tax', () => {
    // Half the bill is half the goods and half the tax — there is no rule that says otherwise.
    expect(commissionBase(event({ collectedPaise: 5_900_00 }), 'net_of_tax')).toBe(5_000_00)
  })

  it('falls back to the receipt when the invoice total is unknown', () => {
    expect(commissionBase(event({ invoiceTotalPaise: 0 }), 'net_of_tax')).toBe(11_800_00)
  })
})

describe('commission on a collection', () => {
  it('is a percentage of the base, in integer paise', () => {
    const r = commissionOn(event(), { rateBp: 250, basis: 'net_of_tax' })
    expect(r.commissionPaise).toBe(250_00)
    expect(Number.isInteger(r.commissionPaise)).toBe(true)
  })

  it('an uncollected invoice earns nothing, because there is no event to earn on', () => {
    expect(commissionStatements([], () => ({ rateBp: 250, basis: 'gross' }))).toEqual([])
  })

  it('a part-collected bill earns part of the commission, with no adjusting entry', () => {
    const full = commissionOn(event(), { rateBp: 250, basis: 'gross' })
    const half = commissionOn(event({ collectedPaise: 5_900_00 }), { rateBp: 250, basis: 'gross' })
    expect(half.commissionPaise * 2).toBe(full.commissionPaise)
  })
})

describe('the statement', () => {
  const events = [
    event(),
    event({ voucherId: 2, billNumber: 'SV-2', date: '2026-05-01', collectedPaise: 5_900_00 }),
    event({ voucherId: 3, billNumber: 'SV-3', salesperson: 'Meena', collectedPaise: 23_600_00, invoiceTotalPaise: 23_600_00, invoiceTaxablePaise: 20_000_00 })
  ]
  const rule = { rateBp: 250, basis: 'net_of_tax' as const }

  it('is one statement per salesperson, biggest first', () => {
    const s = commissionStatements(events, () => rule)
    expect(s.map((x) => x.salesperson)).toEqual(['Meena', 'Ravi'])
  })

  it('foots: the rows add up to the totals', () => {
    for (const s of commissionStatements(events, () => rule)) {
      expect(s.rows.reduce((t, r) => t + r.commissionPaise, 0)).toBe(s.commissionPaise)
      expect(s.rows.reduce((t, r) => t + r.collectedPaise, 0)).toBe(s.collectedPaise)
    }
  })

  it('lists a salesperson’s collections in date order', () => {
    const ravi = commissionStatements(events, () => rule).find((s) => s.salesperson === 'Ravi')!
    expect(ravi.rows.map((r) => r.billNumber)).toEqual(['SV-2', 'SV-1'])
  })

  it('leaves out a salesperson with no scheme — no rate is not a zero rate', () => {
    const s = commissionStatements(events, (who) => (who === 'Ravi' ? rule : null))
    expect(s.map((x) => x.salesperson)).toEqual(['Ravi'])
  })
})
