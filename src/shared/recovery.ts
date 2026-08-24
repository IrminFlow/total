/**
 * What to do when the database is damaged (roadmap #248).
 *
 * The app already detects this: quick_check on every open, a full integrity_check weekly, and a
 * per-voucher balance check. What it did with the answer was log a warning and show a red box
 * saying `database disk image is malformed`, which is a true sentence that helps nobody. The
 * person reading it is a shopkeeper whose books will not open, and the next thing they do
 * decides whether they lose a day or a year — copying the file somewhere safe before touching
 * anything is worth more than any diagnosis.
 *
 * So the guidance is ordered by what it costs to get wrong, not by likelihood, and it is derived
 * from the actual findings: there is no point telling someone to restore a backup when the
 * problem is one unbalanced voucher, and no point suggesting a repair when there are no backups
 * to fall back to if it fails.
 */

export interface RecoverySituation {
  /** What `PRAGMA quick_check` said — 'ok' when the file itself is sound. */
  quickCheck: string
  /** Vouchers whose debits and credits do not agree. */
  unbalancedVoucherIds: number[]
  /** Backups available for this company, newest first, as ISO timestamps. */
  backupsNewestFirst: string[]
  /** Whether the newest backup has been opened and proved to balance. */
  newestBackupVerified?: boolean
}

export type RecoverySeverity = 'ok' | 'books' | 'file'

export interface RecoveryStep {
  title: string
  detail: string
  /** The step is an action the app itself offers, and where. */
  action?: 'backup-now' | 'restore' | 'verify-backup' | 'reveal-folder' | 'export' | 'contact'
}

export interface RecoveryGuidance {
  severity: RecoverySeverity
  headline: string
  steps: RecoveryStep[]
}

/**
 * File damage outranks book damage: a malformed file can lose everything at once, while an
 * unbalanced voucher is a wrong number in an otherwise readable set of books.
 */
export function recoverySeverity(situation: RecoverySituation): RecoverySeverity {
  if (situation.quickCheck !== 'ok') return 'file'
  if (situation.unbalancedVoucherIds.length > 0) return 'books'
  return 'ok'
}

export function recoveryGuidance(situation: RecoverySituation): RecoveryGuidance {
  const severity = recoverySeverity(situation)
  const backups = situation.backupsNewestFirst
  const steps: RecoveryStep[] = []

  if (severity === 'ok') {
    return {
      severity,
      headline: 'This database passes every check.',
      steps: [
        {
          title: 'Prove a backup while nothing is wrong',
          detail:
            'Verifying a backup opens it and foots its books. The day you need one is the wrong day to find out it never worked.',
          action: 'verify-backup'
        }
      ]
    }
  }

  if (severity === 'file') {
    steps.push({
      title: 'Copy the whole company folder somewhere else, now, before anything else',
      detail:
        'A damaged database is often still mostly readable, and every further write can take more of it. A copy on a USB stick or another folder costs a minute and is the only step that cannot make things worse.',
      action: 'reveal-folder'
    })

    if (backups.length > 0) {
      steps.push({
        title: `Restore the most recent backup (${backups[0]})`,
        detail: `${backups.length} backup${backups.length === 1 ? '' : 's'} ${
          backups.length === 1 ? 'is' : 'are'
        } available. Verify it first — that opens it and checks the books inside balance — then restore it. Anything entered since that backup will have to be entered again, so make a note of what that is before restoring.${
          situation.newestBackupVerified === false
            ? ' The newest backup has not passed verification, so try the one before it if it fails.'
            : ''
        }`,
        action: 'restore'
      })
    } else {
      steps.push({
        title: 'There are no backups to restore',
        detail:
          'Do not keep working in this company. Export what the app can still read — the day book, the ledgers, the outstandings — while it opens at all, and treat those exports as the record until the books are rebuilt.',
        action: 'export'
      })
    }

    steps.push({
      title: 'If the file matters more than the last few entries',
      detail:
        'A damaged SQLite file can often be salvaged with the sqlite3 command-line tool (`.recover`), which writes out everything still readable. That is a job for someone comfortable at a terminal, and the copy from step one is what they should work on — never the original.',
      action: 'contact'
    })

    return {
      severity,
      headline: `This company’s database is damaged: SQLite reports “${situation.quickCheck}”.`,
      steps
    }
  }

  const count = situation.unbalancedVoucherIds.length
  steps.push({
    title: `Look at the ${count} voucher${count === 1 ? '' : 's'} that do not balance`,
    detail: `Voucher${count === 1 ? '' : 's'} ${situation.unbalancedVoucherIds.join(', ')}${
      count >= 10 ? ' (the first ten)' : ''
    } have debits that do not equal credits. Open each one and re-save it: the entry screen refuses to save an unbalanced voucher, so saving it again either fixes the row or tells you exactly what is wrong with it.`
  })
  steps.push({
    title: 'Take a backup once they are fixed',
    detail:
      'The automatic snapshots rotate, and the ones taken while the books were out of balance will eventually be all that is left.',
    action: 'backup-now'
  })
  return {
    severity,
    headline: `The file is sound, but ${count} voucher${count === 1 ? ' does' : 's do'} not balance.`,
    steps
  }
}
