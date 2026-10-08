// Tax ledgers by purpose: with both "CGST Input" and "CGST Output" present, sales-side vouchers
// post to Output and purchase-side to Input — never simply the first ledger by name.
import { describe, expect, it } from 'vitest'
import { pickTaxLedger, taxLedgerIdsFrom, taxSideOf, voucherTaxLedgers } from './invoice'

const L = (id: number, name: string, taxType: string | null) => ({ id, name, taxType })
const BOTH = [L(1, 'CGST Input', 'cgst'), L(2, 'CGST Output', 'cgst'), L(3, 'IGST Input', 'igst'), L(4, 'IGST Output', 'igst'), L(5, 'Round Off', null), L(6, 'SGST ITC', 'sgst'), L(7, 'SGST Payable', 'sgst')]

describe('tax ledgers by purpose', () => {
  it('side of each trading kind', () => {
    expect(taxSideOf('sales')).toBe('output')
    expect(taxSideOf('credit_note')).toBe('output')
    expect(taxSideOf('purchase')).toBe('input')
    expect(taxSideOf('debit_note')).toBe('input')
  })

  it('picks the ledger named for the side; falls back to one not named for the other side, then the first', () => {
    expect(taxLedgerIdsFrom(BOTH, 'output')).toEqual({ cgst: 2, sgst: 7, igst: 4, cess: null, roundOff: 5 })
    expect(taxLedgerIdsFrom(BOTH, 'input')).toEqual({ cgst: 1, sgst: 6, igst: 3, cess: null, roundOff: 5 })
    expect(pickTaxLedger([L(1, 'CGST Input', 'cgst'), L(2, 'CGST', 'cgst')], 'cgst', 'output')).toBe(2)
    expect(pickTaxLedger([L(1, 'CGST Input', 'cgst')], 'cgst', 'output')).toBe(1)
    expect(pickTaxLedger([L(1, 'CGST', 'cgst')], 'cgst', 'input')).toBe(1)
    expect(pickTaxLedger([], 'cess', 'input')).toBeNull()
    // Default side stays output (single-ledger companies are unaffected).
    expect(taxLedgerIdsFrom([L(9, 'CGST', 'cgst')])).toMatchObject({ cgst: 9 })
  })

  it('a saved voucher keeps the tax ledgers it posted to', () => {
    const v = { lines: [{ ledgerId: 1 }, { ledgerId: 6 }] } as never
    expect(voucherTaxLedgers(v, BOTH, 'output')).toEqual({ cgst: 1, sgst: 6, igst: 4, cess: null, roundOff: 5 })
  })
})
