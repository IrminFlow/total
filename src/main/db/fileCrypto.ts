// WP 7.2 follow-up — the company's FILES under the passphrase lock (docs/security/encryption-at-rest.md):
// attachments (`attachments/`, `backups/attachments/`) and captured bills (`capture/files/`).
//
// Every store is content-addressed by the PLAINTEXT's SHA-256 (`<sha[0:2]>/<sha>`), so dedupe by
// hash works the same whether a file is stored encrypted or not. An encrypted file is
//
//   "TLF1" (4) | nonce (12, random) | GCM tag (16) | AES-256-GCM ciphertext
//
// under a per-file subkey: HKDF-SHA256(company data key, salt = none, info = "total-file-v1" +
// the file's content hash) — so a file's key is bound to the name it is stored under, and one
// file's key opens no other. The additional data is the magic + nonce. Reading always verifies the
// tag AND the plaintext's hash; a file in either form reads (so a store half-converted by a crash
// still works, and the next open finishes the job — services/dbEncryption.ts).
//
// Pure (crypto + fs, no database, no Electron): the key is passed in; it never leaves main.
import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes } from 'crypto'
import { closeSync, existsSync, fsyncSync, lstatSync, openSync, readdirSync, readSync, renameSync, rmSync, writeSync } from 'fs'
import { join } from 'path'

export const FILE_MAGIC = Buffer.from('TLF1', 'latin1')
const NONCE_BYTES = 12
const TAG_BYTES = 16
export const FILE_HEADER_BYTES = FILE_MAGIC.length + NONCE_BYTES + TAG_BYTES
const INFO_PREFIX = 'total-file-v1'
const CHUNK = 1 << 20
const SHA_RE = /^[0-9a-f]{64}$/

/** A stored file that does not open: wrong key, tampered with, truncated, or its content no
 *  longer hashes to its name. */
export class FileCryptoError extends Error {}

function assertKey(key: Buffer): void {
  if (key.length !== 32) throw new FileCryptoError('A file key must be 32 bytes')
}

/** The per-file key: HKDF-SHA256 over the company data key, bound to the content hash. */
export function fileSubkey(dataKey: Buffer, sha: string): Buffer {
  assertKey(dataKey)
  if (!SHA_RE.test(sha)) throw new FileCryptoError('Not a content hash')
  return Buffer.from(hkdfSync('sha256', dataKey, Buffer.alloc(0), Buffer.from(INFO_PREFIX + sha, 'utf8'), 32))
}

/** Whether the first bytes carry the encrypted-file header (magic, and room for nonce + tag). */
export function hasFileHeader(head: Uint8Array): boolean {
  return head.length >= FILE_HEADER_BYTES && Buffer.from(head.subarray(0, FILE_MAGIC.length)).equals(FILE_MAGIC)
}

const aad = (nonce: Buffer): Buffer => Buffer.concat([FILE_MAGIC, nonce])

/** Encrypt bytes whose SHA-256 is `sha` (checked). */
export function encryptBytes(plain: Uint8Array, dataKey: Buffer, sha: string): Buffer {
  if (sha256Hex(plain) !== sha) throw new FileCryptoError('The bytes do not match their hash')
  const nonce = randomBytes(NONCE_BYTES)
  const c = createCipheriv('aes-256-gcm', fileSubkey(dataKey, sha), nonce)
  c.setAAD(aad(nonce))
  const body = Buffer.concat([c.update(plain), c.final()])
  return Buffer.concat([FILE_MAGIC, nonce, c.getAuthTag(), body])
}

/** Decrypt an encrypted file's bytes; refused (FileCryptoError) unless the tag verifies under
 *  this key AND the plaintext hashes to `sha`. */
export function decryptBytes(blob: Uint8Array, dataKey: Buffer, sha: string): Buffer {
  const b = Buffer.from(blob.buffer, blob.byteOffset, blob.byteLength)
  if (!hasFileHeader(b)) throw new FileCryptoError('Not an encrypted file')
  const nonce = b.subarray(4, 4 + NONCE_BYTES)
  const tag = b.subarray(4 + NONCE_BYTES, FILE_HEADER_BYTES)
  let plain: Buffer
  try {
    const d = createDecipheriv('aes-256-gcm', fileSubkey(dataKey, sha), nonce)
    d.setAAD(aad(Buffer.from(nonce)))
    d.setAuthTag(tag)
    plain = Buffer.concat([d.update(b.subarray(FILE_HEADER_BYTES)), d.final()])
  } catch (err) {
    if (err instanceof FileCryptoError) throw err
    throw new FileCryptoError('The file does not open with this key, or it was changed')
  }
  if (sha256Hex(plain) !== sha) throw new FileCryptoError('The file does not match its hash')
  return plain
}

export const sha256Hex = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex')

function readHeadOf(path: string): Buffer {
  const fd = openSync(path, 'r')
  try {
    const buf = Buffer.alloc(FILE_HEADER_BYTES)
    const n = readSync(fd, buf, 0, buf.length, 0)
    return buf.subarray(0, n)
  } finally {
    closeSync(fd)
  }
}

function hashFile(path: string): string {
  const h = createHash('sha256')
  const fd = openSync(path, 'r')
  try {
    const buf = Buffer.allocUnsafe(CHUNK)
    let n: number
    while ((n = readSync(fd, buf, 0, buf.length, null)) > 0) h.update(buf.subarray(0, n))
  } finally {
    closeSync(fd)
  }
  return h.digest('hex')
}

export type StoredForm = 'plain' | 'encrypted'

/** How the file named for `sha` is stored. A plaintext file that happens to begin with "TLF1"
 *  is told apart by its own hash (it hashes to its name; an encrypted one cannot). */
export function storedForm(path: string, sha: string): StoredForm {
  if (!hasFileHeader(readHeadOf(path))) return 'plain'
  return hashFile(path) === sha ? 'plain' : 'encrypted'
}

/** Stream-decrypt the encrypted file `src`, handing each plaintext chunk to `sink`; throws
 *  FileCryptoError unless the tag verifies AND the plaintext hashes to `sha`. The chunks are only
 *  trustworthy once this returns. */
function decryptStream(src: string, dataKey: Buffer, sha: string, sink: (b: Buffer) => void): void {
  const inFd = openSync(src, 'r')
  try {
    const head = Buffer.alloc(FILE_HEADER_BYTES)
    if (readSync(inFd, head, 0, head.length, 0) !== head.length || !hasFileHeader(head)) throw new FileCryptoError('Not an encrypted file')
    const nonce = Buffer.from(head.subarray(4, 4 + NONCE_BYTES))
    const d = createDecipheriv('aes-256-gcm', fileSubkey(dataKey, sha), nonce)
    d.setAAD(aad(nonce))
    d.setAuthTag(head.subarray(4 + NONCE_BYTES))
    const h = createHash('sha256')
    const out = (b: Buffer): void => {
      if (b.length === 0) return
      h.update(b)
      sink(b)
    }
    const buf = Buffer.allocUnsafe(CHUNK)
    let pos = FILE_HEADER_BYTES
    let n: number
    while ((n = readSync(inFd, buf, 0, buf.length, pos)) > 0) {
      pos += n
      out(d.update(buf.subarray(0, n)))
    }
    let last: Buffer
    try {
      last = d.final()
    } catch {
      throw new FileCryptoError('The file does not open with this key, or it was changed')
    }
    out(last)
    if (h.digest('hex') !== sha) throw new FileCryptoError('The file does not match its hash')
  } finally {
    closeSync(inFd)
  }
}

/** Stream-decrypt `src` (encrypted) into `dest` (created, mode 0600), verifying the tag and the
 *  plaintext hash; on any failure `dest` is removed and the error thrown. */
export function decryptFileTo(src: string, dest: string, dataKey: Buffer, sha: string, opts: { fsync?: boolean } = {}): void {
  const outFd = openSync(dest, 'wx', 0o600)
  let ok = false
  try {
    decryptStream(src, dataKey, sha, (b) => writeAll(outFd, b))
    if (opts.fsync) fsyncSync(outFd)
    ok = true
  } finally {
    closeSync(outFd)
    if (!ok) rmSync(dest, { force: true })
  }
}

/** Stream-encrypt the plaintext file `src` (which must hash to `sha`) into `dest`. The tag is
 *  written into the header once the body is done. On failure `dest` is removed. */
export function encryptFileTo(src: string, dest: string, dataKey: Buffer, sha: string, opts: { fsync?: boolean } = {}): void {
  const inFd = openSync(src, 'r')
  let outFd: number | null = null
  try {
    const nonce = randomBytes(NONCE_BYTES)
    const c = createCipheriv('aes-256-gcm', fileSubkey(dataKey, sha), nonce)
    c.setAAD(aad(nonce))
    const h = createHash('sha256')
    outFd = openSync(dest, 'wx', 0o600)
    writeAll(outFd, Buffer.concat([FILE_MAGIC, nonce, Buffer.alloc(TAG_BYTES)]))
    const buf = Buffer.allocUnsafe(CHUNK)
    let n: number
    while ((n = readSync(inFd, buf, 0, buf.length, null)) > 0) {
      const chunk = buf.subarray(0, n)
      h.update(chunk)
      writeAll(outFd, c.update(chunk))
    }
    writeAll(outFd, c.final())
    if (h.digest('hex') !== sha) throw new FileCryptoError('The file does not match its hash')
    writeSync(outFd, c.getAuthTag(), 0, TAG_BYTES, FILE_MAGIC.length + NONCE_BYTES)
    if (opts.fsync) fsyncSync(outFd)
    closeSync(outFd)
    outFd = null
  } catch (err) {
    if (outFd !== null) closeSync(outFd)
    rmSync(dest, { force: true })
    throw err
  } finally {
    closeSync(inFd)
  }
}

function writeAll(fd: number, b: Buffer): void {
  let off = 0
  while (off < b.length) off += writeSync(fd, b, off, b.length - off)
}

/** The plaintext of a stored file in either form, hash-checked. An encrypted file without a key
 *  is refused with a plain sentence (the business is locked). */
export function readStoredBytes(path: string, sha: string, key: Buffer | null): Buffer {
  const fd = openSync(path, 'r')
  let data: Buffer
  try {
    const parts: Buffer[] = []
    const buf = Buffer.allocUnsafe(CHUNK)
    let n: number
    while ((n = readSync(fd, buf, 0, buf.length, null)) > 0) parts.push(Buffer.from(buf.subarray(0, n)))
    data = Buffer.concat(parts)
  } finally {
    closeSync(fd)
  }
  if (sha256Hex(data) === sha) return data // plaintext (even one that begins with "TLF1")
  if (!hasFileHeader(data)) throw new FileCryptoError('The file does not match its hash')
  if (!key) throw new FileCryptoError('This file is locked with the business’s passphrase — unlock the business first')
  return decryptBytes(data, key, sha)
}

/** Whether the stored file opens (with `key` when encrypted) and its plaintext hashes to `sha`. */
export function storedFileMatches(path: string, sha: string, key: Buffer | null): boolean {
  try {
    if (!hasFileHeader(readHeadOf(path))) return hashFile(path) === sha
    if (hashFile(path) === sha) return true
    if (!key) return false
    decryptStream(path, key, sha, () => {})
    return true
  } catch {
    return false
  }
}

/** A plaintext copy of the stored file at `dest` (for opening it), hash-checked. */
export function copyStoredPlain(src: string, dest: string, sha: string, key: Buffer | null): void {
  if (storedForm(src, sha) === 'plain') {
    const data = readStoredBytes(src, sha, null)
    const fd = openSync(dest, 'wx', 0o600)
    try {
      writeAll(fd, data)
    } finally {
      closeSync(fd)
    }
    return
  }
  if (!key) throw new FileCryptoError('This file is locked with the business’s passphrase — unlock the business first')
  decryptFileTo(src, dest, key, sha)
}

/** Copy a stored file into `dest` in the form `destKey` asks for (null = plaintext), reading it
 *  with `srcKey` when it is encrypted. Hash-checked either way. */
export function copyStoredAs(src: string, dest: string, sha: string, srcKey: Buffer | null, destKey: Buffer | null, opts: { fsync?: boolean } = {}): void {
  const form = storedForm(src, sha)
  if (form === 'plain' && !destKey) {
    copyStoredPlain(src, dest, sha, null)
  } else if (form === 'plain' && destKey) {
    encryptFileTo(src, dest, destKey, sha, opts)
    return
  } else if (!destKey) {
    if (!srcKey) throw new FileCryptoError('This file is locked with the business’s passphrase — unlock the business first')
    decryptFileTo(src, dest, srcKey, sha, opts)
    return
  } else {
    // Encrypted → encrypted: re-encrypted under the target key (a fresh nonce), via a scratch plaintext.
    if (!srcKey) throw new FileCryptoError('This file is locked with the business’s passphrase — unlock the business first')
    const mid = `${dest}.plain-${randomBytes(4).toString('hex')}`
    try {
      decryptFileTo(src, mid, srcKey, sha)
      encryptFileTo(mid, dest, destKey, sha, opts)
    } finally {
      rmSync(mid, { force: true })
    }
    return
  }
  if (opts.fsync) {
    const fd = openSync(dest, 'r+')
    try {
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
  }
}

// ---------- converting a whole store (lock on / off) ----------

/** Suffix of a file being converted in place; swept by dbEncryption.removeLeftoverCopies (it may
 *  be PLAINTEXT when the lock was being taken off). */
export const CONVERTING_SUFFIX = '.tlf-converting'

export interface StoreConversion {
  converted: number
  /** Already in the target form (a resumed run skips what an interrupted one finished). */
  skipped: number
  /** `<sha[0:2]>/<sha>` of each file that could not be converted (left as it was). */
  failed: string[]
}

/** Every content-addressed file in a store: `[rel, sha, abs]`. Links and odd names are left alone. */
export function storeFiles(dir: string): { rel: string; sha: string; abs: string }[] {
  const out: { rel: string; sha: string; abs: string }[] = []
  if (!existsSync(dir)) return out
  for (const prefix of readdirSync(dir).sort()) {
    if (!/^[0-9a-f]{2}$/.test(prefix)) continue
    const sub = join(dir, prefix)
    const st = lstatSync(sub)
    if (st.isSymbolicLink() || !st.isDirectory()) continue
    for (const name of readdirSync(sub).sort()) {
      if (!SHA_RE.test(name) || name.slice(0, 2) !== prefix) continue
      const abs = join(sub, name)
      const fst = lstatSync(abs)
      if (fst.isSymbolicLink() || !fst.isFile()) continue
      out.push({ rel: `${prefix}/${name}`, sha: name, abs })
    }
  }
  return out
}

/**
 * Bring every file of a store into the target form: `to` = encrypt under that key, null =
 * plaintext (`from` decrypts the encrypted ones). Each file: a converted copy beside it
 * (`<sha>.tlf-converting`, hash-checked on the way), fsynced, renamed over it; then the folder
 * is fsynced. A file already in the target form is skipped (resumable); one that fails is left
 * exactly as it was and reported.
 */
export function convertStore(dir: string, from: Buffer | null, to: Buffer | null): StoreConversion {
  const out: StoreConversion = { converted: 0, skipped: 0, failed: [] }
  const touched = new Set<string>()
  for (const f of storeFiles(dir)) {
    const tmp = `${f.abs}${CONVERTING_SUFFIX}`
    try {
      const form = storedForm(f.abs, f.sha)
      if ((form === 'encrypted') === !!to) {
        out.skipped++
        continue
      }
      rmSync(tmp, { force: true })
      copyStoredAs(f.abs, tmp, f.sha, from, to, { fsync: true })
      renameSync(tmp, f.abs)
      touched.add(join(dir, f.rel.slice(0, 2)))
      out.converted++
    } catch {
      rmSync(tmp, { force: true })
      out.failed.push(f.rel)
    }
  }
  for (const d of touched) fsyncDirectory(d)
  return out
}

/** Remove what an interrupted write / conversion left in a store: `*.tlf-converting`, the
 *  scratch `.plain-*` copies (plaintext) and the stores' own `.tmp-*` files. */
export function removeConvertingLeftovers(dir: string): number {
  let removed = 0
  if (!existsSync(dir)) return 0
  for (const prefix of readdirSync(dir)) {
    if (!/^[0-9a-f]{2}$/.test(prefix)) continue
    const sub = join(dir, prefix)
    try {
      if (!lstatSync(sub).isDirectory()) continue
      for (const name of readdirSync(sub)) {
        if (!name.endsWith(CONVERTING_SUFFIX) && !/\.(plain|tmp)-[0-9a-f]+(-[0-9a-f]+)?$/.test(name)) continue
        rmSync(join(sub, name), { force: true })
        removed++
      }
    } catch {
      // not ours
    }
  }
  return removed
}

function fsyncDirectory(dir: string): void {
  if (process.platform === 'win32') return
  try {
    const fd = openSync(dir, 'r')
    try {
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
  } catch {
    // best effort
  }
}
