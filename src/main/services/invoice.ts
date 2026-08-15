import { BrowserWindow } from 'electron'
import { writeFileSync } from 'fs'
import { join } from 'path'
import type { DB } from '../db/connection'
import type { CompanyInfo } from '@shared/domain'
import { amountInWords, formatPaise } from '@shared/money'
import { toDisplayDate } from '@shared/dates'
import { GST_STATES } from '@shared/gst/states'
import { companyExportsDir } from '../paths'
import { extractEdocInvoices } from './edocs'

const esc = (s: string | null): string =>
  (s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

const money = (paise: number): string => formatPaise(paise)

export function invoiceHtml(db: DB, company: CompanyInfo, voucherId: number): { html: string; number: string } {
  const [inv] = extractEdocInvoices(db, company, '0000-01-01', '9999-12-31', voucherId)
  if (!inv) throw new Error('Invoice not found (only sales vouchers can be printed)')

  const isIntra = inv.igst === 0
  const itemRows = inv.items
    .map(
      (item, i) => `
      <tr>
        <td class="c">${i + 1}</td>
        <td>${esc(item.name)}</td>
        <td class="c num">${esc(item.hsn)}</td>
        <td class="r num">${item.qtyMilli / 1000} ${esc(item.uqc)}</td>
        <td class="r num">${money(item.unitPricePaise)}</td>
        <td class="c num">${item.rate}%</td>
        <td class="r num">${money(item.taxablePaise)}</td>
      </tr>`
    )
    .join('')

  const taxRows = [
    isIntra ? `<tr><td>CGST</td><td class="r num">${money(inv.cgst)}</td></tr>` : '',
    isIntra ? `<tr><td>SGST</td><td class="r num">${money(inv.sgst)}</td></tr>` : '',
    !isIntra ? `<tr><td>IGST</td><td class="r num">${money(inv.igst)}</td></tr>` : '',
    inv.cess > 0 ? `<tr><td>Cess</td><td class="r num">${money(inv.cess)}</td></tr>` : '',
    inv.roundOff !== 0 ? `<tr><td>Round off</td><td class="r num">${money(inv.roundOff)}</td></tr>` : ''
  ].join('')

  const html = `<!doctype html><html><head><meta charset="utf-8"><title>Invoice ${esc(inv.number)}</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font: 12px/1.45 'Helvetica Neue', Arial, sans-serif; color: #16181f; padding: 28px; }
    .num { font-variant-numeric: tabular-nums; font-family: 'SF Mono', Menlo, monospace; font-size: 11.5px; }
    .sheet { border: 1.5px solid #16181f; }
    .head { display: flex; justify-content: space-between; border-bottom: 1.5px solid #16181f; padding: 14px 16px; }
    h1 { font-size: 20px; letter-spacing: 0.02em; }
    .tag { text-align: right; font-size: 11px; }
    .tag b { font-size: 14px; letter-spacing: 0.12em; }
    .meta { display: flex; border-bottom: 1.5px solid #16181f; }
    .meta > div { flex: 1; padding: 10px 16px; }
    .meta > div + div { border-left: 1px solid #16181f; }
    .lbl { font-size: 9.5px; text-transform: uppercase; letter-spacing: 0.1em; color: #555; margin-bottom: 2px; }
    table.items { width: 100%; border-collapse: collapse; }
    table.items th { font-size: 10px; text-transform: uppercase; letter-spacing: 0.06em; border-bottom: 1px solid #16181f; padding: 7px 8px; text-align: left; background: #f2f2ee; }
    table.items td { padding: 6px 8px; border-bottom: 1px dotted #999; vertical-align: top; }
    .r { text-align: right; } .c { text-align: center; }
    .bottom { display: flex; border-top: 1.5px solid #16181f; }
    .words { flex: 1; padding: 10px 16px; border-right: 1px solid #16181f; }
    table.tot { width: 260px; border-collapse: collapse; }
    table.tot td { padding: 5px 12px; }
    table.tot tr.grand td { border-top: 1px solid #16181f; border-bottom: 3px double #16181f; font-weight: 700; font-size: 13px; }
    .sig { display: flex; justify-content: space-between; padding: 26px 16px 12px; border-top: 1.5px solid #16181f; font-size: 11px; }
    .sig .for { text-align: right; }
    @media print { body { padding: 0; } }
  </style></head><body>
  <div class="sheet">
    <div class="head">
      <div>
        <h1>${esc(company.name)}</h1>
        <div>${esc(company.address)}</div>
        <div class="num">GSTIN: ${esc(company.gstin ?? 'Unregistered')} · ${esc(GST_STATES[company.stateCode] ?? company.stateCode)}</div>
      </div>
      <div class="tag">
        <b>TAX INVOICE</b>
        <div style="margin-top:6px">Original for recipient</div>
      </div>
    </div>
    <div class="meta">
      <div>
        <div class="lbl">Billed to</div>
        <div><b>${esc(inv.partyName ?? 'Cash sale')}</b></div>
        <div>${esc(inv.partyAddress)}</div>
        <div class="num">${inv.partyGstin ? 'GSTIN: ' + esc(inv.partyGstin) : 'Unregistered'}</div>
      </div>
      <div>
        <div class="lbl">Invoice</div>
        <div>No: <b class="num">${esc(inv.number)}</b></div>
        <div>Date: <span class="num">${toDisplayDate(inv.date)}</span></div>
        <div>Place of supply: <span class="num">${esc(inv.pos)}-${esc(GST_STATES[inv.pos] ?? '')}</span></div>
        ${inv.vehicleNo ? `<div>Vehicle: <span class="num">${esc(inv.vehicleNo)}</span></div>` : ''}
      </div>
    </div>
    <table class="items">
      <thead><tr>
        <th class="c" style="width:34px">#</th><th>Description</th><th class="c" style="width:80px">HSN</th>
        <th class="r" style="width:90px">Qty</th><th class="r" style="width:100px">Rate</th>
        <th class="c" style="width:60px">GST</th><th class="r" style="width:110px">Amount</th>
      </tr></thead>
      <tbody>${itemRows}</tbody>
    </table>
    <div class="bottom">
      <div class="words">
        <div class="lbl">Amount in words</div>
        <div><i>${esc(amountInWords(inv.total))}</i></div>
        <div style="margin-top:10px" class="lbl">Declaration</div>
        <div style="font-size:10.5px">We declare that this invoice shows the actual price of the goods described and that all particulars are true and correct.</div>
      </div>
      <table class="tot">
        <tr><td>Taxable value</td><td class="r num">${money(inv.taxable)}</td></tr>
        ${taxRows}
        <tr class="grand"><td>Total</td><td class="r num">₹ ${money(inv.total)}</td></tr>
      </table>
    </div>
    <div class="sig">
      <div>Receiver's signature</div>
      <div class="for">For <b>${esc(company.name)}</b><br/><br/><br/>Authorised signatory</div>
    </div>
  </div>
  </body></html>`

  return { html, number: inv.number }
}

/** Render the invoice to a PDF in the company's exports folder. Returns the file path. */
export async function invoicePdf(db: DB, company: CompanyInfo, slug: string, voucherId: number): Promise<string> {
  const { html, number } = invoiceHtml(db, company, voucherId)
  const win = new BrowserWindow({ show: false, webPreferences: { sandbox: true } })
  try {
    await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html))
    const pdf = await win.webContents.printToPDF({ pageSize: 'A4', printBackground: true })
    const safe = number.replace(/[^a-zA-Z0-9-_]/g, '_')
    const path = join(companyExportsDir(slug), `invoice-${safe}.pdf`)
    writeFileSync(path, pdf)
    return path
  } finally {
    win.destroy()
  }
}
