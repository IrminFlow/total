// WP 7.2 — the company database key, wrapped by a key derived from the owner's passphrase.
// Pure Node crypto (no Electron, no SQLite), so it is plain-vitest testable (keyEnvelope.test.ts).
//
// The DATA key is 32 random bytes; SQLCipher uses it as a raw key (no KDF on every open). It is
// never stored as is: the envelope holds it encrypted with AES-256-GCM under
// scrypt(passphrase, salt). The envelope alone is useless without the passphrase, which is never
// stored anywhere. A changed passphrase re-wraps the same data key — the database (and every
// backup made with it) is not re-encrypted.
import { createCipheriv, createDecipheriv, randomBytes, scrypt, scryptSync, timingSafeEqual } from 'crypto'

export const DATA_KEY_LEN = 32

export interface ScryptParams {
  N: number
  r: number
  p: number
}

/** scrypt cost: N = 2^17, r = 8, p = 1 (~128 MB, a few hundred ms) — the OWASP password-storage
 *  cheat sheet's scrypt minimum is N = 2^17, r = 8, p = 1. */
export const DEFAULT_SCRYPT: ScryptParams = { N: 2 ** 17, r: 8, p: 1 }

export interface KeyEnvelope {
  v: 1
  kdf: 'scrypt'
  N: number
  r: number
  p: number
  /** base64 */
  salt: string
  iv: string
  tag: string
  ct: string
  createdAt: string
}

export class WrongPassphraseError extends Error {
  constructor() {
    super('That passphrase is not right')
    this.name = 'WrongPassphraseError'
  }
}

const scryptOpts = (params: ScryptParams): { N: number; r: number; p: number; maxmem: number } => ({
  ...params,
  // maxmem must exceed 128 * N * r bytes, or scrypt refuses.
  maxmem: 256 * params.N * params.r + 1024 * 1024
})

function derive(passphrase: string, salt: Buffer, params: ScryptParams): Buffer {
  return scryptSync(passphrase.normalize('NFC'), salt, 32, scryptOpts(params))
}

/** The same KDF off the main thread (libuv's pool) — what the app uses, so a few hundred ms of
 *  scrypt never freeze the window. */
function deriveAsync(passphrase: string, salt: Buffer, params: ScryptParams): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(passphrase.normalize('NFC'), salt, 32, scryptOpts(params), (err, key) => (err ? reject(err) : resolve(key)))
  })
}

/** A fresh random data key. */
export function newDataKey(): Buffer {
  return randomBytes(DATA_KEY_LEN)
}

/** Wrap `key` under `passphrase`. The associated data binds the envelope's own parameters, so a
 *  tampered cost or version fails the tag check instead of silently weakening the KDF. */
export function wrapKey(key: Buffer, passphrase: string, params: ScryptParams = DEFAULT_SCRYPT, now = new Date()): KeyEnvelope {
  const salt = randomBytes(16)
  return seal(key, derive(passphrase, salt, params), salt, params, now)
}

export async function wrapKeyAsync(key: Buffer, passphrase: string, params: ScryptParams = DEFAULT_SCRYPT, now = new Date()): Promise<KeyEnvelope> {
  const salt = randomBytes(16)
  return seal(key, await deriveAsync(passphrase, salt, params), salt, params, now)
}

function seal(key: Buffer, kek: Buffer, salt: Buffer, params: ScryptParams, now: Date): KeyEnvelope {
  if (key.length !== DATA_KEY_LEN) throw new Error('A database key is 32 bytes')
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', kek, iv)
  cipher.setAAD(aad(params))
  const ct = Buffer.concat([cipher.update(key), cipher.final()])
  return {
    v: 1,
    kdf: 'scrypt',
    ...params,
    salt: salt.toString('base64'),
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    ct: ct.toString('base64'),
    createdAt: now.toISOString()
  }
}

/** The data key inside `env`, or WrongPassphraseError (a wrong passphrase and a damaged envelope
 *  look the same — GCM cannot tell them apart, and the caller must not either). */
export function unwrapKey(env: KeyEnvelope, passphrase: string): Buffer {
  if (!isKeyEnvelope(env)) throw new WrongPassphraseError()
  return open(env, derive(passphrase, Buffer.from(env.salt, 'base64'), { N: env.N, r: env.r, p: env.p }))
}

export async function unwrapKeyAsync(env: KeyEnvelope, passphrase: string): Promise<Buffer> {
  if (!isKeyEnvelope(env)) throw new WrongPassphraseError()
  return open(env, await deriveAsync(passphrase, Buffer.from(env.salt, 'base64'), { N: env.N, r: env.r, p: env.p }))
}

function open(env: KeyEnvelope, kek: Buffer): Buffer {
  const params = { N: env.N, r: env.r, p: env.p }
  try {
    const decipher = createDecipheriv('aes-256-gcm', kek, Buffer.from(env.iv, 'base64'))
    decipher.setAAD(aad(params))
    decipher.setAuthTag(Buffer.from(env.tag, 'base64'))
    const key = Buffer.concat([decipher.update(Buffer.from(env.ct, 'base64')), decipher.final()])
    if (key.length !== DATA_KEY_LEN) throw new Error('bad length')
    return key
  } catch {
    throw new WrongPassphraseError()
  }
}

function aad(params: ScryptParams): Buffer {
  return Buffer.from(`total-db-key:v1:scrypt:${params.N}:${params.r}:${params.p}`)
}

/** Shape check for an envelope read back from disk (never trusts the file). The cost may not be
 *  below 2^14 — a hand-edited file cannot make the passphrase cheap to guess. */
export function isKeyEnvelope(x: unknown): x is KeyEnvelope {
  const e = x as Partial<KeyEnvelope> | null
  return (
    !!e && e.v === 1 && e.kdf === 'scrypt' &&
    Number.isInteger(e.N) && (e.N as number) >= 2 ** 14 && (e.N as number) <= 2 ** 22 &&
    Number.isInteger(e.r) && (e.r as number) >= 1 && (e.r as number) <= 32 &&
    Number.isInteger(e.p) && (e.p as number) >= 1 && (e.p as number) <= 16 &&
    typeof e.salt === 'string' && typeof e.iv === 'string' && typeof e.tag === 'string' && typeof e.ct === 'string'
  )
}

/** Constant-time equality of two keys (tests and the verified-copy step). */
export function sameKey(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && timingSafeEqual(a, b)
}
