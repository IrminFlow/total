import { describe, expect, it } from 'vitest'
import { buildWorklist, imsKey, suggestAction } from './ims'
import type { Recon2bPair, PortalInvoice, PurchaseDoc } from './recon2b'

const portal = (over: Partial<PortalInvoice> = {}): PortalInvoice => ({
  gstin: '27AAPFU0939F1ZV',
  number: 'INV-1',
  date: '2026-05-04',
  value: 1_18_000_00,
  taxable: 1_00_000_00,
  igst: 0,
  cgst: 9_000_00,
  sgst: 9_000_00,
  cess: 0,
  kind: 'b2b',
  supplierName: 'Acme',
  ...over
})

const book = (over: Partial<PurchaseDoc> = {}): PurchaseDoc => ({
  voucherId: 7,
  kind: 'purchase',
  date: '2026-05-04',
  number: 'PUR-1',
  supplierRef: 'INV-1',
  partyName: 'Acme',
  partyGstin: '27AAPFU0939F1ZV',
  invoiceValue: 1_18_000_00,
  taxable: 1_00_000_00,
  igst: 0,
  cgst: 9_000_00,
  sgst: 9_000_00,
  cess: 0,
  ...over
})

const pair = (over: Partial<Recon2bPair>): Recon2bPair => ({
  bucket: 'matched',
  portal: portal(),
  book: book(),
  valueDiffPaise: 0,
  taxDiffPaise: null,
  ...over
})

describe('suggestAction', () => {
  it('accepts only what both sides agree about', () => {
    expect(suggestAction('matched')).toMatchObject({ action: 'accept', confidence: 'clear' })
  })

  it('never suggests accepting a document the books have never seen', () => {
    // Deemed acceptance is the trap: left alone, this becomes credit for a bill nobody holds.
    const s = suggestAction('missingInBooks')
    expect(s.action).toBe('pending')
    expect(s.reason).toContain('deemed accepted')
  })

  it('flags a GSTIN mismatch as credit claimed against the wrong registration', () => {
    expect(suggestAction('gstinMismatch').reason).toContain('wrong registration')
  })

  it('has an opinion about every bucket', () => {
    for (const bucket of ['matched', 'amountMismatch', 'taxMismatch', 'gstinMismatch', 'missingInBooks', 'missingInPortal'] as const) {
      expect(suggestAction(bucket).action).toBeTruthy()
    }
  })
})

describe('imsKey', () => {
  it('ignores punctuation and case in the document number', () => {
    expect(imsKey('27AAPFU0939F1ZV', 'inv-1')).toBe(imsKey('27aapfu0939f1zv', 'INV/1'))
  })

  it('gives a supplier with no GSTIN a stable key of its own', () => {
    expect(imsKey(null, 'INV-1')).toBe('NOGSTIN|INV1')
  })
})

describe('buildWorklist', () => {
  it('is empty and undecided-free for a period with no documents', () => {
    const w = buildWorklist([], '052026', new Map())
    expect(w.rows).toEqual([])
    expect(w.undecided).toBe(0)
    expect(w.atRisk).toEqual({ igst: 0, cgst: 0, sgst: 0, cess: 0 })
  })

  it('counts every untouched row as undecided, because that is what is at stake', () => {
    const w = buildWorklist([pair({}), pair({ bucket: 'missingInBooks', book: null })], '052026', new Map())
    expect(w.undecided).toBe(2)
  })

  it('carries a decision across a fresh 2B download', () => {
    // The user works through twelve invoices, downloads a new 2B, and must not be shown the same
    // twelve again.
    const decided = new Map([[imsKey('27AAPFU0939F1ZV', 'INV-1'), { action: 'accept' as const, note: null, at: '2026-06-01' }]])
    const w = buildWorklist([pair({})], '052026', decided)
    expect(w.rows[0]!.action).toBe('accept')
    expect(w.undecided).toBe(0)
    expect(w.counts.accept).toBe(1)
  })

  it('totals the tax on everything it did not suggest accepting', () => {
    const w = buildWorklist([pair({}), pair({ bucket: 'missingInBooks', book: null })], '052026', new Map())
    expect(w.atRisk.cgst).toBe(9_000_00)
  })

  it('puts the undecided work first and the settled rows last', () => {
    const decided = new Map([[imsKey('27AAPFU0939F1ZV', 'INV-1'), { action: 'accept' as const, note: null, at: '2026-06-01' }]])
    const other = pair({ bucket: 'amountMismatch', portal: portal({ number: 'INV-2' }), book: book({ supplierRef: 'INV-2' }) })
    const w = buildWorklist([pair({}), other], '052026', decided)
    expect(w.rows[0]!.number).toBe('INV-2')
  })

  it('builds a row for a document with no voucher behind it', () => {
    const w = buildWorklist([pair({ bucket: 'missingInBooks', book: null })], '052026', new Map())
    expect(w.rows[0]!.voucherId).toBeNull()
    expect(w.rows[0]!.supplierName).toBe('Acme')
  })

  it('builds a row for a book document the portal has never heard of', () => {
    const w = buildWorklist([pair({ bucket: 'missingInPortal', portal: null })], '052026', new Map())
    expect(w.rows[0]!.number).toBe('INV-1') // the supplier's reference from the voucher
    expect(w.rows[0]!.suggestion.reason).toContain('Chase the supplier')
  })
})
