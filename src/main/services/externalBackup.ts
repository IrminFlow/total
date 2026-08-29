/**
 * Copying the books somewhere that is not this disk (roadmap #245, #253).
 *
 * Every existing backup lands in `<company>/backups/`, which survives a mistake and nothing else:
 * a dead disk, a stolen laptop and a wiped Documents folder take the books and their backups
 * together. This writes a copy into a folder the user chose — an external drive, or a synced
 * folder if they accept a passphrase — on a schedule, and prunes its own old copies without ever
 * touching a file it did not write.
 *
 * The copy is proved before it is kept: a snapshot that does not pass quick_check (a full disk, a
 * drive yanked mid-write, a sync client rewriting the file underneath) is deleted rather than left
 * to displace a good one in the pruning window. For an encrypted copy the proof is the plaintext
 * snapshot it was made from, since the encrypted file is by construction unreadable until someone
 * types the passphrase back in.
 */
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync, unlinkSync } from 'fs'
import { join } from 'path'
import type { DB } from '../db/connection'
import { backupStamp, quickCheckOk, snapshotSync } from '../db/backup'
import { encryptFile } from '../db/crypt'
import { getExternalBackup, stampExternalBackup } from './config'
import {
  dueForExternalBackup,
  externalBackupName,
  isExternalBackupOf,
  type ExternalBackupConfig
} from '@shared/backupSchedule'

export interface ExternalBackupRun {
  ran: boolean
  path: string | null
  error: string | null
  /** Copies deleted by retention on this run. */
  pruned: number
}

const idle: ExternalBackupRun = { ran: false, path: null, error: null, pruned: 0 }

/**
 * Write one copy now, whatever the schedule says. `passphrase` is required when the schedule is
 * encrypted — it lives in the OS keychain and is passed in by the caller, never read from here.
 */
export function runExternalBackup(
  db: DB,
  slug: string,
  config: ExternalBackupConfig,
  passphrase: string | null,
  now = new Date()
): Promise<ExternalBackupRun> {
  return (async (): Promise<ExternalBackupRun> => {
    if (!config.dir) return idle
    if (config.encrypt && !passphrase) {
      throw new Error('This schedule is encrypted, and no passphrase is stored on this machine. Set it again in Settings.')
    }
    if (!existsSync(config.dir)) {
      // The everyday case: the external drive is not plugged in. Not an error worth a dialog, but
      // the schedule must say so rather than silently reporting success.
      throw new Error(`The backup folder is not there: ${config.dir}. If it is on a drive, plug it in.`)
    }
    mkdirSync(config.dir, { recursive: true })

    const stamp = backupStamp(now)
    const finalPath = join(config.dir, externalBackupName(slug, stamp, config.encrypt))
    // Written locally first, then moved out: a snapshot written straight onto a slow USB stick or
    // into a sync folder is a file another process is watching while SQLite is still writing it.
    const stagingPath = join(config.dir, `.total-staging-${stamp}.db`)

    try {
      snapshotSync(db, stagingPath)
      if (!quickCheckOk(stagingPath)) {
        throw new Error('The copy did not pass its integrity check and was discarded')
      }
      if (config.encrypt) {
        await encryptFile(stagingPath, finalPath, passphrase!)
      } else {
        // Rename rather than copy: same directory, so it is atomic, and a watching sync client
        // only ever sees a complete file appear.
        renameSync(stagingPath, finalPath)
      }
    } finally {
      rmSync(stagingPath, { force: true })
    }

    const pruned = pruneExternal(config.dir, slug, config.keep)
    return { ran: true, path: finalPath, error: null, pruned }
  })()
}

/** Delete the oldest copies beyond `keep`. Only ever ours, only ever this company's. */
export function pruneExternal(dir: string, slug: string, keep: number): number {
  if (!existsSync(dir)) return 0
  const mine = readdirSync(dir)
    .filter((file) => isExternalBackupOf(file, slug))
    .map((file) => ({ file, mtime: statSync(join(dir, file)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime)
  let pruned = 0
  for (const entry of mine.slice(Math.max(1, keep))) {
    unlinkSync(join(dir, entry.file))
    pruned++
  }
  return pruned
}

/**
 * The scheduler's entry point: copy if one is due, and record what happened either way.
 *
 * Never throws. A failed external backup must not take down the app or the company that is open —
 * it records the reason, which the Backups screen shows, because a schedule that fails invisibly
 * is worse than no schedule at all.
 */
export async function runIfDue(
  db: DB,
  slug: string,
  passphrase: string | null,
  now = new Date()
): Promise<ExternalBackupRun> {
  const config = getExternalBackup(db)
  if (!dueForExternalBackup(config, now)) return idle
  try {
    const result = await runExternalBackup(db, slug, config, passphrase, now)
    stampExternalBackup(db, now.toISOString(), null)
    return result
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    // The last-run stamp is deliberately NOT moved on a failure: the next tick should try again
    // rather than wait another day because a drive was unplugged for a minute.
    stampExternalBackup(db, null, message)
    return { ran: false, path: null, error: message, pruned: 0 }
  }
}
