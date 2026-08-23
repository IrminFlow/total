/**
 * Encrypted secret storage, deliberately OUTSIDE the company database.
 *
 * NIC GST-portal credentials used to live as plaintext JSON in the company DB's `meta` table.
 * That file is copied by `backupCompany()` twenty times over, snapshotted on quit, exported into
 * the CA pack, restored onto other machines, and opened read-only by the consolidated-reports
 * service from other companies' processes — so a password in `meta` rode along in every one of
 * those. `syncpath.ts` already warns that the whole data folder may be sitting inside OneDrive.
 *
 * Two properties follow from that:
 *
 *  1. Secrets live in the app's own userData directory, not under `~/Documents/total`, so no
 *     backup, export or sync of the books can carry them. E2E scenario 13 asserts exactly this
 *     by walking every file under the data dir.
 *
 *  2. When the OS keychain is unavailable, we refuse to persist rather than writing plaintext.
 *     A user on a Linux box with no keyring has to re-enter a password each session; a user
 *     whose GST portal password leaks out of a synced folder has a much worse day. Callers see
 *     `storageMode() === 'session'` and can say so in the UI.
 */

import { app, safeStorage } from 'electron'
import { join } from 'path'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, unlinkSync, chmodSync } from 'fs'
import { dataRoot } from './paths'

interface SecretsFile {
  version: 1
  /** key -> base64 of safeStorage.encryptString */
  entries: Record<string, string>
}

const EMPTY: SecretsFile = { version: 1, entries: {} }

/** Secrets held only for this process, used when the OS keychain is unavailable. */
const sessionOnly = new Map<string, string>()

let encryptionChecked = false
let encryptionAvailable = false

/** Is the OS keychain (Keychain / DPAPI / libsecret) usable right now? */
export function canEncrypt(): boolean {
  if (encryptionChecked) return encryptionAvailable
  encryptionChecked = true
  try {
    encryptionAvailable = safeStorage.isEncryptionAvailable()
  } catch {
    // Not running under a ready Electron app (dbtests run as Electron-as-Node).
    encryptionAvailable = false
  }
  return encryptionAvailable
}

export type StorageMode = 'keychain' | 'session'

export function storageMode(): StorageMode {
  return canEncrypt() ? 'keychain' : 'session'
}

export function secretsPath(): string {
  // Hermetic runs keep everything under the scratch dir. Real installs use userData, which sits
  // outside ~/Documents and so is never captured by Total's own backup machinery.
  if (process.env.TOTAL_DATA_DIR) return join(dataRoot(), 'secrets.json')
  try {
    return join(app.getPath('userData'), 'secrets.json')
  } catch {
    return join(dataRoot(), 'secrets.json')
  }
}

function readFile(): SecretsFile {
  const path = secretsPath()
  if (!existsSync(path)) return { ...EMPTY, entries: {} }
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as SecretsFile
    if (parsed?.version !== 1 || typeof parsed.entries !== 'object') return { ...EMPTY, entries: {} }
    return parsed
  } catch {
    // A corrupt secrets file means "nothing configured", never a crash on launch.
    return { ...EMPTY, entries: {} }
  }
}

function writeFile(file: SecretsFile): void {
  const path = secretsPath()
  mkdirSync(join(path, '..'), { recursive: true })
  const tmp = `${path}.tmp`
  writeFileSync(tmp, JSON.stringify(file, null, 2), 'utf8')
  try {
    chmodSync(tmp, 0o600)
  } catch {
    // Windows has no POSIX mode bits; DPAPI is doing the real work there anyway.
  }
  renameSync(tmp, path)
}

/** Read a secret. Returns null when unset, or when a stored value can no longer be decrypted. */
export function readSecret(key: string): string | null {
  if (!canEncrypt()) return sessionOnly.get(key) ?? null
  const raw = readFile().entries[key]
  if (!raw) return null
  try {
    return safeStorage.decryptString(Buffer.from(raw, 'base64'))
  } catch {
    // Re-signed app or a deleted keychain item: treat as "not configured" and let the user
    // re-enter it. Never throw on a read path that runs at launch.
    return null
  }
}

/** Store a secret, or clear it by passing null/''. */
export function writeSecret(key: string, plain: string | null): void {
  if (!canEncrypt()) {
    if (plain) sessionOnly.set(key, plain)
    else sessionOnly.delete(key)
    return
  }
  const file = readFile()
  if (plain) file.entries[key] = safeStorage.encryptString(plain).toString('base64')
  else delete file.entries[key]
  writeFile(file)
}

/** Forget every secret for a company (used when a company is deleted). */
export function clearSecrets(prefix: string): void {
  for (const key of [...sessionOnly.keys()]) {
    if (key.startsWith(prefix)) sessionOnly.delete(key)
  }
  if (!canEncrypt()) return
  const file = readFile()
  let changed = false
  for (const key of Object.keys(file.entries)) {
    if (key.startsWith(prefix)) {
      delete file.entries[key]
      changed = true
    }
  }
  if (changed) writeFile(file)
}

/** Test-only: wipe the store and re-probe the keychain. */
export function __resetSecretsForTest(): void {
  sessionOnly.clear()
  encryptionChecked = false
  encryptionAvailable = false
  const path = secretsPath()
  if (existsSync(path)) unlinkSync(path)
}
