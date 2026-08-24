import { describe, expect, it } from 'vitest'
import { isValidVpa, upiIntentUrl } from './upi'

describe('isValidVpa', () => {
  it('accepts the addresses people actually have', () => {
    for (const vpa of ['ramesh@okhdfcbank', 'shop.name@ybl', 'total-books@paytm', '9876543210@upi']) {
      expect(isValidVpa(vpa), vpa).toBe(true)
    }
  })

  it('rejects obviously malformed ones', () => {
    // A typo in a VPA does not bounce — the money goes somewhere, or nowhere, and the sender's
    // app reports success either way. This is the only check that can be made locally.
    for (const vpa of ['', 'noatsign', '@handle', 'name@', 'a@b', 'name @ handle', 'name@@handle']) {
      expect(isValidVpa(vpa), vpa).toBe(false)
    }
  })

  it('tolerates surrounding whitespace', () => {
    expect(isValidVpa('  ramesh@okhdfcbank  ')).toBe(true)
  })
})

describe('upiIntentUrl', () => {
  const base = { vpa: 'shop@ybl', payeeName: 'Total Traders' }

  it('builds the NPCI deep link with the amount in rupees', () => {
    const url = upiIntentUrl({ ...base, amountPaise: 10650025, note: 'INV-4' })!
    expect(url.startsWith('upi://pay?')).toBe(true)
    const params = new URLSearchParams(url.slice('upi://pay?'.length))
    expect(params.get('pa')).toBe('shop@ybl')
    expect(params.get('pn')).toBe('Total Traders')
    expect(params.get('am')).toBe('106500.25')
    expect(params.get('cu')).toBe('INR')
    expect(params.get('tn')).toBe('INV-4')
  })

  it('formats paise as two decimals, never as a float', () => {
    expect(new URLSearchParams(upiIntentUrl({ ...base, amountPaise: 5 })!.slice(10)).get('am')).toBe('0.05')
    expect(new URLSearchParams(upiIntentUrl({ ...base, amountPaise: 100 })!.slice(10)).get('am')).toBe('1.00')
    expect(new URLSearchParams(upiIntentUrl({ ...base, amountPaise: 100000 })!.slice(10)).get('am')).toBe('1000.00')
  })

  it('leaves the amount out entirely when there is none, rather than sending zero', () => {
    // Some apps reject am=0.00 outright and others send zero rupees.
    for (const amountPaise of [null, undefined, 0, -100]) {
      const url = upiIntentUrl({ ...base, amountPaise })!
      expect(new URLSearchParams(url.slice(10)).has('am'), String(amountPaise)).toBe(false)
    }
  })

  it('escapes a payee name with characters a URL cares about', () => {
    const url = upiIntentUrl({ vpa: 'shop@ybl', payeeName: 'A & B Traders' })!
    expect(url).toContain('pn=A%20%26%20B%20Traders')
    expect(new URLSearchParams(url.slice(10)).get('pn')).toBe('A & B Traders')
  })

  it('trims a long note rather than letting a bank field cut it', () => {
    const url = upiIntentUrl({ ...base, note: 'x'.repeat(200) })!
    expect(new URLSearchParams(url.slice(10)).get('tn')!.length).toBe(50)
  })

  it('omits an empty note instead of sending a blank one', () => {
    expect(new URLSearchParams(upiIntentUrl({ ...base, note: '   ' })!.slice(10)).has('tn')).toBe(false)
  })

  it('refuses rather than building a link that would pay the wrong place', () => {
    // A QR that opens an app with the wrong payee is worse than no QR: the customer believes
    // they have paid.
    expect(upiIntentUrl({ vpa: 'not a vpa', payeeName: 'Total' })).toBeNull()
    expect(upiIntentUrl({ vpa: 'shop@ybl', payeeName: '   ' })).toBeNull()
  })
})
