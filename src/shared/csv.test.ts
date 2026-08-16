import { describe, it, expect } from 'vitest'
import { parseCsv, parseCsvLine, rowsToCsv } from './csv'

describe('parseCsvLine', () => {
  it('splits plain comma-separated cells', () => {
    expect(parseCsvLine('a,b,c')).toEqual(['a', 'b', 'c'])
  })

  it('keeps commas inside quoted cells intact', () => {
    expect(parseCsvLine('a,"b, with comma",c')).toEqual(['a', 'b, with comma', 'c'])
  })

  it('unescapes doubled quotes inside a quoted cell to a literal quote (v0.3 #67)', () => {
    // RFC 4180: "" inside a quoted field is one literal ". The historical parser dropped the
    // quotes entirely ('say hi') — that was the bug.
    expect(parseCsvLine('a,"say ""hi""",c')).toEqual(['a', 'say "hi"', 'c'])
  })

  it('handles an empty line as a single empty cell', () => {
    expect(parseCsvLine('')).toEqual([''])
  })
})

describe('parseCsv (full-text, v0.3 #67)', () => {
  it('parses simple rows with 1-based line numbers, skipping blank lines', () => {
    expect(parseCsv('a,b\n\n1,2\r\n3,4\n')).toEqual([
      { line: 1, cells: ['a', 'b'] },
      { line: 3, cells: ['1', '2'] },
      { line: 4, cells: ['3', '4'] }
    ])
  })

  it('supports line breaks inside quoted fields (one record spanning physical lines)', () => {
    const records = parseCsv('name,note\nAcme,"first line\nsecond line"\nBeta,plain')
    expect(records).toEqual([
      { line: 1, cells: ['name', 'note'] },
      { line: 2, cells: ['Acme', 'first line\nsecond line'] },
      { line: 4, cells: ['Beta', 'plain'] }
    ])
  })

  it('unescapes doubled quotes and keeps quoted commas', () => {
    expect(parseCsv('"say ""hi""","a, b"')).toEqual([{ line: 1, cells: ['say "hi"', 'a, b'] }])
  })

  it('round-trips rowsToCsv output including embedded newlines and quotes', () => {
    const rows = [['plain', 'with, comma'], ['multi\nline', 'has "quotes"']]
    const csv = rowsToCsv(['h1', 'h2'], rows).slice(1) // drop BOM
    expect(parseCsv(csv).map((r) => r.cells)).toEqual([['h1', 'h2'], ...rows])
  })
})

describe('rowsToCsv', () => {
  it('prefixes a UTF-8 BOM', () => {
    const csv = rowsToCsv(['a'], [['1']])
    expect(csv.charCodeAt(0)).toBe(0xfeff)
  })

  it('uses CRLF line endings', () => {
    const csv = rowsToCsv(['a', 'b'], [['1', '2'], ['3', '4']])
    const withoutBom = csv.slice(1)
    expect(withoutBom.split('\r\n')).toEqual(['a,b', '1,2', '3,4', ''])
    // No bare \n that isn't part of a \r\n pair.
    expect(withoutBom.replace(/\r\n/g, '')).not.toContain('\n')
  })

  it('quotes fields containing commas, quotes, or newlines, doubling embedded quotes', () => {
    const csv = rowsToCsv(
      ['name', 'note'],
      [
        ['Acme, Inc.', 'plain'],
        ['Say "hi"', 'line1\nline2'],
        ['carriage\rreturn', 'plain']
      ]
    )
    const withoutBom = csv.slice(1)
    expect(withoutBom).toContain('"Acme, Inc.",plain')
    expect(withoutBom).toContain('"Say ""hi""","line1\nline2"')
    expect(withoutBom).toContain('"carriage\rreturn",plain')
  })

  it('round-trips quoted commas and newlines through parseCsvLine', () => {
    // Quote characters themselves are excluded here: parseCsvLine only toggles quoting on `"`
    // (inherited verbatim from the historical splitCsvLine) rather than unescaping doubled
    // quotes back to a literal `"`, so a field containing a literal quote does not survive a
    // full round trip byte-for-byte — only comma- and newline-bearing fields do. The "doubling
    // embedded quotes" test above covers the write-side RFC 4180 escaping on its own.
    const header = ['name', 'note']
    const rows = [
      ['Acme, Inc.', 'has a comma'],
      ['multi\nline note', 'has a newline'],
      ['plain', 'plain']
    ]
    const csv = rowsToCsv(header, rows)
    const withoutBom = csv.slice(1)
    // Split on CRLF, but quoted newlines inside a cell must not be mistaken for row breaks —
    // so instead of naively splitting the whole blob, re-parse it the way parseCsvLine expects:
    // one physical CSV "line" may itself contain literal \n inside quotes. Since parseCsvLine
    // only cares about commas (and toggles quoting on "), feed it the row text with its embedded
    // \r\n->\n normalization undone is unnecessary here because parseCsvLine treats \n as an
    // ordinary character once inside quotes. So reconstruct rows by splitting only on the CRLF
    // that follows a closing quote or a plain field boundary.
    const lines = splitCsvRecords(withoutBom)
    expect(lines[0]).toEqual(header)
    expect(lines[1]).toEqual(rows[0])
    expect(lines[2]).toEqual(rows[1])
    expect(lines[3]).toEqual(rows[2])
  })
})

/** Test-only: split a full rowsToCsv blob (sans BOM) back into records, respecting quoted \r\n. */
function splitCsvRecords(text: string): string[][] {
  const records: string[][] = []
  let current = ''
  let inQuotes = false
  const body = text.endsWith('\r\n') ? text.slice(0, -2) : text
  for (let i = 0; i < body.length; i++) {
    const ch = body[i]!
    if (ch === '"') inQuotes = !inQuotes
    if (ch === '\r' && body[i + 1] === '\n' && !inQuotes) {
      records.push(parseCsvLine(current))
      current = ''
      i++
      continue
    }
    current += ch
  }
  records.push(parseCsvLine(current))
  return records
}
