import { describe, expect, it } from 'vitest'
import { assignAliases, createPseudonymiser, maskIdentifiers, mapStrings, outboundText, inboundText, aliasFor } from './privacy'

describe('maskIdentifiers', () => {
  it('masks GSTINs, keeping only the last three characters', () => {
    expect(maskIdentifiers('Party GSTIN 27AAPFU0939F1ZV here')).toBe('Party GSTIN [GSTIN …1ZV] here')
    expect(maskIdentifiers('29ABCDE1234F2Z5,07ABCDE1234F1Z9')).toBe('[GSTIN …2Z5],[GSTIN …1Z9]')
  })

  it('masks PANs (and does not double-mask the PAN inside a GSTIN)', () => {
    expect(maskIdentifiers('PAN ABCDE1234F')).toBe('PAN [PAN …4F]')
    expect(maskIdentifiers('27ABCDE1234F1Z5')).not.toContain('PAN')
  })

  it('masks IFSC codes and bank account numbers', () => {
    expect(maskIdentifiers('IFSC HDFC0001234 a/c 50100123456789')).toBe('IFSC [IFSC HDFC…] a/c [A/c …6789]')
    expect(maskIdentifiers('account 123456789')).toBe('account [A/c …6789]')
  })

  it('leaves amounts, dates, short numbers and ids alone', () => {
    const s = 'Sales ₹1,23,45,678.00 on 2025-07-31, voucher 1234567, qty 3.500, 100000000.00 paid'
    expect(maskIdentifiers(s)).toBe(s)
  })

  it('masks lower-case identifiers, 8-digit and space-grouped account numbers', () => {
    expect(maskIdentifiers('gstin 27aapfu0939f1zv pan abcde1234f ifsc hdfc0001234')).toBe('gstin [GSTIN …1zv] pan [PAN …4f] ifsc [IFSC hdfc…]')
    expect(maskIdentifiers('a/c 12345678')).toBe('a/c [A/c …5678]')
    expect(maskIdentifiers('a/c 5010 0123 4567 89 at HDFC')).toBe('a/c [A/c …6789] at HDFC')
    expect(maskIdentifiers('dated 2025-07-31 and 2025 07')).toBe('dated 2025-07-31 and 2025 07')
  })

  it('applies inside JSON-like values via mapStrings, leaving keys and numbers', () => {
    const v = { gstin: '27AAPFU0939F1ZV', rows: [{ pan: 'ABCDE1234F', id: 5 }], n: 1 }
    expect(mapStrings(v, maskIdentifiers)).toEqual({ gstin: '[GSTIN …1ZV]', rows: [{ pan: '[PAN …4F]', id: 5 }], n: 1 })
  })
})

describe('pseudonyms', () => {
  it('assigns stable aliases after the highest one in use, in id order', () => {
    const existing = new Map([[7, 'Party-0003']])
    expect(assignAliases(existing, [9, 7, 2])).toEqual([
      { ledgerId: 2, alias: 'Party-0004' },
      { ledgerId: 9, alias: 'Party-0005' }
    ])
    expect(assignAliases(new Map(), [1])).toEqual([{ ledgerId: 1, alias: aliasFor(1) }])
  })

  const p = createPseudonymiser([
    { name: 'Acme Traders', alias: 'Party-0001' },
    { name: 'Acme Traders (Pune)', alias: 'Party-0002' },
    { name: 'Raj & Co.', alias: 'Party-0003' },
    { name: 'AB', alias: 'Party-0004' }
  ])

  it('replaces whole names, longest first, case-insensitively', () => {
    expect(p.outbound('Paid Acme Traders (Pune) and acme traders.')).toBe('Paid Party-0002 and Party-0001.')
    expect(p.outbound('Raj & Co. owes')).toBe('Party-0003 owes')
  })

  it('does not replace inside longer words or very short names', () => {
    expect(p.outbound('Acme Tradersville')).toBe('Acme Tradersville')
    expect(p.outbound('AB testing')).toBe('AB testing')
  })

  it('replaces an unambiguous partial name (word prefix) too', () => {
    const q = createPseudonymiser([
      { name: 'Sharma Steel Works', alias: 'Party-0001' },
      { name: 'Mehta Bros', alias: 'Party-0002' },
      { name: 'Mehta Industries', alias: 'Party-0003' }
    ])
    expect(q.outbound('Sharma Steel paid; Sharma owes; Mehta is ambiguous')).toBe('Party-0001 paid; Party-0001 owes; Mehta is ambiguous')
  })

  it('maps aliases back, unknown aliases untouched', () => {
    expect(p.inbound('Party-0002 owes ₹5,000.00; Party-0099 unknown')).toBe('Acme Traders (Pune) owes ₹5,000.00; Party-0099 unknown')
    expect(p.inbound(p.outbound('Acme Traders paid Raj & Co.'))).toBe('Acme Traders paid Raj & Co.')
  })

  it('maps aliases back in a stream even when an alias is split across chunks', () => {
    const s = p.stream()
    const chunks = ['Pay', 'ment to Par', 'ty-00', '01 is due; P', 'arty-0003', ' too. P']
    const out = chunks.map((c) => s.push(c)).join('') + s.flush()
    expect(out).toBe('Payment to Acme Traders is due; Raj & Co. too. P')
  })

  it('outbound = pseudonymise then mask; inbound reverses only the pseudonyms', () => {
    const opts = { maskIds: true, pseudonymiser: p }
    const sent = outboundText('Acme Traders GSTIN 27AAPFU0939F1ZV', opts)
    expect(sent).toBe('Party-0001 GSTIN [GSTIN …1ZV]')
    expect(inboundText(sent, opts)).toBe('Acme Traders GSTIN [GSTIN …1ZV]')
    expect(outboundText('Acme Traders', { maskIds: false, pseudonymiser: null })).toBe('Acme Traders')
  })
})
