// Periodic + quit-time company backups. Kept Electron-light (only `log` touches Electron, via
// app.getVersion() inside log.ts) so the scheduling logic itself stays simple to reason about.
import { join } from 'path'
import type { DB } from './db/connection'
import { backupCompany } from './db/connection'
import { backupStamp, snapshotSync } from './db/backup'
import { companyBackupsDir } from './paths'
import { log } from './log'
import { applyRotationPolicy, replicateBackup } from './services/resilience'

export interface CurrentCompanyLike {
  slug: string
  db: DB
}

/** Every `intervalMin` minutes, snapshot the currently-open company (if any), tagged 'auto'. */
export function startBackupScheduler(
  getCurrent: () => CurrentCompanyLike | null,
  intervalMin = 30
): NodeJS.Timeout {
  return setInterval(
    () => {
      void (async () => {
        try {
          const current = getCurrent()
          if (!current) return
          const path = await backupCompany(current.db, current.slug, 'auto')
          replicateBackup(current.db, current.slug, path)
          applyRotationPolicy(current.db, current.slug)
          log('info', 'backup-auto', { slug: current.slug })
        } catch (err) {
          log('error', 'backup-auto-failed', { error: err instanceof Error ? err.message : String(err) })
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
