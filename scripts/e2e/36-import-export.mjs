// Scenario 36 — Excel books export / import (WP 6.3): export the demo company to one .xlsx from
// System → Export, create a new company, import the workbook through System → Import (picked via
// the stubbed file dialog, dry-run preview, then import), and compare the two trial balances
// line by line. Then undo the import from the done step. Screens shot in both themes.
import { readFileSync, writeFileSync } from 'fs'
import os from 'os'
import path from 'path'
import { scenario, assert, assertEq } from '../lib/harness.mjs'

const today = new Date().toISOString().slice(0, 10)
const tbKey = (tb) => tb.rows.map((r) => `${r.ledgerName}|${r.debit}|${r.credit}`).sort()

await scenario('36-import-export', async (h) => {
  await h.createDemoCompany()
  await h.stubDialogs()

  // ---- export (UI) ----
  await h.goto('data-export')
  await h.shot('01-export-light')
  await h.click('btn-export-books')
  await h.page.waitForSelector('[data-testid="export-books-done"]', { timeout: 30000 })
  await h.shot('02-export-done-light')
  const { path: booksPath, counts } = await h.invoke('export:books', { reveal: false })
  assert(counts.Vouchers > 40, `the workbook carries the demo vouchers (${counts.Vouchers} rows)`)
  assert(readFileSync(booksPath).subarray(0, 2).toString() === 'PK', 'the export is a real .xlsx (ZIP)')
  const srcTb = await h.invoke('report:trialBalance', { asOn: today })

  // ---- new company, import (UI) ----
  await h.click('btn-switch-company')
  await h.createCompanyUI('Imported Traders')
  await h.stubDialogs({ openPaths: [booksPath] })
  await h.goto('data-import')
  await h.shot('03-import-pick-light')
  await h.click('btn-import-pick')
  await h.page.waitForSelector('[data-testid="import-plan-title"]', { timeout: 30000 })
  const title = await h.page.textContent('[data-testid="import-plan-title"]')
  assert(/Total books workbook — Demo Traders/.test(title), `the books workbook is recognised (${title})`)
  await h.shot('04-import-plan-light')
  await h.click('btn-import-preview')
  await h.page.waitForSelector('[data-testid="import-preview-summary"]', { timeout: 60000 })
  await h.shot('05-import-preview-light')
  // Existing defaults (Cash, Main Location, units) are updated or skipped, never duplicated.
  await h.click('btn-import-apply')
  await h.page.waitForSelector('[data-testid="import-done-summary"]', { timeout: 120000 })
  await h.shot('06-import-done-light')

  const dstTb = await h.invoke('report:trialBalance', { asOn: today })
  assertEq(dstTb.totalDebit, srcTb.totalDebit, 'trial balance debit total')
  assertEq(dstTb.totalCredit, srcTb.totalCredit, 'trial balance credit total')
  assertEq(JSON.stringify(tbKey(dstTb)), JSON.stringify(tbKey(srcTb)), 'every trial balance line matches')

  // ---- dark theme ----
  await h.click('btn-theme')
  await h.shot('07-import-done-dark')
  await h.goto('data-export')
  await h.shot('08-export-dark')
  await h.goto('data-import')
  await h.page.waitForSelector('[data-testid="rows-import-batches"]', { timeout: 15000 })
  await h.shot('09-import-history-dark')

  // ---- undo from history ----
  const batches = await h.invoke('importwiz:batches')
  await h.app.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 0 }) })
  await h.page.evaluate(() => { window.confirm = () => true })
  await h.click(`btn-import-undo-${batches[0].id}`)
  await h.page.waitForFunction(() => !document.querySelector('[data-testid^="btn-import-undo-"]'), null, { timeout: 60000 })
  const after = await h.invoke('voucher:list', { from: '2000-01-01', to: '2099-12-31' })
  assertEq(after.length, 0, 'undo bins every imported voucher')

  // ---- a single-table file: mapping step (Zoho contacts, auto-detected) in both themes ----
  const csvPath = path.join(os.tmpdir(), `zoho-contacts-${Date.now()}.csv`)
  writeFileSync(csvPath, [
    'Contact ID,Display Name,Contact Type,GST Treatment,GST Identification Number (GSTIN),Place Of Supply,Payment Terms,Opening Balance,Accounts Receivable,Customer Sub Type',
    '11,Umbrella Retail,customer,business_registered_regular,27AABCD1234E1Z8,MH,30,1500,Accounts Receivable,business'
  ].join('\n'))
  await h.stubDialogs({ openPaths: [csvPath] })
  await h.click('btn-import-pick')
  await h.page.waitForSelector('[data-testid="import-mapping"]', { timeout: 30000 })
  const profile = await h.page.$eval('[data-testid="import-profile"]', (el) => el.value)
  assertEq(profile, 'zoho:contacts', 'Zoho contacts recognised from the headers')
  await h.shot('10-import-mapping-dark')
  await h.click('btn-theme')
  await h.shot('11-import-mapping-light')
  await h.click('btn-import-preview')
  await h.page.waitForSelector('[data-testid="import-preview-summary"]', { timeout: 30000 })
  await h.shot('12-import-preview-contacts-light')
})
