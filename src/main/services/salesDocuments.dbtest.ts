import { describe, expect, it } from 'vitest'
import { seededDb } from '../db/testdb'
import {
  convertSalesDocument, createSalesDocument, getSalesDocument, listSalesDocuments,
  listSalesDocumentSeries, previewSalesDocumentNumber, reviseSalesDocument,
  setSalesDocumentStatus
} from './salesDocuments'

function fixtures(){
  const db=seededDb()
  const debtors=db.prepare("SELECT id FROM groups WHERE name='Sundry Debtors'").get() as {id:number}
  const customerId=Number(db.prepare("INSERT INTO ledgers(name,group_id,gstin,state_code) VALUES('Acme Retail',?,'27ABCDE1234F1Z5','27')").run(debtors.id).lastInsertRowid)
  const unit=db.prepare('SELECT id FROM units ORDER BY id LIMIT 1').get() as {id:number}
  const itemId=Number(db.prepare("INSERT INTO stock_items(name,unit_id,gst_rate) VALUES('Precision Pump',?,18)").run(unit.id).lastInsertRowid)
  const series=Object.fromEntries(listSalesDocumentSeries(db).map((row)=>[row.kind,row])) as unknown as Record<'quotation'|'order'|'challan'|'proforma',{id:number}>
  const input=(kind:'quotation'|'order'|'challan'|'proforma',qtyMilli=10_000)=>({kind,seriesId:series[kind].id,partyLedgerId:customerId,date:'2026-08-24',validUntil:'2026-09-07',purpose:'Replacement line',gstRegistrationId:null,terms:['Prices valid for 14 days'],customFields:{salesperson:'Meera'},lines:[{stockItemId:itemId,description:'Precision Pump',qtyMilli,rate:125_000,discountBps:500,gstRate:18}]})
  return{db,customerId,itemId,series,input}
}

describe('sales document operations',()=>{
  it('allocates collision-proof FY numbers and never consumes one for preview or revision',()=>{
    const{db,input,series}=fixtures()
    expect(previewSalesDocumentNumber(db,series.quotation.id,'2026-08-24')).toMatchObject({sequence:1,number:'QUO/0001',fyStartYear:2026})
    expect(previewSalesDocumentNumber(db,series.quotation.id,'2026-08-24').number).toBe('QUO/0001')
    const first=createSalesDocument(db,input('quotation'),'Meera')
    expect(first).toMatchObject({number:'QUO/0001',revisionNo:1,status:'draft',totals:{baseAmount:1_250_000,discountAmount:62_500,taxableAmount:1_187_500,taxAmount:213_750,totalAmount:1_401_250}})
    const revised=reviseSalesDocument(db,first.id,{...input('quotation'),purpose:'Revised commercial terms'},'Customer requested update','Meera')
    expect(revised).toMatchObject({number:'QUO/0001',revisionNo:2,status:'draft',purpose:'Revised commercial terms'})
    expect(previewSalesDocumentNumber(db,series.quotation.id,'2026-08-24').number).toBe('QUO/0002')
    const second=createSalesDocument(db,input('quotation'),'Meera')
    expect(second.number).toBe('QUO/0002')
    expect(db.prepare('SELECT COUNT(*) AS n FROM sales_document_number_allocations').get()).toEqual({n:2})
    expect(db.prepare('SELECT COUNT(*) AS n FROM sales_document_revisions').get()).toEqual({n:1})
  })

  it('converts a quotation into partial orders with exact quantity lineage and backorder',()=>{
    const{db,input,series}=fixtures()
    let quote=createSalesDocument(db,input('quotation'),'Meera')
    quote=setSalesDocumentStatus(db,quote.id,'sent','Meera')
    quote=setSalesDocumentStatus(db,quote.id,'accepted','Owner')
    const first=convertSalesDocument(db,{sourceDocumentId:quote.id,targetKind:'order',targetSeriesId:series.order.id,date:'2026-08-25',lines:[{sourceLineId:quote.lines[0]!.id,qtyMilli:6_000}]},'Meera')
    expect(first.source).toMatchObject({status:'part_fulfilled',lines:[{allocatedQtyMilli:6_000,openQtyMilli:4_000}]})
    expect(first.targetDocument).toMatchObject({kind:'order',number:'SO/0001',parentDocumentId:quote.id,lines:[{qtyMilli:6_000}]})
    const second=convertSalesDocument(db,{sourceDocumentId:quote.id,targetKind:'order',targetSeriesId:series.order.id,date:'2026-08-26',lines:[{sourceLineId:quote.lines[0]!.id,qtyMilli:4_000}]},'Meera')
    expect(second.source).toMatchObject({status:'converted',lines:[{allocatedQtyMilli:10_000,openQtyMilli:0}]})
    expect(()=>convertSalesDocument(db,{sourceDocumentId:quote.id,targetKind:'order',targetSeriesId:series.order.id,date:'2026-08-27',lines:[{sourceLineId:quote.lines[0]!.id,qtyMilli:1_000}]},'Meera')).toThrow('approved or accepted')
    expect(listSalesDocuments(db,'order')).toHaveLength(2)
  })

  it('tracks partial delivery from order to challan and prevents over-delivery',()=>{
    const{db,input,series}=fixtures()
    let order=createSalesDocument(db,input('order'),'Meera');order=setSalesDocumentStatus(db,order.id,'confirmed','Owner')
    const delivery=convertSalesDocument(db,{sourceDocumentId:order.id,targetKind:'challan',targetSeriesId:series.challan.id,date:'2026-08-25',lines:[{sourceLineId:order.lines[0]!.id,qtyMilli:7_000}]},'Stores')
    expect(delivery.source).toMatchObject({status:'part_fulfilled',lines:[{deliveredQtyMilli:7_000,openQtyMilli:3_000}]})
    expect(delivery.targetDocument).toMatchObject({number:'DC/0001',kind:'challan',lines:[{qtyMilli:7_000}]})
    expect(()=>convertSalesDocument(db,{sourceDocumentId:order.id,targetKind:'challan',targetSeriesId:series.challan.id,date:'2026-08-26',lines:[{sourceLineId:order.lines[0]!.id,qtyMilli:4_000}]},'Stores')).toThrow('exceeds')
  })

  it('converts an approved challan to an editable sales invoice draft exactly once per quantity',()=>{
    const{db,input}=fixtures()
    let challan=createSalesDocument(db,input('challan',5_000),'Stores');challan=setSalesDocumentStatus(db,challan.id,'approved','Owner')
    const converted=convertSalesDocument(db,{sourceDocumentId:challan.id,targetKind:'invoice',date:'2026-08-26',lines:[{sourceLineId:challan.lines[0]!.id,qtyMilli:5_000}]},'Meera')
    expect(converted).toMatchObject({invoiceDraftId:expect.any(Number),source:{status:'fulfilled',lines:[{invoicedQtyMilli:5_000,openQtyMilli:0}]}})
    const draft=db.prepare('SELECT mode,title,payload_json AS payloadJson FROM voucher_drafts WHERE id=?').get(converted.invoiceDraftId) as {mode:string;title:string;payloadJson:string}
    expect(draft).toMatchObject({mode:'invoice',title:'Invoice from DC/0001'})
    expect(JSON.parse(draft.payloadJson)).toMatchObject({partyId:challan.partyLedgerId,salesDocumentId:challan.id,rows:[{itemId:challan.lines[0]!.stockItemId,qtyText:'5',rate:125_000,discount:31_250}]})
    expect(()=>convertSalesDocument(db,{sourceDocumentId:challan.id,targetKind:'invoice',date:'2026-08-27',lines:[{sourceLineId:challan.lines[0]!.id,qtyMilli:1_000}]},'Meera')).toThrow('approved or accepted')
    expect(db.prepare('SELECT COUNT(*) AS n FROM vouchers').get()).toEqual({n:0})
  })

  it('keeps proformas outside the books until a user chooses to post the generated invoice draft',()=>{
    const{db,input}=fixtures()
    let proforma=createSalesDocument(db,input('proforma'),'Meera');proforma=setSalesDocumentStatus(db,proforma.id,'sent','Meera');proforma=setSalesDocumentStatus(db,proforma.id,'accepted','Owner')
    const conversion=convertSalesDocument(db,{sourceDocumentId:proforma.id,targetKind:'invoice',date:'2026-08-25',lines:[{sourceLineId:proforma.lines[0]!.id,qtyMilli:10_000}]},'Meera')
    expect(conversion.invoiceDraftId).toBeGreaterThan(0)
    expect(getSalesDocument(db,proforma.id)?.status).toBe('converted')
    expect(db.prepare('SELECT COUNT(*) AS n FROM vouchers').get()).toEqual({n:0})
  })
})
