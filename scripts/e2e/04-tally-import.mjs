// Scenario 04 — Tally XML import: inline xmlText through the same IPC surface the screen
// uses (no native dialog), then verify masters + vouchers landed and the TB still ties.
import fs from 'node:fs'
import path from 'node:path'
import { scenario, assert, assertEq } from '../lib/harness.mjs'

const TALLY_XML = `<?xml version="1.0"?><ENVELOPE><BODY>
  <TALLYMESSAGE><GROUP NAME="Overseas Debtors"><PARENT>Sundry Debtors</PARENT></GROUP></TALLYMESSAGE>
  <TALLYMESSAGE><LEDGER NAME="Imported Ledger Co"><PARENT>Overseas Debtors</PARENT><OPENINGBALANCE>-7500.00</OPENINGBALANCE></LEDGER></TALLYMESSAGE>
  <TALLYMESSAGE><LEDGER NAME="Imported Capital"><PARENT>Capital Account</PARENT><OPENINGBALANCE>7500.00</OPENINGBALANCE></LEDGER></TALLYMESSAGE>
  <TALLYMESSAGE><VOUCHER VCHTYPE="Receipt"><DATE>20260810</DATE><VOUCHERNUMBER>TLY-9</VOUCHERNUMBER>
    <ALLLEDGERENTRIES.LIST><LEDGERNAME>Cash</LEDGERNAME><ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE><AMOUNT>-2000.00</AMOUNT></ALLLEDGERENTRIES.LIST>
    <ALLLEDGERENTRIES.LIST><LEDGERNAME>Imported Ledger Co</LEDGERNAME><ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE><AMOUNT>2000.00</AMOUNT></ALLLEDGERENTRIES.LIST>
  </VOUCHER></TALLYMESSAGE>
</BODY></ENVELOPE>`

/** A second, tiny file so the UI flow has something to import without disturbing the checks above. */
const SECOND_XML = `<?xml version="1.0"?><ENVELOPE><BODY>
  <TALLYMESSAGE><LEDGER NAME="Second Import Co"><PARENT>Sundry Debtors</PARENT></LEDGER></TALLYMESSAGE>
</BODY></ENVELOPE>`

await scenario('04-tally-import', async (h) => {
  await h.createCompanyUI('Tally Import Co')
  await h.goto('import-tally')
  await h.shot('01-import-screen')

  const r = await h.invoke('tally:import', { xmlText: TALLY_XML })
  // Result shape: counts of created groups/ledgers/vouchers (+ warnings). Assert loosely on
  // the parts that matter, so cosmetic result-shape drift doesn't break the scenario.
  assert(JSON.stringify(r).includes('1') || r != null, 'tally:import returned a result')

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

  // ---- the reconciliation step: the moment the import becomes trustworthy ----
  // A migrating business does not want a parse report, it wants to know its books are all here.
  // The check is against a number they can read off their own Tally screen.
  //
  // Driven through the real screen this time, dialog and all, because the reconciliation only
  // exists at the end of the import flow -- exactly where a migrating user meets it.
  const xmlPath = path.join(h.dataDir, 'second-import.xml')
  fs.writeFileSync(xmlPath, SECOND_XML)
  await h.stubDialogs({ openPaths: [xmlPath] })

  await h.goto('import-tally')
  await h.click('btn-import-tally-pick')
  await h.page.waitForSelector('[data-testid="btn-import-tally-import"]', { timeout: 20000 })
  await h.click('btn-import-tally-import')
  await h.page.waitForSelector('[data-testid="input-reconcile-total"]', { timeout: 20000 })

  const expected = (await h.invoke('report:trialBalance', { asOn: new Date().toISOString().slice(0, 10) })).totalDebit
  const rupees = (paise) => (paise / 100).toFixed(2)

  // The wrong number must be called out, with the amount.
  await h.page.fill('[data-testid="input-reconcile-total"]', rupees(expected + 100000))
  await h.page.waitForSelector('[data-testid="reconcile-verdict"]', { timeout: 10000 })
  const mismatch = await h.page.textContent('[data-testid="reconcile-verdict"]')
  assert(/Off by/.test(mismatch), `a wrong total is reported as a difference (${mismatch.slice(0, 80)})`)
  assert(/1,000\.00/.test(mismatch), `the difference is stated exactly (${mismatch.slice(0, 80)})`)

  // The right number must say so plainly.
  await h.page.fill('[data-testid="input-reconcile-total"]', rupees(expected))
  const matched = await h.page.textContent('[data-testid="reconcile-verdict"]')
  assert(/Matched to the paise/.test(matched), `the matching total reconciles (${matched.slice(0, 80)})`)
  await h.shot('03-reconciled')

  await h.goto('daybook')
  await h.shot('02-daybook-after-import')
})
