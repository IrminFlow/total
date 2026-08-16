import { describe, it, expect } from 'vitest'
import {
  DEMO_COMPANY, DEMO_PARTIES, DEMO_ITEMS, DEMO_EXTRA_LEDGERS,
  DEMO_DEBTORS, DEMO_CREDITORS, demoVouchers, demoWindow
} from './demo'
import { validateGstin } from './gst/validate'
import { fyOf } from './dates'
import { percentOf } from './money'
import { supplyTypeFor } from './gst/calc'

describe('DEMO_COMPANY', () => {
  it('has a valid GSTIN matching its state code', () => {
    const check = validateGstin(DEMO_COMPANY.gstin!)
    expect(check.valid).toBe(true)
    expect(check.stateCode).toBe(DEMO_COMPANY.stateCode)
  })

  it('is a regular-registration company named Demo Traders', () => {
    expect(DEMO_COMPANY.name).toBe('Demo Traders')
    expect(DEMO_COMPANY.gstRegistrationType).toBe('regular')
  })
})

describe('DEMO_PARTIES', () => {
  it('has 3 debtors and 2 creditors, all with valid GSTINs', () => {
    expect(DEMO_DEBTORS).toHaveLength(3)
    expect(DEMO_CREDITORS).toHaveLength(2)
    for (const p of DEMO_PARTIES) {
      expect(validateGstin(p.gstin).valid).toBe(true)
    }
  })

  it('spans 2+ states among the debtors, so sales exercise both CGST+SGST and IGST', () => {
    const states = new Set(DEMO_DEBTORS.map((p) => p.stateCode))
    expect(states.size).toBeGreaterThanOrEqual(2)
  })
})

describe('DEMO_ITEMS', () => {
  it('has 6 items with HSN codes and a 5/12/18% rate mix', () => {
    expect(DEMO_ITEMS).toHaveLength(6)
    for (const item of DEMO_ITEMS) {
      expect(item.hsn).toMatch(/^\d+$/)
    }
    const rates = new Set(DEMO_ITEMS.map((i) => i.gstRate))
    expect(rates.has(5)).toBe(true)
    expect(rates.has(12)).toBe(true)
    expect(rates.has(18)).toBe(true)
  })
})

describe('DEMO_EXTRA_LEDGERS', () => {
  it('includes Sales/Purchase accounts, the 6 tax ledgers, and the bank ledger', () => {
    const names = DEMO_EXTRA_LEDGERS.map((l) => l.name)
    expect(names).toContain('Sales A/c')
    expect(names).toContain('Purchase A/c')
    expect(names).toContain('HDFC Bank')
    for (const tax of ['CGST Output', 'SGST Output', 'IGST Output', 'CGST Input', 'SGST Input', 'IGST Input']) {
      expect(names).toContain(tax)
    }
  })

  it('tags every Duties & Taxes ledger with a tax_type', () => {
    for (const l of DEMO_EXTRA_LEDGERS) {
      if (l.groupName === 'Duties & Taxes') expect(l.taxType).toBeTruthy()
    }
  })
})

describe('demoWindow', () => {
  it('spans the trailing 3 months when the FY started long ago', () => {
    const { from, to } = demoWindow('2026-08-15')
    expect(to).toBe('2026-08-15')
    expect(from).toBe('2026-05-15')
  })

  it('clamps to the FY start when 3 months back would predate it', () => {
    const { from } = demoWindow('2026-05-01')
    expect(from).toBe(fyOf('2026-05-01').from)
  })
})

describe('demoVouchers', () => {
  const TODAY = '2026-08-15'
  const vouchers = demoVouchers(TODAY)

  it('generates ~40 vouchers with the expected kind mix', () => {
    expect(vouchers).toHaveLength(40)
    const counts = vouchers.reduce<Record<string, number>>((acc, v) => {
      acc[v.kind] = (acc[v.kind] ?? 0) + 1
      return acc
    }, {})
    expect(counts.sales).toBe(14)
    expect(counts.purchase).toBe(8)
    expect(counts.receipt).toBe(8)
    expect(counts.payment).toBe(6)
    expect(counts.contra).toBe(2)
    expect(counts.journal).toBe(2)
  })

  it('every voucher balances: sum(dr) === sum(cr)', () => {
    for (const v of vouchers) {
      const dr = v.lines.filter((l) => l.drCr === 'dr').reduce((s, l) => s + l.amount, 0)
      const cr = v.lines.filter((l) => l.drCr === 'cr').reduce((s, l) => s + l.amount, 0)
      expect(dr).toBe(cr)
    }
  })

  it('every voucher falls within the trailing-3-months (FY-clamped) window', () => {
    const { from, to } = demoWindow(TODAY)
    for (const v of vouchers) {
      expect(v.date >= from).toBe(true)
      expect(v.date <= to).toBe(true)
    }
  })

  it('sales/purchase GST lines equal rate × taxable, split correctly by supply type', () => {
    const byName = new Map(DEMO_ITEMS.map((i) => [i.name, i]))
    const partyByName = new Map(DEMO_PARTIES.map((p) => [p.name, p]))

    for (const v of vouchers.filter((v) => v.kind === 'sales' || v.kind === 'purchase')) {
      const taxableLedger = v.kind === 'sales' ? 'Sales A/c' : 'Purchase A/c'
      const taxable = v.lines.find((l) => l.ledgerName === taxableLedger)!.amount
      const item = byName.get(v.inventory![0]!.itemName)!
      const party = partyByName.get(v.partyName!)!
      const supply = supplyTypeFor(DEMO_COMPANY.stateCode, party.stateCode)

      const cgst = v.lines.find((l) => l.ledgerName.includes('CGST'))?.amount ?? 0
      const sgst = v.lines.find((l) => l.ledgerName.includes('SGST'))?.amount ?? 0
      const igst = v.lines.find((l) => l.ledgerName.includes('IGST'))?.amount ?? 0

      if (supply === 'intra') {
        expect(igst).toBe(0)
        expect(cgst).toBe(percentOf(taxable, item.gstRate / 2))
        expect(sgst).toBe(percentOf(taxable, item.gstRate / 2))
      } else {
        expect(cgst).toBe(0)
        expect(sgst).toBe(0)
        expect(igst).toBe(percentOf(taxable, item.gstRate))
      }
    }
  })

  it('inventory line amount matches qty × rate for every sale/purchase', () => {
    for (const v of vouchers.filter((v) => v.kind === 'sales' || v.kind === 'purchase')) {
      const inv = v.inventory![0]!
      expect(inv.amount).toBe((inv.qtyMilli * inv.ratePaise) / 1000)
    }
  })
})
