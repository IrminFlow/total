// WP 5.7 review: a draft's reference (AI / MCP / inbox) reaches the saved voucher; on alteration
// the stored reference still rides in `original` untouched.
import { describe, expect, it } from 'vitest'
import { buildAccountingPayload, type AccountingFormState } from './accounting'

const base: AccountingFormState = {
  date: '2025-09-01',
  number: '',
  rows: [
    { drCr: 'dr', ledgerId: 1, amount: 1000, costAllocations: [] },
    { drCr: 'cr', ledgerId: 9, amount: 1000, costAllocations: [] }
  ],
  narration: 'Counter takings',
  instrumentNo: '',
  billRefs: [],
  advanceReceipt: false,
  optional: false,
  tds: null,
  original: null
}

describe('draft reference', () => {
  it('a new voucher from a draft carries its reference and party', () => {
    const r = buildAccountingPayload({ ...base, reference: ' RCPT-77 ' }, { kind: 'receipt', voucherTypeId: 5, derivedPartyId: 9 })
    expect(r.ok && r.payload).toMatchObject({ reference: 'RCPT-77', partyLedgerId: 9, narration: 'Counter takings' })
  })

  it('no draft reference → null', () => {
    const r = buildAccountingPayload(base, { kind: 'receipt', voucherTypeId: 5, derivedPartyId: null })
    expect(r.ok && r.payload.reference).toBeNull()
  })
})
