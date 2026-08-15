import { describe, it, expect } from 'vitest'
import { buildEInvoiceJson, buildEwbJson, pinFromAddress, type EdocCompany, type EdocInvoice } from './gst/edocs'

const company: EdocCompany = {
  name: 'Demo Traders',
  gstin: '27AAPFU0939F1ZV',
  stateCode: '27',
  address: '12 MG Road, Pune 411001'
}

const invoice: EdocInvoice = {
  number: '1',
  date: '2026-08-15',
  partyName: 'Umbrella Retail',
  partyGstin: '27AAPFU0939F1ZV',
  partyAddress: 'Shop 4, Mumbai 400001',
  partyStateCode: '27',
  pos: '27',
  items: [
    {
      name: 'Laptop 14"', hsn: '8471', qtyMilli: 2000, uqc: 'BOX', unitPricePaise: 4500000,
      taxablePaise: 9000000, rate: 18, cessRate: 0, cgst: 810000, sgst: 810000, igst: 0, cess: 0, isService: false
    }
  ],
  taxable: 9000000,
  cgst: 810000,
  sgst: 810000,
  igst: 0,
  cess: 0,
  roundOff: 0,
  total: 10620000,
  transporterId: null,
  vehicleNo: 'MH01AB1234',
  distanceKm: 120
}

describe('e-invoice builder', () => {
  it('produces NIC schema 1.1 documents', () => {
    const [doc] = buildEInvoiceJson([invoice], company) as any[]
    expect(doc.Version).toBe('1.1')
    expect(doc.DocDtls).toEqual({ Typ: 'INV', No: '1', Dt: '15/08/2026' })
    expect(doc.SellerDtls.Gstin).toBe('27AAPFU0939F1ZV')
    expect(doc.SellerDtls.Pin).toBe(411001)
    expect(doc.BuyerDtls.Pin).toBe(400001)
    expect(doc.ItemList[0]).toMatchObject({
      SlNo: '1', HsnCd: '8471', Qty: 2, Unit: 'BOX', UnitPrice: 45000,
      AssAmt: 90000, GstRt: 18, CgstAmt: 8100, SgstAmt: 8100, TotItemVal: 106200
    })
    expect(doc.ValDtls).toMatchObject({ AssVal: 90000, TotInvVal: 106200 })
  })

  it('extracts PINs defensively', () => {
    expect(pinFromAddress('No pin here')).toBe(0)
    expect(pinFromAddress(null)).toBe(0)
    expect(pinFromAddress('A 110001 B 400002')).toBe(400002)
  })
})

describe('e-way bill builder', () => {
  it('produces the bulk offline-tool shape', () => {
    const json = buildEwbJson([invoice], company) as any
    const bill = json.billLists[0]
    expect(bill.supplyType).toBe('O')
    expect(bill.docNo).toBe('1')
    expect(bill.fromStateCode).toBe(27)
    expect(bill.vehicleNo).toBe('MH01AB1234')
    expect(bill.transDistance).toBe('120')
    expect(bill.itemList[0]).toMatchObject({ hsnCode: '8471', quantity: 2, cgstRate: 9, sgstRate: 9, igstRate: 0 })
    expect(bill.totInvValue).toBe(106200)
  })
})

