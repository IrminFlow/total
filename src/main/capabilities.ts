// WP 7.2 — which IPC channels each capability flag governs (shared/capabilities.ts has the flags).
//
// - canPost: every gated channel whose audit coverage writes the 'voucher' entity (saving,
//   binning, restoring, importing, posting runs …) — derived from AUDIT_COVERAGE, so a new
//   posting channel is covered the day it is mapped there (capabilities.dbtest.ts checks it).
// - canSeeProfit: the screens that show profit / loss (the P&L, the balance sheet's profit line,
//   comparatives, ratios, item profitability, cash flow, budget variance, the simple "How am I
//   doing"). Dashboards and simple Home keep working with their profit figures left out (ipc.ts).
// - canExport: the channels that write the books (or a report of them) to a file. The CA pack
//   (export:caPack) writes the P&L and balance sheet too, so its handler also checks canSeeProfit.
// - canManageAi: the AI assistant's and agent access's settings.
//
// The gate (ipc.ts `handle`): no flag → the channel's minimum role decides, as always. A flag set
// to false refuses the channel; set to true allows it up to the capability's ceiling — a flag never
// opens an owner-only channel except canManageAi, whose whole point is the owner's AI settings.
import type { Capability, CapabilityFlags } from '@shared/capabilities'
import { AUDIT_COVERAGE } from './auditCoverage'
import { roleAllows, type Role } from './services/roles'

export const PROFIT_CHANNELS: readonly string[] = [
  'report:profitLoss',
  'report:balanceSheet',
  'report:comparative',
  'report:ratios',
  'report:itemProfitability',
  'report:cashFlow',
  'budget:variance',
  'simple:reports:doing',
  // PR #127 review: the year-end close preview IS the net profit to transfer; a consolidated
  // P&L / trial balance includes the open business's own statement.
  'yearend:preview',
  // The re-close check shows each closed year's net profit and the lines it would post.
  'yearEnd:repairPreview',
  'consol:run',
  'consolGroup:run'
]

export const EXPORT_CHANNELS: readonly string[] = [
  'agent:exportMirror',
  'audit:exportCsv',
  'audit:exportPdf',
  'backup:exportEncrypted',
  'budget:exportCsv',
  // PR #144 review: the bank's bulk-payment upload file (each supplier's account number and the
  // amounts) — a file of the books, like the payables run CSV.
  'bulkPay:export',
  // PR #155 review: the bank reconciliation statement PDF is a report of the books written to a
  // file (each bank entry, the book and bank balances), like report:pdf — it was neither gated nor audited.
  'banking:brsPdf',
  'edoc:exportEInvoice',
  'edoc:exportEwb',
  'edoc:ewbJson',
  'export:books',
  'export:caPack',
  'export:csv',
  'export:tallyXml',
  'export:xlsx',
  'gst:exportGstr1',
  'gst:exportGstr3b',
  'gst:exportGstr9',
  'gst:exportItc04',
  'gst:imsExport',
  // The IRP-signed invoice + QR of one e-invoice, written to a file.
  'nic:signedCopyExport',
  'payables:msmeForm1Csv',
  'payables:runExportCsv',
  // PR #144 review: the PF ECR and ESI upload files are statutory return files like the PT CSV
  // (employees' wages, UAN / IP numbers) — they were missed.
  'payroll:ecr',
  'payroll:esi',
  'payroll:ptCsv',
  'payroll:ptReturnCsv',
  // PR #155 review: a report pack writes its reports (trial balance, P&L …) to a folder — now
  // (pack:runNow) or on every open from its schedule (pack:save sets the folder and schedule).
  'pack:runNow',
  'pack:save',
  'pricing:exportCsv',
  'rb:exportJson',
  // PR #140 review: a party's statement PDF is a report of the books written to a file, like
  // report:pdf — a viewer may save it (its minimum role), unless the owner turned canExport off.
  'receivables:statementPdf',
  // Review follow-up: every customer's statement written to a folder — a report of the books to
  // files, like report:pdf (accountant, its minimum role, unless the owner turned canExport off).
  'receivables:statementsBulk',
  'report:pdf',
  'tcs:export27eq',
  'tds:export26q',
  'tds:form24qCsv'
]

/**
 * Channels audited as an 'export' (AUDIT_COVERAGE) that are NOT exports of the books, by decision
 * — prints of one document, blank templates and test pages follow their role only
 * (docs/security/encryption-at-rest.md). Every other 'export'-audited channel must be in
 * EXPORT_CHANNELS (security.dbtest.ts), so a new export channel can't miss the canExport gate.
 */
export const NOT_EXPORTS: Readonly<Record<string, string>> = {
  'invoice:pdf': 'print of one document',
  'invoice:pdfBatch': 'prints of the chosen documents',
  'counter:print': 'print of a counter bill',
  'tradeDocs:pdf': 'print of a quotation / order',
  'payroll:payslip': 'print of a payslip',
  'payroll:form16Pdf': "an employee's tax certificate: a document the business hands over, like a payslip",
  'tds:form16aPdf': 'TDS certificate (Form 16A) the business hands over',
  'tcs:form27dPdf': 'TCS certificate (Form 27D) the business hands over',
  'gst:selfInvoicePdf': 'print of a self-invoice',
  'stock:labelsPdf': 'barcode label print',
  'template:export': 'a print-template definition (layout, fonts, column choices): no books data in it',
  'cheque:pdf': 'cheque print',
  'cheque:testGrid': 'cheque alignment test page',
  'cheque:advice': 'payment advice print',
  'cheques:print': 'cheque print (consumes leaves)',
  'template:testPdf': 'print-template test page',
  'import:template': 'blank import template',
  'importwiz:sample': 'blank import sample'
}

export const AI_CHANNELS: readonly string[] = ['ai:settings:set', 'ai:notice:accept', 'ai:testConnection', 'agent:mcp:set']

/** The highest minimum role a granted flag can open. */
const CEILING: Record<Capability, Role> = { canPost: 'accountant', canSeeProfit: 'accountant', canExport: 'accountant', canManageAi: 'owner' }

/** Channels whose coverage writes vouchers (the posting channels), ungated ones excluded. */
export function postingChannels(ungated: ReadonlySet<string>): string[] {
  return Object.entries(AUDIT_COVERAGE)
    .filter(([ch, cov]) => !ungated.has(ch) && 'audit' in cov && cov.audit.includes('voucher'))
    .map(([ch]) => ch)
    .sort()
}

/** channel → capability, built once by ipc.ts. A channel in two lists takes the first (posting). */
export function channelCapabilities(ungated: ReadonlySet<string>): Map<string, Capability> {
  const m = new Map<string, Capability>()
  const put = (chs: readonly string[], cap: Capability): void => {
    for (const ch of chs) if (!m.has(ch)) m.set(ch, cap)
  }
  put(postingChannels(ungated), 'canPost')
  put(EXPORT_CHANNELS, 'canExport')
  put(PROFIT_CHANNELS, 'canSeeProfit')
  put(AI_CHANNELS, 'canManageAi')
  return m
}

/** The gate for a channel governed by `cap`. Owners are never restricted. */
export function capabilityAllows(role: Role, flags: CapabilityFlags | null | undefined, cap: Capability, minRole: Role): boolean {
  if (role === 'owner') return true
  const flag = flags?.[cap]
  if (flag === false) return false
  if (flag === true) return roleAllows(CEILING[cap], minRole)
  return roleAllows(role, minRole)
}
