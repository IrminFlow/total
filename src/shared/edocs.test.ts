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

// Golden snapshot captured from buildEInvoiceJson BEFORE docType/supTyp were added, to prove
// the new fields are additive: an invoice that doesn't set them must produce byte-identical output.
const EINV_SNAPSHOT_BEFORE_DOCTYPE =
  '[{"Version":"1.1","TranDtls":{"TaxSch":"GST","SupTyp":"B2B","RegRev":"N","IgstOnIntra":"N"},"DocDtls":{"Typ":"INV","No":"1","Dt":"15/08/2026"},"SellerDtls":{"Gstin":"27AAPFU0939F1ZV","LglNm":"Demo Traders","Addr1":"12 MG Road, Pune 411001","Loc":"12 MG Road, Pune 411001","Pin":411001,"Stcd":"27"},"BuyerDtls":{"Gstin":"27AAPFU0939F1ZV","LglNm":"Umbrella Retail","Pos":"27","Addr1":"Shop 4, Mumbai 400001","Loc":"Shop 4, Mumbai 400001","Pin":400001,"Stcd":"27"},"ItemList":[{"SlNo":"1","PrdDesc":"Laptop 14\\"","IsServc":"N","HsnCd":"8471","Qty":2,"Unit":"BOX","UnitPrice":45000,"TotAmt":90000,"Discount":0,"AssAmt":90000,"GstRt":18,"IgstAmt":0,"CgstAmt":8100,"SgstAmt":8100,"CesRt":0,"CesAmt":0,"TotItemVal":106200}],"ValDtls":{"AssVal":90000,"CgstVal":8100,"SgstVal":8100,"IgstVal":0,"CesVal":0,"RndOffAmt":0,"TotInvVal":106200}}]'

// Deliberately updated golden (v0.3 GST rebuild): the EWB bulk format gained the mandatory
// fields the NIC tool rejects files without — subSupplyDesc, transactionType, fromPlace/
// toPlace (city heuristic from the address), fromAddr2/toAddr2, mainHsnCode, transDocNo/
// transDocDate and transporterName — and addresses are now split into addr1/addr2/place
// instead of being dumped whole into addr1. Verified field-by-field against the NIC bulk
// e-way bill JSON preparation format (version 1.0.0421).
const EWB_GOLDEN = {
  version: '1.0.0421',
  billLists: [
    {
      userGstin: '27AAPFU0939F1ZV',
      supplyType: 'O',
      subSupplyType: '1',
      subSupplyDesc: '',
      docType: 'INV',
      docNo: '1',
      docDate: '15/08/2026',
      transactionType: 1,
      fromGstin: '27AAPFU0939F1ZV',
      fromTrdName: 'Demo Traders',
      fromAddr1: '12 MG Road',
      fromAddr2: '',
      fromPlace: 'Pune',
      fromStateCode: 27,
      actualFromStateCode: 27,
      fromPincode: 411001,
      toGstin: '27AAPFU0939F1ZV',
      toTrdName: 'Umbrella Retail',
      toAddr1: 'Shop 4',
      toAddr2: '',
      toPlace: 'Mumbai',
      toStateCode: 27,
      actualToStateCode: 27,
      toPincode: 400001,
      mainHsnCode: '8471',
      itemList: [
        {
          productName: 'Laptop 14"',
          productDesc: 'Laptop 14"',
          hsnCode: '8471',
          quantity: 2,
          qtyUnit: 'BOX',
          taxableAmount: 90000,
          cgstRate: 9,
          sgstRate: 9,
          igstRate: 0,
          cessRate: 0
        }
      ],
      totalValue: 90000,
      cgstValue: 8100,
      sgstValue: 8100,
      igstValue: 0,
      cessValue: 0,
      totInvValue: 106200,
      transMode: '1',
      transDistance: '120',
      transporterId: '',
      transporterName: '',
      transDocNo: '',
      transDocDate: '',
      vehicleNo: 'MH01AB1234',
      vehicleType: 'R'
    }
  ]
}

describe('e-invoice/EWB builders — golden snapshots', () => {
  it('buildEInvoiceJson output is byte-identical for an invoice without docType/supTyp', () => {
    const json = buildEInvoiceJson([invoice], company)
    expect(JSON.stringify(json)).toBe(EINV_SNAPSHOT_BEFORE_DOCTYPE)
  })

  it('buildEwbJson emits the complete bulk-tool shape incl. mandatory place/transaction fields', () => {
    const json = buildEwbJson([invoice], company)
    expect(json).toEqual(EWB_GOLDEN)
  })
})

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

  it('carries docType through to the bulk-tool docType field', () => {
    const crnJson = buildEwbJson([{ ...invoice, docType: 'CRN' }], company) as any
    const dbnJson = buildEwbJson([{ ...invoice, docType: 'DBN' }], company) as any
    expect(crnJson.billLists[0].docType).toBe('CRN')
    expect(dbnJson.billLists[0].docType).toBe('DBN')
  })
})

describe('e-invoice builder — docType and supply types', () => {
  it('sets DocDtls.Typ to CRN for a credit note', () => {
    const [doc] = buildEInvoiceJson([{ ...invoice, docType: 'CRN' }], company) as any[]
    expect(doc.DocDtls.Typ).toBe('CRN')
  })

  it('sets DocDtls.Typ to DBN for a debit note', () => {
    const [doc] = buildEInvoiceJson([{ ...invoice, docType: 'DBN' }], company) as any[]
    expect(doc.DocDtls.Typ).toBe('DBN')
  })

  it('sets TranDtls.SupTyp to SEZWOP for an SEZ-without-payment party', () => {
    const [doc] = buildEInvoiceJson([{ ...invoice, supTyp: 'SEZWOP' }], company) as any[]
    expect(doc.TranDtls.SupTyp).toBe('SEZWOP')
    // SEZ (non-export) supply types don't force Pos/Gstin — those stay as captured.
    expect(doc.BuyerDtls.Pos).toBe('27')
    expect(doc.BuyerDtls.Gstin).toBe('27AAPFU0939F1ZV')
  })

  it('sets TranDtls.SupTyp to EXPWP and forces Pos 96 / Gstin URP for an export party', () => {
    const [doc] = buildEInvoiceJson([{ ...invoice, supTyp: 'EXPWP' }], company) as any[]
    expect(doc.TranDtls.SupTyp).toBe('EXPWP')
    expect(doc.BuyerDtls.Pos).toBe('96')
    expect(doc.BuyerDtls.Gstin).toBe('URP')
  })

  it('sets TranDtls.SupTyp to EXPWOP and forces Pos 96 / Gstin URP for a party with state code 96/97 (default export mapping)', () => {
    const [doc] = buildEInvoiceJson(
      [{ ...invoice, partyStateCode: '96', supTyp: 'EXPWOP' }],
      company
    ) as any[]
    expect(doc.TranDtls.SupTyp).toBe('EXPWOP')
    expect(doc.BuyerDtls.Pos).toBe('96')
    expect(doc.BuyerDtls.Gstin).toBe('URP')
  })
})

