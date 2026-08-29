import {describe,expect,it} from 'vitest'
import {seededDb} from '../db/testdb'
import {createLedger} from './masters'
import {listVendorProfiles,saveVendorProfile,setVendorStatus} from './vendors'

const defaults={openingBalance:0,gstin:null,stateCode:null,address:null,taxType:null,gstRate:null,hsn:null,tdsSectionId:null,pan:null,creditDays:0,exportType:null}
describe('vendor onboarding',()=>{
  it('verifies clean evidence, blocks duplicate bank accounts and masks them for viewers',()=>{const db=seededDb();const group=(db.prepare("SELECT id FROM groups WHERE name='Sundry Creditors'").get() as {id:number}).id;const first=createLedger(db,{...defaults,name:'Verified Vendor',groupId:group}).id;const second=createLedger(db,{...defaults,name:'Duplicate Vendor',groupId:group}).id
    saveVendorProfile(db,{ledgerId:first,contactName:'Nisha Shah',email:'nisha@example.com',phone:null,bankName:'HDFC',bankAccount:'123456789012',ifsc:'HDFC0001234',udyamNumber:'UDYAM-MH-12-1234567'},'Asha');expect(setVendorStatus(db,first,'verified','Owner')).toMatchObject({status:'verified',verifiedBy:'Owner',issues:[]});expect(listVendorProfiles(db,true)[0]?.bankAccount).toBe('••••9012')
    const duplicate=saveVendorProfile(db,{ledgerId:second,contactName:'Ravi',email:'ravi@example.com',phone:null,bankName:'HDFC',bankAccount:'123456789012',ifsc:'HDFC0001234',udyamNumber:null},'Asha');expect(duplicate.issues).toMatchObject([{field:'bank_account',severity:'block'}]);expect(()=>setVendorStatus(db,second,'verified','Owner')).toThrow('also appears')
  })
})
