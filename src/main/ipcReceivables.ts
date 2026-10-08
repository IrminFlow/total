// IPC channels for receivables (WP 4.2): settings, statements of account, reminder letters,
// interest on overdue bills, credit holds, credit control, follow-ups / promised dates and the
// collection reports. Registered from ipc.ts with its `handle` (role gate + { ok, data | error }
// envelope); every payload is Zod-parsed here.
import { dialog, shell } from 'electron'
import { isAbsolute, relative, resolve } from 'path'
import { z } from 'zod'
import type { DB } from './db/connection'
import type { CompanyInfo } from '@shared/domain'
import type { Role } from './services/roles'
import { asOnSchema, isoDate } from '@shared/schemas'
import {
  collectionsSchema, followupInputSchema, followupsQuerySchema, interestChargesSchema, interestPreviewSchema, postInterestSchema,
  remindBulkSchema, reminderLogSchema, remindSchema, setHoldSchema, statementQuerySchema, statementsBulkSchema, topOverdueSchema
} from '@shared/receivables/schemas'
import { RECEIVABLES_SOURCES } from '@shared/receivables/sources'
import * as rx from './services/receivables'
import { dashPromisedPayments } from './services/dashboard'
import { companyExportsDir } from './paths'

type Handle = (channel: string, fn: (payload: unknown) => unknown, minRole?: Role) => void
interface Company { db: DB; info: CompanyInfo; slug: string }

/** `path` resolved, when it lies inside `root` (never `root/../x`, never a sibling `root-other`);
 *  null otherwise. */
export function insideExports(root: string, path: string): string | null {
  const base = resolve(root)
  const target = resolve(base, path)
  const rel = relative(base, target)
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) return null
  return target
}

export function registerReceivablesIpc(handle: Handle, company: () => Company): void {
  const db = (): DB => company().db

  // ---------- settings ----------
  handle('receivables:config', () => ({ config: rx.getReceivablesConfig(db()), sources: RECEIVABLES_SOURCES }), 'viewer')
  handle('receivables:setConfig', (p) => rx.setReceivablesConfig(db(), p))

  // ---------- statements ----------
  handle('receivables:statement', (p) => {
    const q = statementQuerySchema.parse(p)
    const c = company()
    return rx.statementHtml(c.db, c.info, q.ledgerId, q.from, q.to)
  }, 'viewer')
  handle('receivables:statementPdf', async (p) => {
    const q = statementQuerySchema.parse(p)
    const c = company()
    return rx.statementPdf(c.db, c.info, c.slug, q.ledgerId, q.from, q.to)
  })
  handle('receivables:statementsBulk', async (p) => {
    const q = statementsBulkSchema.parse(p)
    const c = company()
    let dir: string | undefined
    if (q.pickFolder) {
      // The folder comes from the native picker only — never a path from the renderer.
      const res = await dialog.showOpenDialog({ title: 'Save statements to', defaultPath: companyExportsDir(c.slug), properties: ['openDirectory', 'createDirectory'] })
      if (res.canceled || !res.filePaths[0]) return { folder: '', files: [], cancelled: true }
      dir = res.filePaths[0]
    }
    return rx.statementsBulk(c.db, c.info, c.slug, q.from, q.to, { dir, ledgerIds: q.ledgerIds })
  })
  /** Show a generated statement / reminder in Finder. Only files under the company's exports. */
  handle('receivables:reveal', (p) => {
    const { path } = z.object({ path: z.string().min(1).max(1000) }).parse(p)
    const target = insideExports(companyExportsDir(company().slug), path)
    if (!target) throw new Error('Only files in the exports folder can be shown')
    shell.showItemInFolder(target)
    return null
  }, 'viewer')

  // ---------- reminders ----------
  handle('receivables:reminderCandidates', (p) => rx.reminderCandidates(db(), asOnSchema.parse(p).asOn), 'viewer')
  handle('receivables:remind', async (p) => {
    const c = company()
    return rx.remind(c.db, c.info, c.slug, remindSchema.parse(p))
  })
  handle('receivables:remindBulk', async (p) => {
    const c = company()
    return rx.remindBulk(c.db, c.info, c.slug, remindBulkSchema.parse(p))
  })
  handle('receivables:reminderLog', (p) => {
    const q = reminderLogSchema.parse(p)
    return rx.reminderLog(db(), q.from, q.to, q.ledgerId)
  }, 'viewer')

  // ---------- interest ----------
  handle('receivables:interestPreview', (p) => {
    const q = interestPreviewSchema.parse(p)
    const c = company()
    return rx.interestPreview(c.db, c.info, q.asOn, q.ledgerId, q.gstOnInterest)
  }, 'viewer')
  handle('receivables:postInterest', (p) => {
    const c = company()
    return rx.postInterest(c.db, c.info, postInterestSchema.parse(p))
  })
  handle('receivables:interestCharges', (p) => rx.interestCharges(db(), interestChargesSchema.parse(p ?? {}).ledgerId), 'viewer')

  // ---------- credit control ----------
  // Owner only: a hold stops invoicing a customer (and only an owner may override one).
  handle('receivables:setHold', (p) => {
    const q = setHoldSchema.parse(p)
    return rx.setCreditHold(db(), q.ledgerId, q.hold, q.reason)
  }, 'owner')
  handle('receivables:creditControl', (p) => rx.creditControl(db(), asOnSchema.parse(p).asOn), 'viewer')

  // ---------- follow-ups ----------
  handle('receivables:followups', (p) => rx.listFollowups(db(), followupsQuerySchema.parse(p ?? {}).ledgerId), 'viewer')
  handle('receivables:addFollowup', (p) => rx.addFollowup(db(), followupInputSchema.parse(p)))
  handle('receivables:deleteFollowup', (p) => {
    rx.deleteFollowup(db(), z.object({ id: z.number().int().positive() }).parse(p).id)
    return null
  })
  handle('report:dashboardPromised', (p) => dashPromisedPayments(db(), z.object({ today: isoDate }).parse(p).today), 'viewer')
  handle('receivables:promisedThisWeek', (p) => rx.promisedThisWeek(db(), z.object({ today: isoDate }).parse(p).today), 'viewer')

  // ---------- collection reports ----------
  handle('receivables:collections', (p) => {
    const q = collectionsSchema.parse(p)
    return rx.collectionReport(db(), q.from, q.to)
  }, 'viewer')
  handle('receivables:topOverdue', (p) => {
    const q = topOverdueSchema.parse(p)
    return rx.topOverdue(db(), q.asOn, q.limit)
  }, 'viewer')
}
