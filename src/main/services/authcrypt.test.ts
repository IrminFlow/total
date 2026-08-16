// Plain vitest (pure node:crypto — no electron, no better-sqlite3). Matches src/main/**/*.test.ts
// so it runs under `npm test`, not `npm run test:db`.
import { describe, it, expect } from 'vitest'
import { hashPin, verifyPin } from './authcrypt'

describe('hashPin / verifyPin', () => {
  it('round-trips the correct PIN', () => {
    const hash = hashPin('1234')
    expect(verifyPin('1234', hash)).toBe(true)
  })

  it('rejects the wrong PIN', () => {
    const hash = hashPin('1234')
    expect(verifyPin('4321', hash)).toBe(false)
  })

  it('rejects a tampered hash', () => {
    const hash = hashPin('1234')
    const parts = hash.split('$')
    // Flip the last character of the stored hash's base64 payload.
    const last = parts[5]!
    const flipped = last.slice(0, -1) + (last.at(-1) === 'A' ? 'B' : 'A')
    parts[5] = flipped
    const tampered = parts.join('$')
    expect(verifyPin('1234', tampered)).toBe(false)
  })

  it('produces a different hash each time for the same PIN (random salt)', () => {
    const a = hashPin('9999')
    const b = hashPin('9999')
    expect(a).not.toBe(b)
    expect(verifyPin('9999', a)).toBe(true)
    expect(verifyPin('9999', b)).toBe(true)
  })

  it('rejects malformed stored hashes without throwing', () => {
    expect(verifyPin('1234', 'not-a-hash')).toBe(false)
    expect(verifyPin('1234', 'scrypt$16384$8$1$bad')).toBe(false)
    expect(verifyPin('1234', '')).toBe(false)
  })
})
