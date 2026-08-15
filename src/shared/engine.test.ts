import { describe, it, expect } from 'vitest'
import { parseRupees, formatPaise, percentOf, roundToRupee, amountInWords } from './money'
import { fyOf, parseSmartDate, gstPeriodOf, toPortalDate, isValidISODate } from './dates'
import { validateGstin, gstinCheckChar, validateHsn } from './gst/validate'
import { computeGst, supplyTypeFor } from './gst/calc'
import { validateVoucher, type VoucherInput, type LedgerFacts } from './posting'
import { buildGstr1, buildGstr3b, type GstDoc } from './gst/returns'
import { DEFAULT_GROUPS, DEFAULT_VOUCHER_TYPES } from './seed'

describe('money', () => {
  it('parses rupee strings to paise', () => {
    expect(parseRupees('1,234.56')).toBe(123456)
    expect(parseRupees('0.5')).toBe(50)
    expect(parseRupees('100')).toBe(10000)
    expect(parseRupees('-42.07')).toBe(-4207)
    expect(parseRupees('₹ 1,00,000')).toBe(10000000)
    expect(parseRupees('abc')).toBeNull()
    expect(parseRupees('1.234')).toBeNull()
    expect(parseRupees('')).toBeNull()
  })

  it('formats with Indian digit grouping', () => {
    expect(formatPaise(123456)).toBe('1,234.56')
    expect(formatPaise(12345678)).toBe('1,23,456.78')
    expect(formatPaise(1000000000)).toBe('1,00,00,000.00')
    expect(formatPaise(-4207)).toBe('-42.07')
    expect(formatPaise(0, { zeroDash: true })).toBe('–')
    expect(formatPaise(50000, { symbol: true })).toBe('₹500.00')
  })

  it('computes percentages with half-away-from-zero rounding', () => {
    expect(percentOf(10000, 18)).toBe(1800)
    expect(percentOf(9999, 18)).toBe(1800) // 1799.82 -> 1800
    expect(percentOf(101, 0.25)).toBe(0) // 0.2525 -> 0
    expect(percentOf(10050, 9)).toBe(905) // 904.5 rounds up
  })

  it('rounds to whole rupees for invoice round-off', () => {
    expect(roundToRupee(123456)).toBe(123500)
    expect(roundToRupee(123449)).toBe(123400)
    expect(roundToRupee(123450)).toBe(123500)
  })

  it('spells amounts in Indian words', () => {
    expect(amountInWords(10000000)).toBe('One Lakh Rupees Only')
    expect(amountInWords(123456789)).toBe(
      'Twelve Lakh Thirty Four Thousand Five Hundred Sixty Seven Rupees and Eighty Nine Paise Only'
    )
    expect(amountInWords(0)).toBe('Zero Rupees Only')
  })
})

describe('dates', () => {
  it('maps dates to financial years', () => {
    expect(fyOf('2025-04-01').label).toBe('2025-26')
    expect(fyOf('2026-03-31').label).toBe('2025-26')
    expect(fyOf('2026-04-01').label).toBe('2026-27')
  })

  it('parses Tally-style shorthand dates', () => {
    const ctx = '2025-08-15'
    expect(parseSmartDate('7', ctx)).toBe('2025-08-07')
    expect(parseSmartDate('7/4', ctx)).toBe('2025-04-07')
    expect(parseSmartDate('7/2', ctx)).toBe('2026-02-07') // Jan-Mar falls in FY end year
    expect(parseSmartDate('07-04-2025', ctx)).toBe('2025-04-07')
    expect(parseSmartDate('7/4/24', ctx)).toBe('2024-04-07')
    expect(parseSmartDate('y', ctx)).toBe('2025-08-14')
    expect(parseSmartDate('t', ctx)).toBe(ctx)
    expect(parseSmartDate('32', ctx)).toBeNull()
    expect(parseSmartDate('30/2', ctx)).toBeNull()
  })

  it('formats GST portal periods and dates', () => {
    expect(gstPeriodOf('2025-08-15')).toBe('082025')
    expect(toPortalDate('2025-08-15')).toBe('15-08-2025')
  })

  it('rejects impossible calendar dates', () => {
    expect(isValidISODate('2025-02-29')).toBe(false)
    expect(isValidISODate('2024-02-29')).toBe(true)
    expect(isValidISODate('2025-13-01')).toBe(false)
  })
})

describe('GSTIN validation', () => {
  // 27AAPFU0939F1ZV is the well-known valid specimen GSTIN.
  it('accepts a valid GSTIN', () => {
    const r = validateGstin('27AAPFU0939F1ZV')
    expect(r.valid).toBe(true)
    expect(r.stateCode).toBe('27')
  })

  it('computes the check character', () => {
    expect(gstinCheckChar('27AAPFU0939F1Z')).toBe('V')
  })

  it('rejects bad checksums, formats, lengths and state codes', () => {
    expect(validateGstin('27AAPFU0939F1ZW').error).toBe('checksum')
    expect(validateGstin('27AAPFU0939F1Z').error).toBe('length')
    expect(validateGstin('27aapfu0939f1zv').valid).toBe(true) // case-insensitive input
    expect(validateGstin('99AAPFU0939F1ZV').error).toBe('state_code')
    expect(validateGstin('2AAAPFU0939F1ZV').error).toBe('format')
  })

  it('validates HSN codes', () => {
    expect(validateHsn('8471').valid).toBe(true)
    expect(validateHsn('847130').valid).toBe(true)
    expect(validateHsn('84713010').valid).toBe(true)
    expect(validateHsn('847').valid).toBe(false)
    expect(validateHsn('84A1').valid).toBe(false)
  })
})

describe('GST calculation', () => {
  it('splits intra-state supply into CGST + SGST', () => {
    const g = computeGst(100000, 18, 'intra')
    expect(g.cgst).toBe(9000)
    expect(g.sgst).toBe(9000)
    expect(g.igst).toBe(0)
    expect(g.total).toBe(118000)
  })

  it('charges IGST on inter-state supply', () => {
    const g = computeGst(100000, 18, 'inter')
    expect(g.igst).toBe(18000)
    expect(g.cgst).toBe(0)
    expect(g.total).toBe(118000)
  })

  it('handles fractional rates and cess', () => {
    const g = computeGst(1000000, 3, 'intra', 1)
    expect(g.cgst).toBe(15000)
    expect(g.sgst).toBe(15000)
    expect(g.cess).toBe(10000)
    const tiny = computeGst(333, 0.25, 'inter')
    expect(tiny.igst).toBe(1) // 0.8325 -> 1
  })

  it('derives supply type from states', () => {
    expect(supplyTypeFor('27', '27')).toBe('intra')
    expect(supplyTypeFor('27', '29')).toBe('inter')
  })
})

describe('voucher posting rules', () => {
  const facts: Record<number, LedgerFacts> = {
    1: { exists: true, isCashOrBank: true }, // Cash
    2: { exists: true, isCashOrBank: true }, // Bank
    3: { exists: true, isCashOrBank: false }, // Party
    4: { exists: true, isCashOrBank: false } // Sales
  }
  const resolve = (id: number): LedgerFacts => facts[id] ?? { exists: false, isCashOrBank: false }

  const base: VoucherInput = {
    voucherTypeId: 1,
    date: '2025-08-15',
    partyLedgerId: null,
    narration: null,
    reference: null,
    lines: [],
    inventory: []
  }

  it('accepts a balanced journal', () => {
    const v = {
      ...base,
      lines: [
        { ledgerId: 3, drCr: 'dr' as const, amount: 118000 },
        { ledgerId: 4, drCr: 'cr' as const, amount: 118000 }
      ]
    }
    expect(validateVoucher(v, 'journal', resolve)).toEqual([])
  })

  it('rejects unbalanced vouchers', () => {
    const v = {
      ...base,
      lines: [
        { ledgerId: 3, drCr: 'dr' as const, amount: 100000 },
        { ledgerId: 4, drCr: 'cr' as const, amount: 99999 }
      ]
    }
    expect(validateVoucher(v, 'journal', resolve).map((e) => e.code)).toContain('unbalanced')
  })

  it('rejects unknown ledgers, bad amounts, single-line vouchers', () => {
    const v = {
      ...base,
      lines: [{ ledgerId: 99, drCr: 'dr' as const, amount: -5 }]
    }
    const codes = validateVoucher(v, 'journal', resolve).map((e) => e.code)
    expect(codes).toContain('unknown_ledger')
    expect(codes).toContain('bad_amount')
    expect(codes).toContain('too_few_lines')
  })

  it('enforces cash/bank rules per voucher kind', () => {
    const contraBad = {
      ...base,
      lines: [
        { ledgerId: 1, drCr: 'dr' as const, amount: 5000 },
        { ledgerId: 3, drCr: 'cr' as const, amount: 5000 }
      ]
    }
    expect(validateVoucher(contraBad, 'contra', resolve).map((e) => e.code)).toContain('cash_bank_rule')

    const contraGood = {
      ...base,
      lines: [
        { ledgerId: 2, drCr: 'dr' as const, amount: 5000 },
        { ledgerId: 1, drCr: 'cr' as const, amount: 5000 }
      ]
    }
    expect(validateVoucher(contraGood, 'contra', resolve)).toEqual([])

    const paymentBad = {
      ...base,
      lines: [
        { ledgerId: 3, drCr: 'dr' as const, amount: 5000 },
        { ledgerId: 4, drCr: 'cr' as const, amount: 5000 }
      ]
    }
    expect(validateVoucher(paymentBad, 'payment', resolve).map((e) => e.code)).toContain('cash_bank_rule')

    const receiptGood = {
      ...base,
      lines: [
        { ledgerId: 1, drCr: 'dr' as const, amount: 5000 },
        { ledgerId: 3, drCr: 'cr' as const, amount: 5000 }
      ]
    }
    expect(validateVoucher(receiptGood, 'receipt', resolve)).toEqual([])
  })

  it('requires a party ledger when billRefs are given', () => {
    const v = {
      ...base,
      lines: [
        { ledgerId: 3, drCr: 'dr' as const, amount: 5000 },
        { ledgerId: 4, drCr: 'cr' as const, amount: 5000 }
      ],
      billRefs: [{ kind: 'new' as const, name: 'INV-1', amount: 5000, dueDate: null }]
    }
    expect(validateVoucher(v, 'journal', resolve).map((e) => e.code)).toContain('bill_refs_no_party')
  })

  it('requires billRefs to sum to the party ledger line amount', () => {
    const v = {
      ...base,
      partyLedgerId: 3,
      lines: [
        { ledgerId: 3, drCr: 'dr' as const, amount: 5000 },
        { ledgerId: 4, drCr: 'cr' as const, amount: 5000 }
      ],
      billRefs: [{ kind: 'new' as const, name: 'INV-1', amount: 4000, dueDate: null }]
    }
    expect(validateVoucher(v, 'journal', resolve).map((e) => e.code)).toContain('bill_refs_mismatch')
  })

  it('accepts billRefs summing to the party ledger line amount', () => {
    const v = {
      ...base,
      partyLedgerId: 3,
      lines: [
        { ledgerId: 3, drCr: 'dr' as const, amount: 5000 },
        { ledgerId: 4, drCr: 'cr' as const, amount: 5000 }
      ],
      billRefs: [
        { kind: 'new' as const, name: 'INV-1', amount: 3000, dueDate: null },
        { kind: 'against' as const, name: 'INV-0', amount: 2000, dueDate: '2025-09-01' }
      ]
    }
    expect(validateVoucher(v, 'journal', resolve)).toEqual([])
  })

  it('flags a bill_refs_mismatch when there is no line on the party ledger at all', () => {
    const v = {
      ...base,
      partyLedgerId: 3,
      lines: [
        { ledgerId: 1, drCr: 'dr' as const, amount: 5000 },
        { ledgerId: 4, drCr: 'cr' as const, amount: 5000 }
      ],
      billRefs: [{ kind: 'new' as const, name: 'INV-1', amount: 5000, dueDate: null }]
    }
    expect(validateVoucher(v, 'journal', resolve).map((e) => e.code)).toContain('bill_refs_mismatch')
  })

  it('flags cost allocations exceeding the line amount, tagged with the line index', () => {
    const v = {
      ...base,
      lines: [
        { ledgerId: 3, drCr: 'dr' as const, amount: 5000, costAllocations: [{ costCentreId: 1, amount: 6000 }] },
        { ledgerId: 4, drCr: 'cr' as const, amount: 5000 }
      ]
    }
    const errors = validateVoucher(v, 'journal', resolve)
    const err = errors.find((e) => e.code === 'over_allocated')
    expect(err).toBeDefined()
    expect(err!.line).toBe(0)
  })

  it('accepts cost allocations that sum to at most the line amount', () => {
    const v = {
      ...base,
      lines: [
        {
          ledgerId: 3,
          drCr: 'dr' as const,
          amount: 5000,
          costAllocations: [
            { costCentreId: 1, amount: 2000 },
            { costCentreId: 2, amount: 3000 }
          ]
        },
        { ledgerId: 4, drCr: 'cr' as const, amount: 5000 }
      ]
    }
    expect(validateVoucher(v, 'journal', resolve)).toEqual([])
  })
})

describe('seed data', () => {
  it('has Tally\'s 28 default groups with valid parents', () => {
    expect(DEFAULT_GROUPS.length).toBe(28)
    const names = new Set(DEFAULT_GROUPS.map((g) => g.name))
    expect(names.size).toBe(28)
    for (const g of DEFAULT_GROUPS) {
      if (g.parent) expect(names.has(g.parent)).toBe(true)
    }
  })

  it('has the 10 core voucher types', () => {
    expect(DEFAULT_VOUCHER_TYPES.length).toBe(10)
  })
})

describe('GSTR-1 builder', () => {
  const b2bDoc: GstDoc = {
    voucherId: 1,
    kind: 'sales',
    date: '2025-08-05',
    number: 'S/1',
    partyName: 'Umbrella Traders',
    partyGstin: '27AAPFU0939F1ZV',
    pos: '27',
    invoiceValue: 118000,
    items: [{ rate: 18, taxable: 100000, cgst: 9000, sgst: 9000, igst: 0, cess: 0 }],
    hsnLines: [
      { hsn: '8471', description: 'Laptops', uqc: 'NOS', qtyMilli: 2000, rate: 18, taxable: 100000, cgst: 9000, sgst: 9000, igst: 0, cess: 0 }
    ]
  }
  const b2csDoc: GstDoc = {
    voucherId: 2,
    kind: 'sales',
    date: '2025-08-07',
    number: 'S/2',
    partyName: null,
    partyGstin: null,
    pos: '27',
    invoiceValue: 59000,
    items: [{ rate: 18, taxable: 50000, cgst: 4500, sgst: 4500, igst: 0, cess: 0 }],
    hsnLines: []
  }
  const b2clDoc: GstDoc = {
    voucherId: 3,
    kind: 'sales',
    date: '2025-08-09',
    number: 'S/3',
    partyName: 'Cash buyer',
    partyGstin: null,
    pos: '29',
    invoiceValue: 23_600_000, // ₹2,36,000 > ₹1,00,000 threshold, inter-state
    items: [{ rate: 18, taxable: 20_000_000, cgst: 0, sgst: 0, igst: 3_600_000, cess: 0 }],
    hsnLines: []
  }

  it('routes documents into the right sections', () => {
    const r = buildGstr1([b2bDoc, b2csDoc, b2clDoc], '27AAPFU0939F1ZV', '27', '082025')
    const json = r.json as any
    expect(json.b2b).toHaveLength(1)
    expect(json.b2b[0].ctin).toBe('27AAPFU0939F1ZV')
    expect(json.b2b[0].inv[0].inum).toBe('S/1')
    expect(json.b2b[0].inv[0].idt).toBe('05-08-2025')
    expect(json.b2b[0].inv[0].val).toBe(1180)
    expect(json.b2b[0].inv[0].itms[0].itm_det).toEqual({ rt: 18, txval: 1000, camt: 90, samt: 90, csamt: 0 })
    expect(json.b2cl[0].pos).toBe('29')
    expect(json.b2cs[0]).toMatchObject({ sply_ty: 'INTRA', pos: '27', rt: 18, txval: 500 })
    expect(json.hsn.data[0]).toMatchObject({ hsn_sc: '8471', uqc: 'NOS', qty: 2, txval: 1000 })
  })

  it('aggregates b2cs by pos + rate and nets credit notes in hsn', () => {
    const cn: GstDoc = {
      ...b2bDoc,
      voucherId: 4,
      kind: 'credit_note',
      number: 'CN/1',
      hsnLines: [{ ...b2bDoc.hsnLines[0]!, taxable: 20000, cgst: 1800, sgst: 1800, qtyMilli: 500 }]
    }
    const r = buildGstr1([b2bDoc, cn], '27AAPFU0939F1ZV', '27', '082025')
    const json = r.json as any
    expect(json.cdnr[0].nt[0].ntty).toBe('C')
    expect(json.hsn.data[0].txval).toBe(800) // 1000 - 200
    expect(json.hsn.data[0].qty).toBe(1.5)
  })
})

describe('GSTR-3B builder', () => {
  it('computes outward tax, ITC and net payable', () => {
    const docs: GstDoc[] = [
      {
        voucherId: 1, kind: 'sales', date: '2025-08-05', number: 'S/1',
        partyName: null, partyGstin: null, pos: '27', invoiceValue: 118000,
        items: [{ rate: 18, taxable: 100000, cgst: 9000, sgst: 9000, igst: 0, cess: 0 }],
        hsnLines: []
      },
      {
        voucherId: 2, kind: 'credit_note', date: '2025-08-10', number: 'CN/1',
        partyName: null, partyGstin: null, pos: '27', invoiceValue: 11800,
        items: [{ rate: 18, taxable: 10000, cgst: 900, sgst: 900, igst: 0, cess: 0 }],
        hsnLines: []
      },
      {
        voucherId: 3, kind: 'sales', date: '2025-08-12', number: 'S/2',
        partyName: null, partyGstin: null, pos: '27', invoiceValue: 5000,
        items: [{ rate: 0, taxable: 5000, cgst: 0, sgst: 0, igst: 0, cess: 0 }],
        hsnLines: []
      }
    ]
    const r = buildGstr3b(docs, { igst: 0, cgst: 5000, sgst: 5000, cess: 0 }, '27AAPFU0939F1ZV', '082025')
    expect(r.outward.taxable).toBe(90000)
    expect(r.outward.cgst).toBe(8100)
    expect(r.nilExempt.taxable).toBe(5000)
    expect(r.netPayable.cgst).toBe(3100)
    expect(r.netPayable.sgst).toBe(3100)
    const json = r.json as any
    expect(json.sup_details.osup_det.txval).toBe(900)
    expect(json.itc_elg.itc_net.camt).toBe(50)
  })
})
