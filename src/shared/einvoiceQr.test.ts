import { describe, it, expect } from 'vitest'
import { einvoiceQrPayload, type EinvoiceQrInput } from './einvoiceQr'

const BASE: EinvoiceQrInput = {
  sellerGstin: '27AAAAA0000A1Z5',
  buyerGstin: '29BBBBB1111B2Z6',
  docNo: 'INV-001',
  docType: 'INV',
  docDate: '2025-04-01',
  totalPaise: 1180000,
  itemCount: 2,
  mainHsn: '8471',
  irn: null
}

describe('einvoiceQrPayload (pure — QR JSON payload builder)', () => {
  it('includes all core fields with paise formatted as plain rupees', () => {
    const json = JSON.parse(einvoiceQrPayload(BASE))
    expect(json).toMatchObject({
      SellerGstin: '27AAAAA0000A1Z5',
      BuyerGstin: '29BBBBB1111B2Z6',
      DocNo: 'INV-001',
      DocTyp: 'INV',
      DocDt: '2025-04-01',
      TotInvVal: '11800.00',
      ItemCnt: 2,
      MainHsnCode: '8471'
    })
  })

  it('omits the Irn key when no IRN is present', () => {
    const json = JSON.parse(einvoiceQrPayload(BASE))
    expect('Irn' in json).toBe(false)
  })

  it('includes the Irn key when an IRN is present', () => {
    const json = JSON.parse(einvoiceQrPayload({ ...BASE, irn: 'abc123irn' }))
    expect(json.Irn).toBe('abc123irn')
  })

  it('handles null seller/buyer GSTIN and HSN (unregistered / export cases)', () => {
    const json = JSON.parse(einvoiceQrPayload({ ...BASE, sellerGstin: null, buyerGstin: null, mainHsn: null }))
    expect(json.SellerGstin).toBeNull()
    expect(json.BuyerGstin).toBeNull()
    expect(json.MainHsnCode).toBeNull()
  })

  it('formats paise → rupees correctly for odd amounts', () => {
    const json = JSON.parse(einvoiceQrPayload({ ...BASE, totalPaise: 100050 }))
    expect(json.TotInvVal).toBe('1000.50')
  })
})
