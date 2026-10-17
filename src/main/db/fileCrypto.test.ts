// WP 7.2 follow-up — the encrypted file store's format (pure: crypto + fs, no database).
import { afterAll, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { randomBytes } from 'crypto'
import {
  CONVERTING_SUFFIX, FILE_HEADER_BYTES, FILE_MAGIC, FileCryptoError, convertStore, copyStoredAs, decryptBytes, decryptFileTo, encryptBytes, encryptFileTo,
  fileSubkey, hasFileHeader, readStoredBytes, removeConvertingLeftovers, sha256Hex, storedFileMatches, storedForm
} from './fileCrypto'

const ROOT = mkdtempSync(join(tmpdir(), 'total-filecrypto-'))
afterAll(() => rmSync(ROOT, { recursive: true, force: true }))
const KEY = randomBytes(32)
const OTHER = randomBytes(32)
let n = 0
const scratch = (): string => {
  const d = join(ROOT, `t-${++n}`)
  mkdirSync(d, { recursive: true })
  return d
}
/** A store holding `data` under its hash, in plain form. */
function storeWith(dir: string, data: Buffer): { sha: string; abs: string } {
  const sha = sha256Hex(data)
  mkdirSync(join(dir, sha.slice(0, 2)), { recursive: true })
  const abs = join(dir, sha.slice(0, 2), sha)
  writeFileSync(abs, data)
  return { sha, abs }
}

describe('fileCrypto', () => {
  const plain = Buffer.from('%PDF-1.4 a bill for ₹1,180 '.repeat(500))
  const sha = sha256Hex(plain)

  it('round-trips bytes and files, and the header is detected', () => {
    const blob = encryptBytes(plain, KEY, sha)
    expect(hasFileHeader(blob)).toBe(true)
    expect(blob.subarray(0, 4).equals(FILE_MAGIC)).toBe(true)
    expect(blob.length).toBe(plain.length + FILE_HEADER_BYTES)
    expect(blob.includes(Buffer.from('a bill for'))).toBe(false)
    expect(decryptBytes(blob, KEY, sha).equals(plain)).toBe(true)
    // Two encryptions of the same file differ (random nonce), both open.
    expect(encryptBytes(plain, KEY, sha).equals(blob)).toBe(false)
    expect(hasFileHeader(plain)).toBe(false)
    expect(hasFileHeader(FILE_MAGIC)).toBe(false) // too short for nonce + tag

    const d = scratch()
    writeFileSync(join(d, 'p'), plain)
    encryptFileTo(join(d, 'p'), join(d, 'e'), KEY, sha)
    expect(decryptBytes(readFileSync(join(d, 'e')), KEY, sha).equals(plain)).toBe(true)
    decryptFileTo(join(d, 'e'), join(d, 'back'), KEY, sha)
    expect(readFileSync(join(d, 'back')).equals(plain)).toBe(true)
    expect(storedForm(join(d, 'e'), sha)).toBe('encrypted')
    expect(storedForm(join(d, 'p'), sha)).toBe('plain')
    expect(readStoredBytes(join(d, 'e'), sha, KEY).equals(plain)).toBe(true)
    expect(readStoredBytes(join(d, 'p'), sha, null).equals(plain)).toBe(true)
  })

  it('empty and large (multi-chunk) files round-trip', () => {
    const d = scratch()
    for (const data of [Buffer.alloc(0), randomBytes((1 << 20) * 2 + 17)]) {
      const s = sha256Hex(data)
      writeFileSync(join(d, `p-${s}`), data)
      encryptFileTo(join(d, `p-${s}`), join(d, `e-${s}`), KEY, s)
      expect(readStoredBytes(join(d, `e-${s}`), s, KEY).equals(data)).toBe(true)
      expect(storedFileMatches(join(d, `e-${s}`), s, KEY)).toBe(true)
    }
  })

  it('a tampered file is refused, and nothing is left behind', () => {
    const blob = encryptBytes(plain, KEY, sha)
    for (const at of [5, 20, FILE_HEADER_BYTES + 3, blob.length - 1]) {
      const bad = Buffer.from(blob)
      bad[at] = bad[at]! ^ 0x01
      expect(() => decryptBytes(bad, KEY, sha)).toThrow(FileCryptoError)
      const d = scratch()
      writeFileSync(join(d, 'e'), bad)
      expect(() => decryptFileTo(join(d, 'e'), join(d, 'out'), KEY, sha)).toThrow(FileCryptoError)
      expect(() => readFileSync(join(d, 'out'))).toThrow() // the partial plaintext is removed
      expect(storedFileMatches(join(d, 'e'), sha, KEY)).toBe(false)
    }
    expect(() => decryptBytes(blob.subarray(0, blob.length - 10), KEY, sha)).toThrow(FileCryptoError) // truncated
  })

  it('the wrong key, or another file’s name, is refused', () => {
    const blob = encryptBytes(plain, KEY, sha)
    expect(() => decryptBytes(blob, OTHER, sha)).toThrow(FileCryptoError)
    // The subkey is bound to the content hash: the same bytes under another name do not open.
    const otherSha = sha256Hex(Buffer.from('another file'))
    expect(() => decryptBytes(blob, KEY, otherSha)).toThrow(FileCryptoError)
    expect(fileSubkey(KEY, sha).equals(fileSubkey(KEY, otherSha))).toBe(false)
    expect(fileSubkey(KEY, sha).equals(fileSubkey(OTHER, sha))).toBe(false)
    expect(() => fileSubkey(Buffer.alloc(16), sha)).toThrow(FileCryptoError)
    const d = scratch()
    writeFileSync(join(d, 'e'), blob)
    expect(() => readStoredBytes(join(d, 'e'), sha, null)).toThrow(/locked/)
    expect(() => readStoredBytes(join(d, 'e'), sha, OTHER)).toThrow(FileCryptoError)
    expect(storedFileMatches(join(d, 'e'), sha, null)).toBe(false)
  })

  it('refuses to encrypt bytes that do not match their hash', () => {
    expect(() => encryptBytes(plain, KEY, sha256Hex(Buffer.from('x')))).toThrow(FileCryptoError)
    const d = scratch()
    writeFileSync(join(d, 'p'), plain)
    expect(() => encryptFileTo(join(d, 'p'), join(d, 'e'), KEY, sha256Hex(Buffer.from('x')))).toThrow(FileCryptoError)
    expect(() => readFileSync(join(d, 'e'))).toThrow()
  })

  it('a plaintext file that happens to begin with "TLF1" is still plain', () => {
    const odd = Buffer.concat([FILE_MAGIC, Buffer.from(' — not encrypted, just a text file that starts like one '.repeat(3))])
    const d = scratch()
    const { sha: s, abs } = storeWith(d, odd)
    expect(hasFileHeader(odd)).toBe(true)
    expect(storedForm(abs, s)).toBe('plain')
    expect(readStoredBytes(abs, s, null).equals(odd)).toBe(true)
    expect(storedFileMatches(abs, s, null)).toBe(true)
    // Converting it encrypts it (it is not skipped as "already encrypted").
    expect(convertStore(d, null, KEY)).toEqual({ converted: 1, skipped: 0, failed: [] })
    expect(storedForm(abs, s)).toBe('encrypted')
    expect(readStoredBytes(abs, s, KEY).equals(odd)).toBe(true)
  })

  it('copyStoredAs gives the asked-for form from either form', () => {
    const d = scratch()
    const { abs } = storeWith(d, plain)
    copyStoredAs(abs, join(d, 'enc'), sha, null, KEY)
    expect(storedForm(join(d, 'enc'), sha)).toBe('encrypted')
    copyStoredAs(join(d, 'enc'), join(d, 'enc2'), sha, KEY, OTHER) // re-keyed
    expect(readStoredBytes(join(d, 'enc2'), sha, OTHER).equals(plain)).toBe(true)
    copyStoredAs(join(d, 'enc'), join(d, 'plain'), sha, KEY, null)
    expect(readFileSync(join(d, 'plain')).equals(plain)).toBe(true)
    expect(() => copyStoredAs(join(d, 'enc'), join(d, 'nokey'), sha, null, null)).toThrow(/locked/)
    // Review: the same key (a backup copy) copies the ciphertext as it is — byte-identical, no
    // plaintext scratch beside it — and still refuses a file that does not open.
    copyStoredAs(join(d, 'enc'), join(d, 'same'), sha, KEY, KEY, { fsync: true })
    expect(readFileSync(join(d, 'same')).equals(readFileSync(join(d, 'enc')))).toBe(true)
    expect(readdirSync(d).filter((f) => f.includes('.plain-'))).toEqual([])
    const bad = readFileSync(join(d, 'enc'))
    bad[bad.length - 1] = bad[bad.length - 1]! ^ 1
    writeFileSync(join(d, 'bad'), bad)
    expect(() => copyStoredAs(join(d, 'bad'), join(d, 'same2'), sha, KEY, KEY)).toThrow(FileCryptoError)
    expect(existsSync(join(d, 'same2'))).toBe(false)
  })

  it('convertStore is resumable, reports failures and leaves them as they were', () => {
    const d = scratch()
    const files = [0, 1, 2, 3].map((i) => storeWith(d, Buffer.from(`file number ${i} `.repeat(100 + i))))
    // A half-finished earlier run: file 0 already encrypted, a leftover temp beside file 1.
    writeFileSync(files[0]!.abs, encryptBytes(readFileSync(files[0]!.abs), KEY, files[0]!.sha))
    writeFileSync(`${files[1]!.abs}${CONVERTING_SUFFIX}`, 'half written')
    // File 3 is damaged: it no longer hashes to its name.
    writeFileSync(files[3]!.abs, 'garbage')
    const r = convertStore(d, null, KEY)
    expect(r.converted).toBe(2)
    expect(r.skipped).toBe(1) // file 0; file 3 is "plain" by header but broken → failed
    expect(r.failed).toEqual([`${files[3]!.sha.slice(0, 2)}/${files[3]!.sha}`])
    expect(readFileSync(files[3]!.abs, 'utf8')).toBe('garbage')
    for (const f of files.slice(0, 3)) expect(readStoredBytes(f.abs, f.sha, KEY).length).toBeGreaterThan(0)
    // Run again: everything left is in the target form.
    const again = convertStore(d, null, KEY)
    expect(again.converted).toBe(0)
    expect(again.skipped).toBe(3)
    // And back to plaintext — byte-identical.
    rmSync(files[3]!.abs)
    const back = convertStore(d, KEY, null)
    expect(back).toEqual({ converted: 3, skipped: 0, failed: [] })
    for (const f of files.slice(0, 3)) expect(sha256Hex(readFileSync(f.abs))).toBe(f.sha)
    // Decrypting without the key fails per file and changes nothing.
    convertStore(d, null, KEY)
    const nokey = convertStore(d, null, null)
    expect(nokey.failed).toHaveLength(3)
    expect(storedForm(files[0]!.abs, files[0]!.sha)).toBe('encrypted')
  })

  it('removeConvertingLeftovers sweeps the conversion and scratch files only', () => {
    const d = scratch()
    const { abs } = storeWith(d, plain)
    writeFileSync(`${abs}${CONVERTING_SUFFIX}`, 'x')
    writeFileSync(`${abs}.tmp-123-abcd1234`, 'x')
    writeFileSync(`${abs}${CONVERTING_SUFFIX}.plain-abcd1234`, 'x')
    expect(removeConvertingLeftovers(d)).toBe(3)
    expect(readFileSync(abs).equals(plain)).toBe(true)
  })
})
