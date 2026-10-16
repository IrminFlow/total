// WP 7.2 — where a company's wrapped database key lives.
//
// The envelope (db/keyEnvelope.ts: the data key under scrypt(passphrase)) is kept in TWO places:
//  1. `<company>/company.key.json` — beside the books, so the folder (or a copy of it on another
//     Mac) still opens with the passphrase. Useless without the passphrase.
//  2. `<dataRoot>/secrets.json`, scope `company:<slug>`, name `dbKeyEnvelope` — the secret store
//     (safeStorage: Keychain / DPAPI), a second copy if the folder's file is lost. Best effort: a
//     computer without secure storage keeps only the folder copy.
// Neither copy holds the passphrase or the raw key. Electron-free (the store is injected).
import { closeSync, existsSync, fsyncSync, openSync, readFileSync, renameSync, rmSync, writeSync } from 'fs'
import { join } from 'path'
import { randomBytes } from 'crypto'
import { companyScope, type SecretStore } from './secrets'
import { isKeyEnvelope, unwrapKeyAsync, WrongPassphraseError, type KeyEnvelope } from '../db/keyEnvelope'
import { openDb } from '../db/encryption'
import { AppError } from '@shared/errors'

export const ENVELOPE_FILE = 'company.key.json'
export const ENVELOPE_SECRET = 'dbKeyEnvelope'

export function envelopePath(companyDir: string): string {
  return join(companyDir, ENVELOPE_FILE)
}

function atomicWrite(file: string, text: string): void {
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
  const fd = openSync(tmp, 'w', 0o600)
  try {
    writeSync(fd, text)
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  try {
    renameSync(tmp, file)
  } catch (err) {
    rmSync(tmp, { force: true })
    throw err
  }
}

export interface EnvelopeWriteResult {
  /** False when the secret store could not take the second copy (no secure storage). */
  mirrored: boolean
}

/** Write both copies (the folder's atomically). */
export function writeEnvelope(companyDir: string, slug: string, env: KeyEnvelope, store: SecretStore | null): EnvelopeWriteResult {
  const text = JSON.stringify(env, null, 2)
  atomicWrite(envelopePath(companyDir), text)
  let mirrored = false
  try {
    if (store?.available()) {
      store.set(companyScope(slug), ENVELOPE_SECRET, text)
      mirrored = true
    }
  } catch {
    mirrored = false
  }
  // A mirror that could not take the NEW envelope must not keep the old one: after a passphrase
  // change the old passphrase would still open the books through it.
  if (!mirrored) {
    try {
      store?.delete(companyScope(slug), ENVELOPE_SECRET)
    } catch {
      // nothing stored / no secure storage
    }
  }
  return { mirrored }
}

/** The envelope: the folder's copy, else the secret store's. Null when there is none. */
export function readEnvelope(companyDir: string, slug: string, store: SecretStore | null): KeyEnvelope | null {
  return readEnvelopes(companyDir, slug, store)[0] ?? null
}

/** Every distinct envelope there is — the folder's first, then the secret store's when it differs.
 *  The two can disagree (the folder put back from an older copy after a passphrase change, a
 *  mirror write that failed): an unlock tries each, so either copy's passphrase opens the books. */
export function readEnvelopes(companyDir: string, slug: string, store: SecretStore | null): KeyEnvelope[] {
  const out: KeyEnvelope[] = []
  const add = (text: string | null | undefined): void => {
    if (!text) return
    try {
      const v = JSON.parse(text) as unknown
      if (isKeyEnvelope(v) && !out.some((e) => e.salt === v.salt && e.ct === v.ct)) out.push(v)
    } catch {
      // unreadable copy: the other one may do
    }
  }
  const file = envelopePath(companyDir)
  try {
    if (existsSync(file)) add(readFileSync(file, 'utf8'))
  } catch {
    // fall through to the mirror
  }
  try {
    add(store?.get(companyScope(slug), ENVELOPE_SECRET))
  } catch {
    // no mirror (or no secure storage)
  }
  return out
}

/** Remove both copies (the passphrase was taken off). */
export function removeEnvelope(companyDir: string, slug: string, store: SecretStore | null): void {
  rmSync(envelopePath(companyDir), { force: true })
  try {
    store?.delete(companyScope(slug), ENVELOPE_SECRET)
  } catch {
    // best effort
  }
}

/** The data key `passphrase` unwraps from one of `envelopes` AND that opens `dbPath` (an old
 *  envelope from before the lock was turned off and on again unwraps a key of another file). Throws
 *  WrongPassphraseError when none does — a wrong passphrase and a key of another file look alike. */
export async function unlockKey(dbPath: string, envelopes: readonly KeyEnvelope[], passphrase: string): Promise<Buffer> {
  for (const env of envelopes) {
    let key: Buffer
    try {
      key = await unwrapKeyAsync(env, passphrase)
    } catch (err) {
      if (err instanceof WrongPassphraseError) continue
      throw err
    }
    try {
      openDb(dbPath, { readonly: true, fileMustExist: true, key }).close()
      return key
    } catch {
      // this envelope's key belongs to another file
    }
  }
  throw new WrongPassphraseError()
}

// ---------------------------------------------------------------- the throttled unlock
//
// ONE wrong-passphrase counter per process, keyed by company slug, shared by every way in that
// unwraps a company key: the app's company:open / company:delete / session:unlock (ipc.ts), a
// consolidation run's member passphrases (ipcConsolidation.ts) and total-cli / MCP
// (cli/unlock.ts). Five wrong tries → 30 s refusal. The counter lives in memory only, as it always
// has in the app: the real cost of a guess is the scrypt work in the envelope (N = 2^17, ~0.5 s a
// try), and whoever can start a process here can copy company.key.json and guess offline anyway —
// the counter only slows a person (or an agent) typing at a prompt. A CLI process tries once and
// exits, so its counter never reaches the limit; that is documented, not hidden
// (docs/security/encryption-at-rest.md §CLI, MCP and consolidation).

export const PASSPHRASE_MAX_FAILS = 5
export const PASSPHRASE_LOCKOUT_MS = 30_000
export const passphraseFails = new Map<string, { fails: number; until: number }>()

/** Refuse while `slug` is inside its 30 s lockout. */
export function assertNotThrottled(slug: string, now = Date.now()): void {
  const state = passphraseFails.get(slug)
  if (state && state.until > now) throw new AppError('passphrase_throttled', 'Too many tries — wait 30 seconds', { field: 'passphrase' })
}

/** Count a wrong passphrase for `slug`; returns the number of failures so far. */
export function noteWrongPassphrase(slug: string, now = Date.now()): number {
  const fails = (passphraseFails.get(slug)?.fails ?? 0) + 1
  passphraseFails.set(slug, { fails, until: fails >= PASSPHRASE_MAX_FAILS ? now + PASSPHRASE_LOCKOUT_MS : 0 })
  return fails
}

export function noteRightPassphrase(slug: string): void {
  passphraseFails.delete(slug)
}

export interface UnlockCompanyOptions {
  slug: string
  dbPath: string
  companyDir: string
  passphrase: string | null | undefined
  store: SecretStore | null
  /** Told the failure count of a wrong passphrase (the app logs it; never the passphrase). */
  onWrong?: (fails: number) => void
  /** The message of `passphrase_required` (the CLI names its environment variable). */
  requiredMessage?: string
}

/**
 * The data key of an ENCRYPTED company file, from its passphrase — throttled per slug. Throws
 * `passphrase_required` (none given), `passphrase_throttled`, `db_key_mismatch` (no key file
 * anywhere) or `wrong_passphrase`. The caller decides what to do with the key (remember it for
 * the folder, or use it for one read and drop it).
 */
export async function unlockCompanyKey(o: UnlockCompanyOptions): Promise<Buffer> {
  if (!o.passphrase) {
    throw new AppError('passphrase_required', o.requiredMessage ?? 'This business is locked with a passphrase — type it to open the books', { field: 'passphrase' })
  }
  const now = Date.now()
  assertNotThrottled(o.slug, now)
  const envs = readEnvelopes(o.companyDir, o.slug, o.store)
  if (!envs.length) throw new AppError('db_key_mismatch', 'The key file of this business (company.key.json) is missing — restore the folder or open a recovery copy')
  try {
    const key = await unlockKey(o.dbPath, envs, o.passphrase)
    noteRightPassphrase(o.slug)
    return key
  } catch (err) {
    if (!(err instanceof WrongPassphraseError)) throw err
    const fails = noteWrongPassphrase(o.slug, now) // (not inside `onWrong?.(…)`: that skips it with no callback)
    o.onWrong?.(fails)
    throw new AppError('wrong_passphrase', 'That passphrase is not right', { field: 'passphrase' })
  }
}
