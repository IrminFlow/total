import { describe, it, expect } from 'vitest'
import {
  ATTACHMENT_MAX_BYTES, ATTACHMENT_MAX_PER_VOUCHER, checkAttachment, extensionOf, formatBytes,
  isAllowedAttachment, safeFileName, storedNameFor
} from './attachments'

describe('extensionOf', () => {
  it('reads the last extension, lowercased', () => {
    expect(extensionOf('Bill Jan.2026.PDF')).toBe('pdf')
    expect(extensionOf('/tmp/scan.jpeg')).toBe('jpeg')
  })

  it('has no extension for a dotfile or a bare name', () => {
    expect(extensionOf('.bashrc')).toBe('')
    expect(extensionOf('invoice')).toBe('')
    expect(extensionOf('invoice.')).toBe('')
  })
})

describe('safeFileName', () => {
  it('cannot escape the attachments folder', () => {
    expect(safeFileName('../../../etc/passwd')).toBe('passwd')
    expect(safeFileName('..\\..\\windows\\system32\\cmd.exe')).toBe('cmd.exe')
    expect(safeFileName('/absolute/path/bill.pdf')).toBe('bill.pdf')
  })

  it('never produces an empty or hidden name', () => {
    expect(safeFileName('...')).toBe('attachment')
    expect(safeFileName('')).toBe('attachment')
    expect(safeFileName('.hidden.pdf')).toBe('hidden.pdf')
  })

  it('replaces anything that is not a plain filename character', () => {
    expect(safeFileName('बिल #12/26.pdf')).toBe('26.pdf')
    expect(safeFileName('bill;rm -rf.pdf')).toBe('bill_rm -rf.pdf')
  })
})

describe('storedNameFor', () => {
  it('leads with the voucher id so the folder reads on its own', () => {
    expect(storedNameFor(41, 'a1b2c3', 'bill.pdf')).toBe('41-a1b2c3-bill.pdf')
  })

  it('keeps two files of the same name apart', () => {
    expect(storedNameFor(41, 'aaa', 'bill.pdf')).not.toBe(storedNameFor(41, 'bbb', 'bill.pdf'))
  })

  it('survives a token that is not alphanumeric', () => {
    expect(storedNameFor(1, '../..', 'b.pdf')).toBe('1-0-b.pdf')
  })
})

describe('isAllowedAttachment', () => {
  it('takes what a bill is scanned or photographed into', () => {
    for (const name of ['bill.pdf', 'scan.JPG', 'photo.heic', 'sheet.csv']) {
      expect(isAllowedAttachment(name)).toBe(true)
    }
  })

  it('refuses anything the OS would run', () => {
    // The app opens these with shell.openPath — an allowlist is the only thing standing between
    // "open the bill" and "run whatever was in the folder".
    for (const name of ['payload.command', 'setup.exe', 'thing.app', 'script.sh', 'noext']) {
      expect(isAllowedAttachment(name)).toBe(false)
    }
  })
})

describe('checkAttachment', () => {
  const ok = { fileName: 'bill.pdf', byteSize: 200_000, existingCount: 0 }

  it('accepts an ordinary scan', () => {
    expect(checkAttachment(ok)).toEqual({ ok: true })
  })

  it('states the size and the limit rather than just failing', () => {
    const result = checkAttachment({ ...ok, byteSize: ATTACHMENT_MAX_BYTES + 1 })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toBe('size')
      expect(result.message).toContain('10 MB')
    }
  })

  it('accepts a file exactly at the limit', () => {
    expect(checkAttachment({ ...ok, byteSize: ATTACHMENT_MAX_BYTES }).ok).toBe(true)
  })

  it('refuses an empty file', () => {
    expect(checkAttachment({ ...ok, byteSize: 0 }).ok).toBe(false)
  })

  it('stops at the per-voucher cap', () => {
    const result = checkAttachment({ ...ok, existingCount: ATTACHMENT_MAX_PER_VOUCHER })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('count')
  })
})

describe('formatBytes', () => {
  it('reads like a person wrote it', () => {
    expect(formatBytes(900)).toBe('900 B')
    expect(formatBytes(2048)).toBe('2.0 KB')
    expect(formatBytes(1024 * 1024 * 3.5)).toBe('3.5 MB')
    expect(formatBytes(1024 * 1024 * 12)).toBe('12 MB')
  })
})
