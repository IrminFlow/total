// Scenario 04 — Tally XML import: inline xmlText through the same IPC surface the screen
// uses (no native dialog), then verify masters + vouchers landed and the TB still ties.
import { scenario, assert, assertEq } from '../lib/harness.mjs'
import * as fs from 'node:fs'
import * as path from 'node:path'

const TALLY_XML = `<?xml version="1.0"?><ENVELOPE><BODY>
  <TALLYMESSAGE><GROUP NAME="Overseas Debtors"><PARENT>Sundry Debtors</PARENT></GROUP></TALLYMESSAGE>
  <TALLYMESSAGE><LEDGER NAME="Imported Ledger Co"><PARENT>Overseas Debtors</PARENT><OPENINGBALANCE>-7500.00</OPENINGBALANCE></LEDGER></TALLYMESSAGE>
  <TALLYMESSAGE><LEDGER NAME="Imported Capital"><PARENT>Capital Account</PARENT><OPENINGBALANCE>7500.00</OPENINGBALANCE></LEDGER></TALLYMESSAGE>
  <TALLYMESSAGE><VOUCHER VCHTYPE="Receipt"><DATE>20260810</DATE><VOUCHERNUMBER>TLY-9</VOUCHERNUMBER>
    <ALLLEDGERENTRIES.LIST><LEDGERNAME>Cash</LEDGERNAME><ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE><AMOUNT>-2000.00</AMOUNT></ALLLEDGERENTRIES.LIST>
    <ALLLEDGERENTRIES.LIST><LEDGERNAME>Imported Ledger Co</LEDGERNAME><ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE><AMOUNT>2000.00</AMOUNT></ALLLEDGERENTRIES.LIST>
  </VOUCHER></TALLYMESSAGE>
</BODY></ENVELOPE>`

await scenario('04-tally-import', async (h) => {
  await h.createCompanyUI('Tally Import Co')
  await h.goto('import-tally')
  await h.shot('01-import-screen')

  const xmlPath = path.join(h.dataDir, 'tally-export.xml')
  fs.writeFileSync(xmlPath, TALLY_XML)
  await h.stubDialogs({ openPaths: [xmlPath] })
  await h.click('btn-import-tally-pick')
  await h.page.waitForFunction(() => document.body.innerText.includes('nothing has been imported yet'))
  const previewText = await h.page.locator('[data-screen="import-tally"]').innerText()
  assert(previewText.includes('File fingerprint'), 'preview exposes source fingerprint')
  await h.shot('02-reviewed-file')

  await h.click('btn-import-tally-import')
  await h.page.waitForFunction(() => document.body.innerText.includes('Import complete and recorded'))
  const doneText = await h.page.locator('[data-screen="import-tally"]').innerText()
  assert(doneText.includes('Batch #1'), 'completed import exposes immutable batch identity')
  assert(doneText.includes('Verified fingerprint'), 'completed import retains source fingerprint')
  await h.shot('03-import-complete')

  let replayBlocked = false
  try {
    await h.invoke('tally:import', { xmlText: TALLY_XML })
  } catch (err) {
    replayBlocked = /already imported/i.test(String(err))
  }
  assert(replayBlocked, 'exact Tally file replay is blocked')

  const ledgers = await h.invoke('master:ledgers:list')
  const imported = ledgers.find((l) => l.name === 'Imported Ledger Co')
  assert(imported, 'imported ledger exists')

  const vouchers = await h.invoke('voucher:list', { from: '2026-08-01', to: '2026-08-31' })
  const tly = vouchers.find((v) => v.number === 'TLY-9')
  assert(tly, 'imported voucher TLY-9 exists')

  // Tally's negative-=-debit convention: Cash 2000 Dr / Imported Ledger Co 2000 Cr.
  const got = await h.invoke('voucher:get', { id: tly.id })
  const cashLine = got.lines.find((l) => l.drCr === 'dr')
  assertEq(cashLine.amount, 200000, 'debit line converted to paise with Tally sign convention')

  // Opening balance -7500 (Tally negative = debit) + the voucher must still leave a tied TB.
  const tb = await h.invoke('report:trialBalance', { asOn: '2027-03-31' })
  assertEq(tb.totalDebit, tb.totalCredit, 'TB ties after import')

  await h.goto('daybook')
  await h.shot('04-daybook-after-import')
})
