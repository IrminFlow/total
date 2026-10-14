// WP 7.3 — names that are valid on Windows (reserved device names, invalid characters, MAX_PATH).
import { describe, expect, it } from 'vitest'
import { fitFileName, isWindowsReservedName, portableFileName, portableSlug } from './fileNames'
import { exportCsvSchema } from './schemas'
import { exportXlsxSchema } from './xlsx/schema'

describe('isWindowsReservedName', () => {
  it('knows the device names in any case, with any extension, trailing dots / spaces ignored', () => {
    for (const n of ['CON', 'con', 'Prn', 'aux', 'NUL', 'com1', 'COM9', 'lpt1', 'LPT9', 'com0', 'con.csv', 'NUL.tar.gz', 'aux.', 'con ', 'com¹', 'C:\\x\\con.txt', '/tmp/aux.pdf']) {
      expect(isWindowsReservedName(n), n).toBe(true)
    }
  })
  it('leaves ordinary names alone', () => {
    for (const n of ['console', 'icon.png', 'con-company', 'com10', 'lpt', 'nul1x', 'auxiliary.csv', 'bill.pdf', '']) {
      expect(isWindowsReservedName(n), n).toBe(false)
    }
  })
})

describe('portableFileName', () => {
  it('replaces the characters Windows refuses and drops trailing dots and spaces', () => {
    expect(portableFileName('bill: 7/8?.pdf')).toBe('8-.pdf') // the part after the last separator
    expect(portableFileName('bill: 7 <copy> "a"|b*.pdf')).toBe('bill- 7 -copy- -a--b-.pdf')
    expect(portableFileName('notes.txt. . ')).toBe('notes.txt')
    expect(portableFileName('tab\there.pdf')).toBe('tab-here.pdf')
  })
  it('prefixes a reserved stem and falls back when nothing is left', () => {
    expect(portableFileName('CON.pdf')).toBe('_CON.pdf')
    expect(portableFileName('aux')).toBe('_aux')
    expect(portableFileName('...', { fallback: 'attachment.bin' })).toBe('attachment.bin')
    expect(portableFileName('')).toBe('file')
  })
  it('cuts long names keeping the extension; Devanagari names survive', () => {
    const long = `${'a'.repeat(300)}.pdf`
    const cut = portableFileName(long, { maxLength: 100 })
    expect(cut).toHaveLength(100)
    expect(cut.endsWith('.pdf')).toBe(true)
    expect(portableFileName('शर्मा ट्रेडर्स बिल.pdf')).toBe('शर्मा ट्रेडर्स बिल.pdf')
  })
})

describe('fitFileName (MAX_PATH)', () => {
  it('keeps short paths and shortens names that would pass 250 characters', () => {
    const dir = `C:\\Users\\someone\\AppData\\Local\\Temp\\total-attachment-abc123\\f-xyz789`
    expect(fitFileName(dir, 'bill.pdf')).toBe('bill.pdf')
    const name = fitFileName(dir, `${'b'.repeat(240)}.jpeg`)
    expect(dir.length + 1 + name.length).toBeLessThanOrEqual(250)
    expect(name.endsWith('.jpeg')).toBe(true)
    // A folder that is already too deep never yields an empty name.
    expect(fitFileName('C:\\'.padEnd(300, 'x'), 'statement-2026.pdf').length).toBeGreaterThanOrEqual(16)
  })
})

describe('slugs and export names', () => {
  it('a company called "Con" or "Aux" gets a folder Windows can create', () => {
    expect(portableSlug('con')).toBe('con-company')
    expect(portableSlug('com1')).toBe('com1-company')
    expect(portableSlug('con-traders')).toBe('con-traders')
  })
  it('export file names that are device names are suffixed (CSV / PDF / XLSX)', () => {
    expect(exportCsvSchema.parse({ filename: 'nul', csv: '' }).filename).toBe('nul-export')
    expect(exportCsvSchema.parse({ filename: 'trial-balance', csv: '' }).filename).toBe('trial-balance')
    const sheet = { name: 'S', columns: [{ header: 'A', kind: 'text' }], rows: [] }
    expect(exportXlsxSchema.parse({ filename: 'con', sheets: [sheet] }).filename).toBe('con-export')
  })
})
