// WP 7.2 review — the passphrase lock's convert-copy-verify-swap under a crash at every step, on
// the real driver. Each "crash" leaves the files exactly as the process would have left them at
// that point (the steps are synchronous, so a kill can only land between them) and then checks
// which file is live, that the books open with the right key, and that the next run (or the next
// open's leftover sweep) finishes the job — the original is never lost.
import { afterAll, describe, expect, it } from 'vitest'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import Database from 'better-sqlite3-multiple-ciphers'
import { forgetAllKeys, isEncryptedFile, openDb, rekeyFile } from './encryption'
import { snapshotTo } from './backup'
import { newDataKey, wrapKey } from './keyEnvelope'
import { migrate } from './migrate'
import { seedCompany } from './seed'
import { TEST_INFO } from './testdb'
import { bookFacts, commitConvertedCopy, convertBackups, convertCompanyFile, prepareConvertedCopy, removeLeftoverCopies, sameFacts } from '../services/dbEncryption'
import { readEnvelopes, unlockKey, writeEnvelope } from '../services/companyKeys'
import { WrongPassphraseError } from './keyEnvelope'
import type { SecretStore } from '../services/secrets'

const ROOT = mkdtempSync(join(tmpdir(), 'total-enc-crash-'))
afterAll(() => {
  forgetAllKeys()
  rmSync(ROOT, { recursive: true, force: true })
})
const AS_ON = '2027-03-31'
const SCRYPT = { N: 2 ** 14, r: 8, p: 1 }

let n = 0
function companyFile(): string {
  const dir = join(ROOT, `co-${++n}`)
  mkdirSync(join(dir, 'backups'), { recursive: true })
  mkdirSync(join(dir, 'exports'), { recursive: true })
  const path = join(dir, 'company.db')
  const db = new Database(path)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  migrate(db)
  seedCompany(db, TEST_INFO)
  db.close()
  return path
}
const open = (path: string, key: Buffer | null): Database.Database => {
  const db = openDb(path, { key })
  db.pragma('journal_mode = WAL')
  return db
}
const factsOf = (path: string, key: Buffer | null): ReturnType<typeof bookFacts> => {
  const db = open(path, key)
  try {
    return bookFacts(db, AS_ON)
  } finally {
    db.close()
  }
}
const audit = { before: { encrypted: false }, after: { encrypted: true } }

/** An in-memory secret store (the safeStorage mirror). */
function memoryStore(): SecretStore & { map: Map<string, string> } {
  const map = new Map<string, string>()
  return {
    map,
    available: () => true,
    get: (scope, name) => map.get(`${scope}/${name}`) ?? null,
    set: (scope, name, value) => void map.set(`${scope}/${name}`, value),
    delete: (scope, name) => void map.delete(`${scope}/${name}`),
    deleteScope: (scope) => {
      for (const k of [...map.keys()]) if (k.startsWith(`${scope}/`)) map.delete(k)
    }
  }
}

describe('turning the lock on: a crash at every step', () => {
  it('killed after the verified copy was written, before the swap: the plaintext original is live and intact; the leftover copy is swept; a re-run converts', () => {
    const path = companyFile()
    const before = factsOf(path, null)
    const key = newDataKey()
    const db = open(path, null)
    const tmp = prepareConvertedCopy({ db, dbPath: path, to: key, asOn: AS_ON, audit })
    db.close() // the process dies here: the handle goes, nothing renamed
    expect(existsSync(tmp)).toBe(true)
    expect(isEncryptedFile(path)).toBe(false)
    expect(sameFacts(factsOf(path, null), before)).toBe(true)
    // the next open sweeps the leftover
    removeLeftoverCopies(path, join(path, '..', 'backups'), join(path, '..', 'exports'))
    expect(existsSync(tmp)).toBe(false)
    // and turning the lock on again works
    convertCompanyFile({ db: open(path, null), dbPath: path, to: key, asOn: AS_ON, audit })
    expect(isEncryptedFile(path)).toBe(true)
    const after = factsOf(path, key)
    expect(after.movementDebit).toBe(before.movementDebit)
    expect(after.auditOk).toBe(true)
  })

  it('killed after the rename, before the old -wal / -shm were removed: the encrypted copy is live and opens with its key', () => {
    const path = companyFile()
    const key = newDataKey()
    const db = open(path, null)
    const tmp = prepareConvertedCopy({ db, dbPath: path, to: key, asOn: AS_ON, audit })
    db.close()
    // what the old file's cleanly closed WAL leaves at most: an empty -wal and an -shm
    writeFileSync(`${path}-wal`, '')
    writeFileSync(`${path}-shm`, Buffer.alloc(32768, 7))
    renameSync(tmp, path) // the commit's rename, then the crash
    const f = factsOf(path, key)
    expect(f.auditOk).toBe(true)
    const check = openDb(path, { key, readonly: true })
    try {
      expect(check.pragma('quick_check', { simple: true })).toBe('ok')
    } finally {
      check.close()
    }
  })

  it('the swap is refused while the original still has WAL frames (they are not in the copy): nothing changes, the copy goes', () => {
    const path = companyFile()
    const key = newDataKey()
    const db = open(path, null)
    const tmp = prepareConvertedCopy({ db, dbPath: path, to: key, asOn: AS_ON, audit })
    db.close()
    const original = readFileSync(path)
    writeFileSync(`${path}-wal`, Buffer.alloc(4096, 1)) // a WAL a reader kept alive
    expect(() => commitConvertedCopy(tmp, path)).toThrow(/still in use/)
    expect(existsSync(tmp)).toBe(false)
    expect(readFileSync(path).equals(original)).toBe(true)
    rmSync(`${path}-wal`)
    expect(isEncryptedFile(path)).toBe(false)
    expect(factsOf(path, null).auditOk).toBe(true)
  })
})

describe('taking the lock off: a crash at every step', () => {
  it('killed before the swap: the encrypted original stays live; the PLAINTEXT copy beside it is swept on the next open', () => {
    const path = companyFile()
    const key = newDataKey()
    convertCompanyFile({ db: open(path, null), dbPath: path, to: key, asOn: AS_ON, audit })
    const before = factsOf(path, key)
    const db = open(path, key)
    const tmp = prepareConvertedCopy({ db, dbPath: path, to: null, asOn: AS_ON, audit: { before: audit.after, after: audit.before } })
    db.close()
    expect(isEncryptedFile(tmp)).toBe(false) // a plaintext copy of locked books — must not stay
    expect(isEncryptedFile(path)).toBe(true)
    expect(sameFacts(factsOf(path, key), before)).toBe(true)
    removeLeftoverCopies(path, join(path, '..', 'backups'), join(path, '..', 'exports'))
    expect(existsSync(tmp)).toBe(false)
  })

  it("a backup's interrupted conversion (*.db.converting) is swept; finished backups are never touched", () => {
    const path = companyFile()
    const backups = join(path, '..', 'backups')
    const keep = join(backups, '2026-10-01T00-00-00-manual.db')
    copyFileSync(path, keep)
    writeFileSync(`${keep}.converting`, 'half')
    writeFileSync(`${keep}.restore-tmp`, 'half')
    const exportsDir = join(path, '..', 'exports')
    const oldTmp = join(exportsDir, '.export-tmp-2026-10-01.db')
    const freshTmp = join(exportsDir, '.export-tmp-2026-10-15.db')
    writeFileSync(oldTmp, 'plain')
    writeFileSync(freshTmp, 'plain')
    const twoHoursAgo = (Date.now() - 2 * 3600_000) / 1000
    utimesSync(oldTmp, twoHoursAgo, twoHoursAgo)
    removeLeftoverCopies(path, backups, exportsDir)
    expect(existsSync(keep)).toBe(true)
    expect(existsSync(`${keep}.converting`)).toBe(false)
    expect(existsSync(`${keep}.restore-tmp`)).toBe(false)
    expect(existsSync(oldTmp)).toBe(false)
    expect(existsSync(freshTmp)).toBe(true) // an export still writing its snapshot
    expect(statSync(path).size).toBeGreaterThan(0)
  })

  it('a backup that cannot be decrypted is left as it was and reported (the caller keeps the key for it)', () => {
    const path = companyFile()
    const key = newDataKey()
    const backups = join(path, '..', 'backups')
    const good = join(backups, '2026-10-01T00-00-00-manual.db')
    copyFileSync(path, good)
    rekeyFile(good, null, key)
    const bad = join(backups, '2026-10-02T00-00-00-manual.db')
    copyFileSync(good, bad)
    const bytes = readFileSync(bad)
    bytes.fill(0x42, 0, 64) // header / salt destroyed
    writeFileSync(bad, bytes)
    const out = convertBackups(backups, key, null)
    expect(out.converted).toBe(1)
    expect(out.failed).toEqual(['2026-10-02T00-00-00-manual.db'])
    expect(readFileSync(bad).equals(bytes)).toBe(true)
    expect(isEncryptedFile(good)).toBe(false)
  })
})

describe('the two envelope copies', () => {
  it('when the folder copy and the secret store disagree, either passphrase that unwraps a key OF THIS FILE opens it', async () => {
    const path = companyFile()
    const dir = join(path, '..')
    const key = newDataKey()
    convertCompanyFile({ db: open(path, null), dbPath: path, to: key, asOn: AS_ON, audit })
    const store = memoryStore()
    writeEnvelope(dir, 'co', wrapKey(key, 'first passphrase', SCRYPT), store)
    const oldFolderCopy = readFileSync(join(dir, 'company.key.json'))
    // the passphrase changes (both copies), then the folder is put back from an older copy
    writeEnvelope(dir, 'co', wrapKey(key, 'second passphrase', SCRYPT), store)
    writeFileSync(join(dir, 'company.key.json'), oldFolderCopy)
    const envs = readEnvelopes(dir, 'co', store)
    expect(envs).toHaveLength(2)
    expect((await unlockKey(path, envs, 'second passphrase')).equals(key)).toBe(true)
    expect((await unlockKey(path, envs, 'first passphrase')).equals(key)).toBe(true)
    await expect(unlockKey(path, envs, 'never set')).rejects.toBeInstanceOf(WrongPassphraseError)
    // an envelope of ANOTHER key (the lock turned off and on again since) never opens the file
    const stale = [wrapKey(newDataKey(), 'third passphrase', SCRYPT)]
    await expect(unlockKey(path, stale, 'third passphrase')).rejects.toBeInstanceOf(WrongPassphraseError)
  })

  it('a mirror that cannot take the new envelope drops the old one (no stale passphrase left in it)', () => {
    const dir = join(ROOT, 'mirror')
    mkdirSync(dir, { recursive: true })
    const key = newDataKey()
    const store = memoryStore()
    expect(writeEnvelope(dir, 'm', wrapKey(key, 'first passphrase', SCRYPT), store).mirrored).toBe(true)
    const failing: SecretStore = { ...store, set: () => { throw new Error('keychain locked') } }
    expect(writeEnvelope(dir, 'm', wrapKey(key, 'second passphrase', SCRYPT), failing).mirrored).toBe(false)
    expect(store.map.size).toBe(0)
    expect(readEnvelopes(dir, 'm', store)).toHaveLength(1)
  })
})

describe('backups of a locked business', () => {
  it('a second backup with the same name (same second) replaces the first, as the online backup does — VACUUM INTO alone refuses', async () => {
    const path = companyFile()
    const key = newDataKey()
    rekeyFile(path, null, key)
    const db = open(path, key)
    const dest = join(path, '..', 'backups', '2026-10-15T00-00-00-manual.db')
    try {
      await snapshotTo(db, dest)
      db.prepare("INSERT INTO meta (key, value) VALUES ('review.marker', '1')").run()
      await snapshotTo(db, dest)
    } finally {
      db.close()
    }
    expect(existsSync(`${dest}.vacuum-tmp`)).toBe(false)
    const copy = openDb(dest, { key, readonly: true })
    try {
      expect(copy.prepare("SELECT value FROM meta WHERE key = 'review.marker'").get()).toEqual({ value: '1' })
    } finally {
      copy.close()
    }
  })
})
