import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { generateKeyPairSync, createPrivateKey, sign } from 'crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

/**
 * The licence round trip, against a real key pair generated in the test.
 *
 * The forgery cases are the point. A licence that can be edited to say whatever the holder wants
 * is not a licence, and the failure mode of getting this wrong is silent -- everything keeps
 * working, for everyone, forever.
 */

let scratch: string
let privatePem: string
let publicB64: string

function issue(payload: Record<string, unknown>): string {
  const signed = Buffer.from(JSON.stringify(payload)).toString('base64url')
  const signature = sign(null, Buffer.from(signed), createPrivateKey(privatePem)).toString('base64url')
  return `${signed}.${signature}`
}

const validPayload = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  v: 1,
  name: 'Sharma Traders',
  plan: 'annual',
  issued: '2020-01-01',
  expires: '2099-01-01',
  companies: 1,
  ...over
})

beforeEach(async () => {
  scratch = mkdtempSync(join(tmpdir(), 'total-license-'))
  process.env.TOTAL_DATA_DIR = scratch
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  privatePem = privateKey.export({ format: 'pem', type: 'pkcs8' }) as string
  publicB64 = publicKey.export({ format: 'der', type: 'spki' }).toString('base64')
  process.env.TOTAL_LICENSE_PUBKEY = publicB64
  // The module reads the key at import time, so it has to be loaded after the env is set.
  await import('./license')
})

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true })
  delete process.env.TOTAL_DATA_DIR
  delete process.env.TOTAL_LICENSE_PUBKEY
})

async function svc(): Promise<typeof import('./license')> {
  return import('./license')
}

describe('licence verification', () => {
  it('accepts a licence signed with the matching private key', async () => {
    const { verifyToken } = await svc()
    expect(verifyToken(issue(validPayload()))).toBe(true)
  })

  it('rejects a payload edited after signing', async () => {
    const { verifyToken } = await svc()
    const token = issue(validPayload())
    const [, signature] = token.split('.')
    // The forgery a buyer would actually attempt: extend the expiry and keep the signature.
    const forged = Buffer.from(JSON.stringify(validPayload({ expires: '2199-01-01' }))).toString('base64url')
    expect(verifyToken(`${forged}.${signature}`)).toBe(false)
  })

  it('rejects a licence signed with a different key', async () => {
    const { verifyToken } = await svc()
    const other = generateKeyPairSync('ed25519')
    const signed = Buffer.from(JSON.stringify(validPayload())).toString('base64url')
    const signature = sign(null, Buffer.from(signed), other.privateKey).toString('base64url')
    expect(verifyToken(`${signed}.${signature}`)).toBe(false)
  })

  it('rejects malformed input without throwing', async () => {
    const { verifyToken } = await svc()
    for (const bad of ['', 'nonsense', 'a.b', '....', 'x'.repeat(5000)]) {
      expect(verifyToken(bad), bad.slice(0, 12)).toBe(false)
    }
  })
})

describe('licence state', () => {
  it('starts in trial with everything working', async () => {
    const { currentState } = await svc()
    const state = currentState()
    expect(state.kind).toBe('trial')
    expect(state.readOnly).toBe(false)
  })

  it('a valid key licenses the app and names the holder', async () => {
    const { applyToken } = await svc()
    const state = applyToken(issue(validPayload()))
    expect(state.kind).toBe('licensed')
    expect(state.readOnly).toBe(false)
    expect(state.message).toContain('Sharma Traders')
  })

  it('an expired licence goes read-only and says the books are still there', async () => {
    const { applyToken } = await svc()
    const state = applyToken(issue(validPayload({ expires: '2020-01-02' })))
    expect(state.kind).toBe('license-expired')
    expect(state.readOnly).toBe(true)
    expect(state.message).toMatch(/still here/)
    expect(state.message).toMatch(/export and back up/)
  })

  it('a forged key is reported, and still does not lock anything', async () => {
    const { applyToken } = await svc()
    const token = issue(validPayload())
    const forged = `${Buffer.from(JSON.stringify(validPayload({ name: 'Someone Else' }))).toString('base64url')}.${token.split('.')[1]}`
    const state = applyToken(forged)
    expect(state.kind).toBe('invalid')
    expect(state.readOnly).toBe(false)
  })

  it('survives a corrupt licence file rather than bricking the app', async () => {
    const { currentState } = await svc()
    writeFileSync(join(scratch, 'license.json'), '{ not json')
    expect(() => currentState()).not.toThrow()
    expect(currentState().kind).toBe('trial')
  })

  it('persists across restarts', async () => {
    const { applyToken, currentState } = await svc()
    applyToken(issue(validPayload()))
    expect(currentState().kind).toBe('licensed')
  })
})
