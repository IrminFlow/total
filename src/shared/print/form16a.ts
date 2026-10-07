/**
 * "Data for Form 16A" — a plain certificate-shaped page per deductee for one quarter, rendered to
 * PDF through the print path of WP 1.10c (main: printFonts + pdf.writeExportPdf). Form 16A is the
 * certificate u/s 203 for tax deducted other than on salary (Income-tax Rules 1962 rule 31(1)(b));
 * TRACES issues the actual certificate, so the page is headed as data only. Fields follow the
 * form: deductor and deductee name / address / PAN, deductor TAN, assessment year, period,
 * summary of payments (amount, nature, section, date), tax deducted, and the challans the tax was
 * deposited through (BSR code, date, serial). Pure: no I/O.
 */
import type { Form16aData, Form16aParty } from '../tdsTypes'
import { formatPaise } from '../money'
import { toDisplayDate } from '../dates'
import type { PlexFamily } from './render'

const esc = (s: string | null | undefined): string =>
  (s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
const money = (p: number): string => formatPaise(p)

/** Words that differ between Form 16A (TDS, rule 31(1)(b)) and Form 27D (TCS, rule 37D; Form 133
 *  under the Income-tax Rules 2026 rule 215 — migration 027). */
const WORDS = {
  tds: {
    form: 'Form No. 16A', title: 'Certificate under section 203 of the Income-tax Act for tax deducted at source',
    issuer: 'deductor', party: 'deductee', date: 'Date of payment / credit', nature: 'Nature of payment',
    amount: 'Amount paid / credited', tax: 'Tax deducted', summary: 'Summary of payment', none: 'No deductions in this quarter.'
  },
  tcs: {
    form: 'Form No. 27D', title: 'Certificate under section 206C of the Income-tax Act for tax collected at source',
    issuer: 'collector', party: 'collectee', date: 'Date of debit / receipt', nature: 'Nature of goods',
    amount: 'Amount debited / received', tax: 'Tax collected', summary: 'Summary of receipts / debits', none: 'No collections in this quarter.'
  }
} as const
type Words = (typeof WORDS)[keyof typeof WORDS]

function partyPage(d: Form16aData, p: Form16aParty, w: Words): string {
  const payments = p.payments
    .map(
      (x, i) =>
        `<tr><td>${i + 1}</td><td>${esc(toDisplayDate(x.date))}</td><td>${esc(x.voucherNumber)}</td><td>${esc(x.sectionCode)}</td><td>${esc(x.nature)}</td><td class="r">${money(x.amountPaise)}</td><td class="r">${money(x.tdsPaise)}</td></tr>`
    )
    .join('')
  const challans = p.challans.length
    ? p.challans
        .map((c, i) => `<tr><td>${i + 1}</td><td>${esc(c.bsrCode)}</td><td>${esc(toDisplayDate(c.date))}</td><td>${esc(c.challanNo)}</td><td class="r">${money(c.tdsPaise)}</td></tr>`)
        .join('')
    : '<tr><td colspan="5" class="muted">Not yet deposited / not allocated to a challan</td></tr>'
  return `
<section class="page">
  <p class="tag">Data for ${w.form} — not a certificate. The certificate is generated from TRACES.</p>
  <h1>${w.title}</h1>
  <table class="grid">
    <tr><th>Name and address of the ${w.issuer}</th><th>Name and address of the ${w.party}</th></tr>
    <tr><td><b>${esc(d.deductor.name)}</b><br>${esc(d.deductor.address)}</td><td><b>${esc(p.partyName)}</b><br>${esc(p.address)}</td></tr>
  </table>
  <table class="grid">
    <tr><th>PAN of the ${w.issuer}</th><th>TAN of the ${w.issuer}</th><th>PAN of the ${w.party}</th><th>Assessment year</th><th>Period</th></tr>
    <tr><td>${esc(d.deductor.pan ?? '—')}</td><td>${esc(d.deductor.tan ?? '—')}</td><td>${esc(p.pan ?? 'PANNOTAVBL')}</td><td>${esc(d.assessmentYear)}</td>
      <td>${esc(toDisplayDate(d.period.from))} to ${esc(toDisplayDate(d.period.to))} (Q${d.quarter})</td></tr>
  </table>
  <h2>${w.summary}</h2>
  <table class="grid">
    <tr><th>#</th><th>${w.date}</th><th>Voucher</th><th>Section</th><th>${w.nature}</th><th class="r">${w.amount}</th><th class="r">${w.tax}</th></tr>
    ${payments}
    <tr class="tot"><td colspan="5">Total</td><td class="r">${money(p.totals.amountPaise)}</td><td class="r">${money(p.totals.tdsPaise)}</td></tr>
  </table>
  <h2>Details of tax deposited to the credit of the Central Government through challan</h2>
  <table class="grid">
    <tr><th>#</th><th>BSR code of the bank branch</th><th>Date on which tax deposited</th><th>Challan serial number</th><th class="r">Tax deposited in respect of the ${w.party}</th></tr>
    ${challans}
    <tr class="tot"><td colspan="4">Total</td><td class="r">${money(p.totals.depositedPaise)}</td></tr>
  </table>
</section>`
}

export function renderForm16aHtml(d: Form16aData, fontFaceCss?: (f: PlexFamily) => string, kind: 'tds' | 'tcs' = 'tds'): string {
  const w = WORDS[kind]
  const fonts = fontFaceCss ? `${fontFaceCss('plex-sans')}\n${fontFaceCss('plex-mono')}` : ''
  const body = d.parties.length
    ? d.parties.map((p) => partyPage(d, p, w)).join('\n')
    : `<section class="page"><p>${w.none}</p></section>`
  return `<!doctype html><html><head><meta charset="utf-8"><title>${kind === 'tcs' ? 'Form 27D' : 'Form 16A'} data</title><style>
${fonts}
body { font-family: 'IBM Plex Sans', Helvetica, Arial, sans-serif; font-size: 10.5px; color: #111; margin: 0; }
.page { page-break-after: always; padding: 4px 0; }
.page:last-child { page-break-after: auto; }
h1 { font-size: 14px; margin: 6px 0 10px; }
h2 { font-size: 11.5px; margin: 14px 0 6px; }
.tag { font-size: 9.5px; color: #8a5a00; border: 1px solid #d9b25c; background: #fff7e0; padding: 4px 6px; margin: 0 0 8px; }
table.grid { width: 100%; border-collapse: collapse; margin-bottom: 8px; }
.grid th, .grid td { border: 1px solid #999; padding: 4px 5px; text-align: left; vertical-align: top; }
.grid th { background: #f1efe9; font-weight: 600; font-size: 9.5px; }
.r { text-align: right !important; font-family: 'IBM Plex Mono', monospace; }
.tot td { font-weight: 600; }
.muted { color: #666; }
</style></head><body>${body}</body></html>`
}
