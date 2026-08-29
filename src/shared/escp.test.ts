import { describe, it, expect } from 'vitest'
import {
  CMD,
  EscpDoc,
  ESC,
  FF,
  characterTable,
  fit,
  formLengthInches,
  formLengthLines,
  renderInvoiceEscp,
  row,
  skipPerforation,
  wrap,
  type EscpInvoice
} from './escp'

describe('the escape sequences', () => {
  it('are the documented ESC/P bytes', () => {
    expect([...CMD.init]).toEqual([0x1b, 0x40])
    expect([...CMD.boldOn]).toEqual([0x1b, 0x45])
    expect([...CMD.boldOff]).toEqual([0x1b, 0x46])
    expect([...CMD.condensedOn]).toEqual([0x0f])
    expect([...CMD.condensedOff]).toEqual([0x12])
    expect([...CMD.lineSpacing8]).toEqual([0x1b, 0x30])
  })

  it('encodes form length both ways the printer accepts', () => {
    expect(formLengthLines(66)).toEqual([ESC, 0x43, 66])
    expect(formLengthInches(12)).toEqual([ESC, 0x43, 0x00, 12])
    expect(skipPerforation(6)).toEqual([ESC, 0x4e, 6])
    expect(characterTable(1)).toEqual([ESC, 0x74, 1])
  })

  it('refuses a form length the printer cannot hold', () => {
    expect(() => formLengthLines(0)).toThrow('1–127')
    expect(() => formLengthInches(30)).toThrow('1–22')
  })
})

describe('the byte stream', () => {
  it('ends a line with CR LF, which is what the printer advances on', () => {
    const d = new EscpDoc(20).line('AB')
    expect([...d.toBytes()]).toEqual([0x41, 0x42, 0x0d, 0x0a])
  })

  it('wraps bold text in its on and off sequences', () => {
    const d = new EscpDoc(20).bold('A')
    expect([...d.toBytes()]).toEqual([0x1b, 0x45, 0x41, 0x1b, 0x46])
  })

  it('turns a rupee sign into Rs., because no ESC/P character table has one', () => {
    expect(new EscpDoc(20).text('₹100').toDebugString()).toBe('Rs.100')
  })

  it('replaces anything else it cannot print rather than inventing a glyph', () => {
    expect(new EscpDoc(20).text('क').toDebugString()).toBe('?')
  })

  it('every byte is a byte', () => {
    for (const b of new EscpDoc(40).line('Test — ₹1,234.56').toBytes()) {
      expect(b).toBeGreaterThanOrEqual(0)
      expect(b).toBeLessThanOrEqual(255)
    }
  })
})

describe('fixed-width layout', () => {
  it('pads and truncates to exactly the column width', () => {
    expect(fit('ab', 5)).toBe('ab   ')
    expect(fit('ab', 5, 'right')).toBe('   ab')
    expect(fit('abcdefgh', 5)).toBe('abcde')
  })

  it('a row is always exactly as wide as its columns plus the separators', () => {
    const cols = [{ width: 10 }, { width: 6, align: 'right' as const }]
    expect(row(['a very long description', '1'], cols)).toHaveLength(17)
  })

  it('wraps on words, and breaks a word too long to fit', () => {
    expect(wrap('one two three', 7)).toEqual(['one two', 'three'])
    expect(wrap('abcdefghij', 4)).toEqual(['abcd', 'efgh', 'ij'])
  })

  it('never returns nothing for an empty description', () => {
    expect(wrap('', 10)).toEqual([''])
  })
})

const invoice: EscpInvoice = {
  companyName: 'Demo Traders',
  companyAddress: ['12 MG Road', 'Pune 411001'],
  gstin: '27AAPFU0939F1ZV',
  title: 'TAX INVOICE',
  number: 'SV-0001',
  date: '01-04-2026',
  partyName: 'Kumar Stores',
  partyAddress: ['Shivaji Nagar'],
  partyGstin: '27AAACR5055K1Z5',
  lines: [
    { description: 'Parle-G Biscuit 200g packet, carton of forty-eight', hsn: '1905', qty: '10', rate: '100.00', amount: '1,000.00' },
    { description: 'Sugar', hsn: '1701', qty: '2.5', rate: '48.00', amount: '120.00' }
  ],
  totals: [
    { label: 'Taxable', value: '1,120.00' },
    { label: 'CGST', value: '100.80' },
    { label: 'SGST', value: '100.80' }
  ],
  grandTotalLabel: 'TOTAL',
  grandTotalValue: '1,321.60',
  amountInWords: 'Rupees One Thousand Three Hundred Twenty One and Sixty Paise only',
  footer: ['E. & O.E.', 'For Demo Traders']
}

describe('an invoice on continuous stationery', () => {
  it('starts by resetting the printer and ends by resetting it again', () => {
    const bytes = [...renderInvoiceEscp(invoice)]
    expect(bytes.slice(0, 2)).toEqual([0x1b, 0x40])
    expect(bytes.slice(-2)).toEqual([0x1b, 0x40])
  })

  it('ejects the form after every copy, so the next invoice starts at the top of one', () => {
    const copies = ['ORIGINAL FOR RECIPIENT', 'DUPLICATE FOR TRANSPORTER', 'TRIPLICATE FOR SUPPLIER']
    const bytes = [...renderInvoiceEscp(invoice, { copies })]
    expect(bytes.filter((b) => b === FF)).toHaveLength(3)
  })

  it('marks each copy, because rule 46 requires it', () => {
    const doc = new TextDecoder('latin1').decode(renderInvoiceEscp(invoice, { copies: ['ORIGINAL FOR RECIPIENT', 'DUPLICATE FOR TRANSPORTER'] }))
    expect(doc).toContain('ORIGINAL FOR RECIPIENT')
    expect(doc).toContain('DUPLICATE FOR TRANSPORTER')
  })

  it('keeps every printable line inside the paper width', () => {
    const text = new TextDecoder('latin1').decode(renderInvoiceEscp(invoice, { width: 80 }))
    // Strip escape sequences before measuring: they take no columns on the paper. The
    // parameterised commands are stripped with their parameter, the rest without one — a
    // catch-all that swallows one byte either way eats the CR after ESC F and joins two lines.
    const stripped = text
      .replace(/\x1b[WxCN][\s\S]/g, '')
      .replace(/\x1b[@EFPM0123]/g, '')
      .replace(/[\x0f\x12\x0c]/g, '')
    for (const l of stripped.split('\r\n')) expect(l.length).toBeLessThanOrEqual(80)
  })

  it('wraps a long description onto its own continuation line rather than pushing the columns out', () => {
    const text = new TextDecoder('latin1').decode(renderInvoiceEscp(invoice, { width: 80 }))
    expect(text).toContain('1,000.00')
    expect(text).toContain('forty-eight')
  })

  it('skips the letterhead when the stationery already has one printed on it', () => {
    const text = new TextDecoder('latin1').decode(renderInvoiceEscp(invoice, { preprintedHeader: true }))
    expect(text).not.toContain('12 MG Road')
    expect(text).toContain('SV-0001')
  })

  it('turns condensed print off again at the end of the job', () => {
    const bytes = [...renderInvoiceEscp(invoice, { condensed: true, width: 132 })]
    expect(bytes).toContain(0x0f)
    expect(bytes).toContain(0x12)
  })
})
