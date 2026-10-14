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
import { isKeyEnvelope, type KeyEnvelope } from '../db/keyEnvelope'

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
  return { mirrored }
}

/** The envelope: the folder's copy, else the secret store's. Null when there is none. */
export function readEnvelope(companyDir: string, slug: string, store: SecretStore | null): KeyEnvelope | null {
  const file = envelopePath(companyDir)
  if (existsSync(file)) {
    try {
      const v = JSON.parse(readFileSync(file, 'utf8')) as unknown
      if (isKeyEnvelope(v)) return v
    } catch {
      // fall through to the mirror
    }
  }
  try {
    const text = store?.get(companyScope(slug), ENVELOPE_SECRET)
    if (text) {
      const v = JSON.parse(text) as unknown
      if (isKeyEnvelope(v)) return v
    }
  } catch {
    // no mirror (or no secure storage)
  }
  return null
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
