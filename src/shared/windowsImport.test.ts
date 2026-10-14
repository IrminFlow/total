// WP 7.3 — importers read files written on Windows (UTF-8 BOM, UTF-16LE, CRLF) exactly as the
// LF / UTF-8 originals. Fixtures: src/shared/fixtures/windows/ (make-fixtures.mjs regenerates them).
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import { decodeTextFile, normaliseNewlines } from './textFiles'
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
