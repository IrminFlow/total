// Scenario 34 — durable compliance calendar, registrations, 2B action queue, TDS tie-out and e-document history.
import { scenario, assert, assertEq } from '../lib/harness.mjs'

await scenario('34-compliance-centre',async(h)=>{
  const created=await h.invoke('company:createDemo')
  assert(created?.slug,'demo company is created through IPC')
  await h.page.reload()
  await h.openCompany('Demo Traders',60000)
  const now=new Date();const y=now.getFullYear();const m=String(now.getMonth()+1).padStart(2,'0');const day=String(now.getDate()).padStart(2,'0');const today=`${y}-${m}-${day}`;const period=`${m}${y}`;const from=`${y}-${m}-01`;const to=`${y}-${m}-${String(new Date(Date.UTC(y,now.getMonth()+1,0)).getUTCDate()).padStart(2,'0')}`
  const calendar=await h.invoke('compliance:sync',{today});assert(calendar.some((row)=>row.kind==='gst'),'statutory GST obligations are materialized')
  await h.invoke('compliance:save',{title:'Maharashtra PTRC return',dueDate:to,kind:'state',status:'open',owner:'Asha',note:'State-specific obligation'})
  const registration=await h.invoke('gst:registrationSave',{gstin:'27AAPFU0939F1ZV',legalName:'Demo Traders',stateCode:'27',address:'Pune, Maharashtra',registrationType:'regular',isPrimary:true,active:true,invoicePrefix:'MH'})
  const voucherTypes=await h.invoke('master:voucherTypes:list');const salesType=voucherTypes.find((row)=>row.kind==='sales');assert(salesType,'sales voucher type exists')
  await h.invoke('gst:registrationSeriesSave',{registrationId:registration.id,voucherTypeId:salesType.id,prefix:'MH-',suffix:'/26',padWidth:4,restartFy:true})
  const fyStart=now.getMonth()+1>=4?y:y-1;await h.invoke('gst:lutSave',{registrationId:registration.id,fyStartYear:fyStart,arn:'LUT-DEMO-2026',filedDate:today,validFrom:`${fyStart}-04-01`,validTo:`${fyStart+1}-03-31`,note:'E2E retained evidence'})
  await h.goto('compliance-centre');await h.page.getByTestId('compliance-calendar').waitFor();await h.page.getByText('Maharashtra PTRC return',{exact:true}).waitFor();await h.page.getByText('27AAPFU0939F1ZV',{exact:true}).waitFor();await h.page.getByText('LUT-DEMO-2026',{exact:true}).waitFor();await h.page.getByText(/MH-0000\/26/).waitFor();await h.shot('01-compliance-control-room')

  await h.goto('gstr2b');await h.click('btn-2b-paste');const json=JSON.stringify({data:{rtnprd:period,docdata:{b2b:[{ctin:'27ABCDE1234F1Z5',inv:[{inum:'PORTAL-ONLY-1',idt:`${day}-${m}-${y}`,val:1180,items:[{itm_det:{txval:1000,camt:90,samt:90}}]}]}]}}});await h.fill('input-2b-paste',json);await h.click('btn-2b-paste-apply');await h.page.getByRole('button',{name:/Retain evidence/}).click();await h.page.getByTestId('itc-action-queue').waitFor();await h.page.getByText('PORTAL-ONLY-1',{exact:true}).waitFor();await h.shot('02-itc-action-queue')
  const actions=await h.invoke('gst:itcActions',{period});assert(actions.some((row)=>row.portal?.number==='PORTAL-ONLY-1'),'portal-only 2B exception becomes a durable ITC action')

  await h.goto('tds');await h.page.getByRole('button',{name:'Add challan'}).click();await h.page.getByLabel('BSR code').fill('1234567');await h.page.getByLabel('Challan serial').fill('42');await h.page.getByLabel('Amount').fill('500');await h.page.getByRole('button',{name:'Save challan'}).click();await h.page.getByText('1234567',{exact:true}).waitFor();await h.shot('03-tds-quarter-control')
  const quarter=now.getMonth()+1<=6?1:now.getMonth()+1<=9?2:now.getMonth()+1<=12?3:4;const tds=await h.invoke('tds:workspace',{fyStartYear:fyStart,quarter});assertEq(tds.deposited,50000,'challan deposit is retained in paise')

  const docs=await h.invoke('edoc:list',{from,to});assert(docs.length>0,'demo has an e-document candidate');const target=docs[0];await h.invoke('edoc:eventAdd',{voucherId:target.voucherId,kind:'eway',status:'vehicle_updated',requestKey:null,documentNo:null,validUntil:null,vehicleNo:'MH12AB1234',reason:'Portal vehicle update'});await h.goto('edocs');await h.page.locator(`tr[data-row-id="${target.voucherId}"]`).getByText('Lifecycle',{exact:true}).click();await h.page.getByRole('dialog').getByText('eway · vehicle updated',{exact:true}).waitFor();await h.shot('04-edocument-lifecycle')
})
