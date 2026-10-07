/**
 * "Data for Form 16" — one certificate-shaped page per employee for a financial year, rendered to
 * PDF through the same print path as Form 16A (main: printFonts + pdf.writeExportPdf). Form 16 is
 * the certificate u/s 203 of the Income-tax Act 1961 for salary TDS (Income-tax Rules 1962 rule
 * 31(1)(a)); from FY 2026-27 it is Form No. 130 under rule 215(1) Sl.1 of the Income-tax Rules
 * 2026, certificate u/s 395 of the Income-tax Act 2025, issued by 15 June [R26]. Part A (the TDS
 * summary) comes from TRACES, so the page is headed as data only.
 *
 * Row order: Form 16 Part B (1962 Rules — the row list is UNVERIFIED, read from secondary
 * summaries) for the 1961 Act; Form 130 Part C (Annexure-I) rows 1–21 (VERIFIED in the Rules
 * 2026 gazette, https://egazette.gov.in/WriteReadData/2026/271092.pdf, accessed 2026-10-07) for
 * the 2025 Act. Pure: no I/O.
 */
import type { Form16Data, Form16Employee } from '../payrollStatutoryTypes'
import { formatPaise } from '../money'
import { toDisplayDate } from '../dates'
import type { PlexFamily } from './render'

const esc = (s: string | null | undefined): string =>
  (s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
const money = (p: number): string => formatPaise(p)

interface Row {
  no: string
  label: string
  amount: number | null
  bold?: boolean
}

/** The Part B / Part C rows for one employee. Exported for the renderer's on-screen workings. */
export function form16Rows(e: Form16Employee, act: '1961' | '2025'): Row[] {
  const w = e.workings
  const t = w.taxOnIncome
  const r = e.refs
  const exempt = w.hraExemption
  const deductions = w.deductions
  if (act === '2025') {
    return [
      { no: 'A', label: 'Whether opting out of taxation under section 202(1)?', amount: null },
      { no: '1(a)', label: 'Salary as per section 16 (current employer)', amount: w.gross - w.previousEmployerSalary },
      { no: '1(e)', label: 'Salary from other employer(s) (Form 122)', amount: w.previousEmployerSalary },
      { no: '1(d)', label: 'Total', amount: w.gross, bold: true },
      { no: '2(b)', label: `House rent allowance — ${r.hra}`, amount: exempt },
      { no: '2(f)', label: 'Total exemption claimed under section 11', amount: exempt },
      { no: '3', label: 'Total amount of salary received from current employer [1(d) − 1(e) − 2(f)]', amount: w.gross - w.previousEmployerSalary - exempt },
      { no: '4(a)', label: `Tax on employment — ${r.professionalTax}`, amount: w.professionalTax },
      { no: '4(b)', label: `Standard deduction — ${r.standardDeduction}`, amount: w.standardDeduction },
      { no: '5', label: 'Total amount of deductions under section 19', amount: w.professionalTax + w.standardDeduction },
      { no: '6', label: 'Income chargeable under the head "Salaries" [(3 + 1(e)) − 5]', amount: w.incomeFromSalary, bold: true },
      { no: '7', label: 'Income under the head "Income from house property" reported by the employee (loss)', amount: w.housePropertyLoss ? -w.housePropertyLoss : 0 },
      { no: '8', label: 'Income under other heads reported by the employee (section 392(4))', amount: w.otherIncome },
      { no: '9', label: 'Gross total income (6 + 7 + 8)', amount: w.grossTotalIncome, bold: true },
      ...deductions.map((d, i) => ({ no: `10(${String.fromCharCode(97 + i)})`, label: `Deduction — ${d.section}: ${d.label}`, amount: d.amount })),
      { no: '11', label: 'Aggregate of deductible amount under Chapter VIII', amount: w.deductionsTotal },
      { no: '12', label: 'Total taxable income (9 − 11)', amount: w.totalIncome, bold: true },
      { no: '13', label: 'Tax on total income', amount: t.taxBeforeRebate },
      { no: '14', label: `Rebate — ${r.rebate}`, amount: t.rebate },
      { no: '15', label: 'Surcharge, wherever applicable', amount: t.surcharge },
      { no: '16', label: 'Health and education cess', amount: t.cess },
      { no: '17', label: 'Tax payable (13 − 14 + 15 + 16), rounded', amount: t.total, bold: true },
      { no: '18', label: 'Less: relief under section 157', amount: 0 },
      { no: '19', label: 'TDS by other employer(s) reported in Form 122', amount: w.previousEmployerTds },
      { no: '21', label: 'Net tax payable (17 − 18 − 19)', amount: w.taxPayableByEmployer, bold: true }
    ]
  }
  return [
    { no: '', label: 'Whether opting out of taxation u/s 115BAC?', amount: null },
    { no: '1(a)', label: 'Salary as per provisions contained in section 17(1)', amount: w.gross - w.previousEmployerSalary },
    { no: '1(e)', label: 'Reported total amount of salary received from other employer(s)', amount: w.previousEmployerSalary },
    { no: '1(d)', label: 'Total', amount: w.gross, bold: true },
    { no: '2(e)', label: `House rent allowance — ${r.hra}`, amount: exempt },
    { no: '2(h)', label: 'Total amount of exemption claimed under section 10', amount: exempt },
    { no: '3', label: 'Total amount of salary received from current employer [1(d) − 2(h)]', amount: w.gross - exempt },
    { no: '4(a)', label: `Standard deduction — ${r.standardDeduction}`, amount: w.standardDeduction },
    { no: '4(c)', label: `Tax on employment — ${r.professionalTax}`, amount: w.professionalTax },
    { no: '5', label: 'Total amount of deductions under section 16', amount: w.professionalTax + w.standardDeduction },
    { no: '6', label: 'Income chargeable under the head "Salaries" [(3 + 1(e)) − 5]', amount: w.incomeFromSalary, bold: true },
    { no: '7(a)', label: 'Income (or admissible loss) from house property reported by the employee', amount: w.housePropertyLoss ? -w.housePropertyLoss : 0 },
    { no: '7(b)', label: 'Income under the head Other Sources offered for TDS', amount: w.otherIncome },
    { no: '9', label: 'Gross total income (6 + 8)', amount: w.grossTotalIncome, bold: true },
    ...deductions.map((d, i) => ({ no: `10(${String.fromCharCode(97 + i)})`, label: `Deduction — ${d.section}: ${d.label}`, amount: d.amount })),
    { no: '11', label: 'Aggregate of deductible amount under Chapter VI-A', amount: w.deductionsTotal },
    { no: '12', label: 'Total taxable income (9 − 11)', amount: w.totalIncome, bold: true },
    { no: '13', label: 'Tax on total income', amount: t.taxBeforeRebate },
    { no: '14', label: `Rebate under section 87A, if applicable`, amount: t.rebate },
    { no: '15', label: 'Surcharge, wherever applicable', amount: t.surcharge },
    { no: '16', label: 'Health and education cess', amount: t.cess },
    { no: '17', label: 'Tax payable (13 + 15 + 16 − 14), rounded', amount: t.total, bold: true },
    { no: '18', label: 'Less: relief under section 89', amount: 0 },
    { no: '', label: 'Less: tax deducted by previous employer(s) (Form 12B)', amount: w.previousEmployerTds },
    { no: '19', label: 'Net tax payable (17 − 18)', amount: w.taxPayableByEmployer, bold: true }
  ]
}

function employeePage(d: Form16Data, e: Form16Employee): string {
  const regimeAnswer = e.regime === 'old' ? 'Yes (old regime)' : 'No (new / default regime)'
  const rows = form16Rows(e, d.act)
    .map((r) => {
      const amount = r.amount == null ? esc(regimeAnswer) : money(r.amount)
      return `<tr${r.bold ? ' class="tot"' : ''}><td class="n">${esc(r.no)}</td><td>${esc(r.label)}</td><td class="r">${amount}</td></tr>`
    })
    .join('')
  const quarters = e.quarters
    .map((q) => `<tr><td>Q${q.quarter}</td><td class="r">${money(q.amountPaise)}</td><td class="r">${money(q.tdsPaise)}</td><td class="r">${money(q.depositedPaise)}</td></tr>`)
    .join('')
  const challans = e.challans.length
    ? e.challans.map((c, i) => `<tr><td>${i + 1}</td><td>${esc(c.bsrCode)}</td><td>${esc(toDisplayDate(c.date))}</td><td>${esc(c.challanNo)}</td><td class="r">${money(c.tdsPaise)}</td></tr>`).join('')
    : '<tr><td colspan="5" class="muted">Not yet deposited / not allocated to a challan</td></tr>'
  const q = e.quarters.reduce((s, x) => ({ a: s.a + x.amountPaise, t: s.t + x.tdsPaise, d: s.d + x.depositedPaise }), { a: 0, t: 0, d: 0 })
  const yearWord = d.act === '2025' ? 'Tax year' : 'Assessment year'
  const certSection = d.act === '2025' ? 'section 395 of the Income-tax Act, 2025' : 'section 203 of the Income-tax Act, 1961'
  return `
<section class="page">
  <p class="tag">Data for ${esc(d.formName)} — not a certificate. Part A is generated from TRACES; the employer signs Part B (Annexure).</p>
  <h1>${esc(d.formName)} — certificate under ${esc(certSection)} for tax deducted at source on salary</h1>
  <table class="grid">
    <tr><th>Name and address of the employer</th><th>Name and designation of the employee</th></tr>
    <tr><td><b>${esc(d.deductor.name)}</b><br>${esc(d.deductor.address)}</td><td><b>${esc(e.name)}</b><br>${esc(e.designation)}</td></tr>
  </table>
  <table class="grid">
    <tr><th>PAN of the deductor</th><th>TAN of the deductor</th><th>PAN of the employee</th><th>${yearWord}</th><th>Period with the employer</th></tr>
    <tr><td>${esc(d.deductor.pan ?? '—')}</td><td>${esc(d.deductor.tan ?? '—')}</td><td>${esc(e.pan ?? 'PANNOTAVBL')}</td><td>${esc(d.yearLabel)}</td>
      <td>${esc(toDisplayDate(e.periodFrom))} to ${esc(toDisplayDate(e.periodTo))}</td></tr>
  </table>
  <h2>Summary of amount paid / credited and tax deducted (Part A)</h2>
  <table class="grid">
    <tr><th>Quarter</th><th class="r">Amount paid / credited</th><th class="r">Tax deducted</th><th class="r">Tax deposited (allocated to a challan)</th></tr>
    ${quarters}
    <tr class="tot"><td>Total</td><td class="r">${money(q.a)}</td><td class="r">${money(q.t)}</td><td class="r">${money(q.d)}</td></tr>
  </table>
  <table class="grid">
    <tr><th>#</th><th>BSR code</th><th>Date deposited</th><th>Challan serial</th><th class="r">Tax deposited for the employee</th></tr>
    ${challans}
  </table>
  <h2>Details of salary paid and any other income and tax deducted (${d.act === '2025' ? 'Part C — Annexure-I' : 'Part B — Annexure'})</h2>
  <table class="grid">
    <tr><th class="n">#</th><th>Particulars</th><th class="r">Rs</th></tr>
    ${rows}
  </table>
</section>`
}

export function renderForm16Html(d: Form16Data, fontFaceCss?: (f: PlexFamily) => string): string {
  const fonts = fontFaceCss ? `${fontFaceCss('plex-sans')}\n${fontFaceCss('plex-mono')}` : ''
  const body = d.employees.length
    ? d.employees.map((e) => employeePage(d, e)).join('\n')
    : '<section class="page"><p>No salary paid in this year.</p></section>'
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(d.formName)} data</title><style>
${fonts}
body { font-family: 'IBM Plex Sans', Helvetica, Arial, sans-serif; font-size: 10.5px; color: #111; margin: 0; }
.page { page-break-after: always; padding: 4px 0; }
.page:last-child { page-break-after: auto; }
h1 { font-size: 13.5px; margin: 6px 0 10px; }
h2 { font-size: 11.5px; margin: 14px 0 6px; }
.tag { font-size: 9.5px; color: #8a5a00; border: 1px solid #d9b25c; background: #fff7e0; padding: 4px 6px; margin: 0 0 8px; }
table.grid { width: 100%; border-collapse: collapse; margin-bottom: 8px; }
.grid th, .grid td { border: 1px solid #999; padding: 3px 5px; text-align: left; vertical-align: top; }
.grid th { background: #f1efe9; font-weight: 600; font-size: 9.5px; }
.n { width: 38px; white-space: nowrap; }
.r { text-align: right !important; font-family: 'IBM Plex Mono', monospace; white-space: nowrap; }
.tot td { font-weight: 600; }
.muted { color: #666; }
</style></head><body>${body}</body></html>`
}
