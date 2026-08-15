import { BrowserWindow } from 'electron'
import { writeFileSync } from 'fs'
import { join } from 'path'
import type { DB } from '../db/connection'
import type { CompanyInfo, Employee, PayrollLine, PayrollRun } from '@shared/domain'
import type { EmployeeInput } from '@shared/schemas'
import { computeMonthlyPay, daysInMonth } from '@shared/payroll'
import { amountInWords, formatPaise } from '@shared/money'
import { saveVoucher } from './vouchers'
import { companyExportsDir } from '../paths'

// ---------- employees ----------

interface EmployeeRow {
  id: number; name: string; code: string | null; designation: string | null; joined: string | null
  pan: string | null; uan: string | null; esic_no: string | null
  basic: number; hra: number; special: number
  pf_enabled: number; esi_enabled: number; pt_enabled: number; active: number
}

const mapEmployee = (r: EmployeeRow): Employee => ({
  id: r.id, name: r.name, code: r.code, designation: r.designation, joined: r.joined,
  pan: r.pan, uan: r.uan, esicNo: r.esic_no,
  basic: r.basic, hra: r.hra, special: r.special,
  pfEnabled: !!r.pf_enabled, esiEnabled: !!r.esi_enabled, ptEnabled: !!r.pt_enabled, active: !!r.active
})

export function listEmployees(db: DB): Employee[] {
  return (db.prepare('SELECT * FROM employees ORDER BY name').all() as EmployeeRow[]).map(mapEmployee)
}

export function saveEmployee(db: DB, input: EmployeeInput, id?: number): Employee {
  if (id) {
    db.prepare(
      `UPDATE employees SET name = ?, code = ?, designation = ?, joined = ?, pan = ?, uan = ?, esic_no = ?,
       basic = ?, hra = ?, special = ?, pf_enabled = ?, esi_enabled = ?, pt_enabled = ?, active = ? WHERE id = ?`
    ).run(input.name, input.code, input.designation, input.joined, input.pan, input.uan, input.esicNo,
      input.basic, input.hra, input.special, +input.pfEnabled, +input.esiEnabled, +input.ptEnabled, +input.active, id)
  } else {
    const res = db.prepare(
      `INSERT INTO employees (name, code, designation, joined, pan, uan, esic_no, basic, hra, special,
        pf_enabled, esi_enabled, pt_enabled, active) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(input.name, input.code, input.designation, input.joined, input.pan, input.uan, input.esicNo,
      input.basic, input.hra, input.special, +input.pfEnabled, +input.esiEnabled, +input.ptEnabled, +input.active)
    id = Number(res.lastInsertRowid)
  }
  return mapEmployee(db.prepare('SELECT * FROM employees WHERE id = ?').get(id) as EmployeeRow)
}

export function deleteEmployee(db: DB, id: number): void {
  const used = db.prepare('SELECT COUNT(*) AS n FROM payroll_lines WHERE employee_id = ?').get(id) as { n: number }
  if (used.n > 0) throw new Error('Employee has payroll history; mark them inactive instead')
  db.prepare('DELETE FROM employees WHERE id = ?').run(id)
}

// ---------- pay runs ----------

export interface RunPreviewLine extends Omit<PayrollLine, 'id'> {}

export function previewRun(db: DB, month: string, days: { employeeId: number; payableDays: number }[]): RunPreviewLine[] {
  const monthDays = daysInMonth(month)
  const byId = new Map(days.map((d) => [d.employeeId, d.payableDays]))
  return listEmployees(db)
    .filter((e) => e.active)
    .map((e) => {
      const payableDays = byId.get(e.id) ?? monthDays
      const pay = computeMonthlyPay(e, payableDays, monthDays)
      return { employeeId: e.id, employeeName: e.name, payableDays, monthDays, ...pay }
    })
}

function findOrCreateLedger(db: DB, name: string, groupName: string): number {
  const existing = db.prepare('SELECT id FROM ledgers WHERE name = ? COLLATE NOCASE').get(name) as { id: number } | undefined
  if (existing) return existing.id
  const group = db.prepare('SELECT id FROM groups WHERE name = ?').get(groupName) as { id: number } | undefined
  if (!group) throw new Error(`Group ${groupName} missing`)
  const res = db.prepare('INSERT INTO ledgers (name, group_id, is_system) VALUES (?, ?, 0)').run(name, group.id)
  return Number(res.lastInsertRowid)
}

/** Post the month's payroll: stores the run + lines and books one balanced Journal voucher. */
export function commitRun(db: DB, month: string, days: { employeeId: number; payableDays: number }[]): PayrollRun {
  const existing = db.prepare('SELECT id FROM payroll_runs WHERE month = ?').get(month) as { id: number } | undefined
  if (existing) throw new Error(`Payroll for ${month} is already posted`)
  const lines = previewRun(db, month, days)
  if (lines.length === 0) throw new Error('No active employees')

  const sum = (f: (l: RunPreviewLine) => number): number => lines.reduce((s, l) => s + f(l), 0)
  const gross = sum((l) => l.gross)
  const pfEmp = sum((l) => l.pfEmp)
  const pfEr = sum((l) => l.pfEr)
  const esiEmp = sum((l) => l.esiEmp)
  const esiEr = sum((l) => l.esiEr)
  const pt = sum((l) => l.pt)
  const net = sum((l) => l.net)

  const journal = db.prepare("SELECT id FROM voucher_types WHERE kind = 'journal' AND is_system = 1").get() as { id: number }

  const voucherLines: { ledgerId: number; drCr: 'dr' | 'cr'; amount: number }[] = []
  const push = (name: string, group: string, drCr: 'dr' | 'cr', amount: number): void => {
    if (amount > 0) voucherLines.push({ ledgerId: findOrCreateLedger(db, name, group), drCr, amount })
  }
  push('Salaries', 'Indirect Expenses', 'dr', gross)
  push('Employer PF Contribution', 'Indirect Expenses', 'dr', pfEr)
  push('Employer ESI Contribution', 'Indirect Expenses', 'dr', esiEr)
  push('PF Payable', 'Provisions', 'cr', pfEmp + pfEr)
  push('ESI Payable', 'Provisions', 'cr', esiEmp + esiEr)
  push('Professional Tax Payable', 'Duties & Taxes', 'cr', pt)
  push('Salaries Payable', 'Provisions', 'cr', net)

  const lastDay = `${month}-${String(daysInMonth(month)).padStart(2, '0')}`
  const voucher = saveVoucher(db, {
    voucherTypeId: journal.id,
    date: lastDay,
    partyLedgerId: null,
    narration: `Salary for ${month} — ${lines.length} employee${lines.length > 1 ? 's' : ''}`,
    reference: null,
    instrumentNo: null,
    instrumentDate: null,
    transporterId: null,
    vehicleNo: null,
    transportDistanceKm: null,
    currencyCode: null,
    exchangeRate: null,
    lines: voucherLines,
    inventory: []
  })

  const run = db.transaction((): number => {
    const res = db.prepare('INSERT INTO payroll_runs (month, voucher_id) VALUES (?, ?)').run(month, voucher.id)
    const runId = Number(res.lastInsertRowid)
    const insert = db.prepare(
      `INSERT INTO payroll_lines (run_id, employee_id, payable_days, month_days, basic, hra, special, gross,
        pf_emp, pf_er, esi_emp, esi_er, pt, net) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    for (const l of lines) {
      insert.run(runId, l.employeeId, l.payableDays, l.monthDays, l.basic, l.hra, l.special, l.gross,
        l.pfEmp, l.pfEr, l.esiEmp, l.esiEr, l.pt, l.net)
    }
    return runId
  })
  const runId = run()
  return getRun(db, runId)!
}

interface RunRow { id: number; month: string; voucher_id: number | null; created_at: string }
interface LineRow {
  id: number; employee_id: number; employeeName: string; payable_days: number; month_days: number
  basic: number; hra: number; special: number; gross: number
  pf_emp: number; pf_er: number; esi_emp: number; esi_er: number; pt: number; net: number
}

export function getRun(db: DB, id: number): PayrollRun | null {
  const r = db.prepare('SELECT * FROM payroll_runs WHERE id = ?').get(id) as RunRow | undefined
  if (!r) return null
  const lines = db
    .prepare(
      `SELECT pl.*, e.name AS employeeName FROM payroll_lines pl
       JOIN employees e ON e.id = pl.employee_id WHERE pl.run_id = ? ORDER BY e.name`
    )
    .all(id) as LineRow[]
  return {
    id: r.id,
    month: r.month,
    voucherId: r.voucher_id,
    createdAt: r.created_at,
    lines: lines.map((l) => ({
      id: l.id, employeeId: l.employee_id, employeeName: l.employeeName,
      payableDays: l.payable_days, monthDays: l.month_days,
      basic: l.basic, hra: l.hra, special: l.special, gross: l.gross,
      pfEmp: l.pf_emp, pfEr: l.pf_er, esiEmp: l.esi_emp, esiEr: l.esi_er, pt: l.pt, net: l.net
    }))
  }
}

export function listRuns(db: DB): PayrollRun[] {
  const rows = db.prepare('SELECT id FROM payroll_runs ORDER BY month DESC').all() as { id: number }[]
  return rows.map((r) => getRun(db, r.id)!).filter(Boolean)
}

export function deleteRun(db: DB, id: number): void {
  const run = getRun(db, id)
  if (!run) throw new Error('Pay run not found')
  const del = db.transaction(() => {
    db.prepare('DELETE FROM payroll_runs WHERE id = ?').run(id)
    if (run.voucherId) db.prepare('DELETE FROM vouchers WHERE id = ?').run(run.voucherId)
  })
  del()
}

// ---------- payslip PDF ----------

const esc = (s: string | null): string => (s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

export async function payslipPdf(db: DB, company: CompanyInfo, slug: string, runId: number, employeeId: number): Promise<string> {
  const run = getRun(db, runId)
  if (!run) throw new Error('Pay run not found')
  const line = run.lines.find((l) => l.employeeId === employeeId)
  if (!line) throw new Error('Employee not in this run')
  const emp = listEmployees(db).find((e) => e.id === employeeId)

  const money = (p: number): string => formatPaise(p)
  const row = (label: string, amount: number): string =>
    amount > 0 ? `<tr><td>${label}</td><td class="r num">${money(amount)}</td></tr>` : ''

  const html = `<!doctype html><html><head><meta charset="utf-8"><style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font: 12px/1.5 'Helvetica Neue', Arial, sans-serif; color: #16181f; padding: 32px; }
    .num { font-variant-numeric: tabular-nums; font-family: Menlo, monospace; font-size: 11.5px; }
    .sheet { border: 1.5px solid #16181f; padding: 0; }
    .head { border-bottom: 1.5px solid #16181f; padding: 14px 18px; display: flex; justify-content: space-between; }
    h1 { font-size: 18px; } .sub { color: #555; font-size: 11px; }
    .meta { padding: 10px 18px; border-bottom: 1px solid #16181f; display: flex; gap: 40px; }
    .cols { display: flex; }
    .cols > div { flex: 1; padding: 12px 18px; }
    .cols > div + div { border-left: 1px solid #16181f; }
    h3 { font-size: 10px; text-transform: uppercase; letter-spacing: 0.1em; color: #555; margin-bottom: 6px; }
    table { width: 100%; border-collapse: collapse; }
    td { padding: 4px 0; } .r { text-align: right; }
    .net { border-top: 1.5px solid #16181f; padding: 12px 18px; display: flex; justify-content: space-between; font-weight: 700; }
    .words { padding: 0 18px 14px; font-style: italic; color: #444; }
  </style></head><body><div class="sheet">
    <div class="head">
      <div><h1>${esc(company.name)}</h1><div class="sub">${esc(company.address)}</div></div>
      <div style="text-align:right"><b>PAYSLIP</b><div class="sub">${esc(run.month)}</div></div>
    </div>
    <div class="meta">
      <div><b>${esc(line.employeeName)}</b><div class="sub">${esc(emp?.designation ?? '')}${emp?.code ? ' · ' + esc(emp.code) : ''}</div></div>
      <div class="sub">Days paid: <span class="num">${line.payableDays}/${line.monthDays}</span></div>
      ${emp?.uan ? `<div class="sub">UAN: <span class="num">${esc(emp.uan)}</span></div>` : ''}
      ${emp?.pan ? `<div class="sub">PAN: <span class="num">${esc(emp.pan)}</span></div>` : ''}
    </div>
    <div class="cols">
      <div><h3>Earnings</h3><table>
        ${row('Basic', line.basic)}${row('HRA', line.hra)}${row('Special allowance', line.special)}
        <tr><td><b>Gross</b></td><td class="r num"><b>${money(line.gross)}</b></td></tr>
      </table></div>
      <div><h3>Deductions</h3><table>
        ${row('Provident fund', line.pfEmp)}${row('ESI', line.esiEmp)}${row('Professional tax', line.pt)}
        <tr><td><b>Total deductions</b></td><td class="r num"><b>${money(line.pfEmp + line.esiEmp + line.pt)}</b></td></tr>
      </table></div>
    </div>
    <div class="net"><span>Net pay</span><span class="num">₹ ${money(line.net)}</span></div>
    <div class="words">${esc(amountInWords(line.net))}</div>
  </div></body></html>`

  const win = new BrowserWindow({ show: false, webPreferences: { sandbox: true } })
  try {
    await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html))
    const pdf = await win.webContents.printToPDF({ pageSize: 'A4', printBackground: true })
    const safeName = line.employeeName.replace(/[^a-zA-Z0-9-_]/g, '_')
    const path = join(companyExportsDir(slug), `payslip-${run.month}-${safeName}.pdf`)
    writeFileSync(path, pdf)
    return path
  } finally {
    win.destroy()
  }
}
