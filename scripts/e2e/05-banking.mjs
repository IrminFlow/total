// Scenario 05 — banking: statement import as a dry-run preview first, then apply; matched
// rows get bank dates; BRS computes. Uses the Demo Traders bank ledger (HDFC Bank) and the
// inline csvText path (no native dialog).
//
// RECONCILE: lane S4 adds the renderer preview-confirm step (import button → preview table →
// confirm). Once merged, drive that flow via its testids instead of raw IPC for the apply leg.
import { scenario, assert, assertEq } from '../lib/harness.mjs'

await scenario('05-banking', async (h) => {
  await h.createDemoCompany()

  const bankLedgers = await h.invoke('bank:ledgers')
  const hdfc = bankLedgers.find((l) => l.name === 'HDFC Bank') ?? bankLedgers[0]
  assert(hdfc, 'demo company has a bank ledger')

  // Find two real unreconciled book entries to make the statement from — the matcher wants
  // same amount, same direction, within ±5 days.
  const today = new Date().toISOString().slice(0, 10)
  const yearAgo = new Date(Date.now() - 200 * 86400000).toISOString().slice(0, 10)
  const recon = await h.invoke('bank:recon', { ledgerId: hdfc.id, from: yearAgo, to: today })
  const lines = recon.rows.filter((r) => !r.bankDate)
  assert(lines.length >= 2, `at least 2 unreconciled bank lines in demo data (got ${lines.length})`)
  const [a, b] = lines

  const csvOf = (r) =>
    `${r.date},${(r.particulars || 'entry').replaceAll(',', ' ')},${r.withdrawal ? (r.withdrawal / 100).toFixed(2) : ''},${r.deposit ? (r.deposit / 100).toFixed(2) : ''}`
  const csvText = ['Date,Description,Withdrawal,Deposit', csvOf(a), csvOf(b), `${today},Unknown counterparty,,42.00`].join('\n')

  // Dry run: nothing written, matches reported for the preview.
  const preview = await h.invoke('bank:importCsv', { ledgerId: hdfc.id, csvText, dryRun: true })
  assertEq(preview.statementRows, 3, 'preview parsed all statement rows')
  assert(preview.matched >= 2, `preview matched both real rows (got ${preview.matched})`)
  assert(preview.unmatched.length >= 1, 'the unknown row is reported unmatched')
  assertEq(preview.csvText, csvText, 'csvText rides back for the apply leg')

  // Still unreconciled after the dry run.
  const recheck = await h.invoke('bank:recon', { ledgerId: hdfc.id, from: yearAgo, to: today })
  const stillOpen = recheck.rows.filter((r) => !r.bankDate)
  assertEq(stillOpen.length, lines.length, 'dry run wrote nothing')

  // Apply for real: matched lines get their bank_date set.
  const applied = await h.invoke('bank:importCsv', { ledgerId: hdfc.id, csvText, dryRun: false })
  assert(applied.matched >= 2, 'apply matched the same rows')
  const after = await h.invoke('bank:recon', { ledgerId: hdfc.id, from: yearAgo, to: today })
  const openAfter = after.rows.filter((r) => !r.bankDate)
  assertEq(openAfter.length, lines.length - applied.matched, 'matched lines are now reconciled')

  // BRS computes for the ledger.
  const brs = await h.invoke('banking:brs', { ledgerId: hdfc.id, asOn: today })
  assert(brs && typeof brs === 'object', 'banking:brs returns a statement')

  await h.goto('banking')
  await h.shot('01-banking-screen')
})
