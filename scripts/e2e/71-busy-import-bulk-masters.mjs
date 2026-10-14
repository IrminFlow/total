// Scenario 71 — Busy imports (WP 6.3) and bulk edit of MASTERS (WP 6.4), through the UI. e2e 36
// covers the Total books round trip + a Zoho mapping step; e2e 38 bulk-edits vouchers.
//   1. A Busy account-master Excel/CSV (title rows above the table; fixture shape from
//      importSources.dbtest.ts) picked in System → Import (file dialog stubbed) → the mapping step
//      with the busy:accounts profile auto-detected and its columns auto-mapped (UNVERIFIED-layout
//      banner) → dry-run preview (6 to create, openings tie) → import → Busy groups mapped to the
//      chart, Dr / Cr openings, state, PAN, credit days (IPC).
//   2. A Busy XML data export (<BusyData>: a new account group, accounts with Busy's sign —
//      negative = Dr —, a unit, an item with opening stock, one sale with item + account entries,
//      dated today) → recognised as "Busy XML data export" with its counts → dry-run preview
//      (nothing written; the books' openings still tie, stock included) → import → the group,
//      ledgers (openings), item (opening stock) and the sale land (IPC) → "Undo this import" on the
//      done step → the sale is in the bin, the ledger nothing uses is removed, the masters the
//      binned sale still uses are kept (purge the bin to remove them) with their imported openings
//      CLEARED (#107: Mehta ₹2,000 Dr and the ₹400 opening stock go with the capital that balanced
//      them), so the books' openings still tie; the batch is undone.
//   3. Masters → Ledgers: tick three parties → Bulk edit… → Credit terms 45 days → server
//      preview (2 will change, 1 already 45) → Apply (audited, one bulk batch) → Bulk edits →
//      Undo → 30 / none again.
//   4. Masters → Stock items: tick two items → Bulk edit… → GST rate 18% → preview → Apply →
//      Undo → 12% again.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { scenario, assert, assertEq, fixedToday } from '../lib/harness.mjs'

const dmy = (iso) => `${iso.slice(8, 10)}-${iso.slice(5, 7)}-${iso.slice(0, 4)}`

// Busy XML export (importSources.dbtest.ts BUSY_XML), dated today, with the capital raised to
// ₹2,400 so the openings tie: Dr Mehta ₹2,000 + opening stock ₹400 = Cr Capital ₹2,400.
const BUSY_XML = `<?xml version="1.0" encoding="iso8859-1"?>
<BusyData FinYear="01-04-${fixedToday.slice(0, 4)}">
  <AccountGroups><AccountGroup><Name>Retail Debtors</Name><ParentGroup>Sundry Debtors</ParentGroup></AccountGroup>
    <AccountGroup><Name>Sundry Debtors</Name><ParentGroup>Current Assets</ParentGroup></AccountGroup></AccountGroups>
  <Accounts>
    <Account><Name>Mehta Stores</Name><ParentGroup>Retail Debtors</ParentGroup><OPBal>-2000.00</OPBal>
      <Address><Address1>Main Road</Address1><StateName>Maharashtra</StateName><GSTNo>27AABCE5678F1ZH</GSTNo></Address></Account>
    <Account><Name>Proprietor Capital</Name><ParentGroup>Capital Account</ParentGroup><OPBal>2400.00</OPBal></Account>
    <Account><Name>Sale A/c</Name><ParentGroup>Sale</ParentGroup></Account>
  </Accounts>
  <Units><Unit><Name>Box</Name></Unit></Units>
  <Items><Item><Name>Carton</Name><ParentGroup>Packing</ParentGroup><MainUnit>Box</MainUnit><OPStockInMainUnit>20</OPStockInMainUnit><OPAmount>-400.00</OPAmount></Item></Items>
  <Sales>
    <Sale><VchSeriesName>Main</VchSeriesName><Date>${dmy(fixedToday)}</Date><VchNo>X-1</VchNo><MasterName1>Mehta Stores</MasterName1>
      <ItemEntries><ItemDetail><ItemName>Carton</ItemName><Qty>2</Qty><Price>50</Price><Amt>100</Amt></ItemDetail></ItemEntries>
      <AccEntries>
        <AccDetail><AccountName>Mehta Stores</AccountName><AmountType>1</AmountType><AmtMainCur>100</AmtMainCur></AccDetail>
        <AccDetail><AccountName>Sale A/c</AccountName><AmountType>2</AmountType><AmtMainCur>100</AmtMainCur></AccDetail>
      </AccEntries>
      <VchOtherInfoDetails><Narration1>XML sale</Narration1></VchOtherInfoDetails>
    </Sale>
  </Sales>
</BusyData>`

// Busy account masters (importSources.dbtest.ts BUSY_ACCOUNTS): a title row above the table.
const BUSY_ACCOUNTS = [
  'Busy Account Master List',
  '',
  'Acc_name,Alias,Account Group,Op. Bal.,Dr/Cr,GSTNo,ITPAN,StateName,Address1,Address2,CreditDaysForSale',
  'Sharma Traders,ST,Sundry Debtors,"12,500.00",Dr,27AAPFU0939F1ZV,,Maharashtra,Plot 7,MIDC,30',
  'Gupta Supply Co,GS,Sundry Creditors,"12,500.00",Cr,,ABCDE1234F,Gujarat,,,',
  'Godown Rent,,Expenses (Indirect/Admn.),,,,,,,,',
  'Counter Sales,,Sale,,,,,,,,',
  'Freight Charges,,Expenses (Direct/Mfg.),,,,,,,,',
  'Old Suspense,,Suspense Account,,,,,,,,'
].join('\n')

await scenario('71-busy-import-bulk-masters', async (h) => {
  const page = h.page
  await h.createCompanyUI('Busy Migration Co')
  const srcDir = fs.mkdtempSync(path.join(os.tmpdir(), 'total-e2e-busy-'))
  const xmlPath = path.join(srcDir, 'MSAll.xml')
  const csvPath = path.join(srcDir, 'accounts.csv')
  fs.writeFileSync(xmlPath, BUSY_XML, 'latin1')
  fs.writeFileSync(csvPath, BUSY_ACCOUNTS)
  // The wizard's undo asks with window.confirm.
  await page.evaluate(() => { window.confirm = () => true })

  const groupsBefore = (await h.invoke('master:groups:list')).length
  const ledgerNamed = async (name) => (await h.invoke('master:ledgers:list')).find((l) => l.name === name)
  const groupName = async (groupId) => (await h.invoke('master:groups:list')).find((g) => g.id === groupId)?.name
  const vouchersNow = () => h.invoke('voucher:list', { from: '2000-01-01', to: '2099-12-31' })

  // ================= 1. Busy account masters (CSV): mapping → preview → import =================
  await h.stubDialogs({ openPaths: [csvPath] })
  await h.goto('data-import')
  await h.click('btn-import-pick')
  await page.waitForSelector('[data-testid="import-mapping"]', { timeout: 30000 })
  assertEq(await page.$eval('[data-testid="import-profile"]', (el) => el.value), 'busy:accounts', 'Busy account masters recognised from the headers')
  assertEq((await page.textContent('[data-testid="import-file-name"]'))?.trim(), 'accounts.csv', 'file name shown')
  await page.waitForSelector('[data-testid="import-unverified"]')
  const mapped = async (key) => page.$eval(`[data-testid="import-map-${key}"]`, (el) => el.options[el.selectedIndex]?.textContent)
  assertEq(await mapped('name'), 'Acc_name', 'Name ← Acc_name')
  assertEq(await mapped('group'), 'Account Group', 'Group ← Account Group')
  assertEq(await mapped('opening'), 'Op. Bal.', 'Op. Bal. ← Op. Bal.')
  assertEq(await mapped('gstin'), 'GSTNo', 'GSTIN ← GSTNo')
  assertEq(await mapped('creditDays'), 'CreditDaysForSale', 'Credit Days ← CreditDaysForSale')
  await h.shot('01-busy-accounts-mapping')
  await h.click('btn-import-preview')
  await page.waitForSelector('[data-testid="import-preview-summary"]', { timeout: 30000 })
  const willCreate = await page.textContent('[data-testid="import-preview-summary"]')
  assert(/Will create\s*6/.test(willCreate), `preview: 6 accounts to create (${willCreate})`)
  assert(/— they tie\./.test((await page.textContent('[data-testid="import-opening-check"]')) ?? ''), 'Dr ₹12,500 = Cr ₹12,500')
  await h.click('btn-import-apply')
  await page.waitForSelector('[data-testid="import-done-summary"]', { timeout: 30000 })
  const sharma = await ledgerNamed('Sharma Traders')
  const gupta = await ledgerNamed('Gupta Supply Co')
  assertEq(sharma.openingBalance, 1_250_000, 'Sharma ₹12,500 Dr')
  assertEq(sharma.creditDays, 30, 'Sharma credit days')
  assertEq(sharma.stateCode, '27', 'Sharma state')
  assertEq(sharma.address, 'Plot 7, MIDC', 'Sharma address lines joined')
  assertEq(gupta.openingBalance, -1_250_000, 'Gupta ₹12,500 Cr')
  assertEq(gupta.pan, 'ABCDE1234F', 'Gupta PAN')
  assertEq(gupta.stateCode, '24', 'Gupta: Gujarat → 24')
  assertEq(gupta.creditDays ?? null, null, 'Gupta has no credit terms')
  for (const [name, group] of [['Godown Rent', 'Indirect Expenses'], ['Counter Sales', 'Sales Accounts'], ['Freight Charges', 'Direct Expenses'], ['Old Suspense', 'Suspense A/c']]) {
    assertEq(await groupName((await ledgerNamed(name)).groupId), group, `${name} → ${group}`)
  }
  assertEq((await h.invoke('master:groups:list')).length >= groupsBefore, true, 'no group lost')

  // ================= 2. Busy XML: plan → preview → import → undo =================
  const ledgersBefore = (await h.invoke('master:ledgers:list')).length
  await h.click('btn-import-another')
  await h.stubDialogs({ openPaths: [xmlPath] })
  await h.click('btn-import-pick')
  await page.waitForSelector('[data-testid="import-plan-title"]', { timeout: 30000 })
  assertEq((await page.textContent('[data-testid="import-plan-title"]'))?.trim(), 'Busy XML data export', 'the Busy XML export is recognised')
  const plan = await page.textContent('main')
  for (const [label, n] of [['Accounts', 3], ['Items', 1], ['Vouchers', 1], ['New groups', 1]]) {
    assert(new RegExp(`${label}\\s*${n}`).test(plan), `plan shows ${label} ${n}`)
  }
  assert(plan.includes('Busy XML layout is UNVERIFIED'), 'the UNVERIFIED layout warning is shown')
  await h.shot('02-busy-xml-plan')

  await h.click('btn-import-preview')
  await page.waitForSelector('[data-testid="import-preview-summary"]', { timeout: 60000 })
  const openingCheck = (await page.textContent('[data-testid="import-opening-check"]')) ?? ''
  assert(/Dr ₹14,900\.00 · Cr ₹14,900\.00 \(Dr includes opening stock ₹400\.00\) — they tie\./.test(openingCheck), `openings tie, stock included (${openingCheck})`)
  assertEq(await page.$('[data-testid="import-blocked"]'), null, 'nothing blocks the import')
  assertEq((await vouchersNow()).length, 0, 'the dry run wrote no voucher')
  assertEq((await h.invoke('master:ledgers:list')).length, ledgersBefore, 'the dry run wrote no ledger')
  await h.shot('03-busy-xml-preview')

  await h.click('btn-import-apply')
  await page.waitForSelector('[data-testid="import-done-summary"]', { timeout: 60000 })
  await h.shot('04-busy-xml-done')
  const [xmlBatch] = await h.invoke('importwiz:batches')
  assertEq(xmlBatch.source, 'busy-xml', 'batch source')
  assertEq(xmlBatch.status, 'applied', 'batch applied')
  assert((await page.textContent('[data-testid="import-batch-id"]')).includes(`Batch ${xmlBatch.id}`), 'the done step names the batch')

  const groups = await h.invoke('master:groups:list')
  const retail = groups.find((g) => g.name === 'Retail Debtors')
  assert(retail, 'the Busy account group was created')
  assertEq(groups.find((g) => g.id === retail.parentId)?.name, 'Sundry Debtors', '… under Sundry Debtors')
  const mehta = await ledgerNamed('Mehta Stores')
  assertEq(mehta.groupId, retail.id, 'Mehta Stores under Retail Debtors')
  assertEq(mehta.openingBalance, 200_000, 'Busy OPBal -2000 = ₹2,000 Dr')
  assertEq(mehta.gstin, '27AABCE5678F1ZH', 'GSTIN from the address block')
  const capital = await ledgerNamed('Proprietor Capital')
  assertEq(capital.openingBalance, -240_000, 'Busy OPBal 2400 = ₹2,400 Cr')
  assertEq(await groupName((await ledgerNamed('Sale A/c')).groupId), 'Sales Accounts', 'Busy "Sale" group → Sales Accounts')
  const carton = (await h.invoke('master:stockItems:list')).find((i) => i.name === 'Carton')
  assert(carton, 'the item was created')
  assertEq(carton.openingQtyMilli, 20_000, 'opening 20 boxes')
  assertEq(carton.openingValue, 40_000, 'opening value ₹400')
  const imported = await vouchersNow()
  assertEq(imported.length, 1, 'one voucher imported')
  const x1 = await h.invoke('voucher:get', { id: imported[0].id })
  assertEq(x1.number, 'X-1', 'Busy VchNo')
  assertEq(x1.date, fixedToday, 'Busy date dd-MM-yyyy')
  assertEq(x1.narration, 'XML sale', 'Busy narration')
  assertEq(
    JSON.stringify(x1.lines.map((l) => [l.ledgerId, l.drCr, l.amount])),
    JSON.stringify([[mehta.id, 'dr', 10_000], [(await ledgerNamed('Sale A/c')).id, 'cr', 10_000]]),
    'the sale posts Mehta Dr ₹100 / Sale A/c Cr ₹100'
  )
  assertEq(JSON.stringify(x1.inventory.map((i) => [i.stockItemId, i.qtyMilli, i.direction])), JSON.stringify([[carton.id, 2000, 'out']]), 'its item line')

  // Undo from the done step.
  await h.click('btn-import-undo')
  await page.waitForFunction(() => /Undone: \d+ binned, \d+ removed, \d+ restored/.test(document.body.textContent ?? ''), null, { timeout: 30000 })
  const undoToast = await page.evaluate(() => /Undone: (\d+) binned, (\d+) removed, (\d+) restored/.exec(document.body.textContent ?? '')?.slice(1).map(Number))
  assertEq(await page.$('[data-testid="btn-import-undo"]'), null, 'the undo button goes once used')
  await h.shot('05-busy-xml-undone')
  assertEq((await vouchersNow()).length, 0, 'the imported sale is out of the books')
  const bin = await h.invoke('voucher:bin')
  assert(bin.some((v) => v.id === x1.id), 'the sale is in the bin')
  assertEq(await ledgerNamed('Proprietor Capital'), undefined, 'an imported ledger nothing uses is removed')
  // The binned sale still uses these — the undo keeps them (purge the bin to remove them).
  assert(await ledgerNamed('Mehta Stores'), 'Mehta Stores kept (used by the binned sale)')
  assert(await ledgerNamed('Sale A/c'), 'Sale A/c kept (used by the binned sale)')
  assertEq((await ledgerNamed('Mehta Stores')).openingBalance, 0, 'the kept Mehta Stores has its imported opening cleared')
  const cartonAfter = (await h.invoke('master:stockItems:list')).find((i) => i.name === 'Carton')
  assertEq(`${cartonAfter.openingQtyMilli} ${cartonAfter.openingValue}`, '0 0', 'the kept Carton has its opening stock cleared')
  const ledgerOpenings = (await h.invoke('master:ledgers:list')).reduce((n, l) => n + (l.openingBalance ?? 0), 0)
  const stockOpenings = (await h.invoke('master:stockItems:list')).reduce((n, i) => n + (i.openingValue ?? 0), 0)
  assertEq(ledgerOpenings + stockOpenings, 0, 'after the undo the openings still tie (Dr = Cr, stock included)')
  assertEq(undoToast[0], 1, 'one voucher binned')
  assertEq(undoToast[2], 0, 'nothing to restore (all created)')
  const [xmlAfter] = await h.invoke('importwiz:batches')
  assertEq(xmlAfter.id, xmlBatch.id, 'same batch')
  assert(xmlAfter.status !== 'applied', `the batch is no longer applied (${xmlAfter.status})`)

  // ================= 3. Masters → Ledgers: bulk credit terms =================
  const gid = async (name) => (await h.invoke('master:groups:list')).find((g) => g.name === name).id
  const patel = await h.invoke('master:ledgers:create', { name: 'Patel Agencies', groupId: await gid('Sundry Debtors'), openingBalance: 0, creditDays: 45 })
  await h.goto('masters')
  const picks = [sharma.id, gupta.id, patel.id]
  await page.waitForSelector(`[data-testid="masters-ledgers-select-${patel.id}"]`, { timeout: 15000 })
  for (const id of picks) await h.click(`masters-ledgers-select-${id}`)
  assertEq((await page.textContent('[data-testid="masters-ledgers-bulk-count"]'))?.trim(), '3 ledgers selected', 'selection bar counts three')
  await h.click('masters-ledgers-bulk-edit')
  await page.waitForSelector('[data-testid="bulk-modal"]')
  await page.selectOption('[data-testid="bulk-field"]', 'creditDays')
  await h.fill('bulk-credit-days', '45')
  await h.click('bulk-preview-run')
  await page.waitForSelector('[data-testid="bulk-preview-summary"]')
  assertEq(await page.locator('[data-testid="rows-bulk-preview"] tr[data-status="applied"]').count(), 2, 'preview: two will change')
  assertEq(await page.locator('[data-testid="rows-bulk-preview"] tr[data-status="unchanged"]').count(), 1, 'preview: Patel already 45')
  assertEq((await ledgerNamed('Sharma Traders')).creditDays, 30, 'the preview changed nothing')
  await h.shot('06-bulk-ledgers-preview')
  await h.click('bulk-apply')
  await page.waitForSelector('[data-testid="bulk-modal"]', { state: 'detached' })
  assertEq((await ledgerNamed('Sharma Traders')).creditDays, 45, 'Sharma 30 → 45')
  assertEq((await ledgerNamed('Gupta Supply Co')).creditDays, 45, 'Gupta none → 45')
  assertEq((await ledgerNamed('Patel Agencies')).creditDays, 45, 'Patel unchanged')
  const [ledgerBatch] = await h.invoke('bulk:list', { target: 'ledger' })
  assertEq(ledgerBatch.appliedCount, 2, 'the batch records two changes')
  const bulkAudit = await h.invoke('audit:list', { entity: 'bulk_batch' })
  assertEq(bulkAudit.rows.length, 1, 'the bulk batch is in the audit trail')
  const sharmaAudit = await h.invoke('audit:list', { entity: 'ledger', entityId: sharma.id })
  assert(sharmaAudit.rows.some((r) => r.action === 'update'), 'each changed ledger is audited')

  await h.click('masters-ledgers-bulk-history')
  await page.waitForSelector(`[data-testid="bulk-undo-${ledgerBatch.id}"]`)
  await h.click(`bulk-undo-${ledgerBatch.id}`)
  await page.waitForSelector('[data-testid="bulk-undo-result"]')
  await h.shot('07-bulk-ledgers-undone')
  await h.click('bulk-history-done')
  await page.waitForSelector('[data-testid="bulk-history"]', { state: 'detached' })
  assertEq((await ledgerNamed('Sharma Traders')).creditDays, 30, 'undo: Sharma back to 30')
  assertEq((await ledgerNamed('Gupta Supply Co')).creditDays ?? null, null, 'undo: Gupta back to none')
  assertEq((await ledgerNamed('Patel Agencies')).creditDays, 45, 'undo leaves the unchanged one alone')
  assertEq((await h.invoke('bulk:list', { target: 'ledger' }))[0].status, 'undone', 'ledger batch undone')

  // ================= 4. Masters → Stock items: bulk GST rate =================
  const units = await h.invoke('master:units:list')
  const pcs = units.find((u) => u.symbol === 'Pcs')
  const mkItem = (name) =>
    h.invoke('master:stockItems:create', {
      name, groupId: null, unitId: pcs.id, hsn: '8536', gstRate: 12, cessRate: null,
      openingQtyMilli: 0, openingValue: 0, barcode: null, reorderLevelMilli: null
    })
  const sw = await mkItem('Switch 6A')
  const sk = await mkItem('Socket 16A')
  const itemRate = async (id) => (await h.invoke('master:stockItems:list')).find((i) => i.id === id).gstRate
  await h.click('tab-masters-items')
  await page.waitForSelector(`[data-testid="masters-items-select-${sk.id}"]`, { timeout: 15000 })
  await h.click(`masters-items-select-${sw.id}`)
  await h.click(`masters-items-select-${sk.id}`)
  assertEq((await page.textContent('[data-testid="masters-items-bulk-count"]'))?.trim(), '2 items selected', 'two items selected')
  await h.click('masters-items-bulk-edit')
  await page.waitForSelector('[data-testid="bulk-modal"]')
  assertEq(await page.$eval('[data-testid="bulk-field"]', (el) => el.value), 'gstRate', 'GST rate is the first item field')
  await page.selectOption('[data-testid="bulk-gst-rate"]', '18')
  await h.click('bulk-preview-run')
  await page.waitForSelector('[data-testid="bulk-preview-summary"]')
  assertEq(await page.locator('[data-testid="rows-bulk-preview"] tr[data-status="applied"]').count(), 2, 'preview: both will change')
  await h.shot('08-bulk-items-preview')
  await h.click('bulk-apply')
  await page.waitForSelector('[data-testid="bulk-modal"]', { state: 'detached' })
  assertEq(await itemRate(sw.id), 18, 'Switch 12% → 18%')
  assertEq(await itemRate(sk.id), 18, 'Socket 12% → 18%')
  const [itemBatch] = await h.invoke('bulk:list', { target: 'stockItem' })
  const batchAudit = async (id) => (await h.invoke('audit:list', { entity: 'bulk_batch' })).rows.filter((r) => r.entityId === id)
  assertEq((await batchAudit(itemBatch.id)).length, 1, 'the item batch is audited too')
  assertEq((await batchAudit(ledgerBatch.id)).length, 2, 'the ledger batch: applied + undone, both audited')
  await h.click('masters-items-bulk-history')
  await page.waitForSelector(`[data-testid="bulk-undo-${itemBatch.id}"]`)
  await h.click(`bulk-undo-${itemBatch.id}`)
  await page.waitForSelector('[data-testid="bulk-undo-result"]')
  await h.click('bulk-history-done')
  await page.waitForSelector('[data-testid="bulk-history"]', { state: 'detached' })
  assertEq(await itemRate(sw.id), 12, 'undo: Switch back to 12%')
  assertEq(await itemRate(sk.id), 12, 'undo: Socket back to 12%')
  assertEq((await h.invoke('bulk:list', { target: 'stockItem' }))[0].status, 'undone', 'item batch undone')
  fs.rmSync(srcDir, { recursive: true, force: true })
})
