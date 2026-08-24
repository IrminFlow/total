import { describe, expect, it } from 'vitest'
import { postSimpleVoucher, seededDb } from '../db/testdb'
import type { CompanyInfo } from '@shared/domain'
import {
  addEdocEvent, addTdsChallan, edocEvents, installTaxContentPack, listGstRegistrations, listItcActions,
  listGstRegistrationSeries, listLutAuthorizations, saveComplianceObligation, saveGst2bImport, saveGstRegistration,
  saveGstRegistrationSeries, saveLutAuthorization, setTdsReturnStatus,
  syncComplianceCalendar, tdsWorkspace, updateItcAction
} from './complianceOps'
import { deleteVoucher } from './vouchers'

const company: CompanyInfo = {
  name:'Compliance Co',booksFrom:2026,stateCode:'27',gstin:'27AAPFU0939F1ZV',gstRegistrationType:'regular',address:'Pune',
  email:null,phone:null,pan:'AAPFU0939F',tan:null
}

describe('compliance operations', () => {
  it('retains idempotent 2B evidence and creates a reviewable ITC queue', () => {
    const db=seededDb()
    const jsonText=JSON.stringify({data:{rtnprd:'082026',docdata:{b2b:[{ctin:'27ABCDE1234F1Z5',inv:[{inum:'PORTAL-1',idt:'20-08-2026',val:1180,items:[{itm_det:{txval:1000,camt:90,samt:90}}]}]}]}}})
    const first=saveGst2bImport(db,{jsonText,fileName:'2b.json',from:'2026-08-01',to:'2026-08-31',period:'082026'},'Asha')
    expect(first.duplicate).toBe(false);expect(first.result.buckets.missingInBooks.count).toBe(1)
    expect(saveGst2bImport(db,{jsonText,fileName:'again.json',from:'2026-08-01',to:'2026-08-31',period:'082026'},'Asha').duplicate).toBe(true)
    const action=listItcActions(db,'082026')[0]!;expect(action).toMatchObject({classification:'missing',status:'open'})
    expect(updateItcAction(db,action.id,{classification:'follow_up',status:'waiting_supplier',owner:'Nisha',dueDate:'2026-09-05',note:'Ask supplier'},'Asha')).toMatchObject({owner:'Nisha',status:'waiting_supplier'})
  })

  it('tracks e-document history with retry idempotency', () => {
    const db=seededDb();const id=postSimpleVoucher(db,{kind:'sales',date:'2026-08-24',amount:1_000}).id
    expect(addEdocEvent(db,{voucherId:id,kind:'einvoice',status:'pending',requestKey:'irn:E-1',documentNo:null,validUntil:null,vehicleNo:null,reason:null},'Asha').status).toBe('pending')
    expect(()=>addEdocEvent(db,{voucherId:id,kind:'einvoice',status:'pending',requestKey:'irn:E-1',documentNo:null,validUntil:null,vehicleNo:null,reason:null},'Asha')).toThrow()
    deleteVoucher(db,id)
    expect(edocEvents(db,id)).toHaveLength(0)
    expect(()=>addEdocEvent(db,{voucherId:id,kind:'einvoice',status:'failed',requestKey:'irn:E-2',documentNo:null,validUntil:null,vehicleNo:null,reason:'retry'},'Asha')).toThrow('Voucher is not active in the books')
  })

  it('rejects an e-document lifecycle on an active but unsupported voucher kind', () => {
    const db=seededDb();const id=postSimpleVoucher(db,{kind:'journal',date:'2026-08-24',amount:1_000}).id
    expect(()=>addEdocEvent(db,{voucherId:id,kind:'einvoice',status:'pending',requestKey:'irn:J-1',documentNo:null,validUntil:null,vehicleNo:null,reason:null},'Asha')).toThrow('Voucher type journal is not valid')
  })

  it('ties TDS deductions to challans and filing evidence', () => {
    const db=seededDb();expect(tdsWorkspace(db,2026,1).difference).toBe(0)
    addTdsChallan(db,{fyStartYear:2026,quarter:1,bsrCode:'1234567',challanSerial:'42',depositDate:'2026-07-07',amount:5000,note:null},'Asha')
    expect(tdsWorkspace(db,2026,1)).toMatchObject({deposited:5000,difference:-5000})
    expect(()=>setTdsReturnStatus(db,2026,1,'filed',null,null,null,'Asha')).toThrow('acknowledgement')
    expect(setTdsReturnStatus(db,2026,1,'filed','TOKEN-1','2026-07-31',null,'Asha').returnStatus.status).toBe('filed')
  })

  it('persists calendar ownership, GST registrations and versioned guidance separately from calculations', () => {
    const db=seededDb();const calendar=syncComplianceCalendar(db,company,'2026-08-24',true,'Asha');expect(calendar.some((row)=>row.kind==='gst')).toBe(true)
    const custom=saveComplianceObligation(db,{title:'Maharashtra PTRC',dueDate:'2026-08-31',kind:'state',status:'open',owner:'Nisha',note:null},'Asha');expect(custom.source).toBe('custom')
    saveGstRegistration(db,{gstin:'27AAPFU0939F1ZV',legalName:'Compliance Co',stateCode:'27',address:'Pune',registrationType:'regular',isPrimary:true,active:true,invoicePrefix:'MH'},'Owner')
    expect(listGstRegistrations(db)[0]).toMatchObject({stateCode:'27',isPrimary:true,invoicePrefix:'MH'})
    expect(installTaxContentPack(db,{packKey:'tds-thresholds',version:'2026.1',effectiveFrom:'2026-04-01',title:'TDS guidance',content:{note:'Reference only'}},'Owner')).toMatchObject({version:'2026.1',active:true})
  })

  it('keeps numbering policy and LUT evidence isolated by GST registration', () => {
    const db=seededDb()
    const mh=saveGstRegistration(db,{gstin:'27AAPFU0939F1ZV',legalName:'Compliance Co MH',stateCode:'27',address:'Pune',registrationType:'regular',isPrimary:true,active:true,invoicePrefix:'MH'},'Owner')
    const salesType=(db.prepare("SELECT id FROM voucher_types WHERE kind='sales' LIMIT 1").get() as {id:number}).id
    expect(saveGstRegistrationSeries(db,{registrationId:mh.id,voucherTypeId:salesType,prefix:'MH-',suffix:'/26',padWidth:4,restartFy:true},'Owner')).toMatchObject({prefix:'MH-',padWidth:4,restartFy:true})
    expect(listGstRegistrationSeries(db,mh.id)).toHaveLength(1)
    expect(saveLutAuthorization(db,{registrationId:mh.id,fyStartYear:2026,arn:'LUT272026001',filedDate:'2026-04-01',validFrom:'2026-04-01',validTo:'2027-03-31',note:'Exports without payment'},'Owner')).toMatchObject({registrationGstin:mh.gstin,fyStartYear:2026})
    expect(listLutAuthorizations(db,mh.id)[0]?.validTo).toBe('2027-03-31')
  })
})
