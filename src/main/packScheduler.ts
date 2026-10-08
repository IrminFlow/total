// Scheduled report packs — the main-process trigger (WP 6.2). Like the backup-on-open job there
// is no daemon: due packs run after a company opens (missed runs collapse into one) and on an
// hourly check while it stays open. A pass never runs inside the open itself: it is deferred to a
// later macrotask (so company:open has answered first) and yields between packs and reports. It
// never runs while the company is locked — a company with users waits until someone signs in
// (auth:login triggers the pass then). One pass per company at a time.
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

const running = new Map<string, Promise<void>>()

export interface PackPassOptions {
  /** Whether packs may run now (false while the company is locked). Checked when the deferred
   *  pass actually starts, not when it is scheduled. */
  allowed?: () => boolean
  /** The company still open when the pass starts (it may have closed meanwhile). */
  current?: () => PackCompany | null
  renderPdf?: RenderPdf
  /** Deferral before the pass starts (ms). */
  delayMs?: number
}

/** Schedule one pass over the company's due packs; resolves when it has finished (or was
 *  skipped). Never throws — failures are logged. */
export function runDuePacksInBackground(company: PackCompany | null, opts: PackPassOptions = {}): Promise<void> {
  if (!company) return Promise.resolve()
  const { slug } = company
  const inFlight = running.get(slug)
  if (inFlight) return inFlight
  const pass = (async () => {
    // Defer past the caller (company:open returns first; CSV-only packs never await on their own).
    await new Promise((resolve) => setTimeout(resolve, opts.delayMs ?? 0))
    try {
      if (opts.allowed && !opts.allowed()) return
      const live = opts.current ? opts.current() : company
      if (!live || live.slug !== slug) return
      const runs = await runDuePacks(live.db, slug, live.info, { renderPdf: opts.renderPdf ?? renderPackPdf })
      for (const r of runs) log(r.status === 'ok' ? 'info' : 'warn', 'report-pack-run', { slug, packId: r.packId, status: r.status, files: r.files.length })
    } catch (err) {
      // e.g. the company closed under a running pack — the next open picks it up again.
      log('warn', 'report-pack-run-failed', { slug, error: err instanceof Error ? err.message : String(err) })
    } finally {
      running.delete(slug)
    }
  })()
  running.set(slug, pass)
  return pass
}

/** Hourly due-check while the app runs (the on-open pass is triggered by company:open / login).
 *  `getUnlocked` returns the open company only when packs may run (not locked). */
export function startPackScheduler(getUnlocked: () => PackCompany | null, intervalMin = 60): NodeJS.Timeout {
  return setInterval(() => void runDuePacksInBackground(getUnlocked(), { current: getUnlocked }), intervalMin * 60 * 1000)
}
