// Plain vitest (pure Node crypto/fs — no electron, no better-sqlite3). Matches src/main/**/*.test.ts
// so it runs under `npm test`, not `npm run test:db`.
import { describe, it, expect } from 'vitest'
import { mkdtempSync, readFileSync, writeFileSync, statSync, truncateSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { encryptFile, decryptFile, MAGIC } from './crypt'

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'total-crypt-'))
}

describe('encryptFile / decryptFile', () => {
  it('round-trips arbitrary binary content', async () => {
    const dir = tmpDir()
    const srcPath = join(dir, 'src.bin')
    const encPath = join(dir, 'out.totalbak')
    const outPath = join(dir, 'restored.bin')
    const content = Buffer.from(Array.from({ length: 5000 }, (_, i) => i % 256))
    writeFileSync(srcPath, content)

    await encryptFile(srcPath, encPath, 'correct horse battery staple')

    const encrypted = readFileSync(encPath)
    expect(encrypted.subarray(0, 8).toString('utf8')).toBe(MAGIC.toString('utf8'))
    expect(encrypted.subarray(0, 8)).not.toEqual(content.subarray(0, 8))

    await decryptFile(encPath, outPath, 'correct horse battery staple')
    const restored = readFileSync(outPath)
    expect(restored.equals(content)).toBe(true)
  })

  it('round-trips an empty file', async () => {
    const dir = tmpDir()
    const srcPath = join(dir, 'empty.bin')
    const encPath = join(dir, 'empty.totalbak')
    const outPath = join(dir, 'empty-out.bin')
    writeFileSync(srcPath, Buffer.alloc(0))

    await encryptFile(srcPath, encPath, 'passphrase12')
    await decryptFile(encPath, outPath, 'passphrase12')

    expect(readFileSync(outPath).length).toBe(0)
  })

  it('throws a clear error on the wrong passphrase', async () => {
    const dir = tmpDir()
    const srcPath = join(dir, 'src.bin')
    const encPath = join(dir, 'out.totalbak')
    const outPath = join(dir, 'restored.bin')
    writeFileSync(srcPath, Buffer.from('hello world, this is a company database snapshot'))

    await encryptFile(srcPath, encPath, 'right-passphrase')

    await expect(decryptFile(encPath, outPath, 'wrong-passphrase')).rejects.toThrow(
      'Wrong passphrase or corrupted file'
    )
  })

  it('throws a clear error on a truncated file', async () => {
    const dir = tmpDir()
    const srcPath = join(dir, 'src.bin')
    const encPath = join(dir, 'out.totalbak')
    const outPath = join(dir, 'restored.bin')
    writeFileSync(srcPath, Buffer.from('some company database content, long enough to matter here'))

    await encryptFile(srcPath, encPath, 'a-passphrase')
    const size = statSync(encPath).size
    truncateSync(encPath, size - 4)

    await expect(decryptFile(encPath, outPath, 'a-passphrase')).rejects.toThrow(
      'Wrong passphrase or corrupted file'
    )
  })

  it('throws a clear error when the magic header does not match', async () => {
    const dir = tmpDir()
    const notEncPath = join(dir, 'plain.totalbak')
    const outPath = join(dir, 'restored.bin')
    writeFileSync(notEncPath, Buffer.alloc(64, 1))

    await expect(decryptFile(notEncPath, outPath, 'whatever')).rejects.toThrow(
      'Wrong passphrase or corrupted file'
    )
  })
})
