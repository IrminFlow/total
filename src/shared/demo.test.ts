import { describe, it, expect } from 'vitest'
import {
  DEMO_COMPANY, DEMO_PARTIES, DEMO_ITEMS, DEMO_EXTRA_LEDGERS,
  DEMO_DEBTORS, DEMO_CREDITORS, demoVouchers, demoWindow,
  DEMO_TRADES, DEMO_TRADE_PROFILES, demoProfile
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

// ---------- the three trades (roadmap #293) ----------

describe('DEMO_TRADE_PROFILES', () => {
  const TODAY = '2026-08-15'

  it('covers every trade in DEMO_TRADES, once each', () => {
    expect(DEMO_TRADE_PROFILES.map((p) => p.trade)).toEqual([...DEMO_TRADES])
    for (const trade of DEMO_TRADES) expect(demoProfile(trade).trade).toBe(trade)
  })

  it('gives each trade a distinct company and a valid GSTIN for its state', () => {
    const names = DEMO_TRADE_PROFILES.map((p) => p.company.name)
    expect(new Set(names).size).toBe(names.length)
    for (const p of DEMO_TRADE_PROFILES) {
      const check = validateGstin(p.company.gstin!)
      expect(check.valid, `${p.trade} GSTIN`).toBe(true)
      expect(check.stateCode).toBe(p.company.stateCode)
      for (const party of p.parties) expect(validateGstin(party.gstin).valid, party.name).toBe(true)
    }
  })

  it('says on screen what each sample is, in a label and a blurb', () => {
    for (const p of DEMO_TRADE_PROFILES) {
      expect(p.label.length).toBeGreaterThan(0)
      expect(p.blurb.length).toBeGreaterThan(0)
    }
  })

  for (const profile of DEMO_TRADE_PROFILES) {
    describe(profile.trade, () => {
      const vouchers = profile.vouchers(TODAY)

      it('posts a book worth looking at', () => {
        expect(vouchers.length).toBeGreaterThan(10)
      })

      it('every voucher balances: sum(dr) === sum(cr)', () => {
        for (const v of vouchers) {
          const dr = v.lines.filter((l) => l.drCr === 'dr').reduce((s, l) => s + l.amount, 0)
          const cr = v.lines.filter((l) => l.drCr === 'cr').reduce((s, l) => s + l.amount, 0)
          expect(dr, v.narration ?? v.kind).toBe(cr)
        }
      })

      it('is deterministic for a fixed today — the same books twice', () => {
        expect(JSON.stringify(profile.vouchers(TODAY))).toBe(JSON.stringify(vouchers))
      })

      it('comes out sorted by date, inside the demo window', () => {
        const { from, to } = demoWindow(TODAY)
        for (let i = 1; i < vouchers.length; i++) {
          expect(vouchers[i]!.date >= vouchers[i - 1]!.date).toBe(true)
        }
        for (const v of vouchers) {
          expect(v.date >= from).toBe(true)
          expect(v.date <= to).toBe(true)
        }
      })

      it('references only ledgers and items the profile actually creates', () => {
        // Party ledgers, the profile's extra ledgers, and Cash — which db/seed.ts gives every
        // company. A name in none of those is a voucher that will not post.
        const known = new Set([
          ...profile.parties.map((p) => p.name),
          ...profile.extraLedgers.map((l) => l.name),
          'Cash'
        ])
        const items = new Set(profile.items.map((i) => i.name))
        for (const v of vouchers) {
          for (const l of v.lines) expect(known.has(l.ledgerName), l.ledgerName).toBe(true)
          for (const inv of v.inventory ?? []) expect(items.has(inv.itemName), inv.itemName).toBe(true)
        }
      })

      it('closes with the stock it bought, made and sold accounted for', () => {
        // Closing quantity per item is exactly ins minus outs. Not asserted non-negative for
        // every trade: the trading sample has always sold from an assumed shelf rather than
        // buying first, and that is its own (deliberate) shape — see the manufacturing tests
        // below for the trade where consuming before you have it would be a real error.
        const onHand = new Map<string, number>()
        for (const v of vouchers) {
          for (const inv of v.inventory ?? []) {
            onHand.set(inv.itemName, (onHand.get(inv.itemName) ?? 0) + (inv.direction === 'in' ? inv.qtyMilli : -inv.qtyMilli))
          }
        }
        if (profile.items.length === 0) expect(onHand.size).toBe(0)
        for (const [name] of onHand) expect(profile.items.some((i) => i.name === name), name).toBe(true)
      })
    })
  }
})

describe('the services profile', () => {
  it('has no stock items at all, and switches inventory off', () => {
    const svc = demoProfile('services')
    expect(svc.items).toEqual([])
    expect(svc.bom).toEqual([])
    expect(svc.featureOverrides.inventory).toBe(false)
  })

  it('invoices fees with no inventory line anywhere', () => {
    for (const v of demoProfile('services').vouchers('2026-08-15')) {
      expect(v.inventory ?? []).toEqual([])
    }
  })
})

describe('the manufacturing profile', () => {
  const mfg = demoProfile('manufacturing')
  const vouchers = mfg.vouchers('2026-08-15')

  it('carries a work-in-progress stage between raw material and finished goods', () => {
    expect(mfg.items.map((i) => i.name)).toContain('Pulley Housing (WIP)')
  })

  it('has a bill of materials whose every component is a real item', () => {
    const names = new Set(mfg.items.map((i) => i.name))
    expect(mfg.bom.length).toBeGreaterThan(0)
    for (const b of mfg.bom) {
      expect(names.has(b.itemName), b.itemName).toBe(true)
      expect(b.components.length).toBeGreaterThan(0)
      for (const c of b.components) {
        expect(names.has(c.itemName), c.itemName).toBe(true)
        expect(c.qtyMilliPerUnit).toBeGreaterThan(0)
        expect(Number.isInteger(c.qtyMilliPerUnit)).toBe(true)
        expect(c.itemName).not.toBe(b.itemName)
      }
    }
  })

  it('manufactures with stock journals that consume and produce', () => {
    const journals = vouchers.filter((v) => v.kind === 'stock_journal')
    expect(journals.length).toBeGreaterThanOrEqual(2)
    for (const j of journals) {
      expect(j.lines).toEqual([])
      const inv = j.inventory!
      expect(inv.some((l) => l.direction === 'out')).toBe(true)
      expect(inv.filter((l) => l.direction === 'in')).toHaveLength(1)
      // Value is conserved: what leaves the components is exactly what the produced item is
      // worth. Manufacture moves value between stock items and never touches the P&L.
      const out = inv.filter((l) => l.direction === 'out').reduce((s, l) => s + l.amount, 0)
      expect(inv.find((l) => l.direction === 'in')!.amount).toBe(out)
    }
  })

  it('never takes an item below zero — a factory cannot consume what it has not got', () => {
    const onHand = new Map<string, number>()
    for (const v of vouchers) {
      for (const inv of v.inventory ?? []) {
        const next = (onHand.get(inv.itemName) ?? 0) + (inv.direction === 'in' ? inv.qtyMilli : -inv.qtyMilli)
        expect(next, `${inv.itemName} after ${v.date}`).toBeGreaterThanOrEqual(0)
        onHand.set(inv.itemName, next)
      }
    }
    // And what is left on the shelf at the end is the point of the WIP stage being visible.
    expect(onHand.get('Pulley Housing (WIP)')).toBeGreaterThan(0)
  })

  it('never manufactures before the components it consumes were bought or made', () => {
    const firstIn = new Map<string, string>()
    for (const v of vouchers) {
      for (const inv of v.inventory ?? []) {
        if (inv.direction !== 'in') continue
        const seen = firstIn.get(inv.itemName)
        if (seen === undefined || v.date < seen) firstIn.set(inv.itemName, v.date)
      }
    }
    for (const j of vouchers.filter((v) => v.kind === 'stock_journal')) {
      for (const consumed of j.inventory!.filter((l) => l.direction === 'out')) {
        const arrived = firstIn.get(consumed.itemName)
        expect(arrived, `${consumed.itemName} has to arrive before it is consumed`).toBeDefined()
        expect(arrived! <= j.date).toBe(true)
      }
    }
  })
})
