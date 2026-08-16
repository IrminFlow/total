import { shell } from 'electron'
import type { DB } from '../db/connection'
import type { CompanyInfo } from '@shared/domain'
import type { ChequeConfig } from '@shared/schemas'
import { chequeFields, mmToInches, type ChequeFields } from '@shared/cheque'
import { formatPaise } from '@shared/money'
import { toDisplayDate } from '@shared/dates'
import { getVoucher } from './vouchers'
import { getLedger } from './masters'
import { bankLedgers } from './banking'
import { getChequeConfig } from './config'
import { writeExportPdf } from './pdf'

const esc = (s: string | null | undefined): string =>
  (s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

export interface ChequeData {
  voucherNumber: string
  date: string
  payee: string
  /** Paise — the bank ledger's credit line amount on this voucher. */
  amount: number
  bankLedgerId: number
  bankLedgerName: string
}

/** Resolve + validate everything a cheque print needs, with no PDF/Electron dependency — so it
 *  can be unit-tested under vitest's dbtest harness (printToPDF needs a real BrowserWindow,
 *  which AS_NODE can't create). chequePdf/testGridPdf below build on this. */
export function chequeData(db: DB, voucherId: number, bankLedgerId: number): ChequeData {
  const voucher = getVoucher(db, voucherId)
  if (!voucher) throw new Error('Voucher not found')

  const vt = db.prepare('SELECT kind FROM voucher_types WHERE id = ?').get(voucher.voucherTypeId) as
    | { kind: string }
    | undefined
  if (!vt || vt.kind !== 'payment') throw new Error('Only payment vouchers can print a cheque')

  const isBank = bankLedgers(db).some((b) => b.id === bankLedgerId)
  if (!isBank) throw new Error('That ledger is not a bank account')

  const bankLine = voucher.lines.find((l) => l.drCr === 'cr' && l.ledgerId === bankLedgerId)
  if (!bankLine) throw new Error('This voucher has no credit to that bank ledger')

  const bankLedger = getLedger(db, bankLedgerId)
  if (!bankLedger) throw new Error('Bank ledger not found')

  let payee = 'Payee'
  if (voucher.partyLedgerId != null) {
    payee = getLedger(db, voucher.partyLedgerId)?.name ?? payee
  } else {
    const drLines = voucher.lines.filter((l) => l.drCr === 'dr')
    const largest = drLines.reduce<(typeof drLines)[number] | null>(
      (best, l) => (best == null || l.amount > best.amount ? l : best),
      null
    )
    if (largest) payee = getLedger(db, largest.ledgerId)?.name ?? payee
  }

  return {
    voucherNumber: voucher.number,
    date: voucher.date,
    payee,
    amount: bankLine.amount,
    bankLedgerId,
    bankLedgerName: bankLedger.name
  }
}

/** printToPDF's custom pageSize wants inches (mmToInches — see @shared/cheque); the HTML body
 *  itself stays in CSS mm throughout (Chromium maps CSS mm correctly regardless of page size), so
 *  a misbehaving/clamped custom page size just prints the same mm layout with extra/less margin
 *  around it, never shifted content. */
function chequePageSize(config: ChequeConfig): { width: number; height: number } {
  return { width: mmToInches(config.widthMm), height: mmToInches(config.heightMm) }
}

/** Absolutely-positioned mm layout, printed onto a page sized to match (see chequePageSize). */
function buildChequeHtml(config: ChequeConfig, fields: ChequeFields): string {
  const dateDigits = fields.dateBoxes
    .split('')
    .map(
      (d, i) =>
        `<div class="abs" style="left:${config.date.xMm + i * config.date.charGapMm}mm; top:${config.date.yMm}mm;">${esc(d)}</div>`
    )
    .join('')

  const acPayee = config.acPayee
    ? `<div class="acpayee">A/C PAYEE ONLY</div>`
    : ''

  return `<!doctype html><html><head><meta charset="utf-8"><style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    html, body { width: ${config.widthMm}mm; height: ${config.heightMm}mm; }
    body { position: relative; font: 11pt 'SF Mono', Menlo, monospace; color: #101010; }
    .abs { position: absolute; white-space: nowrap; }
    .acpayee {
      position: absolute; left: 4mm; top: 4mm; width: 44mm;
      transform: rotate(-12deg); transform-origin: left top;
      font-size: 8.5pt; font-weight: 700; letter-spacing: 0.05em; text-align: center;
      border-top: 1.2pt double #101010; border-bottom: 1.2pt double #101010;
      padding: 1mm 0;
    }
  </style></head><body>
    ${acPayee}
    ${dateDigits}
    <div class="abs" style="left:${config.payee.xMm}mm; top:${config.payee.yMm}mm;">${esc(fields.payee)}</div>
    <div class="abs" style="left:${config.words.xMm}mm; top:${config.words.yMm}mm; width:${config.words.wMm}mm; white-space: normal;">${esc(fields.words)}</div>
    <div class="abs" style="left:${config.figures.xMm}mm; top:${config.figures.yMm}mm;">${esc(fields.figures)}</div>
  </body></html>`
}

/** Render + save the cheque PDF, then reveal it in Finder (loaded straight into the printer tray
 *  by the user — no reason to open a viewer first). Returns the file path. */
export async function chequePdf(
  db: DB,
  company: CompanyInfo,
  slug: string,
  voucherId: number,
  bankLedgerId: number
): Promise<string> {
  const data = chequeData(db, voucherId, bankLedgerId)
  const config = getChequeConfig(db, bankLedgerId)
  const fields = chequeFields({ date: data.date, payee: data.payee, amount: data.amount })
  const html = buildChequeHtml(config, fields)
  const safe = data.voucherNumber.replace(/[^a-zA-Z0-9-_]/g, '_')
  const path = await writeExportPdf(slug, `cheque-${safe}.pdf`, html, {
    pageSize: chequePageSize(config),
    margins: 'none'
  })
  shell.showItemInFolder(path)
  return path
}

const GRID_FIELDS = (config: ChequeConfig): { x: number; y: number; label: string }[] => [
  { x: config.date.xMm, y: config.date.yMm, label: 'date' },
  { x: config.payee.xMm, y: config.payee.yMm, label: 'payee' },
  { x: config.words.xMm, y: config.words.yMm, label: 'words' },
  { x: config.figures.xMm, y: config.figures.yMm, label: 'figures' }
]

function buildGridHtml(config: ChequeConfig): string {
  const crosses = GRID_FIELDS(config)
    .map(
      (c) => `
      <div class="abs" style="left:${c.x}mm; top:${c.y - 2}mm; width:0.3mm; height:4mm; background:#c00;"></div>
      <div class="abs" style="left:${c.x - 2}mm; top:${c.y}mm; width:4mm; height:0.3mm; background:#c00;"></div>
      <div class="abs label" style="left:${c.x + 2.5}mm; top:${c.y - 3.5}mm;">${esc(c.label)} (${c.x}, ${c.y})</div>`
    )
    .join('')

  return `<!doctype html><html><head><meta charset="utf-8"><style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    html, body { width: ${config.widthMm}mm; height: ${config.heightMm}mm; }
    body {
      position: relative;
      background-image:
        repeating-linear-gradient(to right, #ccc 0, #ccc 0.15mm, transparent 0.15mm, transparent 5mm),
        repeating-linear-gradient(to bottom, #ccc 0, #ccc 0.15mm, transparent 0.15mm, transparent 5mm);
    }
    .abs { position: absolute; }
    .label { font: 6.5pt 'SF Mono', Menlo, monospace; color: #c00; white-space: nowrap; }
  </style></head><body>${crosses}</body></html>`
}

/** A 5mm-gridded calibration printout with crosses at every configured field position — print
 *  onto the same physical stationery to check the offsets before printing a real cheque. */
export async function testGridPdf(db: DB, company: CompanyInfo, slug: string, bankLedgerId: number): Promise<string> {
  const config = getChequeConfig(db, bankLedgerId)
  const html = buildGridHtml(config)
  return writeExportPdf(slug, 'cheque-test-grid.pdf', html, {
    pageSize: chequePageSize(config),
    margins: 'none'
  })
}

/** A4 payment-advice PDF: header, party, date, instrument details, and a table of the bills this
 *  payment was allocated against (falls back to a single narration line when none were recorded). */
export async function paymentAdvicePdf(db: DB, company: CompanyInfo, slug: string, voucherId: number): Promise<string> {
  const voucher = getVoucher(db, voucherId)
  if (!voucher) throw new Error('Voucher not found')

  const party = voucher.partyLedgerId != null ? getLedger(db, voucher.partyLedgerId) : null
  const against = voucher.billRefs.filter((r) => r.kind === 'against')
  const paidTotal = voucher.lines.filter((l) => l.drCr === 'dr').reduce((s, l) => s + l.amount, 0)

  const rows =
    against.length > 0
      ? against.map((r) => `<tr><td>${esc(r.name)}</td><td class="r num">${formatPaise(r.amount)}</td></tr>`).join('')
      : `<tr><td>${esc(voucher.narration ?? 'Payment')}</td><td class="r num">${formatPaise(paidTotal)}</td></tr>`
  const total = against.length > 0 ? against.reduce((s, r) => s + r.amount, 0) : paidTotal

  const html = `<!doctype html><html><head><meta charset="utf-8"><title>Payment advice ${esc(voucher.number)}</title><style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font: 12px/1.5 'Helvetica Neue', Arial, sans-serif; color: #16181f; padding: 36px; }
    .num { font-variant-numeric: tabular-nums; font-family: Menlo, monospace; font-size: 11.5px; }
    h1 { font-size: 18px; } .sub { color: #555; font-size: 11px; margin-top: 2px; }
    .head { border-bottom: 1.5px solid #16181f; padding-bottom: 12px; display: flex; justify-content: space-between; }
    .tag { text-align: right; } .tag b { font-size: 14px; letter-spacing: 0.1em; }
    .meta { display: flex; gap: 48px; padding: 14px 0; border-bottom: 1px solid #16181f; }
    .lbl { font-size: 9.5px; text-transform: uppercase; letter-spacing: 0.1em; color: #555; margin-bottom: 2px; }
    table { width: 100%; border-collapse: collapse; margin-top: 14px; }
    th { font-size: 10px; text-transform: uppercase; letter-spacing: 0.06em; border-bottom: 1px solid #16181f; padding: 7px 4px; text-align: left; }
    td { padding: 6px 4px; border-bottom: 1px dotted #999; }
    .r { text-align: right; }
    tr.total td { border-top: 1.5px solid #16181f; border-bottom: 3px double #16181f; font-weight: 700; padding-top: 8px; }
  </style></head><body>
    <div class="head">
      <div><h1>${esc(company.name)}</h1><div class="sub">${esc(company.address)}</div></div>
      <div class="tag"><b>PAYMENT ADVICE</b><div class="sub">${esc(voucher.number)}</div></div>
    </div>
    <div class="meta">
      <div><div class="lbl">Paid to</div><div><b>${esc(party?.name ?? 'Payee')}</b></div></div>
      <div><div class="lbl">Date</div><div class="num">${toDisplayDate(voucher.date)}</div></div>
      ${voucher.instrumentNo ? `<div><div class="lbl">Instrument no.</div><div class="num">${esc(voucher.instrumentNo)}</div></div>` : ''}
      ${voucher.instrumentDate ? `<div><div class="lbl">Instrument date</div><div class="num">${toDisplayDate(voucher.instrumentDate)}</div></div>` : ''}
    </div>
    <table>
      <thead><tr><th>Towards</th><th class="r" style="width:140px">Amount</th></tr></thead>
      <tbody>${rows}</tbody>
      <tfoot><tr class="total"><td>Total</td><td class="r num">${formatPaise(total)}</td></tr></tfoot>
    </table>
  </body></html>`

  const safe = voucher.number.replace(/[^a-zA-Z0-9-_]/g, '_')
  return writeExportPdf(slug, `advice-${safe}.pdf`, html, { pageSize: 'A4' })
}
