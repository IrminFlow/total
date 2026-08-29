// Scenario 52 — production UI coverage for customer collections depth and voucher accelerators.
import * as fs from 'node:fs'
import * as path from 'node:path'
import { scenario, assert } from '../lib/harness.mjs'

await scenario('52-customer-voucher-depth', async (h) => {
  await h.createDemoCompany()

  await h.goto('collections')
  const firstAction = h.page.locator('[data-testid^="btn-promise-"]').first()
  await firstAction.waitFor()
  await firstAction.locator('xpath=..').locator('button').first().click()
  const workspaceButton = h.page.locator('[data-testid^="btn-customer-workspace-"]').first()
  await workspaceButton.click()
  await h.page.getByTestId('customer-workspace').waitFor()
  assert(await h.page.getByText('Six-month ageing trend', { exact: true }).isVisible(), 'ageing trend is visible')
  assert(await h.page.getByText('Expected receipts', { exact: true }).isVisible(), 'collections forecast is visible')
  await h.page.getByLabel('Owner', { exact: true }).fill('Asha')
  await h.page.getByTestId('btn-save-collection-settings').click()
  await h.page.getByText('Collection policy saved', { exact: false }).waitFor()
  await h.shot('01-customer-workspace')
  await h.page.keyboard.press('Escape')

  await h.page.getByTestId('btn-receipt-matcher').click()
  await h.page.getByLabel('Amount', { exact: true }).fill('45000')
  await h.page.getByLabel('Payer clue', { exact: true }).fill('Umbrella')
  await h.page.getByTestId('btn-run-receipt-match').click()
  await h.page.getByTestId('receipt-match-results').locator('button').first().waitFor()
  await h.shot('02-receipt-suggestions')
  await h.page.keyboard.press('Escape')

  const vouchers = await h.invoke('voucher:list', { from: '2000-01-01', to: '2099-12-31' })
  const voucherId = vouchers[0].id ?? vouchers[0].voucherId
  await h.goto('daybook')
  await h.page.locator(`[data-testid="rows-daybook"] [data-row-id="${voucherId}"]`).click()
  await h.page.getByTestId('btn-voucher-attachments').waitFor()
  const proof = path.join(h.dataDir, 'delivery-proof.txt')
  fs.writeFileSync(proof, 'Reviewed delivery evidence\n')
  await h.stubDialogs({ openPaths: [proof] })
  await h.page.getByTestId('btn-voucher-attachments').click()
  await h.page.getByTestId('select-voucher-attachment-kind').selectOption('delivery')
  await h.page.getByTestId('btn-add-voucher-attachment').click()
  await h.page.getByText('delivery-proof.txt', { exact: true }).waitFor()
  await h.shot('03-voucher-evidence-bundle')
  await h.page.keyboard.press('Escape')

  await h.goto('voucher-entry')
  await h.page.getByTestId('btn-compound-entry').click()
  await h.page.getByText('Nothing posts until the normal validation and approval flow succeeds.', { exact: false }).waitFor()
  await h.shot('04-compound-entry-assistant')
  await h.page.keyboard.press('Escape')

  const ledgers = await h.invoke('master:ledgers:list')
  const cash = ledgers.find((ledger) => ledger.name === 'Cash')
  const bank = ledgers.find((ledger) => ledger.name === 'HDFC Bank')
  assert(cash && bank, 'demo cash and bank ledgers exist')
  await h.page.getByTestId('btn-paste-voucher-lines').click()
  await h.page.getByTestId('input-clipboard-voucher-lines').fill(`Ledger\tDebit\tCredit\n${cash.name}\t100.00\t\n${bank.name}\t\t100.00`)
  await h.page.getByTestId('btn-apply-clipboard-lines').waitFor()
  const clipboardIssues = await h.page.getByTestId('clipboard-line-issues').allTextContents().catch(() => [])
  assert(await h.page.getByTestId('btn-apply-clipboard-lines').isEnabled(), `balanced clipboard preview can be applied (${clipboardIssues.join(' · ')})`)
  await h.shot('05-clipboard-preview')
  await h.page.keyboard.press('Escape')
})
