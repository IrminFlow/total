/**
 * Headless CLI command implementations (lane A). Each function is the exact same service call the
 * app's IPC handlers make — same connection module (WAL + busy_timeout, safe alongside a running
 * app), same migrations, same zod `voucherInputSchema` + `validateVoucher` + `saveVoucher` posting
 * path, same period lock. The dispatcher in `main.ts` handles argv/stdout; these stay testable
 * from `cli.dbtest.ts` without spawning a process.
 */
import { existsSync, writeFileSync } from 'fs'
import { join } from 'path'
import { openCompanyDb, openExistingCompanyDb, type DB } from '../db/connection'
import { seedCompany } from '../db/seed'
import { readRegistry, requireRegisteredCompany, upsertCompany, type Registry } from '../registry'
import { companyDbPath, dataRoot, ensureCompanyTree, slugify } from '../paths'
import { companyCreateSchema, voucherInputSchema } from '@shared/schemas'
import type { CompanyInfo, Voucher } from '@shared/domain'
import { fyOf, todayISO } from '@shared/dates'
import { saveVoucher, nextVoucherNumber } from '../services/vouchers'
import { trialBalance } from '../services/reports'
import type { TrialBalance } from '@shared/reports'
import { applyImport, type ImportKind, type ImportResult } from '../services/importers'
import { exportMirror, type MirrorOptions, type MirrorResult } from '../services/agentBridge'

export function cmdCompanies(): Registry {
  return readRegistry()
}

/** Open an existing company DB the same way the app does (migrations, WAL, busy_timeout). */
export function openCompany(slug: string): DB {
  try {
    requireRegisteredCompany(slug)
  } catch {
    throw new Error(`Company '${slug}' not found — run 'companies' to list slugs`)
  }
  return openExistingCompanyDb(slug)
}

export interface CreateCompanyOpts {
  name: string
  stateCode: string
  gstin?: string | null
  booksFrom?: number
}

/** Create + seed a company (same path as the app's company:create) and register it. */
export function cmdCreateCompany(opts: CreateCompanyOpts): { slug: string } {
  const input = companyCreateSchema.parse({
    name: opts.name,
    stateCode: opts.stateCode,
    gstin: opts.gstin ?? null,
    gstRegistrationType: 'regular',
    address: '',
    booksFrom: opts.booksFrom ?? Number(fyOf(todayISO()).from.slice(0, 4)),
    email: null,
    phone: null
  })
  let slug = slugify(input.name)
  let n = 2
  while (existsSync(companyDbPath(slug))) slug = `${slugify(input.name)}-${n++}`
  ensureCompanyTree(slug)
  const db = openCompanyDb(slug)
  const info: CompanyInfo = { ...input }
  seedCompany(db, info)
  db.close()
  upsertCompany({ slug, name: input.name, stateCode: input.stateCode, gstin: input.gstin, lastOpenedAt: null })
  return { slug }
}

export type PostResult =
  | { index: number; ok: true; id: number; number: string; date: string; total: number }
  | { index: number; ok: false; error: string }

/**
 * Post one voucher or an array of vouchers from parsed JSON. Each item is independently
 * zod-validated and saved (partial success is possible — the per-item results say exactly
 * what happened, so the caller can retry only the failures).
 */
export function cmdPost(db: DB, payload: unknown): PostResult[] {
  const items = Array.isArray(payload) ? payload : [payload]
  return items.map((item, index): PostResult => {
    try {
      const input = voucherInputSchema.parse(item)
      const saved: Voucher = saveVoucher(db, input)
      const total = saved.lines.filter((l) => l.drCr === 'dr').reduce((s, l) => s + l.amount, 0)
      return { index, ok: true, id: saved.id, number: saved.number, date: saved.date, total }
    } catch (err) {
      const message =
        err && typeof err === 'object' && 'issues' in err
          ? (err as { issues: { path: (string | number)[]; message: string }[] }).issues
              .map((i) => `${i.path.join('.')}: ${i.message}`)
              .join('; ')
          : err instanceof Error
            ? err.message
            : String(err)
      return { index, ok: false, error: message }
    }
  })
}

export function cmdImportMasters(db: DB, kind: ImportKind, csvText: string): ImportResult {
  return applyImport(db, kind, csvText)
}

export function cmdTrialBalance(db: DB, asOn: string): TrialBalance & { asOn: string } {
  return { asOn, ...trialBalance(db, asOn) }
}

/** Resolve a voucher type by numeric id or (case-insensitive) name, then compute the next number. */
export function cmdNextNumber(db: DB, typeRef: string, date: string): { voucherTypeId: number; number: string } {
  const types = db.prepare('SELECT id, name FROM voucher_types').all() as { id: number; name: string }[]
  const byId = /^\d+$/.test(typeRef) ? types.find((t) => t.id === Number(typeRef)) : undefined
  const byName = types.find((t) => t.name.toLowerCase() === typeRef.toLowerCase())
  const vt = byId ?? byName
  if (!vt) {
    throw new Error(`Unknown voucher type '${typeRef}'. Known: ${types.map((t) => `${t.id}=${t.name}`).join(', ')}`)
  }
  return { voucherTypeId: vt.id, number: nextVoucherNumber(db, vt.id, date) }
}

export function cmdExport(db: DB, slug: string, opts: MirrorOptions): MirrorResult {
  return exportMirror(db, slug, opts)
}

/** Write the agent-facing docs (AGENTS.md + voucher.schema.json) into the data root, so any agent
 *  pointed at ~/Documents/total self-discovers the contract. Content is passed in by main.ts
 *  (bundled at build time) so this stays testable with plain strings. */
export function cmdInitAgentDocs(agentsMd: string, voucherSchemaJson: string): { wrote: string[] } {
  const root = dataRoot()
  const wrote: string[] = []
  const agentsPath = join(root, 'AGENTS.md')
  writeFileSync(agentsPath, agentsMd)
  wrote.push(agentsPath)
  const schemaPath = join(root, 'voucher.schema.json')
  writeFileSync(schemaPath, voucherSchemaJson)
  wrote.push(schemaPath)
  return { wrote }
}
