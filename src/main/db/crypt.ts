// Pure Node crypto/fs — no Electron, no better-sqlite3 — so this is plain-vitest testable.
//
// File format ("TOTALBK1"): magic(8) | salt(16) | iv(12) | ciphertext(N) | gcmTag(16)
// AES-256-GCM with a scrypt-derived key. Streaming so multi-GB company databases don't need
// to fit in memory twice.
import { randomBytes, scryptSync, createCipheriv, createDecipheriv, type DecipherGCM } from 'crypto'
import { createReadStream, createWriteStream, openSync, readSync, closeSync, statSync, unlink } from 'fs'

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

/** Encrypt `srcPath` into `destPath` in the TOTALBK1 format, streaming throughout. */
export async function encryptFile(srcPath: string, destPath: string, passphrase: string): Promise<void> {
  const salt = randomBytes(SALT_LEN)
  const iv = randomBytes(IV_LEN)
  const key = deriveKey(passphrase, salt)
  const cipher = createCipheriv('aes-256-gcm', key, iv)

  const src = createReadStream(srcPath)
  const dest = createWriteStream(destPath)

  await new Promise<void>((resolve, reject) => {
    let settled = false
    const fail = (err: Error): void => {
      if (settled) return
      settled = true
      reject(err)
    }
    src.on('error', fail)
    cipher.on('error', fail)
    dest.on('error', fail)
    dest.on('finish', () => {
      if (settled) return
      settled = true
      resolve()
    })

    dest.write(Buffer.concat([MAGIC, salt, iv]))
    src.pipe(cipher).pipe(dest, { end: false })
    cipher.on('end', () => {
      dest.end(cipher.getAuthTag())
    })
  }).catch((err) => {
    unlink(destPath, () => {})
    throw err
  })
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

  let decipher: DecipherGCM
  try {
    decipher = createDecipheriv('aes-256-gcm', key, iv)
    decipher.setAuthTag(tag)
  } catch {
    throw new Error(WRONG_PASSPHRASE)
  }

  const ciphertextLen = size - HEADER_LEN - TAG_LEN
  const dest = createWriteStream(destPath)

  try {
    await new Promise<void>((resolve, reject) => {
      let settled = false
      const fail = (err: Error): void => {
        if (settled) return
        settled = true
        reject(err)
      }
      dest.on('error', fail)
      dest.on('finish', () => {
        if (settled) return
        settled = true
        resolve()
      })
      if (ciphertextLen === 0) {
        // No body — GCM still needs final() run to validate the tag against empty ciphertext.
        dest.end(decipher.final())
        return
      }
      const src = createReadStream(srcPath, { start: HEADER_LEN, end: HEADER_LEN + ciphertextLen - 1 })
      decipher.on('error', fail)
      src.on('error', fail)
      src.pipe(decipher).pipe(dest)
    })
  } catch {
    unlink(destPath, () => {})
    throw new Error(WRONG_PASSPHRASE)
  }
}
