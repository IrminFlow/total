// NIC credentials: secrets (password, clientSecret) live in the encrypted secret store, not the
// company DB's `meta`; a legacy plaintext copy in `meta` is moved out on first read.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { seededDb } from '../db/testdb'
import type { DB } from '../db/connection'
import { createSecretStore, insecureTestCipher, companyScope, SecretsUnavailableError, type SecretStore } from './secrets'
import crypto from 'crypto'
import {
  authenticate, deleteNicSecrets, nicConfigured, readNicCredentials, resetNicSession, writeNicCredentials, type NicFetch
} from './nic'
import { nicCredentialsSchema } from '@shared/schemas'

const CREDS = nicCredentialsSchema.parse({
  baseUrlEinvoice: 'https://einv-apisandbox.nic.in',
  username: 'demo_user',
  password: 'secret123',
  clientId: 'CID',
  clientSecret: 'CSEC',
  publicKeyPem: '-----BEGIN PUBLIC KEY-----\nMIIB\n-----END PUBLIC KEY-----'
})

let dir: string
let prevDataDir: string | undefined
let store: SecretStore
let db: DB

function metaNic(): Record<string, unknown> | null {
  const row = db.prepare("SELECT value FROM meta WHERE key = 'nic'").get() as { value: string } | undefined
  return row ? (JSON.parse(row.value) as Record<string, unknown>) : null
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'total-nic-'))
  // log() derives its folder from dataRoot(); keep it hermetic.
  prevDataDir = process.env.TOTAL_DATA_DIR
  process.env.TOTAL_DATA_DIR = dir
})

afterAll(() => {
  if (prevDataDir === undefined) delete process.env.TOTAL_DATA_DIR
  else process.env.TOTAL_DATA_DIR = prevDataDir
  rmSync(dir, { recursive: true, force: true })
})

beforeEach(() => {
  const file = join(dir, `secrets-${Math.random().toString(36).slice(2)}.json`)
  store = createSecretStore({ filePath: () => file, cipher: insecureTestCipher() })
  db = seededDb()
})

describe('NIC credentials at rest', () => {
  it('write keeps secrets out of meta and reads them back from the store', () => {
    writeNicCredentials(db, 'acme', CREDS, store)
    const meta = metaNic()!
    expect(meta.username).toBe('demo_user')
    expect(meta).not.toHaveProperty('password')
    expect(meta).not.toHaveProperty('clientSecret')
    expect(JSON.stringify(meta)).not.toContain('secret123')
    expect(store.get(companyScope('acme'), 'nic.password')).toBe('secret123')
    expect(readNicCredentials(db, 'acme', store)).toEqual(CREDS)
    expect(nicConfigured(db, 'acme', store)).toBe(true)
    // Another company (slug) doesn't see them.
    expect(readNicCredentials(db, 'other', store).password).toBe('')
  })

  it('migrates a legacy plaintext copy out of meta on first read', () => {
    db.prepare("INSERT INTO meta (key, value) VALUES ('nic', ?)").run(JSON.stringify(CREDS))
    const got = readNicCredentials(db, 'acme', store)
    expect(got).toEqual(CREDS)
    const meta = metaNic()!
    expect(meta).not.toHaveProperty('password')
    expect(meta).not.toHaveProperty('clientSecret')
    expect(meta.username).toBe('demo_user') // non-secret fields stay put
    expect(meta.publicKeyPem).toBe(CREDS.publicKeyPem)
    expect(store.get(companyScope('acme'), 'nic.password')).toBe('secret123')
    expect(store.get(companyScope('acme'), 'nic.clientSecret')).toBe('CSEC')
    // Idempotent: a second read changes nothing and still returns the secrets.
    expect(readNicCredentials(db, 'acme', store)).toEqual(CREDS)
  })

  it('store wins over an older plaintext copy (e.g. a restored pre-migration backup), which is still scrubbed', () => {
    writeNicCredentials(db, 'acme', { ...CREDS, password: 'newer-pw' }, store)
    db.prepare("UPDATE meta SET value = ? WHERE key = 'nic'").run(JSON.stringify(CREDS))
    expect(readNicCredentials(db, 'acme', store).password).toBe('newer-pw')
    expect(metaNic()).not.toHaveProperty('password')
  })

  it('clearing a secret deletes it from the store', () => {
    writeNicCredentials(db, 'acme', CREDS, store)
    writeNicCredentials(db, 'acme', { ...CREDS, clientSecret: '' }, store)
    expect(store.get(companyScope('acme'), 'nic.clientSecret')).toBeNull()
    expect(readNicCredentials(db, 'acme', store).clientSecret).toBe('')
  })

  it('without encryption: refuses to save, leaves legacy plaintext untouched, never writes plaintext', () => {
    const off = createSecretStore({ filePath: () => join(dir, 'off.json'), cipher: insecureTestCipher(false) })
    expect(() => writeNicCredentials(db, 'acme', CREDS, off)).toThrow(SecretsUnavailableError)
    expect(metaNic()).toBeNull() // nothing written at all
    db.prepare("INSERT INTO meta (key, value) VALUES ('nic', ?)").run(JSON.stringify(CREDS))
    expect(readNicCredentials(db, 'acme', off)).toEqual(CREDS)
    expect(metaNic()!.password).toBe('secret123') // not migrated (can't be), not lost
  })

  it('deleteNicSecrets forgets a company', () => {
    writeNicCredentials(db, 'acme', CREDS, store)
    deleteNicSecrets('acme', store)
    expect(readNicCredentials(db, 'acme', store).password).toBe('')
    expect(nicConfigured(db, 'acme', store)).toBe(false)
  })
})

// ---------- session isolation (fake portal; no network) ----------

/** Minimal NIC auth endpoint: decrypts the RSA payload (PKCS#1 v1.5 over Base64(JSON) — WP 3.5), returns a token
 *  naming the caller (gstin/user) and a SEK encrypted under the caller's AppKey. */
function fakePortal(privateKeyPem: string) {
  const calls: { url: string; gstin: string; user: string }[] = []
  let n = 0
  const fetchFn: NicFetch = async (url, init) => {
    const { Data } = JSON.parse(init.body!) as { Data: string }
    const plain = crypto.privateDecrypt({ key: privateKeyPem, padding: crypto.constants.RSA_PKCS1_PADDING }, Buffer.from(Data, 'base64'))
    const { UserName, AppKey } = JSON.parse(Buffer.from(plain.toString('utf8'), 'base64').toString('utf8')) as { UserName: string; AppKey: string }
    calls.push({ url, gstin: init.headers.Gstin!, user: UserName })
    const cipher = crypto.createCipheriv('aes-256-ecb', Buffer.from(AppKey, 'base64'), null)
    const sek = Buffer.concat([cipher.update(crypto.randomBytes(32)), cipher.final()]).toString('base64')
    const inner = { AuthToken: `token-${++n}-${init.headers.Gstin}-${UserName}`, Sek: sek, TokenExpiry: '2099-01-01 00:00:00' }
    return { status: 200, json: async () => ({ Status: 1, Data: inner }) }
  }
  return { fetchFn, calls }
}

describe('NIC session cache', () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
  })
  const A = { ...CREDS, publicKeyPem: publicKey }

  beforeEach(() => resetNicSession())

  it('reuses a session only for the identity it was obtained for', async () => {
    const portal = fakePortal(privateKey)
    const s1 = await authenticate(A, '27AAAAA0000A1Z5', portal.fetchFn)
    const again = await authenticate(A, '27AAAAA0000A1Z5', portal.fetchFn)
    expect(again.authToken).toBe(s1.authToken)
    expect(portal.calls).toHaveLength(1)

    // Different company GSTIN, username, client id or endpoint (sandbox vs prod) → fresh login.
    const variants: [typeof A, string][] = [
      [A, '29BBBBB1111B1Z5'],
      [{ ...A, username: 'other_user' }, '27AAAAA0000A1Z5'],
      [{ ...A, clientId: 'CID2' }, '27AAAAA0000A1Z5'],
      [{ ...A, baseUrlEinvoice: 'https://api.einvoice1.gst.gov.in' }, '27AAAAA0000A1Z5'],
      [{ ...A, password: 'changed' }, '27AAAAA0000A1Z5']
    ]
    for (const [creds, gstin] of variants) {
      const s = await authenticate(creds, gstin, portal.fetchFn)
      expect(s.authToken).not.toBe(s1.authToken)
    }
    expect(portal.calls).toHaveLength(1 + variants.length)
    expect(portal.calls[1]!.gstin).toBe('29BBBBB1111B1Z5')
  })

  it('resetNicSession (credential save / company switch) forces a new login', async () => {
    const portal = fakePortal(privateKey)
    const s1 = await authenticate(A, '27AAAAA0000A1Z5', portal.fetchFn)
    resetNicSession()
    const s2 = await authenticate(A, '27AAAAA0000A1Z5', portal.fetchFn)
    expect(s2.authToken).not.toBe(s1.authToken)
    expect(portal.calls).toHaveLength(2)
  })
})
