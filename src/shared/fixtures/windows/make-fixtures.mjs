// WP 7.3 — regenerates the Windows-encoded fixtures in this folder from their LF / UTF-8 sources:
//   node src/shared/fixtures/windows/make-fixtures.mjs
// The generated files are byte-exact (.gitattributes marks this folder binary, so a Windows
// checkout never rewrites their line endings). windowsImport.test.ts parses each one and expects
// exactly what its LF / UTF-8 source gives.
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const bank = join(here, '..', '..', 'bankFormats', 'fixtures')

const crlf = (s) => s.replace(/\r?\n/g, '\r\n')
const utf8Bom = (s) => Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(s, 'utf8')])
const utf16leBom = (s) => Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(s, 'utf16le')])

const tally = readFileSync(join(here, 'tally-export.lf.xml'), 'utf8')
// Tally on Windows: "Unicode" (UTF-16LE + BOM, CRLF) is the export default; UTF-8 + BOM is the other.
writeFileSync(join(here, 'tally-export.utf16le-bom-crlf.xml'), utf16leBom(crlf(tally.replace('encoding="UTF-8"', 'encoding="UTF-16"'))))
writeFileSync(join(here, 'tally-export.utf8-bom-crlf.xml'), utf8Bom(crlf(tally)))
// Without a BOM (some tools strip it) — still UTF-16LE, detected from the NUL pattern.
writeFileSync(join(here, 'tally-export.utf16le-nobom-crlf.xml'), Buffer.from(crlf(tally.replace('encoding="UTF-8"', 'encoding="UTF-16"')), 'utf16le'))

// Bank statements as Excel / Notepad on Windows save them: "CSV UTF-8" = BOM + CRLF.
for (const [src, out] of [
  ['hdfc-style.csv', 'bank-hdfc-style.bom-crlf.csv'],
  ['flag-style.csv', 'bank-flag-style.bom-crlf.csv'],
  ['sbi-style.txt', 'bank-sbi-style.bom-crlf.txt'],
  ['statement.sta', 'bank-statement.crlf.sta'],
  ['camt053.xml', 'bank-camt053.bom-crlf.xml']
]) {
  const text = readFileSync(join(bank, src), 'utf8')
  writeFileSync(join(here, out), out.includes('bom') ? utf8Bom(crlf(text)) : Buffer.from(crlf(text), 'utf8'))
}
// Excel's "Unicode Text" save: UTF-16LE + BOM, tab-separated, CRLF.
const hdfc = readFileSync(join(bank, 'hdfc-style.csv'), 'utf8')
writeFileSync(join(here, 'bank-hdfc-style.utf16le-bom-crlf.csv'), utf16leBom(crlf(hdfc)))
console.log('fixtures written to', here)
