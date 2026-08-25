// Pure Node crypto/fs — no Electron, no better-sqlite3 — so this is plain-vitest testable.
//
// File format ("TOTALBK1"): magic(8) | salt(16) | iv(12) | ciphertext(N) | gcmTag(16)
// AES-256-GCM with a scrypt-derived key. Streaming so multi-GB company databases don't need
// to fit in memory twice.
import { randomBytes, scryptSync, createCipheriv, createDecipheriv } from 'crypto'
import {
  closeSync,
  createReadStream,
  createWriteStream,
  existsSync,
  fsyncSync,
  openSync,
  readSync,
  rmSync,
  statSync,
  writeFileSync
} from 'fs'
import { finished, pipeline } from 'stream/promises'

export const MAGIC = Buffer.from('TOTALBK1', 'utf8')
const SALT_LEN = 16
const IV_LEN = 12
const TAG_LEN = 16
const HEADER_LEN = MAGIC.length + SALT_LEN + IV_LEN
const SCRYPT_OPTS = { N: 16384, r: 8, p: 1 } as const

const WRONG_PASSPHRASE = 'Wrong passphrase or corrupted file'

function deriveKey(passphrase: string, salt: Buffer): Buffer {
  return scryptSync(passphrase, salt, 32, SCRYPT_OPTS)
}

function fsyncFile(path: string): void {
  const fd = openSync(path, 'r')
  try {
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
}

function removePartial(path: string): void {
  try {
    rmSync(path, { force: true })
  } catch {
    // The caller also owns the containing private workspace and will retry its cleanup. Never
    // replace the useful authentication/I/O error with a secondary removal failure.
  }
}

/** Encrypt `srcPath` into `destPath` in the TOTALBK1 format, streaming throughout. */
export async function encryptFile(srcPath: string, destPath: string, passphrase: string): Promise<void> {
  const salt = randomBytes(SALT_LEN)
  const iv = randomBytes(IV_LEN)
  const key = deriveKey(passphrase, salt)
  const cipher = createCipheriv('aes-256-gcm', key, iv)

  const src = createReadStream(srcPath)
  const dest = createWriteStream(destPath, { flags: 'wx', mode: 0o600 })
  try {
    dest.write(Buffer.concat([MAGIC, salt, iv]))
    await pipeline(src, cipher, dest, { end: false })
    dest.end(cipher.getAuthTag())
    await finished(dest)
    fsyncFile(destPath)
  } catch (error) {
    src.destroy()
    cipher.destroy()
    dest.destroy()
    try {
      await finished(dest)
    } catch {
      // Expected when the pipeline or destination failed.
    }
    removePartial(destPath)
    throw error
  }
}

/** Decrypt a TOTALBK1 file produced by `encryptFile`. Throws on wrong passphrase / corruption. */
export async function decryptFile(srcPath: string, destPath: string, passphrase: string): Promise<void> {
  const size = statSync(srcPath).size
  if (size < HEADER_LEN + TAG_LEN) throw new Error(WRONG_PASSPHRASE)

  const fd = openSync(srcPath, 'r')
  let header: Buffer
  let tag: Buffer
  try {
    header = Buffer.alloc(HEADER_LEN)
    readSync(fd, header, 0, HEADER_LEN, 0)
    tag = Buffer.alloc(TAG_LEN)
    readSync(fd, tag, 0, TAG_LEN, size - TAG_LEN)
  } finally {
    closeSync(fd)
  }

  const magic = header.subarray(0, MAGIC.length)
  if (!magic.equals(MAGIC)) throw new Error(WRONG_PASSPHRASE)
  const salt = header.subarray(MAGIC.length, MAGIC.length + SALT_LEN)
  const iv = header.subarray(MAGIC.length + SALT_LEN, HEADER_LEN)
  const key = deriveKey(passphrase, salt)

  let decipher
  try {
    decipher = createDecipheriv('aes-256-gcm', key, iv)
    decipher.setAuthTag(tag)
  } catch {
    throw new Error(WRONG_PASSPHRASE)
  }

  const ciphertextLen = size - HEADER_LEN - TAG_LEN
  try {
    if (ciphertextLen === 0) {
      // Authenticate before creating the destination when there is no ciphertext body.
      writeFileSync(destPath, decipher.final(), { flag: 'wx', mode: 0o600 })
    } else {
      const src = createReadStream(srcPath, {
        start: HEADER_LEN,
        end: HEADER_LEN + ciphertextLen - 1
      })
      const dest = createWriteStream(destPath, { flags: 'wx', mode: 0o600 })
      await pipeline(src, decipher, dest)
    }
    fsyncFile(destPath)
  } catch {
    // pipeline() closes all streams before rejecting, so this synchronous removal cannot race an
    // open writer. This matters on Windows and prevents authenticated plaintext from lingering.
    if (existsSync(destPath)) removePartial(destPath)
    throw new Error(WRONG_PASSPHRASE)
  }
}
