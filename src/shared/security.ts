// WP 7.2 — what the security settings screen reads (security:get) and the on / off results.
import type { BackupCheck } from './backupCheck'

export interface SecurityView {
  /** The company file is encrypted (locked with a passphrase). */
  encrypted: boolean
  /** The wrapped key (company.key.json, or its copy in secure storage) is there. */
  keyFile: boolean
  /** The company has users (the screen lock asks for their PIN). */
  usersExist: boolean
  /** Auto-lock after this many idle minutes; null = off. */
  autoLockMinutes: number | null
  autoLockChoices: number[]
  /** The newest automatic restore check of a backup. */
  lastCheck: BackupCheck | null
  /** The data key is remembered on this computer (opens without the passphrase). */
  remembered: boolean
  /** "Remember on this computer" was ticked at this open's prompt and waits for an owner's sign-in. */
  rememberPending: boolean
}

export interface SecurityChangeResult extends SecurityView {
  backupsConverted: number
  backupsFailed: string[]
  /** The second copy of the wrapped key went into the computer's secure storage. */
  mirrored?: boolean
}
