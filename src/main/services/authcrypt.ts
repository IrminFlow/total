// Pure Node crypto — no Electron, no better-sqlite3 — so this is plain-vitest testable.
// Stored format: "scrypt$<N>$<r>$<p>$<saltB64>$<hashB64>" — the scrypt cost parameters travel
// with the hash so they can be tuned later without invalidating existing PINs.
import { randomBytes, scryptSync, timingSafeEqual } from 'crypto'

const SCRYPT_OPTS = { N: 16384, r: 8, p: 1 } as const
const SALT_LEN = 16
const KEY_LEN = 32

/** Hash a numeric PIN for storage. A fresh random salt means two hashes of the same PIN differ. */
export function hashPin(pin: string): string {
  const salt = randomBytes(SALT_LEN)
  const key = scryptSync(pin, salt, KEY_LEN, SCRYPT_OPTS)
  return `scrypt$${SCRYPT_OPTS.N}$${SCRYPT_OPTS.r}$${SCRYPT_OPTS.p}$${salt.toString('base64')}$${key.toString('base64')}`
}

/** Verify `pin` against a hash produced by `hashPin`. Never throws — any malformed input returns false. */
export function verifyPin(pin: string, stored: string): boolean {
  const parts = stored.split('$')
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false
  const [, nStr, rStr, pStr, saltB64, hashB64] = parts as [string, string, string, string, string, string]
  const N = Number(nStr)
  const r = Number(rStr)
  const p = Number(pStr)
  if (!Number.isInteger(N) || !Number.isInteger(r) || !Number.isInteger(p)) return false

  let salt: Buffer
  let expected: Buffer
  try {
    salt = Buffer.from(saltB64, 'base64')
    expected = Buffer.from(hashB64, 'base64')
  } catch {
    return false
  }
  if (expected.length !== KEY_LEN) return false

  let actual: Buffer
  try {
    actual = scryptSync(pin, salt, KEY_LEN, { N, r, p })
  } catch {
    return false
  }
  // Length-check before timingSafeEqual — it throws on mismatched buffer lengths.
  if (actual.length !== expected.length) return false
  return timingSafeEqual(actual, expected)
}
