/**
 * Sending ESC/P bytes to an impact printer (roadmap #379).
 *
 * The bytes are built in `@shared/escp`, which is pure and tested. This module is the part that
 * needs an operating system: enumerating printers and pushing a byte stream at one without CUPS
 * rendering it first.
 *
 * NOT VERIFIED ON HARDWARE. There has been no dot-matrix printer to test against. The escape
 * sequences are the documented ones and the `lp -o raw` invocation is the documented way to send
 * a job unfiltered, but nobody has watched paper come out of a printer at the other end. The
 * "save the bytes to a file" path exists partly so that whoever first tries this can look at what
 * would have been sent, and partly because a shop with a printer on a parallel-port print server
 * copies the file to the device directly anyway.
 */
import { execFile } from 'child_process'
import { writeFileSync } from 'fs'
import { promisify } from 'util'
import { renderInvoiceEscp, type EscpInvoice, type EscpOptions } from '@shared/escp'
import type { DB } from '../db/connection'
import type { CompanyInfo } from '@shared/domain'
import { extractEdocInvoices } from './edocs'
import { amountInWords, formatPaise, plainMilli } from '@shared/money'
import { toDisplayDate } from '@shared/dates'

const run = promisify(execFile)

export interface RawPrinter {
  name: string
  description: string | null
  isDefault: boolean
}

/**
 * Printers CUPS knows about.
 *
 * `lpstat` rather than Electron's own printer list: Electron reports what Chromium can render to,
 * which is the wrong question — a raw queue pointed at a nine-pin printer is a perfectly good
 * destination for these bytes and a hopeless one for a PDF.
 */
export async function listPrinters(): Promise<RawPrinter[]> {
  try {
    const [{ stdout: queues }, def] = await Promise.all([
      run('lpstat', ['-a']),
      run('lpstat', ['-d']).catch(() => ({ stdout: '' }))
    ])
    const defaultName = def.stdout.split(':')[1]?.trim() ?? ''
    return queues
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => {
        const name = l.split(/\s+/)[0] ?? ''
        return { name, description: l.slice(name.length).trim() || null, isDefault: name === defaultName }
      })
      .filter((p) => p.name)
  } catch {
    // No CUPS, or lpstat missing. An empty list is the honest answer; the caller offers the
    // save-to-file path instead of pretending a printer exists.
    return []
  }
}

export interface PrintRawResult {
  printer: string | null
  bytes: number
  /** Set when the job was written to a file instead of sent to a queue. */
  path: string | null
}

/**
 * Send bytes to a queue without letting the spooler reinterpret them.
 *
 * `-o raw` is the whole point: without it CUPS runs the job through a filter chain that turns
 * text into PostScript and the escape sequences into literal characters printed across the page.
 */
export async function printRaw(bytes: Uint8Array, printer: string | null): Promise<PrintRawResult> {
  if (!printer) throw new Error('No printer chosen')
  const args = ['-d', printer, '-o', 'raw', '-']
  await new Promise<void>((resolve, reject) => {
    const child = execFile('lp', args, (err) => (err ? reject(err) : resolve()))
    child.stdin?.end(Buffer.from(bytes))
  })
  return { printer, bytes: bytes.length, path: null }
}

/** Write the byte stream to a file — for a print server, or for looking at what would be sent. */
export function saveRaw(bytes: Uint8Array, path: string): PrintRawResult {
  writeFileSync(path, Buffer.from(bytes))
  return { printer: null, bytes: bytes.length, path }
}

export { renderInvoiceEscp }
export type { EscpInvoice, EscpOptions }

// ---------- turning a real invoice into columns ----------

/**
 * Build the ESC/P document for a saved sales voucher.
 *
 * Deliberately the same source the PDF invoice uses (`extractEdocInvoices`), so the paper copy
 * and the electronic one can never disagree about a figure — which they would within a month if
 * this had its own query.
 */
export function invoiceEscp(
  db: DB,
  company: CompanyInfo,
  voucherId: number,
  opts: EscpOptions = {}
): { bytes: Uint8Array; number: string } {
  const [inv] = extractEdocInvoices(db, company, '0000-01-01', '9999-12-31', voucherId)
  if (!inv) throw new Error('Invoice not found (only sales vouchers can be printed)')

  const totals: { label: string; value: string }[] = [{ label: 'Taxable', value: formatPaise(inv.taxable) }]
  if (inv.cgst) totals.push({ label: 'CGST', value: formatPaise(inv.cgst) })
  if (inv.sgst) totals.push({ label: 'SGST', value: formatPaise(inv.sgst) })
  if (inv.igst) totals.push({ label: 'IGST', value: formatPaise(inv.igst) })
  if (inv.cess) totals.push({ label: 'Cess', value: formatPaise(inv.cess) })
  if (inv.roundOff) totals.push({ label: 'Round off', value: formatPaise(inv.roundOff) })

  const doc: EscpInvoice = {
    companyName: company.name,
    companyAddress: (company.address ?? '').split('\n').filter(Boolean),
    gstin: company.gstin,
    title: inv.isOptional ? 'PROFORMA INVOICE' : 'TAX INVOICE',
    number: inv.number,
    date: toDisplayDate(inv.date),
    partyName: inv.partyName ?? 'Cash',
    partyAddress: (inv.partyAddress ?? '').split('\n').filter(Boolean),
    partyGstin: inv.partyGstin,
    lines: inv.items.map((i) => ({
      description: i.name,
      hsn: i.hsn || null,
      qty: i.isService ? '' : plainMilli(i.qtyMilli),
      rate: formatPaise(i.unitPricePaise),
      amount: formatPaise(i.taxablePaise)
    })),
    totals,
    grandTotalLabel: 'TOTAL',
    grandTotalValue: formatPaise(inv.total),
    amountInWords: amountInWords(inv.total),
    footer: ['E. & O.E.', `For ${company.name}`, '', '', 'Authorised Signatory']
  }
  return { bytes: renderInvoiceEscp(doc, opts), number: inv.number }
}
