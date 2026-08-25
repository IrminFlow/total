/**
 * The branch-transfer invoice, as paper (roadmap #108).
 *
 * Its own module, and not because branchTransfer.ts was long. Rendering a PDF needs Electron's
 * BrowserWindow, and `branchTransfer.ts` is reachable from `gst.ts` — which the MCP server
 * bundles and runs under ELECTRON_RUN_AS_NODE, where there is no BrowserWindow to have. Keeping
 * the renderer out of that import graph is what lets the returns read these documents in a
 * headless process. `src/main/mcp/bundle.test.ts` is what notices when it stops being true.
 */

import type { DB } from '../db/connection'
import { toDisplayDate } from '@shared/dates'
import { formatPaise, plainMilli } from '@shared/money'
import { getBranchTransferInvoice } from './branchTransfer'
import { writeExportPdf } from './pdf'

// ---------- paper ----------

const esc = (s: string | null): string => (s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/**
 * The document, as paper.
 *
 * Headed "Tax invoice — branch transfer (Schedule I para 2)" rather than "Invoice", because that is
 * what it is: the person filing it six months from now needs to know at a glance that no money was
 * ever going to arrive against it. Both GSTINs sit on the face, rule 46(b) and 46(e); the rule 28
 * basis is printed with its citation; and the note saying the tax is not in the books rides at the
 * bottom, because the one thing a user must not conclude from a printed tax invoice is that the
 * accounting has been done.
 */
export async function branchTransferPdf(db: DB, slug: string, id: number): Promise<string> {
  const doc = getBranchTransferInvoice(db, id)
  const money = (p: number): string => formatPaise(p)

  const rows = doc.lines
    .map(
      (l) =>
        `<tr><td>${esc(l.description)}</td><td class="num">${esc(l.hsn ?? '—')}</td>` +
        `<td class="r num">${plainMilli(l.qtyMilli)} ${esc(l.unit ?? '')}</td>` +
        `<td class="r num">${money(l.bookValue)}</td>` +
        `<td class="r num">${money(l.taxable)}</td><td class="r num">${l.rate}%</td>` +
        `<td class="r num">${money(l.igst + l.cgst + l.sgst + l.cess)}</td></tr>`
    )
    .join('')

  const taxRows = [
    ['IGST', doc.totals.igst],
    ['CGST', doc.totals.cgst],
    ['SGST', doc.totals.sgst],
    ['Cess', doc.totals.cess]
  ]
    .filter(([, v]) => (v as number) !== 0)
    .map(([label, v]) => `<tr><td>${label}</td><td class="r num">${money(v as number)}</td></tr>`)
    .join('')

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
    td { padding: 5px 0; border-bottom: 1px dotted #bbb; }
    .r { text-align: right; }
    .totals { width: 44%; margin-left: auto; }
    .totals tr:last-child td { font-weight: 600; border-top: 1px solid #16181f; }
    .warn { margin-top: 16px; font-size: 10.5px; border: 1px solid #b45309; padding: 8px 10px; }
    .warn ul { margin: 4px 0 0 16px; }
    .note { margin-top: 14px; font-size: 10.5px; color: #555; border-top: 1px dotted #999; padding-top: 8px; }
    .sign { margin-top: 30px; display: flex; justify-content: space-between; font-size: 11px; }
  </style></head><body>
    <div class="head">
      <div><h1>${esc(doc.from.tradeName)}</h1><div class="sub">${esc(doc.from.address ?? '')}</div>
        <div class="sub">${doc.from.gstin ? 'GSTIN ' + esc(doc.from.gstin) : 'No GSTIN on record'}</div></div>
      <div class="tag"><b>Branch transfer</b>
        <div class="sub">Tax invoice — Schedule I para 2, section 25(4)</div>
        <div class="sub">${esc(doc.number)} · ${toDisplayDate(doc.date)}</div></div>
    </div>

    <div class="parties">
      <div><h3>Supplier (sending registration)</h3><b>${esc(doc.from.tradeName)}</b>
        <div class="sub">State ${esc(doc.from.stateCode)}</div>
        <div class="sub">${doc.from.gstin ? 'GSTIN ' + esc(doc.from.gstin) : 'Unregistered'}</div></div>
      <div><h3>Recipient (receiving registration)</h3><b>${esc(doc.to.tradeName)}</b>
        <div class="sub">${esc(doc.to.address ?? '')}</div>
        <div class="sub">${doc.to.gstin ? 'GSTIN ' + esc(doc.to.gstin) : 'No GSTIN on record'}</div></div>
      <div><h3>Place of supply</h3><span class="num">${esc(doc.placeOfSupply)}</span>
        <div class="sub">${doc.supplyType === 'intra' ? 'Intra-state' : 'Inter-state'}</div></div>
    </div>

    <table>
      <thead><tr><th>Description</th><th>HSN</th><th class="r">Qty</th><th class="r">Book value</th>
        <th class="r">Taxable (rule 28)</th><th class="r">Rate</th><th class="r">Tax</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>

    <table class="totals">
      <tbody>
        <tr><td>Taxable value</td><td class="r num">${money(doc.totals.taxable)}</td></tr>
        ${taxRows}
        <tr><td>Total</td><td class="r num">${money(doc.totals.total)}</td></tr>
      </tbody>
    </table>

    ${warnings}

    <div class="note">
      <b>Valuation.</b> ${esc(doc.basisCitation)}<br>
      <b>Why this invoice exists.</b> Schedule I para 2 of the CGST Act makes a supply between distinct persons
      under section 25 a supply even when made without consideration. Two registrations of one PAN are distinct
      persons, so this movement is a taxable supply and needs a tax invoice; rule 55's delivery challan does not
      cover it. Place of supply is where the movement terminates — section 10(1)(a) of the IGST Act.<br>
      <b>This is not a book entry.</b> The transfer moved stock between two of your own registrations: it creates
      output tax in ${esc(doc.from.gstin ?? doc.from.stateCode)}'s return and input credit in
      ${esc(doc.to.gstin ?? doc.to.stateCode)}'s, but no revenue, no expense and no change in stock value —
      so nothing is posted and the trial balance is unchanged.
    </div>

    <div class="sign"><span>Movement: ${esc(doc.from.stateCode)} → ${esc(doc.to.stateCode)}</span>
      <span>For <b>${esc(doc.from.tradeName)}</b><br><br><br>Authorised signatory</span></div>
  </body></html>`

  return writeExportPdf(slug, `branch-transfer-${doc.number.replace(/[^a-zA-Z0-9]/g, '-')}.pdf`, html, {
    pageSize: 'A4',
    pageNumbers: true
  })
}
