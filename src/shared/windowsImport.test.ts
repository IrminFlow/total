// WP 7.3 — importers read files written on Windows (UTF-8 BOM, UTF-16LE, CRLF) exactly as the
// LF / UTF-8 originals. Fixtures: src/shared/fixtures/windows/ (make-fixtures.mjs regenerates them).
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import { TextEncodingError, decodeTextFile, normaliseNewlines } from './textFiles'
import { decodeBytes } from './bankFormats/quirks'
import { parseTallyExport, parseXml, childText, collect } from './tally'
import { parseStatementFile } from './bankFormats'
import { parseCsv } from './csv'

const win = (name: string): Uint8Array => new Uint8Array(readFileSync(join(__dirname, 'fixtures', 'windows', name)))
const bank = (name: string): Uint8Array => new Uint8Array(readFileSync(join(__dirname, 'bankFormats', 'fixtures', name)))

describe('decodeTextFile', () => {
  it('drops a UTF-8 BOM and decodes UTF-16LE / UTF-16BE with or without one', () => {
    const s = 'Date,₹ Amount\r\nशर्मा,1\r\n'
    const le = new Uint8Array(Buffer.from(s, 'utf16le'))
    const be = new Uint8Array(le.length)
    for (let i = 0; i < le.length; i += 2) [be[i], be[i + 1]] = [le[i + 1]!, le[i]!]
    expect(decodeTextFile(new Uint8Array([0xef, 0xbb, 0xbf, ...Buffer.from(s, 'utf8')]))).toBe(s)
    expect(decodeTextFile(new Uint8Array([0xff, 0xfe, ...le]))).toBe(s)
    expect(decodeTextFile(new Uint8Array([0xfe, 0xff, ...be]))).toBe(s)
    expect(decodeTextFile(le)).toBe(s)
    expect(decodeTextFile(be)).toBe(s)
    expect(decodeTextFile(new Uint8Array(Buffer.from(s, 'utf8')))).toBe(s)
  })
  it('leaves plain UTF-8 (and short files) alone', () => {
    expect(decodeTextFile(new Uint8Array(Buffer.from('a', 'utf8')))).toBe('a')
    expect(decodeTextFile(new Uint8Array())).toBe('')
    expect(normaliseNewlines('a\r\nb\rc\n')).toBe('a\nb\nc\n')
  })
})

describe('Tally XML written on Windows', () => {
  const original = parseTallyExport(new TextDecoder().decode(win('tally-export.lf.xml')))

  it('the LF fixture parses (sanity): masters, a Devanagari ledger, a two-line narration', () => {
    expect(original.groups.map((g) => g.name)).toEqual(['Overseas Debtors'])
    expect(original.ledgers.map((l) => l.name)).toEqual(['शर्मा ट्रेडर्स', 'Imported Capital'])
    expect(original.vouchers).toHaveLength(1)
    expect(original.vouchers[0]!.narration).toBe('Part payment & advance\nagainst bill 7')
  })

  for (const file of ['tally-export.utf16le-bom-crlf.xml', 'tally-export.utf16le-nobom-crlf.xml', 'tally-export.utf8-bom-crlf.xml']) {
    it(`${file}: same groups, ledgers, vouchers and warnings as the LF original`, () => {
      const bytes = win(file)
      expect(bytes.includes(0x0d)).toBe(true) // really CRLF on disk
      const text = decodeTextFile(bytes)
      expect(text.charCodeAt(0)).not.toBe(0xfeff)
      expect(parseTallyExport(text)).toEqual(original)
    })
  }

  it('parseXml itself drops a BOM and normalises CRLF inside text (XML 1.0 §2.11)', () => {
    const root = parseXml('﻿<A>\r\n<B>one\r\ntwo\rthree</B></A>')
    expect(childText(collect(root, 'A')[0]!, 'B')).toBe('one\ntwo\nthree')
  })
})

describe('Tally XML in the Windows "ANSI" code page (WP 7.3 review)', () => {
  const original = parseTallyExport(new TextDecoder().decode(win('tally-export.latin.lf.xml')))

  it('the Latin original holds the accented name (sanity)', () => {
    expect(original.ledgers.map((l) => l.name)).toContain('Café Müller — Señor’s')
  })

  for (const file of ['tally-export.cp1252-decl-crlf.xml', 'tally-export.cp1252-nodecl-crlf.xml']) {
    it(`${file}: read as Windows-1252, never U+FFFD in a ledger name`, () => {
      const bytes = win(file)
      expect(bytes.includes(0x97)).toBe(true) // the em dash really is a 1252 byte
      const text = decodeTextFile(bytes)
      expect(text).not.toContain('\uFFFD')
      expect(parseTallyExport(text)).toEqual(original)
    })
  }

  it('well-formed UTF-8 next to invalid bytes is refused, not guessed', () => {
    const bytes = new Uint8Array([...Buffer.from('<A>शर्मा', 'utf8'), 0xe9, ...Buffer.from('</A>', 'utf8')])
    expect(() => decodeTextFile(bytes)).toThrow(TextEncodingError)
    expect(() => decodeTextFile(bytes)).toThrow(/export it again as UTF-8/)
  })

  it('an encoding Total cannot read is refused by name', () => {
    const bytes = new Uint8Array([...Buffer.from('<?xml version="1.0" encoding="Shift_JIS"?><A>', 'latin1'), 0x82, 0xa0, ...Buffer.from('</A>', 'latin1')])
    expect(() => decodeTextFile(bytes)).toThrow(/shift_jis/)
  })

  it('valid UTF-8 always reads as UTF-8 (a stray 1252 declaration on UTF-8 bytes does not garble it)', () => {
    const s = '<?xml version="1.0" encoding="windows-1252"?><A>शर्मा</A>'
    expect(decodeTextFile(new Uint8Array(Buffer.from(s, 'utf8')))).toBe(s)
  })

  it('bank statements: a 1252 file and a BOM-less UTF-16LE file decode too (decodeBytes default)', () => {
    expect(decodeBytes(new Uint8Array([0x43, 0x61, 0x66, 0xe9, 0x20, 0x80]))).toBe('Café €')
    expect(decodeBytes(new Uint8Array(Buffer.from('Date,Amount\r\n', 'utf16le')))).toBe('Date,Amount\r\n')
    expect(decodeBytes(new Uint8Array(Buffer.from('Café ₹', 'utf8')))).toBe('Café ₹')
  })
})

describe('bank statements written on Windows', () => {
  const cases: [string, string, string][] = [
    ['bank-hdfc-style.bom-crlf.csv', 'hdfc-style.csv', 'hdfc.csv'],
    ['bank-hdfc-style.utf16le-bom-crlf.csv', 'hdfc-style.csv', 'hdfc.csv'],
    ['bank-flag-style.bom-crlf.csv', 'flag-style.csv', 'flag.csv'],
    ['bank-sbi-style.bom-crlf.txt', 'sbi-style.txt', 'sbi.txt'],
    ['bank-statement.crlf.sta', 'statement.sta', 'statement.sta'],
    ['bank-camt053.bom-crlf.xml', 'camt053.xml', 'camt053.xml']
  ]
  for (const [file, source, name] of cases) {
    it(`${file} = ${source}: same lines, balances, account and warnings`, () => {
      const want = parseStatementFile({ fileName: name, bytes: bank(source) })
      expect(want.lines.length).toBeGreaterThan(0)
      const got = parseStatementFile({ fileName: name, bytes: win(file) })
      const strip = (r: typeof want) => ({ ...r, grid: null })
      expect(strip(got)).toEqual(strip(want))
    })
  }

  it('the legacy CSV path (parseCsv) reads a BOM + CRLF file record for record', () => {
    const lf = parseCsv(new TextDecoder().decode(bank('hdfc-style.csv')))
    const crlf = parseCsv(decodeTextFile(win('bank-hdfc-style.bom-crlf.csv')))
    expect(crlf).toEqual(lf)
  })
})
