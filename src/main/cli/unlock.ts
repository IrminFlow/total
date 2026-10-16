// total-cli / MCP access to a business locked with a passphrase (WP 7.2 follow-up).
//
// The passphrase comes from the environment variable TOTAL_PASSPHRASE — never from a flag: a
// process's arguments are readable by every user on the machine (`ps`, Activity Monitor, Task
// Manager), its environment only by the same user (and root). The variable is read once and
// removed from this process's environment straight away, so nothing the CLI starts inherits it.
//
// The key is unwrapped exactly as the app does it (companyKeys.unlockCompanyKey → unlockKey: every
// envelope, folder then mirror, accepted only once it opens the file), with the app's
// wrong-passphrase counter (per process — see companyKeys.ts for why that is acceptable), and
// remembered for the folder only while the command runs: `forgetCliKeys` at the end of the command
// and again on process exit. The passphrase itself is never logged, audited or stored.
import { existsSync } from 'fs'
import { isAppError } from '@shared/errors'
import { forgetAllKeys, forgetFolderKey, isEncryptedFile, keyForPath, rememberFolderKey } from '../db/encryption'
import { unlockCompanyKey } from '../services/companyKeys'
import type { SecretStore } from '../services/secrets'
import { companyDbPath, companyDir } from '../paths'

export const PASSPHRASE_ENV = 'TOTAL_PASSPHRASE'

/** Exit code of a command refused for the passphrase (missing, wrong, throttled). */
export const PASSPHRASE_EXIT_CODE = 2
const PASSPHRASE_CODES = new Set(['passphrase_required', 'wrong_passphrase', 'passphrase_throttled'])

export function isPassphraseRefusal(err: unknown): boolean {
  return isAppError(err) && PASSPHRASE_CODES.has(err.code)
}

/** Read TOTAL_PASSPHRASE once and remove it from `env` (so children never inherit it). */
export function takePassphrase(env: NodeJS.ProcessEnv = process.env): string | null {
  const v = env[PASSPHRASE_ENV]
  delete env[PASSPHRASE_ENV]
  return v ? v : null
}

/**
 * Unlock `slug`'s folder for this process when its file is encrypted. A plaintext business opens
 * as before (a passphrase given for it is ignored); an already-unlocked folder is left as it is.
 * Returns whether the file is encrypted. Throws the app's AppErrors (passphrase_required,
 * wrong_passphrase, passphrase_throttled, db_key_mismatch).
 */
export async function unlockForCli(slug: string, passphrase: string | null, store: SecretStore | null): Promise<boolean> {
  const dbPath = companyDbPath(slug)
  if (!existsSync(dbPath) || !isEncryptedFile(dbPath)) return false
  if (keyForPath(dbPath)) return true
  const key = await unlockCompanyKey({
    slug, dbPath, companyDir: companyDir(slug), passphrase, store,
    requiredMessage: `This business is locked with a passphrase — set ${PASSPHRASE_ENV} to unlock it (it is read from the environment, never from a flag)`
  })
  rememberFolderKey(companyDir(slug), key) // keeps its own copy
  key.fill(0)
  return true
}

/** Forget the folder key of `slug` (end of a command). */
export function forgetCliKey(slug: string): void {
  forgetFolderKey(companyDir(slug))
}

let exitHookInstalled = false
/** Forget every key when the process exits, however it exits. */
export function forgetKeysOnExit(): void {
  if (exitHookInstalled) return
  exitHookInstalled = true
  process.on('exit', () => forgetAllKeys())
}
