// Scenario 35 — explainable management views, non-posting scenarios, Schedule III mapping and portable pack.
import { scenario, assert } from '../lib/harness.mjs'

await scenario('35-management-insights',async(h)=>{
  const created=await h.invoke('company:createDemo');assert(created?.slug,'demo company created')
  await h.page.reload();await h.openCompany('Demo Traders',60000);await h.goto('management-insights')
  await h.page.getByText('Ratio definitions',{exact:true}).waitFor();await h.page.getByText('Receivables ÷ sales × period days',{exact:true}).waitFor();await h.shot('01-decision-desk')

  await h.page.getByRole('tab',{name:'Variance drivers'}).click();await h.page.getByText('Sales change vs comparison',{exact:true}).waitFor();await h.shot('02-variance-drivers')

  await h.page.getByRole('tab',{name:'Scenarios',exact:true}).click();await h.page.getByRole('button',{name:'New scenario'}).click();await h.page.getByLabel('Scenario name').fill('Growth plan');await h.page.getByLabel('Sales growth %').fill('12');await h.page.getByLabel('Gross margin % (optional)').fill('35');await h.page.getByLabel('Collection days change').fill('-5');await h.page.getByRole('button',{name:'Save scenario'}).click();await h.page.getByRole('paragraph').filter({hasText:'Growth plan'}).waitFor();await h.shot('03-scenario-report')

  await h.page.getByRole('tab',{name:'Schedule III'}).click();await h.page.getByRole('button',{name:'Map account group'}).click();await h.page.getByLabel('Section').fill('Shareholders funds');await h.page.getByLabel('Note code').fill('3');await h.page.getByRole('button',{name:'Save mapping'}).click();await h.page.getByText('Shareholders funds',{exact:true}).waitFor();await h.shot('04-schedule-iii')

  await h.page.getByRole('tab',{name:'Notes & pack'}).click();await h.page.getByLabel('Report row').fill('owner-summary');await h.page.getByLabel('Explanation').fill('Seasonal investment approved by owner.');await h.page.getByRole('button',{name:'Retain note'}).click();await h.page.getByText('Seasonal investment approved by owner.',{exact:true}).waitFor();await h.page.getByRole('button',{name:'Build indexed pack'}).click();await h.page.getByText(/Portable report pack ready/).waitFor({timeout:60000});await h.shot('05-notes-portable-pack')
})
