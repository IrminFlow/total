// Scenario 39 — returns, territory ownership, custom fields, subscriptions and customer pack.
import { scenario, assert, assertEq } from '../lib/harness.mjs'

await scenario('39-customer-operations', async (h) => {
  await h.createCompanyUI('Customer Operations Books')
  const groups=await h.invoke('master:groups:list'),units=await h.invoke('master:units:list'),types=await h.invoke('master:voucherTypes:list')
  const customer=await h.invoke('master:ledgers:create',{name:'Atlas Retail',groupId:groups.find((row)=>row.name==='Sundry Debtors').id,openingBalance:0,gstin:null,stateCode:'27',address:null,taxType:null,gstRate:null,hsn:null})
  const salesLedger=await h.invoke('master:ledgers:create',{name:'Product Sales',groupId:groups.find((row)=>row.name==='Sales Accounts').id,openingBalance:0,gstin:null,stateCode:null,address:null,taxType:null,gstRate:0,hsn:null})
  const item=await h.invoke('master:stockItems:create',{name:'Control Unit',groupId:null,unitId:units[0].id,hsn:'8537',gstRate:0,cessRate:null,openingQtyMilli:10000,openingValue:1000000,barcode:null,reorderLevelMilli:0,valuationMethod:'weighted_avg'})
  const today=new Date().toISOString().slice(0,10),salesType=types.find((row)=>row.kind==='sales')
  const saved=await h.invoke('voucher:save',{data:{voucherTypeId:salesType.id,date:today,partyLedgerId:customer.id,narration:'Initial customer shipment',reference:null,instrumentNo:null,instrumentDate:null,transporterId:null,vehicleNo:null,transportDistanceKm:null,posOverride:null,currencyCode:null,exchangeRate:null,lines:[{ledgerId:customer.id,drCr:'dr',amount:500000},{ledgerId:salesLedger.id,drCr:'cr',amount:500000}],inventory:[{stockItemId:item.id,godownId:null,batchId:null,qtyMilli:5000,ratePaise:100000,discountPaise:0,amount:500000,direction:'out'}],billRefs:[],tds:null}})
  const territory=await h.invoke('customerOps:territorySave',{name:'West',parentId:null});await h.invoke('customerOps:customerAssign',{customerLedgerId:customer.id,territoryId:territory.id,salesperson:'Meera',effectiveFrom:today,effectiveTo:null})
  await h.invoke('customerOps:customFieldSave',{fieldKey:'po_reference',label:'Customer PO',documentKind:'order',dataType:'text',required:true,options:[],active:true})
  const schedule=await h.invoke('salesRecurring:save',{data:{name:'Atlas annual care',partyLedgerId:customer.id,voucherTypeId:salesType.id,cadence:'yearly',nextDue:today,endDate:null,dueDays:30,lines:[{stockItemId:item.id,description:'Annual care',qtyMilli:1000,rateMode:'fixed',fixedRate:100000,discountBps:0}],narration:'Annual care',active:true}})
  await h.invoke('customerOps:subscriptionCreate',{recurringScheduleId:schedule.id,planName:'Gold care',startDate:today,endDate:null,escalationBps:500,nextEscalationDate:null,note:'Priority response'})
  const bundle=await h.invoke('customerOps:portalBundle',{customerLedgerId:customer.id,from:today,to:today});assertEq(bundle.invoiceCount,1,'customer bundle includes the invoice');assert(bundle.manifestHash.length===64,'customer bundle has SHA-256 manifest identity')

  await h.page.keyboard.press('l');await h.waitScreen('sales-documents');await h.click('btn-customer-operations')
  await h.page.getByRole('button',{name:'Prepare credit note'}).waitFor();await h.shot('01-returnable-invoice')
  await h.page.getByRole('button',{name:'Territories'}).click();await h.page.getByText('West',{exact:true}).waitFor();await h.page.getByText('Meera',{exact:true}).waitFor();await h.shot('02-territory-performance')
  await h.page.getByRole('button',{name:'Subscriptions'}).click();await h.page.getByText('Gold care',{exact:true}).waitFor();await h.shot('03-subscription-contract')
  await h.page.getByRole('button',{name:'Document fields'}).click();await h.page.getByText('Customer PO',{exact:true}).waitFor();await h.shot('04-custom-fields')
  await h.page.getByRole('button',{name:'Returns'}).click();await h.page.getByRole('button',{name:'Prepare credit note'}).click();await h.waitScreen('voucher-entry');assertEq(await h.page.getByTestId('picker-party').inputValue(),'Atlas Retail','return draft retains original customer');assert((await h.invoke('voucher:list',{from:today,to:today})).length===1,'return preparation does not post a credit note')
})
