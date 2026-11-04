// IPC channels for comparatives and ratios (WP 6.2). Registered from ipc.ts with its `handle`
// (role gate + { ok, data | error } envelope); every payload is Zod-parsed here.
import { z } from 'zod'
import type { DB } from './db/connection'
import type { CompanyInfo } from '@shared/domain'
import type { Role } from './services/roles'
import { isoDate } from '@shared/schemas'
import * as analytics from './services/reportAnalytics'

type Handle = (channel: string, fn: (payload: unknown) => unknown, minRole?: Role) => void
interface Company { db: DB; info: CompanyInfo }

const rangeSchema = z.object({ from: isoDate, to: isoDate }).refine((r) => r.from <= r.to, 'from must be on or before to')

export function registerReportsIpc(handle: Handle, company: () => Company): void {
  const db = (): DB => company().db

  // ---------- comparatives + ratios ----------
  handle('report:comparative', (p) => {
    const q = z.object({ kind: z.enum(['pnl', 'bs']), from: isoDate, to: isoDate }).parse(p)
    const c = company()
    return q.kind === 'pnl' ? analytics.comparativePnl(c.db, q.from, q.to) : analytics.comparativeBs(c.db, `${c.info.booksFrom}-04-01`, q.from, q.to)
  }, 'viewer')
  handle('report:ratios', (p) => {
    const q = rangeSchema.parse(p)
    return analytics.ratioReport(db(), q.from, q.to)
  }, 'viewer')
}
