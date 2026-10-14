// Plain vitest (pure node:crypto — no electron, no SQLite). WP 7.2: the wrapped database key.
import { describe, expect, it } from 'vitest'
import { isKeyEnvelope, newDataKey, unwrapKey, unwrapKeyAsync, wrapKey, wrapKeyAsync, WrongPassphraseError, type ScryptParams } from './keyEnvelope'

// The cheapest cost the envelope accepts, so the suite stays fast (the app uses DEFAULT_SCRYPT).
const FAST: ScryptParams = { N: 2 ** 14, r: 8, p: 1 }

describe('the async KDF (what the app uses)', { timeout: 60_000 }, () => {
  it('interoperates with the sync one', async () => {
    const key = newDataKey()
    const env = await wrapKeyAsync(key, 'async passphrase', FAST)
    expect(unwrapKey(env, 'async passphrase').equals(key)).toBe(true)
    expect((await unwrapKeyAsync(wrapKey(key, 'sync one', FAST), 'sync one')).equals(key)).toBe(true)
    await expect(unwrapKeyAsync(env, 'nope nope')).rejects.toThrow(WrongPassphraseError)
  })
})

describe('key envelope (scrypt + AES-256-GCM)', { timeout: 60_000 }, () => {
  it('wraps and unwraps the same 32-byte key; the envelope holds neither key nor passphrase', () => {
    const key = newDataKey()
    const env = wrapKey(key, 'correct horse battery', FAST)
    expect(isKeyEnvelope(env)).toBe(true)
    expect(unwrapKey(env, 'correct horse battery').equals(key)).toBe(true)
    const text = JSON.stringify(env)
    expect(text).not.toContain(key.toString('hex'))
    expect(text).not.toContain(key.toString('base64'))
    expect(text).not.toContain('correct horse battery')
  })

  it('a wrong passphrase, a tampered ciphertext or a tampered cost all fail the same way', () => {
    const env = wrapKey(newDataKey(), 'passphrase one', FAST)
    expect(() => unwrapKey(env, 'passphrase two')).toThrow(WrongPassphraseError)
    const ct = Buffer.from(env.ct, 'base64')
    ct[0] = ct[0]! ^ 1
    expect(() => unwrapKey({ ...env, ct: ct.toString('base64') }, 'passphrase one')).toThrow(WrongPassphraseError)
    // The cost is bound into the tag (AAD): raising it is a different envelope.
    expect(() => unwrapKey({ ...env, N: 2 ** 15 }, 'passphrase one')).toThrow(WrongPassphraseError)
  })

  it('refuses a hand-made cheap envelope and odd shapes', () => {
    const env = wrapKey(newDataKey(), 'passphrase one', FAST)
    expect(isKeyEnvelope({ ...env, N: 1024 })).toBe(false)
    expect(isKeyEnvelope({ ...env, kdf: 'pbkdf2' })).toBe(false)
    expect(isKeyEnvelope(null)).toBe(false)
    expect(() => unwrapKey({ ...env, N: 1024 }, 'passphrase one')).toThrow(WrongPassphraseError)
  })

  it('two wraps of one key differ (fresh salt and IV) and both open', () => {
    const key = newDataKey()
    const a = wrapKey(key, 'same passphrase', FAST)
    const b = wrapKey(key, 'same passphrase', FAST)
    expect(a.salt).not.toBe(b.salt)
    expect(a.ct).not.toBe(b.ct)
    expect(unwrapKey(b, 'same passphrase').equals(key)).toBe(true)
  })

  it('the passphrase is NFC-normalised (the same word typed two ways opens the same envelope)', () => {
    const key = newDataKey()
    const env = wrapKey(key, 'café passphrase', FAST)
    expect(unwrapKey(env, 'café passphrase').equals(key)).toBe(true)
  })
})
