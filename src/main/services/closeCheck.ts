/**
 * Gathering the numbers the month-end checklist compares.
 *
 * The rules live in `@shared/ai/closeCheck` — this file only collects, and every figure it
 * collects comes from the service that owns it rather than from a query written here. That is the
 * same discipline the AI tools follow, and for the same reason: a checklist that computes
 * "unreconciled" its own way is a checklist that can disagree with the Banking screen, and then
 * nobody knows which of the two is lying.
 *
 * Read-only. Nothing here closes, locks or posts anything.
 */

import type { DB } from '../db/connection'
import type { CompanyInfo } from '@shared/domain'
import { closeChecklist, type CloseChecklist } from '@shared/ai/closeCheck'
import { formatPaise } from '@shared/money'
import { daysBetween } from '@shared/dates'
import { companyBackupsDir } from '../paths'
import { listBackupsIn } from '../db/backup'
import { getLockDate } from './vouchers'
import { getFeatures } from './config'
import * as reports from './reports'
import * as banking from './banking'
import * as approvals from './approvals'
import * as recurring from './recurring'
import * as analysis from './analysis'
import { gstValidate } from './gst'

export function monthEndChecklist(
  db: DB,
  slug: string,
  info: CompanyInfo,
  from: string,
  to: string,
  today: string
): CloseChecklist {
  const features = getFeatures(db)
  const exceptions = reports.exceptions(db, from, to, info)
  const count = (key: string): number => exceptions.sections.find((s) => s.key === key)?.count ?? 0

  const bank = banking.reconciliationStatus(db, to)
  const unreconciledLines = bank.reduce((sum, b) => sum + (b.totalLines - b.reconciledLines), 0)

  // "Suspense" is a name, not a group, and a company may not have one at all — a missing
  // Suspense ledger is a clean month, not a missing check.
  const tb = reports.trialBalance(db, to)
  const suspense = tb.rows
    .filter((r) => /suspense/i.test(r.ledgerName))
    .reduce((sum, r) => sum + r.debit - r.credit, 0)

  const overdue90 = analysis
    .outstandings(db, 'receivable', to)
    .reduce((sum, p) => sum + (p.buckets[3] ?? 0), 0)

  // GST checks are only meaningful for a company that is registered at all.
  const gstIssues = info.gstRegistrationType === 'unregistered' ? [] : gstValidate(db, info, from, to)

  const backups = listBackupsIn(companyBackupsDir(slug))
  const newestMtime = backups.map((b) => b.mtime).sort((a, b) => a - b).at(-1) ?? null
  const newest = newestMtime == null ? null : new Date(newestMtime).toISOString().slice(0, 10)

  // Payroll for the month is "posted" when a run exists for it. Null when the feature is off, so
  // the item is skipped rather than failed — see the checklist's own handling.
  //
  // Counted directly rather than through the payroll service on purpose: that module reaches for
  // the PDF writer, which reaches for Electron's BrowserWindow, and this file is on the MCP
  // server's dependency graph — which is bundled against a deliberately tiny Electron stub so an
  // accidental Electron dependency fails loudly (see src/main/mcp/bundle.test.ts).
  const month = from.slice(0, 7)
  const payrollPosted = features.payroll
    ? ((db.prepare('SELECT COUNT(*) AS n FROM payroll_runs WHERE month = ?').get(month) as { n: number }).n > 0)
    : null

  return closeChecklist({
    from,
    to,
    unbalancedVouchers: count('unbalanced'),
    negativeStockItems: count('negativeStock'),
    unreconciledBankLines: unreconciledLines,
    bankLedgers: bank.length,
    gstBlockingIssues: gstIssues.filter((i) => i.severity === 'blocking').length,
    gstWarnings: gstIssues.filter((i) => i.severity === 'warning').length,
    pendingApprovals: approvals.pendingCount(db),
    // Anything still due as at the last day of the month was not posted for that month.
    recurringDue: recurring.due(db, to).length,
    suspensePaise: suspense,
    lastBackupDaysAgo: newest ? Math.max(0, daysBetween(newest, today)) : null,
    lockedUpTo: getLockDate(db),
    overdue90Paise: overdue90,
    payrollPosted,
    money: (paise) => formatPaise(paise)
  })
}
