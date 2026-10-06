/**
 * Secret store — small encrypted key/value store for credentials (NIC API password/client
 * secret today; an AI provider API key later).
 *
 * - Addressed by (scope, name). Scope is `companyScope(slug)` for per-company secrets or
 *   APP_SCOPE for app-wide ones.
 * - Values are encrypted by an injected SecretCipher (Electron `safeStorage` in the app — see
 *   secretStore.ts — which is backed by the macOS Keychain / Windows DPAPI / libsecret) and kept
 *   base64-encoded in ONE JSON file under the data root, NOT in any company DB. Company backups
 *   therefore never contain secrets; restoring a backup on another machine (or under a new
 *   slug) means the user re-enters them.
 * - Writes are atomic: temp file in the same directory, fsync, rename over the original.
 * - When the cipher reports encryption unavailable, set()/get() of an existing entry throw
 *   SecretsUnavailableError. There is deliberately NO plaintext fallback.
 *
 * Pure Node (fs/path only): no Electron, no DB — unit-tested in secrets.test.ts.
 */
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeSync } from 'fs'
import { dirname } from 'path'
import { randomBytes } from 'crypto'

export const APP_SCOPE = 'app'

export function companyScope(slug: string): string {
  return `company:${slug}`
}

export interface SecretCipher {
  /** False when the OS can't provide an encryption key (e.g. no keychain / headless Linux). */
  isAvailable(): boolean
  encrypt(plain: string): Buffer
  decrypt(cipher: Buffer): string
}

export class SecretsUnavailableError extends Error {
  constructor() {
    super(
      'Secure storage is not available on this computer (the system keychain could not be used), ' +
        'so Total will not save this secret. It is never stored unencrypted. Unlock or set up the ' +
        'system keychain and try again.'
    )
    this.name = 'SecretsUnavailableError'
  }
}

export interface SecretStore {
  /** Whether set() can succeed right now. */
  available(): boolean
  /** Decrypted value, or null when absent. Throws SecretsUnavailableError if present but undecryptable for lack of a cipher. */
  get(scope: string, name: string): string | null
  set(scope: string, name: string, value: string): void
  /** No-op when absent. Works without a cipher (it only removes ciphertext). */
  delete(scope: string, name: string): void
  /** Remove every secret in a scope (e.g. when a company is deleted). */
  deleteScope(scope: string): void
}

interface SecretFile {
  version: 1
  /** scope → name → base64 ciphertext */
  secrets: Record<string, Record<string, string>>
}

function emptyFile(): SecretFile {
  return { version: 1, secrets: {} }
}

export function createSecretStore(opts: { filePath: () => string; cipher: SecretCipher }): SecretStore {
  const { cipher } = opts

  const load = (): SecretFile => {
    let text: string
    try {
      text = readFileSync(opts.filePath(), 'utf8')
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return emptyFile()
      throw err
    }
    const parsed = JSON.parse(text) as Partial<SecretFile>
    if (!parsed || typeof parsed !== 'object' || typeof parsed.secrets !== 'object' || parsed.secrets === null) {
      throw new Error('Secret store file is malformed')
    }
    return { version: 1, secrets: parsed.secrets }
  }

  const save = (data: SecretFile): void => {
    const file = opts.filePath()
    mkdirSync(dirname(file), { recursive: true })
    const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
    const fd = openSync(tmp, 'w', 0o600)
    try {
      writeSync(fd, JSON.stringify(data, null, 2))
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

  return {
    available: () => cipher.isAvailable(),
    get(scope, name) {
      const b64 = load().secrets[scope]?.[name]
      if (b64 === undefined) return null
      if (!cipher.isAvailable()) throw new SecretsUnavailableError()
      return cipher.decrypt(Buffer.from(b64, 'base64'))
    },
    set(scope, name, value) {
      if (!cipher.isAvailable()) throw new SecretsUnavailableError()
      const ct = cipher.encrypt(value).toString('base64')
      const data = load()
      data.secrets[scope] = { ...(data.secrets[scope] ?? {}), [name]: ct }
      save(data)
    },
    delete(scope, name) {
      const data = load()
      const bucket = data.secrets[scope]
      if (!bucket || !(name in bucket)) return
      delete bucket[name]
      if (Object.keys(bucket).length === 0) delete data.secrets[scope]
      save(data)
    },
    deleteScope(scope) {
      const data = load()
      if (!(scope in data.secrets)) return
      delete data.secrets[scope]
      save(data)
    }
  }
}

/**
 * Whether the non-secure test cipher may be used. All three must hold:
 * - TOTAL_INSECURE_TEST_SECRETS is exactly '1' (explicit opt-in),
 * - TOTAL_DATA_DIR is set (a scratch data root, never the real ~/Documents/total),
 * - the app is NOT packaged (a shipped build never honours the flag, whatever its env).
 * `isPackaged` is null when it can't be determined (Electron-as-Node: `app` is undefined) —
 * treated as unpackaged, since that environment is only ever the test runner.
 */
export function insecureTestCipherAllowed(env: { TOTAL_DATA_DIR?: string; TOTAL_INSECURE_TEST_SECRETS?: string }, isPackaged: boolean | null): boolean {
  if (isPackaged === true) return false
  return !!env.TOTAL_DATA_DIR && env.TOTAL_INSECURE_TEST_SECRETS === '1'
}

/** In-memory-key test cipher (XOR with a fixed pad + marker) — NOT secure. Used by unit/db tests
 *  and, via TOTAL_INSECURE_TEST_SECRETS, by the hermetic smoke/e2e runs so they never touch the
 *  developer's real keychain. */
export function insecureTestCipher(available = true): SecretCipher {
  const pad = Buffer.from('total-insecure-test-cipher')
  const xor = (b: Buffer): Buffer => Buffer.from(b.map((x, i) => x ^ pad[i % pad.length]!))
  return {
    isAvailable: () => available,
    encrypt: (plain) => Buffer.concat([Buffer.from('T1:'), xor(Buffer.from(plain, 'utf8'))]),
    decrypt: (ct) => {
      if (ct.subarray(0, 3).toString() !== 'T1:') throw new Error('Not a test-cipher value')
      return xor(ct.subarray(3)).toString('utf8')
    }
  }
}
