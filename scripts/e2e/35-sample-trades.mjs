// Scenario 35 — the sample company mirrors the user's own trade (roadmap #293).
//
// The complaint the feature answers is that one generic "Demo Traders" teaches a consultancy to
// keep stock it will never have, and teaches a workshop nothing at all about making things. So
// the two claims worth asserting through the real UI are the two that differ:
//
//   the services sample has no stock items and no inventory feature — nothing to reconcile;
//   the manufacturing sample has the work-in-progress item, a bill of materials the Manufacture
//   screen can actually read, and closing stock of what it made.
//
// Both are asked at the point the sample is created, in one three-way choice.
import { scenario, assert, assertEq } from '../lib/harness.mjs'

await scenario('35-sample-trades', async (h) => {
  // ---- the choice itself ----
  await h.waitScreen('company-select')
  await h.click('btn-company-demo')
  await h.page.waitForSelector('[data-testid="demo-trade-picker"]', { timeout: 10000 })
  const options = await h.page.$$eval('[data-testid^="btn-demo-trade-"]', (els) =>
    els.map((e) => ({ testId: e.dataset.testid, text: e.textContent.trim() }))
  )
  assertEq(options.length, 3, 'three trades to choose from')
  for (const o of options) assert(o.text.length > 10, `${o.testId} says what it is: ${JSON.stringify(o.text)}`)
  await h.shot('01-trade-picker')

  // ---- a practice: fees, and no shelf ----
  await h.click('btn-demo-trade-services')
  await h.waitScreen('gateway', 60000)
  await h.shot('02-services-gateway')

  const svcItems = await h.invoke('master:stockItems:list')
  assertEq(svcItems.length, 0, 'the services sample has no stock items at all')

  const svcFeatures = await h.invoke('config:features:get')
  assertEq(svcFeatures.inventory, false, 'and inventory is switched off, so the stock screens are not offered')
  assertEq(svcFeatures.billWise, true, 'only inventory is touched — the rest of F11 is left at its defaults')

  // The feature flag is not decoration: the screen it gates is genuinely not in the sidebar.
  const stockNav = await h.page.$('[data-testid="nav-stock-summary"]')
  assert(stockNav === null, 'Stock summary is not in the sidebar for a firm with no stock')

  const svcTb = await h.invoke('report:trialBalance', { asOn: '2027-03-31' })
  assertEq(svcTb.totalDebit, svcTb.totalCredit, 'the services books balance')
  assert(svcTb.totalDebit > 0, 'and there is something in them')

  // ---- a workshop: raw material, work in progress, finished goods ----
  await h.clickText('Switch company')
  await h.waitScreen('company-select', 20000)
  await h.click('btn-company-demo')
  await h.click('btn-demo-trade-manufacturing')
  await h.waitScreen('gateway', 60000)

  const mfgItems = await h.invoke('master:stockItems:list')
  const names = mfgItems.map((i) => i.name)
  assert(names.includes('Pulley Housing (WIP)'), `the work-in-progress item exists (${names.length} items)`)
  assert(names.includes('MS Sheet 2mm'), 'along with the raw material it is pressed from')
  assert(names.includes('Idler Pulley Assembly'), 'and the finished good it becomes')

  const mfgFeatures = await h.invoke('config:features:get')
  assertEq(mfgFeatures.inventory, true, 'a factory keeps inventory on')

  // The bill of materials is the app's own, so the Manufacture voucher's picker finds it.
  const withBom = await h.invoke('bom:items')
  assert(
    withBom.some((i) => i.name === 'Pulley Housing (WIP)'),
    `the WIP item has a bill of materials (${withBom.map((i) => i.name).join(', ')})`
  )
  for (const row of withBom) assert(row.components > 0, `${row.name} lists components`)

  const stock = await h.invoke('report:stockSummary', { asOn: '2027-03-31' })
  const qty = (name) => stock.find((r) => r.name === name)?.closingQtyMilli
  assert(qty('Pulley Housing (WIP)') > 0, `housings made and not yet consumed: ${qty('Pulley Housing (WIP)')}`)
  assert(qty('Idler Pulley Assembly') > 0, 'assemblies made and not yet sold')
  for (const r of stock) assert(r.closingQtyMilli >= 0, `${r.name} never goes negative (${r.closingQtyMilli})`)

  const mfgTb = await h.invoke('report:trialBalance', { asOn: '2027-03-31' })
  assertEq(mfgTb.totalDebit, mfgTb.totalCredit, 'the manufacturing books balance too')

  await h.goto('stock-summary')
  await h.shot('03-manufacturing-stock')

  // ---- and the original sample is still the original sample ----
  await h.clickText('Switch company')
  await h.waitScreen('company-select', 20000)
  await h.createDemoCompany()
  const tradingItems = await h.invoke('master:stockItems:list')
  assertEq(tradingItems.length, 6, 'Demo Traders still carries its six items')
  assertEq((await h.invoke('bom:items')).length, 0, 'and a distributor is not shown a bill of materials')
})
