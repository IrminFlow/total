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
  'consol:run',
  'consolGroup:run'
]

export const EXPORT_CHANNELS: readonly string[] = [
  'agent:exportMirror',
  'audit:exportCsv',
  'audit:exportPdf',
  'backup:exportEncrypted',
  'budget:exportCsv',
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
  'payables:msmeForm1Csv',
  'payables:runExportCsv',
  'payroll:ptCsv',
  'payroll:ptReturnCsv',
  'pricing:exportCsv',
  'rb:exportJson',
  'report:pdf',
  'tcs:export27eq',
  'tds:export26q',
  'tds:form24qCsv'
]

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
