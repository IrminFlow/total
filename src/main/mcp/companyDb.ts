/**
 * Opening a company for the MCP server.
 *
 * Read-only is enforced by SQLite itself (`readonly: true`), not by convention: a read-only
 * server *cannot* write even if a tool has a bug. That is worth more than any amount of care in
 * the tool implementations.
 *
 * The migration-count check mirrors services/consolidated.ts, which already opens other
 * companies' databases from a separate process. A schema older than the app's would silently
 * return wrong numbers rather than fail, so it fails.
 */

import Database from 'better-sqlite3'
import type { DB } from '../db/connection'
import { MIGRATIONS } from '../db/migrations'
import { companyDbPath } from '../paths'
import { readRegistry } from '../registry'
import type { CompanyInfo } from '@shared/domain'
import { readCompanyInfo } from '../db/seed'

export interface OpenedCompany {
  db: DB
  slug: string
  info: CompanyInfo
  writable: boolean
}

export function listCompanySlugs(): string[] {
  return readRegistry().companies.map((c) => c.slug)
}

export function openForMcp(slug: string, allowWrites: boolean): OpenedCompany {
  const known = listCompanySlugs()
  if (!known.includes(slug)) {
    throw new Error(`No company "${slug}". Known companies: ${known.join(', ') || '(none)'}`)
  }

  const db = new Database(companyDbPath(slug), { readonly: !allowWrites, fileMustExist: true })
  // WAL + busy_timeout are what make it safe to run alongside the open app; neither side takes
  // an exclusive lock. The app sets these on its own handle.
  db.pragma('busy_timeout = 5000')

  const { n } = db.prepare('SELECT COUNT(*) AS n FROM migrations').get() as { n: number }
  if (n !== MIGRATIONS.length) {
    db.close()
    throw new Error(
      `${slug}: database schema is at version ${n} but this build expects ${MIGRATIONS.length}. Open the company in Total once to migrate it.`
    )
  }

  return { db, slug, info: readCompanyInfo(db), writable: allowWrites }
}
