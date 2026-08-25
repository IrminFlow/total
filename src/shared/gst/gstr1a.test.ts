import { describe, expect, it } from 'vitest'
import { amendmentWindow, diffGstr1 } from './gstr1a'
import type { GstDoc } from './returns'

const doc = (over: Partial<GstDoc> = {}): GstDoc => ({
  voucherId: 1,
  kind: 'sales',
  date: '2026-05-04',
  number: 'INV-1',
  partyName: 'Acme',
  partyGstin: '27AAPFU0939F1ZV',
  pos: '27',
  invoiceValue: 1_18_000_00,
  items: [{ rate: 18, taxable: 1_00_000_00, cgst: 9_000_00, sgst: 9_000_00, igst: 0, cess: 0 }],
  hsnLines: [],
  ...over
})

describe('diffGstr1', () => {
  it('reports a clean return when the books still match what was filed', () => {
    const result = diffGstr1([doc()], [doc()], '052026')
    expect(result.clean).toBe(true)
    expect(result.rows).toEqual([])
  })

  it('is clean for a period in which nothing was ever filed and nothing exists', () => {
    expect(diffGstr1([], [], '052026').clean).toBe(true)
  })

  it('reports an invoice added since filing', () => {
    const result = diffGstr1([], [doc()], '052026')
    expect(result.rows[0]!.change).toBe('added')
    expect(result.rows[0]!.delta.taxable).toBe(1_00_000_00)
    expect(result.net.igst + result.net.cgst + result.net.sgst).toBe(18_000_00)
  })

  it('reports an invoice that has left the books', () => {
    const result = diffGstr1([doc()], [], '052026')
    expect(result.rows[0]!.change).toBe('removed')
    // The delta is negative: less tax is payable than was filed.
    expect(result.rows[0]!.delta.taxable).toBe(-1_00_000_00)
  })

  it('reports a value change as an amendment, with the difference', () => {
    const filed = doc()
    const amended = doc({
      invoiceValue: 2_36_000_00,
      items: [{ rate: 18, taxable: 2_00_000_00, cgst: 18_000_00, sgst: 18_000_00, igst: 0, cess: 0 }]
    })
    const result = diffGstr1([filed], [amended], '052026')
    expect(result.rows[0]!.change).toBe('amended')
    expect(result.rows[0]!.delta.taxable).toBe(1_00_000_00)
    expect(result.rows[0]!.reasons.join(' ')).toContain('Taxable value changed')
  })

  it('singles out a changed recipient GSTIN, which GSTR-1A cannot carry', () => {
    // The counter-party of a filed invoice is not amendable. Calling this an amendment would send
    // the user to a form that rejects it.
    const result = diffGstr1([doc()], [doc({ partyGstin: '29AAPFU0939F1ZV' })], '052026')
    expect(result.rows[0]!.change).toBe('counterPartyChanged')
    expect(result.notAmendable).toHaveLength(1)
    expect(result.rows[0]!.reasons.join(' ')).toContain('credit note')
  })

  it('handles a supplier with no GSTIN on either side without inventing a change', () => {
    const b2c = doc({ partyGstin: null })
    expect(diffGstr1([b2c], [b2c], '052026').clean).toBe(true)
  })

  it('reports a date or place-of-supply move even when the money did not change', () => {
    const result = diffGstr1([doc()], [doc({ date: '2026-05-06', pos: '29' })], '052026')
    expect(result.rows[0]!.change).toBe('amended')
    expect(result.rows[0]!.reasons).toHaveLength(2)
    expect(result.rows[0]!.delta.taxable).toBe(0)
  })

  it('matches on number and kind, so a re-keyed voucher is one amendment and not two', () => {
    // The portal knows the invoice number. Matching on voucher id would report a deleted and
    // re-entered invoice as a deletion plus an addition.
    const result = diffGstr1([doc({ voucherId: 1 })], [doc({ voucherId: 99 })], '052026')
    expect(result.clean).toBe(true)
  })

  it('does not match a credit note against an invoice of the same number', () => {
    const result = diffGstr1([doc()], [doc({ kind: 'credit_note' })], '052026')
    expect(result.rows.map((r) => r.change).sort()).toEqual(['added', 'removed'])
  })
})

describe('amendmentWindow', () => {
  it('is shut before GSTR-1 is filed — there is nothing to amend', () => {
    expect(amendmentWindow({ gstr1FiledAt: null, gstr3bFiledAt: null }).open).toBe(false)
  })

  it('is open between GSTR-1 and GSTR-3B', () => {
    expect(amendmentWindow({ gstr1FiledAt: '2026-06-11', gstr3bFiledAt: null }).open).toBe(true)
  })

  it('shuts once GSTR-3B is filed', () => {
    const w = amendmentWindow({ gstr1FiledAt: '2026-06-11', gstr3bFiledAt: '2026-06-20' })
    expect(w.open).toBe(false)
    expect(w.reason).toContain('amendment tables')
  })

  it('never claims to be verified', () => {
    expect(amendmentWindow({ gstr1FiledAt: null, gstr3bFiledAt: null }).unverified).toBe(true)
  })
})
