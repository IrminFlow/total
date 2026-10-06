// NIC credentials: secrets (password, clientSecret) live in the encrypted secret store, not the
// company DB's `meta`; a legacy plaintext copy in `meta` is moved out on first read.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { seededDb } from '../db/testdb'
import type { DB } from '../db/connection'
import { createSecretStore, insecureTestCipher, companyScope, SecretsUnavailableError, type SecretStore } from './secrets'
import { deleteNicSecrets, nicConfigured, readNicCredentials, writeNicCredentials } from './nic'
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
