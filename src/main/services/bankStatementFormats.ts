import ExcelJS from 'exceljs'
import { rowsToCsv } from '@shared/csv'
import { assertSafeXlsxContainer } from './xlsxSafety'

export type BankStatementFormat = 'csv' | 'xlsx' | 'ofx' | 'qif' | 'mt940'

export interface NormalizedBankStatement {
  format: BankStatementFormat
  csvText: string
}

const HEADER = ['Date', 'Description', 'Reference', 'Debit', 'Credit', 'Balance']

function isoDate(raw: string): string {
  const value = raw.trim()
  let match = value.match(/^(\d{4})(\d{2})(\d{2})/)
  if (match) return `${match[1]}-${match[2]}-${match[3]}`
  match = value.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{2}|\d{4})$/)
  if (!match) return value
  const year = match[3]!.length === 2 ? `20${match[3]}` : match[3]
  return `${year}-${match[2]!.padStart(2, '0')}-${match[1]!.padStart(2, '0')}`
}

function money(value: number): string {
  return value.toFixed(2)
}

function amount(raw: string): number {
  const cleaned = raw.replace(/[₹,\s]/g, '').replace(/^\((.*)\)$/, '-$1')
  const parsed = Number(cleaned)
  if (!Number.isFinite(parsed)) throw new Error(`Invalid statement amount: ${raw}`)
  return parsed
}

function withRunningBalances(
  rows: { date: string; description: string; reference: string; value: number }[],
  opening: number | null
): string {
  let balance = opening
  return rowsToCsv(HEADER, rows.map((row) => {
    if (balance != null) balance += row.value
    return [row.date, row.description, row.reference, row.value < 0 ? money(-row.value) : '', row.value >= 0 ? money(row.value) : '', balance == null ? '' : money(balance)]
  }))
}

function tag(block: string, name: string): string {
  const match = block.match(new RegExp(`<${name}>([^<\\r\\n]*)`, 'i'))
  return match?.[1]?.trim() ?? ''
}

function decodeEntities(value: string): string {
  return value.replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&quot;/gi, '"').replace(/&#39;/gi, "'")
}

export function normalizeOfx(text: string): string {
  const rows = [...text.matchAll(/<STMTTRN>([\s\S]*?)(?:<\/STMTTRN>|(?=<STMTTRN>|<\/BANKTRANLIST>))/gi)].map((match) => {
    const block = match[1]!
    const value = amount(tag(block, 'TRNAMT'))
    return {
      date: isoDate(tag(block, 'DTPOSTED')),
      description: decodeEntities([tag(block, 'NAME'), tag(block, 'MEMO')].filter(Boolean).join(' · ')),
      reference: tag(block, 'FITID') || tag(block, 'CHECKNUM'),
      value
    }
  }).filter((row) => row.date && row.value !== 0).sort((a, b) => a.date.localeCompare(b.date))
  if (!rows.length) throw new Error('No transactions found in the OFX statement')
  const closingRaw = tag(text, 'BALAMT')
  const closing = closingRaw ? amount(closingRaw) : null
  const net = rows.reduce((sum, row) => sum + row.value, 0)
  return withRunningBalances(rows, closing == null ? null : closing - net)
}

export function normalizeQif(text: string): string {
  const rows: { date: string; description: string; reference: string; value: number }[] = []
  for (const block of text.split(/^\^\s*$/m)) {
    const fields = new Map<string, string>()
    for (const line of block.split(/\r?\n/)) {
      if (line.length > 1 && !line.startsWith('!')) fields.set(line[0]!, line.slice(1).trim())
    }
    const rawAmount = fields.get('T')
    const date = fields.get('D')
    if (!rawAmount || !date) continue
    const value = amount(rawAmount)
    if (value === 0) continue
    rows.push({ date: isoDate(date), description: [fields.get('P'), fields.get('M')].filter(Boolean).join(' · '), reference: fields.get('N') ?? '', value })
  }
  if (!rows.length) throw new Error('No transactions found in the QIF statement')
  rows.sort((a, b) => a.date.localeCompare(b.date))
  return withRunningBalances(rows, null)
}

function mtAmount(raw: string): number {
  return amount(raw.replace(',', '.'))
}

export function normalizeMt940(text: string): string {
  const openingMatch = text.match(/:60[FM]:([CD])\d{6}[A-Z]{3}([\d,]+)/)
  const opening = openingMatch ? mtAmount(openingMatch[2]!) * (openingMatch[1] === 'D' ? -1 : 1) : null
  const lines = text.replace(/\r/g, '').split('\n')
  const rows: { date: string; description: string; reference: string; value: number }[] = []
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!
    const match = line.match(/^:61:(\d{2})(\d{2})(\d{2})(?:\d{4})?([CD])(?:R)?([\d,]+)(.*)$/)
    if (!match) continue
    const detail = match[6] ?? ''
    const next = lines[index + 1]?.startsWith(':86:') ? lines[++index]!.slice(4) : ''
    const value = mtAmount(match[5]!) * (match[4] === 'D' ? -1 : 1)
    rows.push({ date: `20${match[1]}-${match[2]}-${match[3]}`, description: next || detail, reference: detail.slice(0, 80), value })
  }
  if (!rows.length) throw new Error('No transactions found in the MT940 statement')
  return withRunningBalances(rows, opening)
}

function cellText(cell: ExcelJS.Cell): string {
  const value = cell.value
  if (value == null) return ''
  if (value instanceof Date) return value.toISOString().slice(0, 10)
  if (typeof value === 'object') {
    if ('result' in value && value.result != null) return String(value.result)
    if ('text' in value && typeof value.text === 'string') return value.text
    if ('richText' in value && Array.isArray(value.richText)) return value.richText.map((part) => part.text).join('')
  }
  return String(value)
}

export async function normalizeXlsx(buffer: Buffer): Promise<string> {
  assertSafeXlsxContainer(buffer, {
    maxEntries: 5_000,
    maxUncompressedBytes: 128 * 1024 * 1024,
    maxEntryBytes: 48 * 1024 * 1024,
  })
  const workbook = new ExcelJS.Workbook()
  await workbook.xlsx.load(buffer as unknown as ExcelJS.Buffer)
  const sheet = workbook.worksheets[0]
  if (!sheet) throw new Error('The workbook has no worksheets')
  if (sheet.rowCount > 50_001) throw new Error('Statement has more than 50,000 rows')
  const rows: string[][] = []
  sheet.eachRow({ includeEmpty: false }, (row) => {
    const values: string[] = []
    for (let column = 1; column <= row.cellCount; column++) values.push(cellText(row.getCell(column)))
    rows.push(values)
  })
  if (rows.length < 2) throw new Error('The first worksheet has no statement rows')
  return rowsToCsv(rows[0]!, rows.slice(1))
}

export function detectBankStatementFormat(fileName: string): BankStatementFormat {
  const extension = fileName.toLowerCase().split('.').pop()
  if (extension === 'xlsx') return 'xlsx'
  if (extension === 'ofx') return 'ofx'
  if (extension === 'qif') return 'qif'
  if (extension === 'sta' || extension === 'mt940' || extension === '940') return 'mt940'
  return 'csv'
}

export async function normalizeBankStatement(fileName: string, buffer: Buffer): Promise<NormalizedBankStatement> {
  if (buffer.byteLength > 25 * 1024 * 1024) throw new Error('Bank statement exceeds the 25 MB safety limit')
  const format = detectBankStatementFormat(fileName)
  if (format === 'xlsx') return { format, csvText: await normalizeXlsx(buffer) }
  const text = buffer.toString('utf8').replace(/^\uFEFF/, '')
  if (format === 'ofx') return { format, csvText: normalizeOfx(text) }
  if (format === 'qif') return { format, csvText: normalizeQif(text) }
  if (format === 'mt940') return { format, csvText: normalizeMt940(text) }
  return { format, csvText: text }
}
