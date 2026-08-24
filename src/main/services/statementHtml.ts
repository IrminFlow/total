/**
 * The statement of account, as a document you would post to a customer.
 *
 * Deliberately not `reportHtml`: an internal report identifies the company and the period, and a
 * statement has to identify *the party* — their name and address in a block that shows through a
 * window envelope, their GSTIN so their accounts team can find themselves, and a closing figure
 * they are meant to agree with. The visual language is the same family as the invoice and the
 * report so the three read as one business's paperwork.
 */
import type { CompanyInfo } from '@shared/domain'
import { GST_STATES } from '@shared/gst/states'
import { formatPaise } from '@shared/money'
import { toDisplayDate } from '@shared/dates'
import type { PartyStatement } from './receivables'

const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')

const money = (p: number): string => formatPaise(p, { symbol: false })

/** "Dr"/"Cr" beside a figure — a bare signed number on a statement is read wrong by half the
 *  people who receive one. */
function signed(paise: number, side: 'receivable' | 'payable'): string {
  if (paise === 0) return `${money(0)}`
  const owed = side === 'receivable' ? paise > 0 : paise < 0
  return `${money(Math.abs(paise))} ${owed ? 'Dr' : 'Cr'}`
}

export function statementHtml(
  company: CompanyInfo,
  st: PartyStatement,
  opts: { side: 'receivable' | 'payable'; contact?: string | null } = { side: 'receivable' }
): string {
  const side = opts.side
  const rows = st.lines
    .map(
      (l) => `<tr>
        <td class="c">${esc(toDisplayDate(l.date))}</td>
        <td>${esc(l.number)}</td>
        <td>${esc(l.particulars)}</td>
        <td class="r">${l.debit === null ? '' : esc(money(l.debit))}</td>
        <td class="r">${l.credit === null ? '' : esc(money(l.credit))}</td>
        <td class="r">${esc(signed(l.balance, side))}</td>
      </tr>`
    )
    .join('')

  const bandCells = st.bandLabels
    .map((label) => `<th class="r">${esc(label)}</th>`)
    .join('')
  const bandValues = st.buckets.map((v) => `<td class="r">${esc(money(v))}</td>`).join('')
  const openTotal = st.openBills.reduce((s, b) => s + b.pending, 0)

  const billRows = st.openBills
    .map(
      (b) => `<tr>
        <td class="c">${esc(toDisplayDate(b.date))}</td>
        <td>${esc(b.number)}</td>
        <td class="c">${b.dueDate ? esc(toDisplayDate(b.dueDate)) : '—'}</td>
        <td class="r">${b.overdueDays > 0 ? esc(String(b.overdueDays)) : '—'}</td>
        <td class="r">${esc(money(b.pending))}</td>
      </tr>`
    )
    .join('')

  return `<!doctype html><html><head><meta charset="utf-8"><title>Statement — ${esc(st.name)}</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font: 12px/1.45 'Helvetica Neue', Arial, sans-serif; color: #16181f; }
    .sheet { padding: 28px; }
    .head { display: flex; justify-content: space-between; border-bottom: 1.5px solid #16181f; padding-bottom: 12px; }
    h1 { font-size: 20px; letter-spacing: 0.02em; }
    .num { font-family: 'SF Mono', Menlo, monospace; font-size: 11.5px; }
    .tag { text-align: right; font-size: 11px; }
    .tag b { font-size: 15px; letter-spacing: 0.08em; text-transform: uppercase; }
    .tag .period { margin-top: 3px; color: #555; }
    .to { margin-top: 18px; display: flex; justify-content: space-between; align-items: flex-start; }
    .to .label { font-size: 10px; text-transform: uppercase; letter-spacing: 0.06em; color: #555; }
    .to .name { font-size: 14px; font-weight: 700; margin-top: 2px; }
    .closing { text-align: right; }
    .closing .figure { font-family: 'SF Mono', Menlo, monospace; font-size: 20px; font-weight: 700; }
    h2 { font-size: 11px; text-transform: uppercase; letter-spacing: 0.06em; margin: 18px 0 0; color: #555; }
    table { width: 100%; border-collapse: collapse; margin-top: 8px; }
    th { font-size: 10px; text-transform: uppercase; letter-spacing: 0.06em; border-bottom: 1.5px solid #16181f; padding: 7px 8px; text-align: left; background: #f2f2ee; }
    td { padding: 6px 8px; border-bottom: 1px dotted #999; vertical-align: top; }
    td.r, td.c, th.r { font-family: 'SF Mono', Menlo, monospace; font-size: 11.5px; }
    th.r { text-align: right; }
    .r { text-align: right; } .c { text-align: center; }
    thead { display: table-header-group; }
    tr { page-break-inside: avoid; }
    tr.bold td { font-weight: 700; border-top: 1px solid #16181f; border-bottom: 3px double #16181f; }
    .note { margin-top: 16px; font-size: 11px; color: #555; }
    .provenance { margin-top: 10px; padding-top: 4px; border-top: 1px dotted #999; font-size: 9.5px; color: #555; }
  </style></head><body>
    <div class="sheet">
      <div class="head">
        <div>
          <h1>${esc(company.name)}</h1>
          <div>${esc(company.address)}</div>
          <div class="num">GSTIN: ${esc(company.gstin ?? 'Unregistered')} · ${esc(GST_STATES[company.stateCode] ?? company.stateCode)}</div>
        </div>
        <div class="tag">
          <b>Statement of account</b>
          <div class="period">${esc(toDisplayDate(st.from))} to ${esc(toDisplayDate(st.to))}</div>
        </div>
      </div>

      <div class="to">
        <div>
          <div class="label">Statement for</div>
          <div class="name">${esc(st.name)}</div>
          ${st.address ? `<div>${esc(st.address)}</div>` : ''}
          ${st.gstin ? `<div class="num">GSTIN: ${esc(st.gstin)}</div>` : ''}
        </div>
        <div class="closing">
          <div class="label">${side === 'receivable' ? 'Amount receivable' : 'Amount payable'}</div>
          <div class="figure">${esc(signed(st.closingBalance, side))}</div>
        </div>
      </div>

      <h2>Transactions</h2>
      <table>
        <thead><tr>
          <th class="c" style="width:80px">Date</th>
          <th style="width:110px">Number</th>
          <th>Particulars</th>
          <th class="r" style="width:100px">Debit</th>
          <th class="r" style="width:100px">Credit</th>
          <th class="r" style="width:120px">Balance</th>
        </tr></thead>
        <tbody>
          <tr><td class="c">${esc(toDisplayDate(st.from))}</td><td></td><td>Opening balance</td><td class="r"></td><td class="r"></td><td class="r">${esc(signed(st.openingBalance, side))}</td></tr>
          ${rows}
          <tr class="bold"><td class="c">${esc(toDisplayDate(st.to))}</td><td></td><td>Closing balance</td><td class="r"></td><td class="r"></td><td class="r">${esc(signed(st.closingBalance, side))}</td></tr>
        </tbody>
      </table>

      ${
        st.openBills.length > 0
          ? `<h2>Open bills</h2>
      <table>
        <thead><tr>
          <th class="c" style="width:80px">Date</th>
          <th style="width:110px">Bill</th>
          <th class="c" style="width:80px">Due</th>
          <th class="r" style="width:90px">Overdue</th>
          <th class="r" style="width:120px">Pending</th>
        </tr></thead>
        <tbody>${billRows}
          <tr class="bold"><td colspan="4">Total open</td><td class="r">${esc(money(openTotal))}</td></tr>
        </tbody>
      </table>

      <h2>Ageing</h2>
      <table>
        <thead><tr>${bandCells}</tr></thead>
        <tbody><tr>${bandValues}</tr></tbody>
      </table>`
          : ''
      }

      ${
        st.interest && st.interest.total > 0 && st.termsLabel
          ? `<div class="note">Interest on overdue bills at ${esc(st.termsLabel)}: <b>${esc(money(st.interest.total))}</b>. Shown for information; not included in the balance above.</div>`
          : ''
      }
      <div class="note">Please verify this statement against your records and advise us of any difference within seven days.${
        opts.contact ? ` Queries: ${esc(opts.contact)}` : ''
      }</div>
      <div class="provenance">Statement of account · ${esc(st.name)} · ${esc(toDisplayDate(st.from))} to ${esc(
        toDisplayDate(st.to)
      )} · ${esc(company.name)}${company.gstin ? ' · GSTIN ' + esc(company.gstin) : ''}</div>
    </div>
  </body></html>`
}
