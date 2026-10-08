// MCP resources (WP 5.7): company info, the chart of accounts and the read-only CSV/JSON mirrors
// the agent bridge writes under <company>/agent/ — all computed from the database when read,
// never from files, and passed through the session's privacy transform (masking /
// pseudonymisation of text values; amounts stay integer paise). No SDK import.
import type { DB } from '../db/connection'
import { fyOf, todayISO } from '@shared/dates'
import { MCP_RESOURCES } from '@shared/mcp'
import { readCompanyInfo } from '../db/seed'
import { groupTree, listLedgers } from '../services/masters'
import { buildMirrorFiles, mirrorVoucherYears, type MirrorOptions } from '../services/agentBridge'
import type { GroupTreeNode } from '@shared/reports'
import type { PrivacyOptions } from '../ai/privacy'
import { fitToBudget } from '../ai/truncate'
import { mcpMaskString, mcpMaskValue } from './mask'

/** Characters per resource read — the same bound as a tool result. A bigger mirror comes back
 *  trimmed (arrays cut with a marker; CSV rows cut) with a note saying how to get the rest. */
export const MCP_RESOURCE_BUDGET = 120_000
export const RESOURCE_TRUNCATED_NOTE =
  'Truncated to fit — use the ledger_statement / day_book / trial_balance tools with dates (or a narrower FY file) for the full data.'

/** Fit one resource body to the budget: JSON keeps its shape (arrays trimmed, wrapped with a note),
 *  CSV keeps its header and whole rows, then a comment line. */
export function fitResource(mimeType: string, text: string, budget = MCP_RESOURCE_BUDGET): string {
  if (text.length <= budget) return text
  if (mimeType === 'application/json') {
    const fitted = fitToBudget(JSON.parse(text) as unknown, budget - 400)
    return JSON.stringify({ truncated: true, note: RESOURCE_TRUNCATED_NOTE, originalChars: text.length, data: fitted.value }, null, 2)
  }
  const lines = text.split('\n')
  const out: string[] = []
  let size = 0
  for (const line of lines) {
    if (size + line.length + 1 > budget - 300) break
    out.push(line)
    size += line.length + 1
  }
  out.push(`# ${RESOURCE_TRUNCATED_NOTE} (${lines.length - out.length} of ${lines.length} lines not shown)`)
  return out.join('\n')
}

export interface McpResourceInfo {
  uri: string
  name: string
  title: string
  description: string
  mimeType: 'application/json' | 'text/csv'
}

const MIRROR_STATIC: { file: string; title: string; description: string; mimeType: McpResourceInfo['mimeType']; opts: MirrorOptions }[] = [
  { file: 'ledgers.csv', title: 'Ledgers (CSV)', description: 'Every ledger: id, name, group, opening balance (paise), GSTIN, state, HSN, GST rate, credit days.', mimeType: 'text/csv', opts: { what: 'masters', format: 'csv' } },
  { file: 'ledgers.json', title: 'Ledgers (JSON)', description: 'Every ledger with all its master fields and its group name. Amounts in integer paise.', mimeType: 'application/json', opts: { what: 'masters', format: 'json' } },
  { file: 'items.csv', title: 'Stock items (CSV)', description: 'Every stock item: id, name, group, unit, HSN, GST rate, opening quantity (milli-units) and value (paise).', mimeType: 'text/csv', opts: { what: 'masters', format: 'csv' } },
  { file: 'trial-balance.json', title: 'Trial balance (today)', description: 'Trial balance as on today, integer paise, dr-positive.', mimeType: 'application/json', opts: { what: 'reports', format: 'json' } },
  { file: 'outstandings.json', title: 'Outstandings (today)', description: 'Receivable and payable bills as on today, integer paise.', mimeType: 'application/json', opts: { what: 'reports', format: 'json' } },
  { file: 'meta.json', title: 'Mirror metadata', description: 'Mirror schema version, units, voucher types and the file list.', mimeType: 'application/json', opts: { what: 'masters', format: 'all' } }
]

const VOUCHERS_RE = /^vouchers-(\d{4})-\d{2}\.json$/

export function listMcpResources(db: DB): McpResourceInfo[] {
  const out: McpResourceInfo[] = [
    { uri: MCP_RESOURCES.company, name: 'company', title: 'Company', description: 'Name, GSTIN, PAN, state, registration type, books-from year.', mimeType: 'application/json' },
    {
      uri: MCP_RESOURCES.chartOfAccounts,
      name: 'chart-of-accounts',
      title: 'Chart of accounts',
      description: 'The group tree (nature: asset / liability / income / expense) with every ledger (id, name) under its group.',
      mimeType: 'application/json'
    },
    ...MIRROR_STATIC.map((m) => ({ uri: `${MCP_RESOURCES.mirrorPrefix}${m.file}`, name: m.file, title: m.title, description: m.description, mimeType: m.mimeType }))
  ]
  for (const fy of mirrorVoucherYears(db)) {
    const file = `vouchers-${fy}.json`
    out.push({
      uri: `${MCP_RESOURCES.mirrorPrefix}${file}`,
      name: file,
      title: `Vouchers FY ${fy}`,
      description: `Every voucher of FY ${fy} in the books (binned ones excluded) with its lines, stock lines and bill references. Integer paise.`,
      mimeType: 'application/json'
    })
  }
  return out
}

interface ChartNode {
  id: number
  name: string
  nature: GroupTreeNode['nature']
  ledgers: { id: number; name: string }[]
  groups: ChartNode[]
}

function chartOfAccounts(db: DB): ChartNode[] {
  const byGroup = new Map<number, { id: number; name: string }[]>()
  for (const l of listLedgers(db)) byGroup.set(l.groupId, [...(byGroup.get(l.groupId) ?? []), { id: l.id, name: l.name }])
  const walk = (n: GroupTreeNode): ChartNode => ({
    id: n.id,
    name: n.name,
    nature: n.nature,
    ledgers: (byGroup.get(n.id) ?? []).sort((a, b) => a.name.localeCompare(b.name)),
    groups: n.children.map(walk)
  })
  return groupTree(db).map(walk)
}

/** Read one resource. Throws for an unknown URI. */
export function readMcpResource(db: DB, slug: string, uri: string, privacy: PrivacyOptions, today = todayISO()): { mimeType: string; text: string } {
  const r = readRaw(db, slug, uri, privacy, today)
  return { mimeType: r.mimeType, text: fitResource(r.mimeType, r.text) }
}

function readRaw(db: DB, slug: string, uri: string, privacy: PrivacyOptions, today: string): { mimeType: string; text: string } {
  const json = (v: unknown): { mimeType: string; text: string } => ({ mimeType: 'application/json', text: JSON.stringify(mcpMaskValue(v, privacy), null, 2) })
  const text = (s: string, key: string | null): string => mcpMaskString(s, key, privacy)
  if (uri === MCP_RESOURCES.company) {
    const c = readCompanyInfo(db)
    return json({
      slug,
      name: c.name,
      gstin: c.gstin,
      pan: c.pan,
      stateCode: c.stateCode,
      registrationType: c.gstRegistrationType,
      booksFromFy: `${c.booksFrom}-${String((c.booksFrom + 1) % 100).padStart(2, '0')}`,
      currentFy: fyOf(today),
      today,
      amountsUnit: 'paise (integer, 100 paise = 1 rupee) in mirrors; tools return formatted rupees'
    })
  }
  if (uri === MCP_RESOURCES.chartOfAccounts) return json({ groups: chartOfAccounts(db) })
  if (uri.startsWith(MCP_RESOURCES.mirrorPrefix)) {
    const file = uri.slice(MCP_RESOURCES.mirrorPrefix.length)
    const fixed = MIRROR_STATIC.find((m) => m.file === file)
    let opts: MirrorOptions | null = fixed ? { ...fixed.opts, to: fixed.opts.what === 'reports' ? today : undefined } : null
    const fy = VOUCHERS_RE.exec(file)
    if (!opts && fy) {
      const range = fyOf(`${fy[1]}-04-01`)
      opts = { what: 'vouchers', format: 'json', from: range.from, to: range.to }
    }
    if (opts) {
      const found = buildMirrorFiles(db, slug, opts, text).find((f) => f.name === file)
      if (found) return { mimeType: found.mimeType, text: found.content }
      if (fy) throw new Error(`No vouchers in FY ${file.slice(9, 16)}`)
    }
  }
  throw new Error(`Unknown resource ${uri}`)
}
