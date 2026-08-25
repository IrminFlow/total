import { describe, it, expect } from 'vitest'
import { buildInvoiceShare } from './invoiceShare'

const INV = { number: 'INV/26-27/001', date: '2026-04-10', totalPaise: 1_18_000 }
const PARTY = { name: 'Ravi Stores', phone: '98765 43210', email: 'ravi@example.com' }

describe('buildInvoiceShare (I-193/I-192 — the app fills the message in, a person sends it)', () => {
  it('puts the number, date and amount in the body, not just "please find attached"', () => {
    const share = buildInvoiceShare('Counter Traders', INV, PARTY)
    expect(share.body).toContain('INV/26-27/001')
    expect(share.body).toContain('10-Apr-26')
    expect(share.body).toContain('1,180.00')
  })

  it('builds a wa.me link from a number WhatsApp can use', () => {
    const share = buildInvoiceShare('Counter Traders', INV, PARTY)
    expect(share.whatsapp).toContain('https://wa.me/919876543210')
  })

  it('returns a null WhatsApp link when the party has no phone, so the UI can say why', () => {
    const share = buildInvoiceShare('Counter Traders', INV, { ...PARTY, phone: null })
    expect(share.whatsapp).toBeNull()
  })

  it('returns a null WhatsApp link for a number that is not dialable, rather than a broken link', () => {
    const share = buildInvoiceShare('Counter Traders', INV, { ...PARTY, phone: '12' })
    expect(share.whatsapp).toBeNull()
  })

  it('still builds a mailto for a party with no email address — an empty compose window beats none', () => {
    const share = buildInvoiceShare('Counter Traders', INV, { ...PARTY, email: null })
    expect(share.mailto.startsWith('mailto:?')).toBe(true)
  })

  it('url-encodes the body so a newline or an ampersand cannot truncate the link', () => {
    const share = buildInvoiceShare('Ram & Co', INV, PARTY)
    expect(share.whatsapp).not.toContain('\n')
    expect(share.mailto).toContain('%26')
  })

  it('calls a credit note a credit note, and never says an amount is due on one', () => {
    const share = buildInvoiceShare('Counter Traders', { ...INV, kind: 'credit_note' }, PARTY)
    expect(share.subject).toContain('credit note')
    expect(share.body).toContain('credit note')
  })

  it('calls a proforma a proforma, because it is not a demand for payment', () => {
    const share = buildInvoiceShare('Counter Traders', { ...INV, kind: 'proforma' }, PARTY)
    expect(share.subject).toContain('proforma invoice')
  })

  it('tells the user the PDF has to be pasted, because a wa.me link cannot carry one', () => {
    const share = buildInvoiceShare('Counter Traders', INV, PARTY, { pdfFileName: 'invoice-1.pdf' })
    expect(share.attachmentHint).toContain('invoice-1.pdf')
    expect(share.attachmentHint).toContain('paste')
  })

  it('honours a non-Indian default country code rather than assuming 91', () => {
    const share = buildInvoiceShare('Counter Traders', INV, { ...PARTY, phone: '7700900123' }, {
      defaultCountryCode: '44'
    })
    expect(share.whatsapp).toContain('/447700900123')
  })
})
