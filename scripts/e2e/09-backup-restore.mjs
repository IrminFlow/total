// Scenario 09 — backup/restore round-trip with every native dialog stubbed: back up, mutate,
// restore the backup, and the pre-mutation books come back — validated by TB tie-outs.
import { scenario, assert, assertEq } from '../lib/harness.mjs'
import * as fs from 'node:fs'
import * as path from 'node:path'

await scenario('09-backup-restore', async (h) => {
  await h.createCompanyUI('Backup Co')
  await h.stubDialogs() // restore flows may confirm via showMessageBox; reveals become no-ops

  const ledgers = await h.invoke('master:ledgers:list')
  const cash = ledgers.find((l) => l.name === 'Cash')
  const groups = await h.invoke('master:groups:list')
  const salesGroup = groups.find((g) => g.name === 'Sales Accounts')
  await h.invoke('master:ledgers:create', {
    name: 'BK Sales', groupId: salesGroup.id, openingBalance: 0,
    gstin: null, stateCode: null, address: null, taxType: null, gstRate: null, hsn: null
  })
  const bkSales = (await h.invoke('master:ledgers:list')).find((l) => l.name === 'BK Sales')
  const types = await h.invoke('master:voucherTypes:list')
  const receipt = types.find((t) => t.kind === 'receipt')
  const today = new Date().toISOString().slice(0, 10)

  const saved = await h.invoke('voucher:save', {
    data: {
      voucherTypeId: receipt.id, date: today, partyLedgerId: null,
      narration: 'Pre-backup receipt', reference: null, instrumentNo: null, instrumentDate: null,
      transporterId: null, vehicleNo: null, transportDistanceKm: null, currencyCode: null, exchangeRate: null,
      lines: [
        { ledgerId: cash.id, drCr: 'dr', amount: 55500 },
        { ledgerId: bkSales.id, drCr: 'cr', amount: 55500 }
      ],
      inventory: []
    }
  })

  // Back up with the voucher in the books.
  const backup = await h.invoke('backup:run')
  assert(fs.existsSync(backup.path), `backup file written at ${backup.path}`)
  const backups = await h.invoke('backup:list')
  assert(backups.length >= 1, 'backup:list sees the backup')

  // Mutate: delete the voucher (soft) AND purge it, so restore provably brings it back.
  await h.invoke('voucher:delete', { id: saved.id })
  await h.invoke('voucher:purge', { id: saved.id })
  const tbAfterPurge = await h.invoke('report:trialBalance', { asOn: today })
  assertEq(tbAfterPurge.totalDebit, 0, 'voucher gone before restore')

  // Restore the exact backup we just took.
  const base = path.basename(backup.path)
  const entry = backups.find((b) => b.file === base) ?? backups[0]
  const preview = await h.invoke('backup:preview', { file: entry.file })
  assert(preview.valid && preview.integrity === 'ok', 'restore preview verifies backup integrity')
  assertEq(preview.company.name, 'Backup Co', 'restore preview identifies company')
  assertEq(preview.voucherCount, 1, 'restore preview reports source voucher count')

  await h.goto('settings')
  await h.page.getByRole('button', { name: 'Restore…', exact: true }).first().waitFor()
  await h.page.getByRole('button', { name: 'Restore…', exact: true }).first().click()
  await h.page.waitForFunction(() => document.body.innerText.includes('Integrity verified'))
  const modalText = await h.page.locator('[role="dialog"]').innerText()
  assert(modalText.includes('Backup Co') && /voucher period/i.test(modalText), 'restore modal shows identity, period and integrity')
  await h.shot('01-restore-preview')
  await h.clickText('Cancel')

  const restored = await h.invoke('backup:restore', { file: entry.file })
  assert(restored !== undefined, 'backup:restore answered')

  const tb = await h.invoke('report:trialBalance', { asOn: today })
  assertEq(tb.totalDebit, 55500, 'restored books have the voucher back (TB debit)')
  assertEq(tb.totalCredit, 55500, 'restored books have the voucher back (TB credit)')

  // A complete backup must survive a clean-company import with managed evidence, not just SQLite.
  const evidencePath = path.join(h.outDir, 'portable-evidence.txt')
  fs.writeFileSync(evidencePath, 'portable voucher evidence')
  await h.stubDialogs({ openPaths: [evidencePath] })
  const attached = await h.invoke('voucher:attachmentAdd', { id: saved.id, kind: 'receipt' })
  assertEq(attached.length, 1, 'voucher evidence attached before complete backup')
  const passphrase = 'portable backup test phrase'
  const complete = await h.invoke('backup:exportEncrypted', { passphrase })
  assert(fs.existsSync(complete.path), 'complete encrypted package written')
  assert(complete.entries > 1 && complete.attachments === 1, 'complete package reports database and evidence')

  await h.invoke('company:close')
  await h.stubDialogs({ openPaths: [complete.path] })
  const imported = await h.invoke('backup:importEncrypted', { passphrase })
  assert(imported && imported.format === 'complete', 'complete package imported as a separate company')
  assertEq(imported.attachmentsRestored, 1, 'complete import restored the managed attachment')
  await h.invoke('company:open', { slug: imported.slug })
  const restoredAttachments = await h.invoke('voucher:attachments', { id: saved.id })
  assertEq(restoredAttachments.length, 1, 'clean-company restore retained voucher evidence')
  assert(fs.existsSync(restoredAttachments[0].storedPath), 'restored evidence exists at the rebased managed path')

  // The UI survives a restore: navigate + render the backups tab.
  await h.goto('settings')
  await h.shot('02-settings-after-restore')
})
