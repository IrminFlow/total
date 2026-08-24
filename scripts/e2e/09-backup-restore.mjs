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
  const restored = await h.invoke('backup:restore', { file: entry.file })
  assert(restored !== undefined, 'backup:restore answered')

  const tb = await h.invoke('report:trialBalance', { asOn: today })
  assertEq(tb.totalDebit, 55500, 'restored books have the voucher back (TB debit)')
  assertEq(tb.totalCredit, 55500, 'restored books have the voucher back (TB credit)')

  // The UI survives a restore: navigate + render the backups tab.
  await h.goto('settings')
  await h.shot('01-settings-after-restore')

  // ---- proving a backup, rather than promising one ----
  // A backup button that has never been proved is a promise, and a business finds out whether it
  // was true on the worst day of its year. Checking quick_check is not proof: a structurally
  // valid SQLite file can still hold books that do not add up.
  const toVerify = await h.invoke('backup:list')
  assert(toVerify.length > 0, 'there is a backup to verify')

  const verified = await h.invoke('backup:verify', { file: toVerify[0].file })
  assert(verified.integrityOk, 'the backup is structurally sound')
  assert(verified.opensAsCompany, 'and is a Total company database')
  assert(verified.balanced, 'and the books inside it balance')
  assert(verified.totalDebit === verified.totalCredit, 'debits equal credits in the backup')
  assert(verified.problem === null, 'with nothing to report')

  // The count is the backup's own, not the live books' — that is what makes it a check.
  assert(typeof verified.voucherCount === 'number', 'it counts the vouchers it found')

  // On screen, verification is on demand: opening twenty databases to answer a question nobody
  // asked would be worse than not offering it.
  await h.goto('settings')
  await h.page.click('[data-testid="tab-settings-backups"]')
  await h.page.waitForSelector(`[data-testid="btn-verify-${toVerify[0].file}"]`, { timeout: 15000 })
  await h.page.click(`[data-testid="btn-verify-${toVerify[0].file}"]`)
  await h.page.waitForSelector(`[data-testid="verify-result-${toVerify[0].file}"]`, { timeout: 15000 })
  const resultText = await h.page.textContent(`[data-testid="verify-result-${toVerify[0].file}"]`)
  assert(/books balance/.test(resultText), `the result says the books balance (got ${resultText})`)
  await h.shot('05-verified')

  // ---- the Gateway says when the books were last backed up ----
  await h.goto('gateway')
  await h.page.waitForSelector('[data-testid="gateway-last-backup"]', { timeout: 15000 })
  const line = await h.page.textContent('[data-testid="gateway-last-backup"]')
  assert(/Last backup/.test(line), `the Gateway states the last backup (got ${line})`)
  assert(new RegExp(`${toVerify.length} kept`).test(line), 'and how many are kept')

  // ---- what a restore would cost, before it costs it ----
  // "This replaces the current books" is true and abstract. What someone needs is how many
  // vouchers exist now that do not exist in the backup, because those get typed again.
  const liveCount = await h.invoke('voucher:count')
  assert(typeof liveCount === 'number', 'the books report a voucher count')
  const backupCount = (await h.invoke('backup:verify', { file: toVerify[0].file })).voucherCount
  assert(typeof backupCount === 'number', 'and so does the backup')

  await h.goto('settings')
  await h.page.click('[data-testid="tab-settings-backups"]')
  await h.page.waitForSelector('[data-testid="btn-verify-' + toVerify[0].file + '"]', { timeout: 15000 })
  // Restore is owner-gated. A company with no users has no signed-in role, so the control is
  // absent — which is correct, and is why this checks rather than assumes.
  const restoreBtn = await h.page.$(`[data-testid="btn-restore-${toVerify[0].file}"]`)
  if (restoreBtn) {
    await restoreBtn.click()
    await h.page.waitForSelector('[data-testid="restore-impact"]', { timeout: 15000 })
    const impact = await h.page.textContent('[data-testid="restore-impact"]')
    if (liveCount > backupCount) {
      assert(
        new RegExp(`${liveCount - backupCount}`).test(impact),
        `it names how many vouchers would be lost (got ${impact})`
      )
    } else {
      assert(impact.length > 0, `it says where the two stand (got ${impact})`)
    }
    await h.shot('06-restore-impact')
    await h.page.keyboard.press('Escape')
  }

  // ---- backup retention is the business's choice ----
  // Twenty was a guess: a business that opens its books four times a day burns through twenty in
  // a week, and one that opens weekly keeps five months in the same twenty.
  const before = await h.invoke('config:backupKeep:get')
  assert(before.keep === 20, `the default is twenty (got ${before.keep})`)
  const set = await h.invoke('config:backupKeep:set', { keep: 50 })
  assert(set.keep === 50, 'and it can be changed')

  // A retention of one is not a backup policy but a mirror — the next open would overwrite the
  // only copy, and the one thing backups exist to survive is a mistake noticed later.
  let refused = false
  try {
    await h.invoke('config:backupKeep:set', { keep: 1 })
  } catch {
    refused = true
  }
  assert(refused, 'a retention of one is refused')
  await h.invoke('config:backupKeep:set', { keep: 20 })
})
