// Scheduled report packs — the main-process trigger (WP 6.2). Like the backup-on-open job there
// is no daemon: due packs run when a company opens (missed runs collapse into one) and on an
// hourly check while it stays open. One pass at a time; a pass never blocks or fails the open.
import type { DB } from './db/connection'
import type { CompanyInfo } from '@shared/domain'
import { log } from './log'
import { htmlToPdf } from './services/pdf'
import { runDuePacks, type RenderPdf } from './services/reportPacks'

export interface PackCompany {
  slug: string
  db: DB
  info: CompanyInfo
}

export const renderPackPdf: RenderPdf = (html, { landscape }) => htmlToPdf(html, { pageSize: 'A4', landscape, pageNumbers: true })

let running: Promise<void> | null = null

/** Run every due pack of the open company in the background; logs, never throws. */
export function runDuePacksInBackground(company: PackCompany | null): Promise<void> {
  if (!company || running) return running ?? Promise.resolve()
  const { slug, db, info } = company
  running = (async () => {
    try {
      const runs = await runDuePacks(db, slug, info, { renderPdf: renderPackPdf })
      for (const r of runs) log(r.status === 'ok' ? 'info' : 'warn', 'report-pack-run', { slug, packId: r.packId, status: r.status, files: r.files.length })
    } catch (err) {
      // e.g. the company closed under a running pack — the next open picks it up again.
      log('warn', 'report-pack-run-failed', { slug, error: err instanceof Error ? err.message : String(err) })
    } finally {
      running = null
    }
  })()
  return running
}

/** Hourly due-check while the app runs (the on-open pass is triggered by company:open). */
export function startPackScheduler(getCurrent: () => PackCompany | null, intervalMin = 60): NodeJS.Timeout {
  return setInterval(() => void runDuePacksInBackground(getCurrent()), intervalMin * 60 * 1000)
}
