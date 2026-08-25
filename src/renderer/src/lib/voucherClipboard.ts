export interface ClipboardVoucherLine { ledgerName: string; drCr: 'dr' | 'cr'; amount: number; row: number }
export interface ClipboardParseResult { lines: ClipboardVoucherLine[]; issues: string[] }

function paise(value: string): number | null {
  const normalized = value.trim().replace(/[₹,\s]/g, '')
  if (!/^\d+(?:\.\d{1,2})?$/.test(normalized)) return null
  const [rupees, fraction = ''] = normalized.split('.')
  const amount = Number(rupees) * 100 + Number(fraction.padEnd(2, '0'))
  return Number.isSafeInteger(amount) && amount > 0 ? amount : null
}

/** Parse Ledger / Debit / Credit TSV or CSV without floating-point money conversion. */
export function parseVoucherClipboard(text: string): ClipboardParseResult {
  const lines: ClipboardVoucherLine[] = []
  const issues: string[] = []
  const rawRows = text.replace(/\r/g, '').split('\n').filter((row) => row.trim())
  if (rawRows.length > 201) return { lines: [], issues: ['Clipboard has more than 200 data rows'] }
  rawRows.forEach((raw, index) => {
    const cells = (raw.includes('\t') ? raw.split('\t') : raw.split(',')).map((cell) => cell.trim())
    if (index === 0 && /ledger|account/i.test(cells[0] ?? '') && cells.some((cell) => /debit|credit|dr|cr/i.test(cell))) return
    const row = index + 1
    if (cells.length < 3 || !cells[0]) return void issues.push(`Row ${row}: expected Ledger, Debit, Credit`)
    const debit = cells[1] ? paise(cells[1]) : null
    const credit = cells[2] ? paise(cells[2]) : null
    if ((debit == null) === (credit == null)) return void issues.push(`Row ${row}: enter exactly one positive debit or credit amount`)
    lines.push({ ledgerName: cells[0], drCr: debit != null ? 'dr' : 'cr', amount: debit ?? credit!, row })
  })
  if (!rawRows.length) issues.push('Clipboard is empty')
  return { lines, issues }
}
