/**
 * The ISD invoice, as paper (roadmap #355).
 *
 * Split from `isd.ts` for the reason given at the top of `branchTransferPdf.ts`: the PDF renderer
 * needs Electron, and `isd.ts` is reachable from `gst.ts`, which the MCP server bundles and runs
 * without one.
 */

import type { DB } from '../db/connection'
import type { CreditHeads, IsdInvoice } from '@shared/gst/isd'
import { toDisplayDate } from '@shared/dates'
import { formatPaise } from '@shared/money'
import { writeExportPdf } from './pdf'

// ---------- paper ----------

const esc = (s: string | null): string => (s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/** The stored document, for reprinting. */
export function getIsdInvoice(db: DB, id: number): IsdInvoice {
  const row = db.prepare('SELECT doc_json FROM isd_invoices WHERE id = ?').get(id) as { doc_json: string } | undefined
  if (!row) throw new Error('ISD invoice not found')
  return JSON.parse(row.doc_json) as IsdInvoice
}

/**
 * The ISD invoice, as paper — rule 54(1).
 *
 * Not a tax invoice, and it says so: there is no taxable value on it, nothing is payable against
 * it, and the only amounts are credit distributed. The head conversion is shown line by line —
 * "received CGST+SGST, distributed IGST" — because that is the single most surprising thing about
 * an ISD invoice and the recipient's accountant will otherwise go looking for the CGST.
 */
export async function isdInvoicePdf(db: DB, slug: string, id: number): Promise<string> {
  const doc = getIsdInvoice(db, id)
  const money = (p: number): string => formatPaise(p)
  const heads = (h: CreditHeads): string =>
    [h.igst && `IGST ${money(h.igst)}`, h.cgst && `CGST ${money(h.cgst)}`, h.sgst && `SGST ${money(h.sgst)}`, h.cess && `Cess ${money(h.cess)}`]
      .filter(Boolean)
      .join(' · ') || '—'

  const rows = doc.lines
    .map(
      (l) =>
        `<tr><td>${esc(l.supplierName)}<div class="sub">${esc(l.description ?? '')}</div></td>` +
        `<td class="num">${esc(l.supplierGstin ?? '—')}</td>` +
        `<td class="num">${esc(l.supplierInvoiceNumber)}<div class="sub">${toDisplayDate(l.supplierInvoiceDate)}</div></td>` +
        `<td>${l.eligibility === 'eligible' ? 'Eligible' : 'Ineligible'}</td>` +
        `<td class="num">${esc(heads(l.received))}</td>` +
        `<td class="num">${esc(heads(l.distributed))}</td></tr>`
    )
    .join('')

  const ratioPct =
    doc.ratio.totalTurnoverPaise > 0
      ? ((doc.ratio.turnoverPaise / doc.ratio.totalTurnoverPaise) * 100).toFixed(4)
      : '—'

  const warnings = doc.warnings.length
    ? `<div class="warn"><b>Before this is filed:</b><ul>${doc.warnings.map((w) => `<li>${esc(w)}</li>`).join('')}</ul></div>`
    : ''

  const html = `<!doctype html><html><head><meta charset="utf-8"><title>${esc(doc.number)}</title><style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font: 12px/1.5 'Helvetica Neue', Arial, sans-serif; color: #16181f; padding: 30px; }
    .num { font-variant-numeric: tabular-nums; font-family: Menlo, monospace; font-size: 11.5px; }
    .head { border-bottom: 1.5px solid #16181f; padding-bottom: 12px; display: flex; justify-content: space-between; }
    h1 { font-size: 17px; } .sub { color: #555; font-size: 11px; }
    .tag { text-align: right; } .tag b { font-size: 13px; letter-spacing: 0.06em; text-transform: uppercase; }
    .parties { display: flex; gap: 40px; padding: 14px 0; border-bottom: 1px solid #16181f; }
    h3 { font-size: 10px; text-transform: uppercase; letter-spacing: 0.08em; color: #555; margin-bottom: 4px; }
    table { width: 100%; border-collapse: collapse; margin-top: 12px; }
    th { font-size: 10px; text-transform: uppercase; letter-spacing: 0.06em; text-align: left; border-bottom: 1.5px solid #16181f; padding: 6px 0; }
    td { padding: 5px 0; border-bottom: 1px dotted #bbb; vertical-align: top; }
    .r { text-align: right; }
    .totals { width: 56%; margin-left: auto; }
    .totals tr:last-child td { font-weight: 600; border-top: 1px solid #16181f; }
    .warn { margin-top: 16px; font-size: 10.5px; border: 1px solid #b45309; padding: 8px 10px; }
    .warn ul { margin: 4px 0 0 16px; }
    .note { margin-top: 14px; font-size: 10.5px; color: #555; border-top: 1px dotted #999; padding-top: 8px; }
    .sign { margin-top: 30px; display: flex; justify-content: space-between; font-size: 11px; }
  </style></head><body>
    <div class="head">
      <div><h1>${esc(doc.isd.tradeName)}</h1><div class="sub">${esc(doc.isd.address ?? '')}</div>
        <div class="sub">${doc.isd.gstin ? 'GSTIN ' + esc(doc.isd.gstin) : 'No GSTIN on record'} · Input Service Distributor</div></div>
      <div class="tag"><b>ISD invoice</b>
        <div class="sub">Document under rule 54(1)</div>
        <div class="sub">${esc(doc.number)} · ${toDisplayDate(doc.date)}</div></div>
    </div>

    <div class="parties">
      <div><h3>Distributor</h3><b>${esc(doc.isd.tradeName)}</b>
        <div class="sub">State ${esc(doc.isd.stateCode)}</div></div>
      <div><h3>Recipient of credit</h3><b>${esc(doc.recipient.tradeName)}</b>
        <div class="sub">${esc(doc.recipient.address ?? '')}</div>
        <div class="sub">${doc.recipient.gstin ? 'GSTIN ' + esc(doc.recipient.gstin) : 'No GSTIN on record'}</div></div>
      <div><h3>Ratio — ${esc(doc.ratio.period.label)}</h3>
        <span class="num">${money(doc.ratio.turnoverPaise)} / ${money(doc.ratio.totalTurnoverPaise)}</span>
        <div class="sub">${ratioPct}% of the common credit</div></div>
    </div>

    <table>
      <thead><tr><th>Supplier</th><th>GSTIN</th><th>Invoice</th><th>Eligibility</th>
        <th>Credit received</th><th>Credit distributed</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>

    <table class="totals">
      <tbody>
        <tr><td>Eligible credit distributed</td><td class="r num">${esc(heads(doc.eligible))}</td></tr>
        <tr><td>Ineligible credit distributed</td><td class="r num">${esc(heads(doc.ineligible))}</td></tr>
        <tr><td>Total</td><td class="r num">${esc(heads(doc.total))}</td></tr>
      </tbody>
    </table>

    ${warnings}

    <div class="note">
      Issued under rule 54(1) of the CGST Rules by an Input Service Distributor registered under section 24(viii),
      distributing credit under section 20 read with rule 39. The ratio is the recipient's turnover in the State
      over the aggregate turnover of all recipients for ${esc(doc.ratio.period.label)}: ${esc(doc.ratio.period.reason)}
      <br><b>This is not a tax invoice.</b> Nothing is supplied and nothing is payable against it — it distributes
      credit already paid on the supplier's invoices listed above. Credit of central and State tax distributed to a
      recipient outside the distributor's own State arrives as integrated tax.
      <br><b>It is not a book entry either.</b> Distribution moves credit between two of your own electronic credit
      ledgers; it creates no revenue and no expense, and nothing is posted.
    </div>

    <div class="sign"><span>Distribution month: ${esc(doc.month)}</span>
      <span>For <b>${esc(doc.isd.tradeName)}</b><br><br><br>Authorised signatory</span></div>
  </body></html>`

  return writeExportPdf(slug, `isd-invoice-${doc.number.replace(/[^a-zA-Z0-9]/g, '-')}.pdf`, html, {
    pageSize: 'A4',
    pageNumbers: true
  })
}
