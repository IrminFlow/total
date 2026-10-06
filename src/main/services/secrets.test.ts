import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  APP_SCOPE, SecretsUnavailableError, companyScope, createSecretStore, insecureTestCipher, type SecretCipher
} from './secrets'

let dir: string
let file: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'total-secrets-'))
  file = join(dir, 'nested', 'secrets.json')
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

/** Toggleable cipher so one store can see encryption come and go. */
function toggleCipher(): SecretCipher & { on: boolean } {
  const inner = insecureTestCipher()
  const c = {
    on: true,
    isAvailable: () => c.on,
    encrypt: inner.encrypt,
    decrypt: inner.decrypt
  }
  return c
}

describe('secret store', () => {
  it('round-trips by (scope, name) and keeps scopes apart', () => {
    const s = createSecretStore({ filePath: () => file, cipher: insecureTestCipher() })
    expect(s.get(companyScope('a'), 'nic.password')).toBeNull()
    s.set(companyScope('a'), 'nic.password', 'pw-a')
    s.set(companyScope('b'), 'nic.password', 'pw-b')
    s.set(APP_SCOPE, 'ai.apiKey', 'sk-123')
    expect(s.get(companyScope('a'), 'nic.password')).toBe('pw-a')
    expect(s.get(companyScope('b'), 'nic.password')).toBe('pw-b')
    expect(s.get(APP_SCOPE, 'ai.apiKey')).toBe('sk-123')
    // A fresh store over the same file sees the same data (persisted, not in-memory).
    const s2 = createSecretStore({ filePath: () => file, cipher: insecureTestCipher() })
    expect(s2.get(companyScope('a'), 'nic.password')).toBe('pw-a')
  })

  it('stores only ciphertext on disk, owner-only, with no temp files left behind', () => {
    const s = createSecretStore({ filePath: () => file, cipher: insecureTestCipher() })
    s.set(companyScope('a'), 'nic.password', 'super-secret-password')
    const text = readFileSync(file, 'utf8')
    expect(text).not.toContain('super-secret-password')
    const parsed = JSON.parse(text) as { version: number; secrets: Record<string, Record<string, string>> }
    expect(parsed.version).toBe(1)
    expect(typeof parsed.secrets['company:a']!['nic.password']).toBe('string')
    if (process.platform !== 'win32') expect(statSync(file).mode & 0o777).toBe(0o600)
    expect(readdirSync(join(dir, 'nested'))).toEqual(['secrets.json'])
  })

  it('delete / deleteScope remove entries; deleting without a cipher works', () => {
    const c = toggleCipher()
    const s = createSecretStore({ filePath: () => file, cipher: c })
    s.set(companyScope('a'), 'x', '1')
    s.set(companyScope('a'), 'y', '2')
    s.set(companyScope('b'), 'x', '3')
    c.on = false
    s.delete(companyScope('a'), 'x')
    s.delete(companyScope('a'), 'missing') // no-op
    c.on = true
    expect(s.get(companyScope('a'), 'x')).toBeNull()
    expect(s.get(companyScope('a'), 'y')).toBe('2')
    s.deleteScope(companyScope('a'))
    expect(s.get(companyScope('a'), 'y')).toBeNull()
    expect(s.get(companyScope('b'), 'x')).toBe('3')
  })

  it('refuses to store (and to read existing values) when encryption is unavailable — no plaintext fallback', () => {
    const c = toggleCipher()
    const s = createSecretStore({ filePath: () => file, cipher: c })
    s.set(companyScope('a'), 'x', 'kept')
    c.on = false
    expect(s.available()).toBe(false)
    expect(() => s.set(companyScope('a'), 'y', 'plain')).toThrow(SecretsUnavailableError)
    expect(() => s.get(companyScope('a'), 'x')).toThrow(/Secure storage is not available/)
    expect(s.get(companyScope('a'), 'absent')).toBeNull() // nothing to decrypt → just absent
    expect(readFileSync(file, 'utf8')).not.toContain('plain')
    c.on = true
    expect(s.get(companyScope('a'), 'x')).toBe('kept')
  })

  it('a failed write leaves the previous file intact (atomic replace)', () => {
    const s = createSecretStore({ filePath: () => file, cipher: insecureTestCipher() })
    s.set(APP_SCOPE, 'k', 'v1')
    const before = readFileSync(file, 'utf8')
    const broken = createSecretStore({
      filePath: () => file,
      cipher: { isAvailable: () => true, encrypt: () => { throw new Error('boom') }, decrypt: () => '' }
    })
    expect(() => broken.set(APP_SCOPE, 'k', 'v2')).toThrow('boom')
    expect(readFileSync(file, 'utf8')).toBe(before)
    expect(s.get(APP_SCOPE, 'k')).toBe('v1')
  })

  it('rejects a malformed file instead of silently overwriting it', () => {
    const s = createSecretStore({ filePath: () => file, cipher: insecureTestCipher() })
    s.set(APP_SCOPE, 'k', 'v')
    writeFileSync(file, '"not an object"')
    expect(() => s.set(APP_SCOPE, 'k2', 'v2')).toThrow(/malformed/)
    expect(existsSync(file)).toBe(true)
  })
})
