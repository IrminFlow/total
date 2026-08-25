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
  assert(applied.importId > 0, 'applied statement is retained as durable evidence')
  const after = await h.invoke('bank:recon', { ledgerId: hdfc.id, from: yearAgo, to: today })
  const openAfter = after.rows.filter((r) => !r.bankDate)
  assertEq(openAfter.length, lines.length - applied.matched, 'matched lines are now reconciled')

  // BRS computes for the ledger.
  const brs = await h.invoke('banking:brs', { ledgerId: hdfc.id, asOn: today })
  assert(brs && typeof brs === 'object', 'banking:brs returns a statement')

  const workspace = await h.invoke('bank:workspace', { ledgerId: hdfc.id })
  assertEq(workspace.latestImport.id, applied.importId, 'control room opens the latest durable import')
  assert(workspace.counts.matched >= 2, 'workspace separates matched rows')
  assert(workspace.counts.bankOnly >= 1, 'workspace separates bank-only rows')
  const bankOnly = workspace.statementRows.find((row) => row.status === 'bank_only')
  assert(bankOnly, 'unmatched statement row remains reviewable')
  await h.invoke('bank:classifyRow', { id: bankOnly.id, status: 'timing_difference', note: 'E2E reviewed timing item' })
  const reviewed = await h.invoke('bank:workspace', { ledgerId: hdfc.id })
  assertEq(reviewed.counts.timingDifference, 1, 'reviewed timing state persists')

  const allLedgers = await h.invoke('master:ledgers:list')
  const bankIds = new Set(bankLedgers.map((ledger) => ledger.id))
  const expense = allLedgers.find((ledger) => !bankIds.has(ledger.id))
  assert(expense, 'demo company has a non-bank ledger for learned-rule coverage')
  const learned = await h.invoke('bankrule:save', { data: { pattern: 'E2E LEARNED', ledgerId: expense.id, kind: 'payment', active: true, source: 'learned' } })
  assertEq(learned.confidenceBp, 6000, 'learned rule starts with a cautious confidence')
  await h.invoke('bankrule:hit', { id: learned.id })
  const rolledBack = await h.invoke('bankrule:rollback', { id: learned.id })
  assertEq(rolledBack.active, false, 'learned mapping can be rolled back')

  await h.goto('banking')
  await h.page.getByTestId('banking-ledger').selectOption(String(hdfc.id))
  await h.page.getByTestId('bank-control-room').waitFor()
  await h.shot('01-banking-screen')

  await h.page.getByRole('button', { name: 'Treasury' }).click()
  await h.page.getByTestId('treasury-forecast').waitFor()
  await h.shot('02-treasury-forecast')

  await h.page.getByRole('button', { name: 'Cash count' }).click()
  await h.page.getByTestId('cash-count-workspace').waitFor()
  await h.shot('03-cash-count')

  await h.page.getByRole('button', { name: 'Cheques' }).click()
  await h.page.getByTestId('cheque-lifecycle').waitFor()

  await h.page.getByRole('button', { name: 'Transfers' }).click()
  await h.page.getByTestId('bank-transfer-suggestions').waitFor()

  await h.page.getByRole('button', { name: 'Charges' }).click()
  await h.page.getByTestId('bank-charge-suggestions').waitFor()

  await h.page.getByRole('button', { name: 'Feeds' }).click()
  await h.page.getByTestId('bank-feeds').waitFor()
  await h.shot('04-optional-feeds')
})
