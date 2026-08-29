// Periodic + quit-time company backups. Kept Electron-light (only `log` touches Electron, via
// app.getVersion() inside log.ts) so the scheduling logic itself stays simple to reason about.
import { join } from 'path'
import type { DB } from './db/connection'
import { backupCompany } from './db/connection'
import { backupStamp, snapshotSync } from './db/backup'
import { companyBackupsDir } from './paths'
import { log } from './log'
import { runIfDue } from './services/externalBackup'
import { readSecret } from './secrets'

export interface CurrentCompanyLike {
  slug: string
  db: DB
}

/**
 * Every `intervalMin` minutes, snapshot the currently-open company (if any), tagged 'auto', and
 * — if one is configured and due — write a copy into the folder the user chose somewhere else
 * (roadmap #245, #253).
 *
 * The external copy rides on this timer rather than one of its own: a schedule measured in hours
 * does not need its own half-hourly tick, and one timer is one place to look when a backup did
 * not happen.
 */
export function startBackupScheduler(
  getCurrent: () => CurrentCompanyLike | null,
  intervalMin = 30
): NodeJS.Timeout {
  return setInterval(
    () => {
      void (async () => {
        const current = getCurrent()
        if (!current) return
        try {
          await backupCompany(current.db, current.slug, 'auto')
          log('info', 'backup-auto', { slug: current.slug })
        } catch (err) {
          log('error', 'backup-auto-failed', { error: err instanceof Error ? err.message : String(err) })
        }
        try {
          // runIfDue never throws — it records why it could not run (an unplugged drive, most
          // often) where the Backups screen can show it.
          const run = await runIfDue(current.db, current.slug, readSecret(`backup.external.${current.slug}`))
          if (run.ran) log('info', 'backup-external', { slug: current.slug, path: run.path, pruned: run.pruned })
          else if (run.error) log('warn', 'backup-external-failed', { slug: current.slug, error: run.error })
        } catch (err) {
          log('error', 'backup-external-failed', { error: err instanceof Error ? err.message : String(err) })
        }
      })()
    },
    intervalMin * 60 * 1000
  )
}

/** Synchronous snapshot of the currently-open company on app quit, tagged 'quit'. */
export function backupOnQuit(getCurrent: () => CurrentCompanyLike | null): void {
  try {
    const current = getCurrent()
    if (!current) return
    const dest = join(companyBackupsDir(current.slug), `${backupStamp()}-quit.db`)
    snapshotSync(current.db, dest)
    log('info', 'backup-quit', { slug: current.slug })
  } catch (err) {
    log('error', 'backup-quit-failed', { error: err instanceof Error ? err.message : String(err) })
  }
}
