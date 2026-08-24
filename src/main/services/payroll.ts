import type { DB } from "../db/connection";
import type {
  CompanyInfo,
  Employee,
  PayrollHeadAmount,
  PayrollLine,
  PayrollRun,
} from "@shared/domain";
import type {
  EmployeeInput,
  EmployeeHeadsSetInput,
  PayHeadInput,
} from "@shared/schemas";
import {
  buildEcr,
  buildEsiCsv,
  buildPtCsv,
  computeMonthlyPay,
  daysInMonth,
  type PayHeadSpec,
} from "@shared/payroll";
import { amountInWords, formatPaise } from "@shared/money";
import { deleteVoucher, getLockDate, saveVoucher } from "./vouchers";
import { findOrCreateLedger } from "./masters";
import { writeAudit } from "./audit";
import { writeExportPdf } from "./pdf";
import { copyFileSync, mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { companyExportsDir } from "../paths";

// ---------- employees ----------

interface EmployeeRow {
  id: number;
  name: string;
  code: string | null;
  designation: string | null;
  joined: string | null;
  pan: string | null;
  uan: string | null;
  esic_no: string | null;
  bank_account: string | null;
  bank_ifsc: string | null;
  department: string | null;
  exit_date: string | null;
  basic: number;
  hra: number;
  special: number;
  pf_enabled: number;
  esi_enabled: number;
  pt_enabled: number;
  pt_state: string;
  active: number;
}

const mapEmployee = (r: EmployeeRow): Employee => ({
  id: r.id,
  name: r.name,
  code: r.code,
  designation: r.designation,
  joined: r.joined,
  pan: r.pan,
  uan: r.uan,
  esicNo: r.esic_no,
  bankAccount: r.bank_account,
  bankIfsc: r.bank_ifsc,
  department: r.department,
  exitDate: r.exit_date,
  basic: r.basic,
  hra: r.hra,
  special: r.special,
  pfEnabled: !!r.pf_enabled,
  esiEnabled: !!r.esi_enabled,
  ptEnabled: !!r.pt_enabled,
  ptState: r.pt_state,
  active: !!r.active,
});

export function listEmployees(db: DB): Employee[] {
  return (
    db.prepare("SELECT * FROM employees ORDER BY name").all() as EmployeeRow[]
  ).map(mapEmployee);
}

/** Keeps the three seeded heads (Basic/HRA/Special Allowance) in lockstep with the legacy salary
 *  columns, so head-based and column-based views of an employee can never drift apart. */
function syncSeededHeads(
  db: DB,
  employeeId: number,
  input: EmployeeInput,
): void {
  const upsert = db.prepare(
    `INSERT INTO employee_pay_heads (employee_id, pay_head_id, override_value)
     SELECT ?, id, ? FROM pay_heads WHERE name = ?
     ON CONFLICT(employee_id, pay_head_id) DO UPDATE SET override_value = excluded.override_value`,
  );
  upsert.run(employeeId, input.basic, "Basic");
  upsert.run(employeeId, input.hra, "HRA");
  upsert.run(employeeId, input.special, "Special Allowance");
}

export function saveEmployee(
  db: DB,
  input: EmployeeInput,
  id?: number,
): Employee {
  const before = id
    ? (db.prepare("SELECT * FROM employees WHERE id = ?").get(id) as
        EmployeeRow | undefined)
    : undefined;
  if (id) {
    db.prepare(
      `UPDATE employees SET name = ?, code = ?, designation = ?, joined = ?, pan = ?, uan = ?, esic_no = ?,
       basic = ?, hra = ?, special = ?, pf_enabled = ?, esi_enabled = ?, pt_enabled = ?, pt_state = ?, active = ?,
       bank_account = ?, bank_ifsc = ?, department = ?, exit_date = ? WHERE id = ?`,
    ).run(
      input.name,
      input.code,
      input.designation,
      input.joined,
      input.pan,
      input.uan,
      input.esicNo,
      input.basic,
      input.hra,
      input.special,
      +input.pfEnabled,
      +input.esiEnabled,
      +input.ptEnabled,
      input.ptState,
      +input.active,
      input.bankAccount,
      input.bankIfsc,
      input.department,
      input.exitDate,
      id,
    );
  } else {
    const res = db
      .prepare(
        `INSERT INTO employees (name, code, designation, joined, pan, uan, esic_no, basic, hra, special,
        pf_enabled, esi_enabled, pt_enabled, pt_state, active, bank_account, bank_ifsc, department, exit_date)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.name,
        input.code,
        input.designation,
        input.joined,
        input.pan,
        input.uan,
        input.esicNo,
        input.basic,
        input.hra,
        input.special,
        +input.pfEnabled,
        +input.esiEnabled,
        +input.ptEnabled,
        input.ptState,
        +input.active,
        input.bankAccount,
        input.bankIfsc,
        input.department,
        input.exitDate,
      );
    id = Number(res.lastInsertRowid);
  }
  syncSeededHeads(db, id, input);
  const saved = mapEmployee(
    db.prepare("SELECT * FROM employees WHERE id = ?").get(id) as EmployeeRow,
  );
  writeAudit(
    db,
    "employee",
    id,
    before ? "update" : "create",
    before ? mapEmployee(before) : null,
    saved,
  );
  return saved;
}

export function deleteEmployee(db: DB, id: number): void {
  const existing = db
    .prepare("SELECT * FROM employees WHERE id = ?")
    .get(id) as EmployeeRow | undefined;
  if (!existing) throw new Error("Employee not found");
  const used = db
    .prepare("SELECT COUNT(*) AS n FROM payroll_lines WHERE employee_id = ?")
    .get(id) as { n: number };
  if (used.n > 0)
    throw new Error("Employee has payroll history; mark them inactive instead");
  db.prepare("DELETE FROM employees WHERE id = ?").run(id);
  writeAudit(db, "employee", id, "delete", mapEmployee(existing), null);
}

// ---------- pay heads ----------

export interface PayHead {
  id: number;
  name: string;
  kind: "earning" | "deduction";
  calc: "flat" | "percent_of_basic";
  value: number;
  active: boolean;
}

interface PayHeadRow {
  id: number;
  name: string;
  kind: "earning" | "deduction";
  calc: "flat" | "percent_of_basic";
  value: number;
  active: number;
}

const mapHead = (r: PayHeadRow): PayHead => ({
  id: r.id,
  name: r.name,
  kind: r.kind,
  calc: r.calc,
  value: r.value,
  active: !!r.active,
});

export function listPayHeads(db: DB): PayHead[] {
  return (
    db.prepare("SELECT * FROM pay_heads ORDER BY id").all() as PayHeadRow[]
  ).map(mapHead);
}

export function savePayHead(db: DB, input: PayHeadInput, id?: number): PayHead {
  if (id != null) {
    const before = db
      .prepare("SELECT * FROM pay_heads WHERE id = ?")
      .get(id) as PayHeadRow | undefined;
    if (!before) throw new Error("Pay head not found");
    db.prepare(
      "UPDATE pay_heads SET name = ?, kind = ?, calc = ?, value = ?, active = ? WHERE id = ?",
    ).run(
      input.name,
      input.kind,
      input.calc,
      input.value,
      input.active ? 1 : 0,
      id,
    );
    writeAudit(db, "pay_head", id, "update", mapHead(before), input);
  } else {
    const res = db
      .prepare(
        "INSERT INTO pay_heads (name, kind, calc, value, active) VALUES (?, ?, ?, ?, ?)",
      )
      .run(
        input.name,
        input.kind,
        input.calc,
        input.value,
        input.active ? 1 : 0,
      );
    id = Number(res.lastInsertRowid);
    writeAudit(db, "pay_head", id, "create", null, input);
  }
  return mapHead(
    db.prepare("SELECT * FROM pay_heads WHERE id = ?").get(id) as PayHeadRow,
  );
}

export function deletePayHead(db: DB, id: number): void {
  const before = db.prepare("SELECT * FROM pay_heads WHERE id = ?").get(id) as
    PayHeadRow | undefined;
  if (!before) throw new Error("Pay head not found");
  const used = db
    .prepare(
      "SELECT COUNT(*) AS n FROM employee_pay_heads WHERE pay_head_id = ?",
    )
    .get(id) as { n: number };
  if (used.n > 0)
    throw new Error(
      "Pay head is assigned to employees; remove it from them first",
    );
  db.prepare("DELETE FROM pay_heads WHERE id = ?").run(id);
  writeAudit(db, "pay_head", id, "delete", mapHead(before), null);
}

export interface EmployeeHeadRow {
  payHeadId: number;
  name: string;
  kind: "earning" | "deduction";
  calc: "flat" | "percent_of_basic";
  /** The head's default value. */
  value: number;
  /** Per-employee override (null = use the default). */
  overrideValue: number | null;
}

export function getEmployeeHeads(
  db: DB,
  employeeId: number,
): EmployeeHeadRow[] {
  return db
    .prepare(
      `SELECT eph.pay_head_id AS payHeadId, ph.name, ph.kind, ph.calc, ph.value, eph.override_value AS overrideValue
       FROM employee_pay_heads eph JOIN pay_heads ph ON ph.id = eph.pay_head_id
       WHERE eph.employee_id = ? ORDER BY ph.id`,
    )
    .all(employeeId) as EmployeeHeadRow[];
}

/** Replaces the employee's full head assignment list. Also mirrors the seeded Basic/HRA/Special
 *  values back onto the legacy salary columns so both views stay in lockstep. */
export function setEmployeeHeads(
  db: DB,
  input: EmployeeHeadsSetInput,
): EmployeeHeadRow[] {
  const emp = db
    .prepare("SELECT id FROM employees WHERE id = ?")
    .get(input.employeeId);
  if (!emp) throw new Error("Employee not found");
  const before = getEmployeeHeads(db, input.employeeId);
  const run = db.transaction(() => {
    db.prepare("DELETE FROM employee_pay_heads WHERE employee_id = ?").run(
      input.employeeId,
    );
    const insert = db.prepare(
      "INSERT INTO employee_pay_heads (employee_id, pay_head_id, override_value) VALUES (?, ?, ?)",
    );
    for (const h of input.heads)
      insert.run(input.employeeId, h.payHeadId, h.overrideValue);

    const seeded = db
      .prepare(
        "SELECT id, name FROM pay_heads WHERE name IN ('Basic', 'HRA', 'Special Allowance')",
      )
      .all() as { id: number; name: string }[];
    const byName = new Map(seeded.map((s) => [s.name, s.id]));
    const valueOf = (name: string): number => {
      const headId = byName.get(name);
      const assigned =
        headId == null
          ? undefined
          : input.heads.find((h) => h.payHeadId === headId);
      return assigned?.overrideValue ?? 0;
    };
    db.prepare(
      "UPDATE employees SET basic = ?, hra = ?, special = ? WHERE id = ?",
    ).run(
      valueOf("Basic"),
      valueOf("HRA"),
      valueOf("Special Allowance"),
      input.employeeId,
    );
  });
  run();
  const after = getEmployeeHeads(db, input.employeeId);
  writeAudit(
    db,
    "employee",
    input.employeeId,
    "update",
    { payHeads: before },
    { payHeads: after },
  );
  return after;
}

/** Active head list per employee, override-resolved, in PayHeadSpec shape for computeMonthlyPay. */
function loadEmployeeHeadSpecs(
  db: DB,
  month?: string,
): Map<number, PayHeadSpec[]> {
  const rows = db
    .prepare(
      `SELECT eph.employee_id AS employeeId, ph.name, ph.kind, ph.calc,
              COALESCE(eph.override_value, ph.value) AS value
       FROM employee_pay_heads eph JOIN pay_heads ph ON ph.id = eph.pay_head_id
       WHERE ph.active = 1 ORDER BY ph.id`,
    )
    .all() as {
    employeeId: number;
    name: string;
    kind: "earning" | "deduction";
    calc: "flat" | "percent_of_basic";
    value: number;
  }[];
  const map = new Map<number, PayHeadSpec[]>();
  for (const r of rows) {
    const list = map.get(r.employeeId) ?? [];
    list.push({ name: r.name, kind: r.kind, calc: r.calc, value: r.value });
    map.set(r.employeeId, list);
  }
  if (month) {
    const effectiveTo = `${month}-${String(daysInMonth(month)).padStart(2, "0")}`;
    const revisions = db
      .prepare(
        `SELECT employee_id AS employeeId,heads_json AS headsJson FROM salary_revisions r
      WHERE r.status='approved' AND r.effective_from<=? AND r.id=(SELECT r2.id FROM salary_revisions r2 WHERE r2.employee_id=r.employee_id AND r2.status='approved' AND r2.effective_from<=? ORDER BY r2.effective_from DESC,r2.id DESC LIMIT 1)`,
      )
      .all(effectiveTo, effectiveTo) as {
      employeeId: number;
      headsJson: string;
    }[];
    for (const revision of revisions)
      map.set(
        revision.employeeId,
        JSON.parse(revision.headsJson) as PayHeadSpec[],
      );
  }
  return map;
}

// ---------- pay runs ----------

export interface RunPreviewLine extends Omit<PayrollLine, "id"> {}

export function previewRun(
  db: DB,
  month: string,
  days: { employeeId: number; payableDays: number }[],
): RunPreviewLine[] {
  const monthDays = daysInMonth(month);
  const byId = new Map(days.map((d) => [d.employeeId, d.payableDays]));
  const headsByEmployee = loadEmployeeHeadSpecs(db, month);
  return listEmployees(db)
    .filter((e) => e.active)
    .map((e) => {
      const payableDays = byId.get(e.id) ?? monthDays;
      const heads = [...(headsByEmployee.get(e.id) ?? [])];
      const loanDue = (
        db
          .prepare(
            `SELECT COALESCE(SUM(i.principal+i.interest),0) AS amount FROM employee_loan_installments i JOIN employee_loans l ON l.id=i.loan_id WHERE l.employee_id=? AND i.month=? AND i.status='scheduled' AND l.status='active'`,
          )
          .get(e.id, month) as { amount: number }
      ).amount;
      if (loanDue > 0)
        heads.push({
          name: "Employee loan instalment",
          kind: "deduction",
          calc: "flat",
          value: loanDue,
          prorate: false,
        });
      const overtime = db
        .prepare(
          `SELECT ar.overtime_minutes AS minutes,s.work_minutes AS workMinutes,s.overtime_rate_bps AS rateBps
        FROM attendance_records ar LEFT JOIN employee_shift_assignments a ON a.id=(SELECT a2.id FROM employee_shift_assignments a2 WHERE a2.employee_id=ar.employee_id AND a2.effective_from<=? AND (a2.effective_to IS NULL OR a2.effective_to>=?) ORDER BY a2.effective_from DESC LIMIT 1)
        LEFT JOIN shift_rules s ON s.id=a.shift_rule_id AND s.active=1 WHERE ar.employee_id=? AND ar.month=? AND ar.status='approved'`,
        )
        .get(`${month}-31`, `${month}-01`, e.id, month) as
        | {
            minutes: number;
            workMinutes: number | null;
            rateBps: number | null;
          }
        | undefined;
      const overtimeMinutes = overtime?.minutes ?? 0;
      const overtimeAmount =
        overtimeMinutes > 0 && overtime?.workMinutes && overtime.rateBps != null
          ? Math.round(
              (e.basic * overtimeMinutes * overtime.rateBps) /
                (26 * overtime.workMinutes * 10000),
            )
          : 0;
      if (overtimeAmount > 0)
        heads.push({
          name: "Overtime",
          kind: "earning",
          calc: "flat",
          value: overtimeAmount,
          prorate: false,
        });
      const pay = computeMonthlyPay({ ...e, heads }, payableDays, monthDays);
      return {
        employeeId: e.id,
        employeeName: e.name,
        payableDays,
        monthDays,
        overtimeMinutes,
        overtimeAmount,
        department: e.department,
        ...pay,
      };
    });
}

/** Post the month's payroll: stores the run + lines and books one balanced Journal voucher — all
 *  inside ONE transaction (saveVoucher's inner db.transaction nests as a savepoint), so a failure
 *  while writing run rows can never leave an orphaned salary voucher behind. */
export function commitRun(
  db: DB,
  month: string,
  days: { employeeId: number; payableDays: number }[],
): PayrollRun {
  const existing = db
    .prepare("SELECT id FROM payroll_runs WHERE month = ?")
    .get(month) as { id: number } | undefined;
  if (existing) throw new Error(`Payroll for ${month} is already posted`);
  const lines = previewRun(db, month, days);
  if (lines.length === 0) throw new Error("No active employees");

  const sum = (f: (l: RunPreviewLine) => number): number =>
    lines.reduce((s, l) => s + f(l), 0);
  const gross = sum((l) => l.gross);
  const pfEmp = sum((l) => l.pfEmp);
  const pfEr = sum((l) => l.pfEr);
  const pfAdmin = sum((l) => l.pfAdmin);
  const edli = sum((l) => l.edli);
  const esiEmp = sum((l) => l.esiEmp);
  const esiEr = sum((l) => l.esiEr);
  const pt = sum((l) => l.pt);
  const otherDeductions = sum((l) => l.otherDeductions);
  const net = sum((l) => l.net);

  const journal = db
    .prepare(
      "SELECT id FROM voucher_types WHERE kind = 'journal' AND is_system = 1",
    )
    .get() as { id: number };

  const voucherLines: {
    ledgerId: number;
    drCr: "dr" | "cr";
    amount: number;
    costAllocations: never[];
  }[] = [];
  const push = (
    name: string,
    group: string,
    drCr: "dr" | "cr",
    amount: number,
  ): void => {
    if (amount > 0)
      voucherLines.push({
        ledgerId: findOrCreateLedger(db, name, group),
        drCr,
        amount,
        costAllocations: [],
      });
  };
  push("Salaries", "Indirect Expenses", "dr", gross);
  push("Employer PF Contribution", "Indirect Expenses", "dr", pfEr);
  push("PF Admin & EDLI Charges", "Indirect Expenses", "dr", pfAdmin + edli);
  push("Employer ESI Contribution", "Indirect Expenses", "dr", esiEr);
  push("PF Payable", "Provisions", "cr", pfEmp + pfEr + pfAdmin + edli);
  push("ESI Payable", "Provisions", "cr", esiEmp + esiEr);
  push("Professional Tax Payable", "Duties & Taxes", "cr", pt);
  push("Employee Deductions Payable", "Provisions", "cr", otherDeductions);
  push("Salaries Payable", "Provisions", "cr", net);

  const lastDay = `${month}-${String(daysInMonth(month)).padStart(2, "0")}`;
  const commit = db.transaction((): number => {
    const voucher = saveVoucher(db, {
      voucherTypeId: journal.id,
      date: lastDay,
      number: undefined,
      partyLedgerId: null,
      narration: `Salary for ${month} — ${lines.length} employee${lines.length > 1 ? "s" : ""}`,
      reference: null,
      instrumentNo: null,
      instrumentDate: null,
      transporterId: null,
      vehicleNo: null,
      transportDistanceKm: null,
      currencyCode: null,
      exchangeRate: null,
      lines: voucherLines,
      inventory: [],
      billRefs: [],
      tds: null,
    });

    const res = db
      .prepare("INSERT INTO payroll_runs (month, voucher_id) VALUES (?, ?)")
      .run(month, voucher.id);
    const runId = Number(res.lastInsertRowid);
    const insert = db.prepare(
      `INSERT INTO payroll_lines (run_id, employee_id, payable_days, month_days, basic, hra, special, gross,
        pf_emp, pf_er, esi_emp, esi_er, pt, net,
        other_earnings, other_deductions, eps_er, pf_admin, edli, heads_json,overtime_minutes,overtime_amount,department)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const l of lines) {
      insert.run(
        runId,
        l.employeeId,
        l.payableDays,
        l.monthDays,
        l.basic,
        l.hra,
        l.special,
        l.gross,
        l.pfEmp,
        l.pfEr,
        l.esiEmp,
        l.esiEr,
        l.pt,
        l.net,
        l.otherEarnings,
        l.otherDeductions,
        l.epsEr,
        l.pfAdmin,
        l.edli,
        l.headAmounts.length ? JSON.stringify(l.headAmounts) : null,
        l.overtimeMinutes ?? 0,
        l.overtimeAmount ?? 0,
        l.department ?? null,
      );
    }
    db.prepare(
      `UPDATE employee_loan_installments
       SET status='deducted',payroll_run_id=?
       WHERE month=? AND status='scheduled'
         AND EXISTS (
           SELECT 1 FROM employee_loans l
           JOIN payroll_lines pl ON pl.employee_id=l.employee_id
           WHERE l.id=employee_loan_installments.loan_id
             AND l.status='active' AND pl.run_id=?
         )`,
    ).run(runId, month, runId);
    return runId;
  });
  const runId = commit();
  const created = getRun(db, runId)!;
  writeAudit(db, "payroll_run", runId, "create", null, created);
  return created;
}

interface RunRow {
  id: number;
  month: string;
  voucher_id: number | null;
  created_at: string;
  run_kind: PayrollRun["runKind"];
  parent_run_id: number | null;
  locked_at: string | null;
  locked_by: string | null;
}
interface LineRow {
  id: number;
  employee_id: number;
  employeeName: string;
  payable_days: number;
  month_days: number;
  basic: number;
  hra: number;
  special: number;
  gross: number;
  pf_emp: number;
  pf_er: number;
  esi_emp: number;
  esi_er: number;
  pt: number;
  net: number;
  other_earnings: number;
  other_deductions: number;
  eps_er: number;
  pf_admin: number;
  edli: number;
  heads_json: string | null;
  overtime_minutes: number;
  overtime_amount: number;
  department: string | null;
}

export function getRun(db: DB, id: number): PayrollRun | null {
  const r = db.prepare("SELECT * FROM payroll_runs WHERE id = ?").get(id) as
    RunRow | undefined;
  if (!r) return null;
  const lines = db
    .prepare(
      `SELECT pl.*, e.name AS employeeName FROM payroll_lines pl
       JOIN employees e ON e.id = pl.employee_id WHERE pl.run_id = ? ORDER BY e.name`,
    )
    .all(id) as LineRow[];
  return {
    id: r.id,
    month: r.month,
    voucherId: r.voucher_id,
    createdAt: r.created_at,
    runKind: r.run_kind,
    parentRunId: r.parent_run_id,
    lockedAt: r.locked_at,
    lockedBy: r.locked_by,
    lines: lines.map((l) => ({
      id: l.id,
      employeeId: l.employee_id,
      employeeName: l.employeeName,
      payableDays: l.payable_days,
      monthDays: l.month_days,
      basic: l.basic,
      hra: l.hra,
      special: l.special,
      otherEarnings: l.other_earnings,
      otherDeductions: l.other_deductions,
      gross: l.gross,
      pfEmp: l.pf_emp,
      pfEr: l.pf_er,
      epsEr: l.eps_er,
      pfAdmin: l.pf_admin,
      edli: l.edli,
      esiEmp: l.esi_emp,
      esiEr: l.esi_er,
      pt: l.pt,
      net: l.net,
      overtimeMinutes: l.overtime_minutes,
      overtimeAmount: l.overtime_amount,
      department: l.department,
      headAmounts: l.heads_json
        ? (JSON.parse(l.heads_json) as PayrollHeadAmount[])
        : [],
    })),
  };
}

export function listRuns(db: DB): PayrollRun[] {
  const rows = db
    .prepare("SELECT id FROM payroll_runs ORDER BY month DESC")
    .all() as { id: number }[];
  return rows.map((r) => getRun(db, r.id)!).filter(Boolean);
}

export function deleteRun(db: DB, id: number): void {
  const run = getRun(db, id);
  if (!run) throw new Error("Pay run not found");
  if (run.lockedAt)
    throw new Error(
      "Locked payroll cannot be deleted; post an explicit supplementary or reversal run",
    );
  const lock = getLockDate(db);
  const lastDay = `${run.month}-${String(daysInMonth(run.month)).padStart(2, "0")}`;
  if (lock && lastDay <= lock) {
    throw new Error(
      `Payroll for ${run.month} falls in a locked period (books are locked up to ${lock}) — move the lock date first`,
    );
  }
  const del = db.transaction(() => {
    db.prepare(
      "UPDATE employee_loan_installments SET status='scheduled',payroll_run_id=NULL WHERE payroll_run_id=? AND status='deducted'",
    ).run(id);
    db.prepare("DELETE FROM payroll_runs WHERE id = ?").run(id);
    if (run.voucherId) deleteVoucher(db, run.voucherId);
  });
  del();
  writeAudit(db, "payroll_run", id, "delete", run, null);
}

// ---------- statutory exports (PF ECR / ESI upload / PT summary) ----------

/** EPFO ECR 2.0 text for a posted run — one #~# line per PF member with a UAN. */
export function ecrForRun(
  db: DB,
  runId: number,
): { filename: string; text: string } {
  const run = getRun(db, runId);
  if (!run) throw new Error("Pay run not found");
  const employees = new Map(listEmployees(db).map((e) => [e.id, e]));
  const rows = run.lines
    .filter((l) => {
      const e = employees.get(l.employeeId);
      return !!e?.pfEnabled && !!e.uan && l.pfEmp > 0;
    })
    .map((l) => ({
      uan: employees.get(l.employeeId)!.uan!,
      name: l.employeeName,
      gross: l.gross,
      basic: l.basic,
      pfEmp: l.pfEmp,
      pfEr: l.pfEr,
      epsEr: l.epsEr,
      payableDays: l.payableDays,
      monthDays: l.monthDays,
    }));
  if (rows.length === 0)
    throw new Error(
      "No PF members with a UAN in this run — add UANs on the employee records first",
    );
  return { filename: `pf-ecr-${run.month}.txt`, text: buildEcr(rows) };
}

/** ESIC monthly-contribution upload CSV for a posted run. */
export function esiForRun(
  db: DB,
  runId: number,
): { filename: string; text: string } {
  const run = getRun(db, runId);
  if (!run) throw new Error("Pay run not found");
  const employees = new Map(listEmployees(db).map((e) => [e.id, e]));
  const rows = run.lines
    .filter((l) => {
      const e = employees.get(l.employeeId);
      return l.esiEmp > 0 && !!e?.esicNo;
    })
    .map((l) => ({
      esicNo: employees.get(l.employeeId)!.esicNo!,
      name: l.employeeName,
      payableDays: l.payableDays,
      gross: l.gross,
    }));
  if (rows.length === 0)
    throw new Error("No ESI contributions with an ESIC number in this run");
  return { filename: `esi-upload-${run.month}.csv`, text: buildEsiCsv(rows) };
}

export interface PtSummaryRow {
  state: string;
  employees: number;
  gross: number;
  pt: number;
}

/** Professional tax collected per state for a posted run (drives the state-wise PT challans). */
export function ptSummaryForRun(db: DB, runId: number): PtSummaryRow[] {
  const run = getRun(db, runId);
  if (!run) throw new Error("Pay run not found");
  const stateById = new Map(listEmployees(db).map((e) => [e.id, e.ptState]));
  const byState = new Map<string, PtSummaryRow>();
  for (const l of run.lines) {
    const state = stateById.get(l.employeeId) ?? "MH";
    const row = byState.get(state) ?? { state, employees: 0, gross: 0, pt: 0 };
    row.employees += 1;
    row.gross += l.gross;
    row.pt += l.pt;
    byState.set(state, row);
  }
  return [...byState.values()].sort((a, b) => a.state.localeCompare(b.state));
}

/** State-wise PT return CSV for a posted run (the file the state challan is filled from). */
export function ptCsvForRun(
  db: DB,
  runId: number,
): { filename: string; text: string } {
  const run = getRun(db, runId);
  if (!run) throw new Error("Pay run not found");
  const rows = ptSummaryForRun(db, runId).filter((r) => r.pt > 0);
  if (rows.length === 0) throw new Error("No professional tax in this run");
  return { filename: `pt-return-${run.month}.csv`, text: buildPtCsv(rows) };
}

// ---------- payslip PDF ----------

const esc = (s: string | null): string =>
  (s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const SEEDED_HEAD_NAMES = new Set([
  "basic",
  "hra",
  "special allowance",
  "special",
]);

export async function payslipPdf(
  db: DB,
  company: CompanyInfo,
  slug: string,
  runId: number,
  employeeId: number,
): Promise<string> {
  const run = getRun(db, runId);
  if (!run) throw new Error("Pay run not found");
  const line = run.lines.find((l) => l.employeeId === employeeId);
  if (!line) throw new Error("Employee not in this run");
  const emp = listEmployees(db).find((e) => e.id === employeeId);

  const money = (p: number): string => formatPaise(p);
  const row = (label: string, amount: number): string =>
    amount > 0
      ? `<tr><td>${esc(label)}</td><td class="r num">${money(amount)}</td></tr>`
      : "";

  const customHeads = line.headAmounts.filter(
    (h) => !SEEDED_HEAD_NAMES.has(h.name.trim().toLowerCase()),
  );
  const customEarningRows = customHeads
    .filter((h) => h.kind === "earning")
    .map((h) => row(h.name, h.amount))
    .join("");
  const customDeductionRows = customHeads
    .filter((h) => h.kind === "deduction")
    .map((h) => row(h.name, h.amount))
    .join("");
  const otherEarningsFallback =
    customEarningRows === "" ? row("Other allowances", line.otherEarnings) : "";
  const otherDeductionsFallback =
    customDeductionRows === ""
      ? row("Other deductions", line.otherDeductions)
      : "";
  const totalDeductions =
    line.pfEmp + line.esiEmp + line.pt + line.otherDeductions;

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
      <div><b>${esc(line.employeeName)}</b><div class="sub">${esc(emp?.designation ?? "")}${emp?.code ? " · " + esc(emp.code) : ""}</div></div>
      <div class="sub">Days paid: <span class="num">${line.payableDays}/${line.monthDays}</span></div>
      ${emp?.uan ? `<div class="sub">UAN: <span class="num">${esc(emp.uan)}</span></div>` : ""}
      ${emp?.pan ? `<div class="sub">PAN: <span class="num">${esc(emp.pan)}</span></div>` : ""}
    </div>
    <div class="cols">
      <div><h3>Earnings</h3><table>
        ${row("Basic", line.basic)}${row("HRA", line.hra)}${row("Special allowance", line.special)}
        ${customEarningRows}${otherEarningsFallback}
        <tr><td><b>Gross</b></td><td class="r num"><b>${money(line.gross)}</b></td></tr>
      </table></div>
      <div><h3>Deductions</h3><table>
        ${row("Provident fund", line.pfEmp)}${row("ESI", line.esiEmp)}${row("Professional tax", line.pt)}
        ${customDeductionRows}${otherDeductionsFallback}
        <tr><td><b>Total deductions</b></td><td class="r num"><b>${money(totalDeductions)}</b></td></tr>
      </table></div>
    </div>
    <div class="net"><span>Net pay</span><span class="num">₹ ${money(line.net)}</span></div>
    <div class="words">${esc(amountInWords(line.net))}</div>
  </div></body></html>`;

  const safeName = line.employeeName.replace(/[^a-zA-Z0-9-_]/g, "_");
  return writeExportPdf(slug, `payslip-${run.month}-${safeName}.pdf`, html, {
    pageSize: "A4",
  });
}

export async function payslipDeliveryPack(
  db: DB,
  company: CompanyInfo,
  slug: string,
  runId: number,
): Promise<{ folder: string; files: string[] }> {
  const run = getRun(db, runId);
  if (!run) throw new Error("Pay run not found");
  if (!run.lockedAt)
    throw new Error(
      "Lock the reconciled payroll before exporting its delivery pack",
    );
  const folder = join(companyExportsDir(slug), `payroll-${run.month}-delivery`);
  mkdirSync(folder, { recursive: true });
  const files: string[] = [];
  const manifest = ["employee,employee_code,payslip_file,net_pay_paise"];
  const employees = new Map(
    listEmployees(db).map((employee) => [employee.id, employee]),
  );
  for (const line of run.lines) {
    const source = await payslipPdf(db, company, slug, runId, line.employeeId);
    const filename = source.split(/[\\/]/).pop()!;
    const target = join(folder, filename);
    copyFileSync(source, target);
    files.push(target);
    const employee = employees.get(line.employeeId);
    const csv = (value: string): string => `"${value.replace(/"/g, '""')}"`;
    manifest.push(
      [
        csv(line.employeeName),
        csv(employee?.code ?? ""),
        csv(filename),
        String(line.net),
      ].join(","),
    );
  }
  const manifestPath = join(folder, "manifest.csv");
  writeFileSync(manifestPath, manifest.join("\n"), "utf8");
  files.push(manifestPath);
  writeAudit(db, "payroll_run", runId, "export", null, {
    kind: "payslip_delivery_pack",
    month: run.month,
    files: files.length,
  });
  return { folder, files };
}
