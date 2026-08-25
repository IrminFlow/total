// Scenario 38 — recurring invoice preview, customer pricing and discount authority UI.
import { scenario, assert, assertEq } from '../lib/harness.mjs'

await scenario('38-sales-controls', async (h) => {
  await h.createCompanyUI('Commercial Controls Books')
  const groups=await h.invoke('master:groups:list'),units=await h.invoke('master:units:list')
  const level=await h.invoke('master:priceLevels:create',{name:'Contract pricing'})
  const customer=await h.invoke('master:ledgers:create',{name:'Orbit Stores',groupId:groups.find((row)=>row.name==='Sundry Debtors').id,openingBalance:0,gstin:null,stateCode:'27',address:null,taxType:null,gstRate:null,hsn:null,priceLevelId:level.id})
  const item=await h.invoke('master:stockItems:create',{name:'Service Kit',groupId:null,unitId:units[0].id,hsn:'9983',gstRate:18,cessRate:null,openingQtyMilli:0,openingValue:0,barcode:null,reorderLevelMilli:0,valuationMethod:'weighted_avg'})
  const today=new Date().toISOString().slice(0,10)
  await h.invoke('priceLevels:saveRate',{priceLevelId:level.id,stockItemId:item.id,rate:250000,effectiveFrom:today})
  const types=await h.invoke('master:voucherTypes:list'),salesType=types.find((row)=>row.kind==='sales')
  const schedule=await h.invoke('salesRecurring:save',{data:{name:'Orbit monthly care',partyLedgerId:customer.id,voucherTypeId:salesType.id,cadence:'monthly',nextDue:today,endDate:null,dueDays:15,lines:[{stockItemId:item.id,description:item.name,qtyMilli:1000,rateMode:'price_list',fixedRate:null,discountBps:1000}],narration:'Monthly care plan',active:true}})
  await h.invoke('salesDiscount:save',{data:{name:'Accountant ceiling',scopeKind:'role',role:'accountant',stockItemId:null,customerLedgerId:null,maxDiscountBps:1000,active:true}})

  await h.page.keyboard.press('l');await h.waitScreen('sales-documents')
  await h.click('btn-sales-recurring')
  await h.page.getByText(schedule.name,{exact:true}).waitFor()
  await h.page.getByText('1 ready',{exact:true}).waitFor()
  await h.shot('01-recurring-preview')
  await h.click('btn-recurring-sales-generate');await h.waitScreen('voucher-drafts')
  await h.page.getByText(`${schedule.name} · ${today}`,{exact:true}).waitFor()
  assertEq((await h.invoke('voucher:list',{from:today,to:today})).length,0,'recurring batch creates drafts, not vouchers')

  await h.goto('sales-documents');await h.page.getByRole('button',{name:'Pricing'}).click()
  await h.page.getByText('Contract pricing',{exact:true}).waitFor();await h.page.getByText('Service Kit',{exact:false}).waitFor();await h.shot('02-effective-price-lists');await h.page.keyboard.press('Escape')
  await h.page.getByRole('button',{name:'Discounts'}).click();await h.page.getByText('Accountant ceiling',{exact:true}).waitFor();await h.shot('03-discount-authority')
  const policies=await h.invoke('salesDiscount:list');assert(policies.some((row)=>row.maxDiscountBps===1000&&row.scopeLabel==='Role: accountant'),'discount policy is visible through API and UI')
})
