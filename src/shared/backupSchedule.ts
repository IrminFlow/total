/**
 * The backup that leaves the machine (roadmap #245, #253).
 *
 * Every backup this app takes today lands in the company folder, next to the database it is a
 * copy of. That survives a mistake and nothing else: a dead disk, a stolen laptop and a wiped
 * Documents folder all take the books and the backups together. A second copy is only a backup
 * when it is somewhere else.
 *
 * "Somewhere else" for this market is an external drive or a Dropbox/Drive folder, which is why
 * the schedule offers a passphrase: a synced folder is a folder somebody else's servers can read.
 * The app refuses to write plaintext books into a folder it can see is synced — see
 * `externalDestinationVerdict` — because a "backup" that quietly hands the books to a cloud
 * provider is not the promise this app makes.
 *
 * Pure: no fs, no Electron. The scheduler in main decides *when* from here and does the writing.
 */
import { syncFolderWarning } from './syncpath'

export interface ExternalBackupConfig {
  /** Absolute destination folder, or null when the schedule is off. */
  dir: string | null
  /** How often to copy. 0 is not allowed — 'off' is `dir: null`, which is honest about itself. */
  everyHours: number
  /** Encrypt with the TOTALBK1 format instead of copying the raw database. */
  encrypt: boolean
  /** Copies to keep in the destination before the oldest is deleted. */
  keep: number
  /** When the last copy landed, ISO. Null until one has. */
  lastRunAt: string | null
  /** Why the last attempt failed, if it did — a schedule that fails silently is worse than none. */
  lastError: string | null
}

export const EXTERNAL_BACKUP_HOURS = [1, 6, 12, 24, 168] as const
export const EXTERNAL_KEEP_MIN = 3
export const EXTERNAL_KEEP_MAX = 200

export const DEFAULT_EXTERNAL_BACKUP: ExternalBackupConfig = {
  dir: null,
  everyHours: 24,
  encrypt: false,
  keep: 7,
  lastRunAt: null,
  lastError: null
}

/** Re-validate on read: `meta` is a plain JSON column a restore or a hand-edit can reach. */
export function parseExternalBackup(raw: unknown): ExternalBackupConfig {
  if (!raw || typeof raw !== 'object') return DEFAULT_EXTERNAL_BACKUP
  const value = raw as Partial<ExternalBackupConfig>
  const hours = Number(value.everyHours)
  const keep = Number(value.keep)
  return {
    dir: typeof value.dir === 'string' && value.dir.trim() ? value.dir : null,
    everyHours: (EXTERNAL_BACKUP_HOURS as readonly number[]).includes(hours) ? hours : 24,
    encrypt: value.encrypt === true,
    keep: Number.isInteger(keep) && keep >= EXTERNAL_KEEP_MIN && keep <= EXTERNAL_KEEP_MAX ? keep : 7,
    lastRunAt: typeof value.lastRunAt === 'string' ? value.lastRunAt : null,
    lastError: typeof value.lastError === 'string' ? value.lastError : null
  }
}

export type DestinationVerdict =
  | { ok: true; warning: string | null }
  | { ok: false; error: string }

/**
 * Whether a chosen destination is one this app will write to.
 *
 * Two refusals, both of which have cost somebody their books somewhere:
 *  - inside the data folder itself, which is not a second copy of anything;
 *  - a synced folder without a passphrase, which is the books on someone else's disk.
 */
export function externalDestinationVerdict(dir: string, dataRoot: string, encrypt: boolean): DestinationVerdict {
  const target = dir.replace(/\/+$/, '')
  if (!target) return { ok: false, error: 'Choose a folder' }

  const root = dataRoot.replace(/\/+$/, '')
  if (target === root || target.startsWith(`${root}/`) || target.startsWith(`${root}\\`)) {
    return {
      ok: false,
      error: 'That folder is inside Total’s own data folder — a copy there dies with the original.'
    }
  }

  const synced = syncFolderWarning(target)
  if (synced && !encrypt) {
    return {
      ok: false,
      error: `That folder looks like it is synced by ${synced}. Turn on the passphrase to send an encrypted copy, or choose a folder that is not synced.`
    }
  }
  if (synced) {
    return {
      ok: true,
      warning: `Encrypted copies will be written into a folder synced by ${synced}. Nobody can recover the passphrase — keep it somewhere other than this machine.`
    }
  }
  return { ok: true, warning: null }
}

/** True when a copy is due. An unparseable or absent lastRunAt means "never run", i.e. due now. */
export function dueForExternalBackup(config: ExternalBackupConfig, now: Date): boolean {
  if (!config.dir) return false
  if (!config.lastRunAt) return true
  const last = Date.parse(config.lastRunAt)
  if (!Number.isFinite(last)) return true
  return now.getTime() - last >= config.everyHours * 3600_000
}

/** Filename inside the destination. Carries the company slug: two companies can share a folder. */
export function externalBackupName(slug: string, stamp: string, encrypt: boolean): string {
  return `total-${slug}-${stamp}.${encrypt ? 'totalbak' : 'db'}`
}

/** True when `file` is one of ours for `slug` — the pruner must never delete a stranger's file. */
export function isExternalBackupOf(file: string, slug: string): boolean {
  return file.startsWith(`total-${slug}-`) && (file.endsWith('.db') || file.endsWith('.totalbak'))
}

/** One line for the settings screen, stating the schedule as it will actually behave. */
export function describeExternalSchedule(config: ExternalBackupConfig): string {
  if (!config.dir) return 'Off — backups stay in this company’s folder only.'
  const every =
    config.everyHours === 1
      ? 'every hour'
      : config.everyHours === 24
        ? 'once a day'
        : config.everyHours === 168
          ? 'once a week'
          : `every ${config.everyHours} hours`
  const how = config.encrypt ? 'an encrypted copy' : 'a copy'
  return `${how.charAt(0).toUpperCase()}${how.slice(1)} ${every}, keeping the last ${config.keep}.`
}
