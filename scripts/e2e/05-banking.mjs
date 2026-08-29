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

  // ---- where every account stands, on one page ----
  // The Reconcile tab answers this one account at a time and only once you have picked one, so a
  // business with four accounts cannot see which one is behind.
  const status = await h.invoke('bank:reconciliationStatus', { asOn: '2026-12-31' })
  assert(status.length > 0, 'the status covers every bank account')
  for (const s of status) {
    assert(
      s.reconciledLines <= s.totalLines,
      `${s.name}: cannot have reconciled more lines than exist`
    )
    assert(
      s.ageing.reduce((a, b) => a + b, 0) === s.totalLines - s.reconciledLines,
      `${s.name}: the ageing buckets account for every open line`
    )
    // Same derivation the BRS uses, so a status row and a printed BRS can never disagree.
    const recon = await h.invoke('bank:recon', { ledgerId: s.ledgerId, from: '1900-01-01', to: '2026-12-31' })
    assert(s.bookBalance === recon.bookBalance, `${s.name}: book balance agrees with the BRS`)
    assert(s.bankBalance === recon.bankBalance, `${s.name}: bank balance agrees with the BRS`)
  }

  await h.goto('banking')
  await h.page.click('[data-testid="tab-banking-status"]')
  await h.page.waitForSelector('[data-testid="rows-recon-status"] tr', { timeout: 15000 })
  const progress = await h.page.$$eval('[data-testid="recon-progress"]', (els) =>
    els.map((e) => e.textContent.trim())
  )
  assert(progress.length === status.length, 'a progress figure per account')
  assert(
    progress.every((t) => /^\d+\/\d+$/.test(t)),
    `each reads as reconciled of total (got ${JSON.stringify(progress)})`
  )
  await h.shot('05-recon-status')
})
