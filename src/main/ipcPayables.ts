// IPC channels for payables (WP 4.3): payment planning, payment runs (planned / batch payment
// vouchers), the MSME report and Form 1 export, the s.16 bank-rate table, supplier statements and
// supplier reconciliation, and the dashboard's "MSME due this week". Registered from ipc.ts with
// its `handle` (role gate + { ok, data | error } envelope); every payload is Zod-parsed here.
// Every write channel is mapped in auditCoverage.ts.
import { shell } from 'electron'
import { writeFileSync } from 'fs'
import { join } from 'path'
import type { DB } from './db/connection'
import type { CompanyInfo } from '@shared/domain'
import type { Role } from './services/roles'
import {
  bankRateSaveSchema, msmeDueSchema, msmeReportSchema, payablesPlanSchema, paymentRunIdSchema, paymentRunSchema, runExportSchema,
  supplierReconSchema, supplierStatementSchema
} from '@shared/payables/schemas'
import * as payables from './services/payables'
import { writeAudit } from './services/audit'
import { companyExportsDir } from './paths'

type Handle = (channel: string, fn: (payload: unknown) => unknown, minRole?: Role) => void
interface Company { db: DB; info: CompanyInfo; slug: string }

const writeExport = (c: Company, filename: string, text: string, kind: string, detail: Record<string, unknown>): { path: string } => {
  const path = join(companyExportsDir(c.slug), filename)
  writeFileSync(path, text, 'utf8')
  writeAudit(c.db, 'export', 0, 'export', null, { kind, ...detail, path })
  shell.showItemInFolder(path)
  return { path }
}

export function registerPayablesIpc(handle: Handle, company: () => Company): void {
  const db = (): DB => company().db

  // ---------- planning ----------
  handle('payables:plan', (p) => payables.payablesPlan(db(), payablesPlanSchema.parse(p).asOn), 'viewer')
  handle('payables:msmeDue', (p) => payables.msmeDueSummary(db(), msmeDueSchema.parse(p).asOn), 'viewer')

  // ---------- payment runs ----------
  handle('payables:previewRun', (p) => payables.previewPaymentRun(db(), paymentRunSchema.parse(p)), 'viewer')
  handle('payables:createRun', (p) => payables.createPaymentRun(db(), paymentRunSchema.parse(p)))
  handle('payables:runs', () => payables.listPaymentRuns(db()), 'viewer')
  handle('payables:run', (p) => payables.getPaymentRun(db(), paymentRunIdSchema.parse(p).id), 'viewer')
  // HOOK (WP 4.1): bank-specific bulk payment files belong to WP 4.1's export; this is the
  // generic per-run CSV until it lands.
  handle('payables:runExportCsv', (p) => {
    const { id } = runExportSchema.parse(p)
    const c = company()
    const { csv, filename } = payables.paymentRunCsv(c.db, id)
    return writeExport(c, filename, csv, 'payment_run_csv', { runId: id })
  }, 'viewer')

  // ---------- MSME ----------
  handle('payables:msmeReport', (p) => payables.msmeReport(db(), msmeReportSchema.parse(p)), 'viewer')
  handle('payables:msmeForm1Csv', (p) => {
    const q = msmeReportSchema.parse(p)
    const c = company()
    const { csv, filename, rows } = payables.msmeForm1Csv(c.db, q)
    return { ...writeExport(c, filename, csv, 'msme_form1_csv', { asOn: q.asOn, formPeriodDate: q.formPeriodDate ?? null, rows }), rows }
  }, 'viewer')
  handle('payables:bankRates', () => payables.listBankRates(db()), 'viewer')
  // The s.16 rate table is reference data like the TDS / statutory rate masters: owner-edited.
  handle('payables:bankRateSave', (p) => {
    const { id, data } = bankRateSaveSchema.parse(p)
    return payables.saveBankRate(db(), data, id)
  }, 'owner')
  handle('payables:bankRateDelete', (p) => {
    payables.deleteBankRate(db(), paymentRunIdSchema.parse(p).id)
    return null
  }, 'owner')

  // ---------- supplier statement / reconciliation ----------
  handle('payables:supplierStatement', (p) => {
    const q = supplierStatementSchema.parse(p)
    return payables.supplierStatement(db(), q.ledgerId, q.from, q.to)
  }, 'viewer')
  handle('payables:supplierRecon', (p) => payables.supplierRecon(db(), supplierReconSchema.parse(p)), 'viewer')
}
