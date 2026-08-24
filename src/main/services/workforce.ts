import { createHash } from "crypto";
import type { DB } from "../db/connection";
import { parseCsv } from "@shared/csv";
import type {
  AttendanceImportPreview,
  AttendanceImportRow,
  AttendanceInput,
  AttendanceMonthSummary,
  AttendanceRecord,
  LeaveBalance,
  LeaveTransaction,
  LeaveType,
  SalaryRevision,
  EmployeeLoan,
  EmployeeReimbursement,
  Contractor,
  ContractorPayment,
  FinalSettlement,
  FinalSettlementPreview,
} from "@shared/workforce";
import { daysInMonth, type PayHeadSpec } from "@shared/payroll";
import { writeAudit } from "./audit";
import { findOrCreateLedger } from "./masters";
import { saveVoucher } from "./vouchers";
import { tdsSuggestion } from "./tds";

type AttendanceRow = Omit<AttendanceRecord, "employeeName" | "employeeCode"> & {
  employee_name: string;
  employee_code: string | null;
};

const mapAttendance = (row: AttendanceRow): AttendanceRecord => ({
  id: row.id,
  importId: row.importId,
  employeeId: row.employeeId,
  employeeName: row.employee_name,
  employeeCode: row.employee_code,
  month: row.month,
  payableDays: row.payableDays,
  presentDays: row.presentDays,
  leaveDays: row.leaveDays,
  unpaidDays: row.unpaidDays,
  overtimeMinutes: row.overtimeMinutes,
  status: row.status,
  note: row.note,
  approvedBy: row.approvedBy,
  approvedAt: row.approvedAt,
});

export function listAttendance(db: DB, month: string): AttendanceRecord[] {
  return (
    db
      .prepare(
        `
    SELECT ar.id,ar.import_id AS importId,ar.employee_id AS employeeId,e.name AS employee_name,
      e.code AS employee_code,ar.month,ar.payable_days AS payableDays,ar.present_days AS presentDays,
      ar.leave_days AS leaveDays,ar.unpaid_days AS unpaidDays,ar.overtime_minutes AS overtimeMinutes,
      ar.status,ar.note,ar.approved_by AS approvedBy,ar.approved_at AS approvedAt
    FROM attendance_records ar JOIN employees e ON e.id=ar.employee_id
    WHERE ar.month=? ORDER BY e.name COLLATE NOCASE
  `,
      )
      .all(month) as AttendanceRow[]
  ).map(mapAttendance);
}

export function attendanceSummary(
  db: DB,
  month: string,
): AttendanceMonthSummary {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS employees,
    SUM(CASE WHEN status='approved' THEN 1 ELSE 0 END) AS approved,
    SUM(CASE WHEN status='review' THEN 1 ELSE 0 END) AS review,
    SUM(CASE WHEN status='exception' THEN 1 ELSE 0 END) AS exceptions,
    COALESCE(SUM(payable_days),0) AS payableDays,COALESCE(SUM(overtime_minutes),0) AS overtimeMinutes
    FROM attendance_records WHERE month=?`,
    )
    .get(month) as Omit<AttendanceMonthSummary, "month">;
  return {
    month,
    employees: row.employees,
    approved: row.approved,
    review: row.review,
    exceptions: row.exceptions,
    payableDays: row.payableDays,
    overtimeMinutes: row.overtimeMinutes,
  };
}

function validateAttendance(input: AttendanceInput): void {
  if (!/^\d{4}-\d{2}$/.test(input.month))
    throw new Error("Month must be YYYY-MM");
  for (const [label, value] of [
    ["payable days", input.payableDays],
    ["present days", input.presentDays],
    ["leave days", input.leaveDays],
    ["unpaid days", input.unpaidDays],
  ] as const) {
    if (!Number.isFinite(value) || value < 0 || value > 31)
      throw new Error(`${label} must be between 0 and 31`);
  }
  if (!Number.isInteger(input.overtimeMinutes) || input.overtimeMinutes < 0)
    throw new Error("Overtime minutes must be a non-negative whole number");
}

export function saveAttendance(
  db: DB,
  input: AttendanceInput,
  author: string,
  importId: number | null = null,
): AttendanceRecord {
  validateAttendance(input);
  const existing = db
    .prepare(
      "SELECT id FROM attendance_records WHERE employee_id=? AND month=?",
    )
    .get(input.employeeId, input.month) as { id: number } | undefined;
  const approved = input.status === "approved";
  db.prepare(
    `INSERT INTO attendance_records(import_id,employee_id,month,payable_days,present_days,leave_days,unpaid_days,overtime_minutes,status,note,approved_by,approved_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,CASE WHEN ? THEN datetime('now') ELSE NULL END)
    ON CONFLICT(employee_id,month) DO UPDATE SET import_id=excluded.import_id,payable_days=excluded.payable_days,
      present_days=excluded.present_days,leave_days=excluded.leave_days,unpaid_days=excluded.unpaid_days,
      overtime_minutes=excluded.overtime_minutes,status=excluded.status,note=excluded.note,approved_by=excluded.approved_by,
      approved_at=excluded.approved_at`,
  ).run(
    importId,
    input.employeeId,
    input.month,
    input.payableDays,
    input.presentDays,
    input.leaveDays,
    input.unpaidDays,
    input.overtimeMinutes,
    input.status,
    input.note ?? null,
    approved ? author : null,
    approved ? 1 : 0,
  );
  const after = listAttendance(db, input.month).find(
    (row) => row.employeeId === input.employeeId,
  )!;
  writeAudit(
    db,
    "attendance",
    after.id,
    existing ? "update" : "create",
    existing ?? null,
    after,
  );
  return after;
}

function cellIndex(headers: string[], aliases: string[]): number {
  return headers.findIndex((header) => aliases.includes(header));
}

function numberCell(cells: string[], index: number): number {
  if (index < 0 || !cells[index]?.trim()) return 0;
  return Number(cells[index]!.trim());
}

export function previewAttendanceImport(
  db: DB,
  month: string,
  sourceName: string,
  csvText: string,
): AttendanceImportPreview {
  const sourceHash = createHash("sha256").update(csvText).digest("hex");
  const records = parseCsv(csvText.replace(/^\uFEFF/, ""));
  if (records.length < 2)
    throw new Error(
      "Attendance CSV must include a header and at least one employee row",
    );
  const headers = records[0]!.cells.map((cell) =>
    cell
      .trim()
      .toLowerCase()
      .replace(/[\s-]+/g, "_"),
  );
  const codeIndex = cellIndex(headers, [
    "employee_code",
    "code",
    "employee_id",
  ]);
  const payableIndex = cellIndex(headers, ["payable_days", "paid_days"]);
  const presentIndex = cellIndex(headers, ["present_days", "present"]);
  const leaveIndex = cellIndex(headers, ["leave_days", "leave"]);
  const unpaidIndex = cellIndex(headers, ["unpaid_days", "lop_days", "lop"]);
  const overtimeIndex = cellIndex(headers, [
    "overtime_minutes",
    "ot_minutes",
    "overtime",
  ]);
  if (codeIndex < 0 || payableIndex < 0)
    throw new Error("CSV needs employee_code and payable_days columns");
  const employees = db
    .prepare("SELECT id,name,code FROM employees WHERE active=1")
    .all() as { id: number; name: string; code: string | null }[];
  const byCode = new Map(
    employees
      .filter((e) => e.code)
      .map((e) => [e.code!.trim().toLowerCase(), e]),
  );
  const seen = new Set<string>();
  const rows: AttendanceImportRow[] = records.slice(1).map((record) => {
    const code = record.cells[codeIndex]?.trim() ?? "";
    const employee = byCode.get(code.toLowerCase());
    const values = {
      payableDays: numberCell(record.cells, payableIndex),
      presentDays: numberCell(record.cells, presentIndex),
      leaveDays: numberCell(record.cells, leaveIndex),
      unpaidDays: numberCell(record.cells, unpaidIndex),
      overtimeMinutes: numberCell(record.cells, overtimeIndex),
    };
    let status: AttendanceImportRow["status"] = "valid";
    let message: string | null = null;
    if (!code) {
      status = "error";
      message = "Employee code is blank";
    } else if (seen.has(code.toLowerCase())) {
      status = "error";
      message = "Duplicate employee code in this file";
    } else if (!employee) {
      status = "error";
      message = "No active employee matches this code";
    } else if (
      Object.values(values).some(
        (value) => !Number.isFinite(value) || value < 0,
      )
    ) {
      status = "error";
      message = "Days and overtime must be non-negative numbers";
    } else if (
      values.payableDays > 31 ||
      values.presentDays > 31 ||
      values.leaveDays > 31 ||
      values.unpaidDays > 31
    ) {
      status = "error";
      message = "Day values cannot exceed 31";
    } else if (!Number.isInteger(values.overtimeMinutes)) {
      status = "error";
      message = "Overtime minutes must be a whole number";
    } else if (
      Math.abs(values.presentDays + values.leaveDays - values.payableDays) >
      0.001
    ) {
      status = "warning";
      message = "Present plus leave days differs from payable days";
    }
    seen.add(code.toLowerCase());
    return {
      sourceRow: record.line,
      employeeCode: code,
      employeeId: employee?.id ?? null,
      employeeName: employee?.name ?? null,
      ...values,
      status,
      message,
    };
  });
  return {
    month,
    sourceName,
    sourceHash,
    rows,
    validCount: rows.filter((row) => row.status === "valid").length,
    warningCount: rows.filter((row) => row.status === "warning").length,
    errorCount: rows.filter((row) => row.status === "error").length,
    alreadyImported: !!db
      .prepare("SELECT 1 FROM attendance_imports WHERE source_hash=?")
      .get(sourceHash),
  };
}

export function applyAttendanceImport(
  db: DB,
  month: string,
  sourceName: string,
  csvText: string,
  author: string,
): AttendanceImportPreview {
  const preview = previewAttendanceImport(db, month, sourceName, csvText);
  if (preview.alreadyImported)
    throw new Error("This attendance file has already been imported");
  if (preview.errorCount)
    throw new Error(
      `Resolve ${preview.errorCount} attendance error(s) before applying`,
    );
  db.transaction(() => {
    const result = db
      .prepare(
        `INSERT INTO attendance_imports(month,source_name,source_hash,status,row_count,exception_count,imported_by)
      VALUES(?,?,?,'applied',?,?,?)`,
      )
      .run(
        month,
        sourceName,
        preview.sourceHash,
        preview.rows.length,
        preview.warningCount,
        author,
      );
    const importId = Number(result.lastInsertRowid);
    for (const row of preview.rows)
      saveAttendance(
        db,
        {
          employeeId: row.employeeId!,
          month,
          payableDays: row.payableDays,
          presentDays: row.presentDays,
          leaveDays: row.leaveDays,
          unpaidDays: row.unpaidDays,
          overtimeMinutes: row.overtimeMinutes,
          status: row.status === "warning" ? "exception" : "review",
          note: row.message,
        },
        author,
        importId,
      );
    writeAudit(db, "attendance_import", importId, "import", null, {
      month,
      sourceName,
      rows: preview.rows.length,
      exceptions: preview.warningCount,
    });
  })();
  return preview;
}

export function approveAttendanceMonth(
  db: DB,
  month: string,
  author: string,
): AttendanceRecord[] {
  const count = (
    db
      .prepare(
        "SELECT COUNT(*) AS n FROM attendance_records WHERE month=? AND status='exception'",
      )
      .get(month) as { n: number }
  ).n;
  if (count)
    throw new Error(`Resolve ${count} attendance exception(s) before approval`);
  db.prepare(
    "UPDATE attendance_records SET status='approved',approved_by=?,approved_at=datetime('now') WHERE month=? AND status='review'",
  ).run(author, month);
  const rows = listAttendance(db, month);
  writeAudit(
    db,
    "attendance_month",
    Number(month.replace("-", "")),
    "update",
    null,
    { month, approved: rows.length, author },
  );
  return rows;
}

type LeaveTypeRow = {
  id: number;
  name: string;
  annual_accrual_milli: number;
  carry_forward_limit_milli: number | null;
  encashable: number;
  paid: number;
  active: number;
};
const mapLeaveType = (row: LeaveTypeRow): LeaveType => ({
  id: row.id,
  name: row.name,
  annualAccrualMilli: row.annual_accrual_milli,
  carryForwardLimitMilli: row.carry_forward_limit_milli,
  encashable: !!row.encashable,
  paid: !!row.paid,
  active: !!row.active,
});

export function listLeaveTypes(db: DB): LeaveType[] {
  return (
    db
      .prepare("SELECT * FROM leave_types ORDER BY name COLLATE NOCASE")
      .all() as LeaveTypeRow[]
  ).map(mapLeaveType);
}

export function saveLeaveType(
  db: DB,
  input: Omit<LeaveType, "id">,
  id?: number,
): LeaveType {
  if (!input.name.trim()) throw new Error("Leave type name is required");
  if (
    !Number.isInteger(input.annualAccrualMilli) ||
    input.annualAccrualMilli < 0
  )
    throw new Error("Annual accrual must use non-negative thousandths");
  const before = id
    ? (db.prepare("SELECT * FROM leave_types WHERE id=?").get(id) as
        LeaveTypeRow | undefined)
    : undefined;
  if (id) {
    if (!before) throw new Error("Leave type not found");
    db.prepare(
      "UPDATE leave_types SET name=?,annual_accrual_milli=?,carry_forward_limit_milli=?,encashable=?,paid=?,active=? WHERE id=?",
    ).run(
      input.name.trim(),
      input.annualAccrualMilli,
      input.carryForwardLimitMilli,
      +input.encashable,
      +input.paid,
      +input.active,
      id,
    );
  } else {
    id = Number(
      db
        .prepare(
          "INSERT INTO leave_types(name,annual_accrual_milli,carry_forward_limit_milli,encashable,paid,active) VALUES(?,?,?,?,?,?)",
        )
        .run(
          input.name.trim(),
          input.annualAccrualMilli,
          input.carryForwardLimitMilli,
          +input.encashable,
          +input.paid,
          +input.active,
        ).lastInsertRowid,
    );
  }
  const after = mapLeaveType(
    db.prepare("SELECT * FROM leave_types WHERE id=?").get(id) as LeaveTypeRow,
  );
  writeAudit(
    db,
    "leave_type",
    id,
    before ? "update" : "create",
    before ? mapLeaveType(before) : null,
    after,
  );
  return after;
}

type LeaveTxRow = {
  id: number;
  employeeId: number;
  employeeName: string;
  leaveTypeId: number;
  leaveTypeName: string;
  date: string;
  qtyMilli: number;
  kind: LeaveTransaction["kind"];
  status: LeaveTransaction["status"];
  note: string | null;
  approvedBy: string | null;
  createdAt: string;
};
export function listLeaveTransactions(
  db: DB,
  employeeId?: number,
): LeaveTransaction[] {
  return db
    .prepare(
      `SELECT lt.id,lt.employee_id AS employeeId,e.name AS employeeName,lt.leave_type_id AS leaveTypeId,t.name AS leaveTypeName,lt.date,lt.qty_milli AS qtyMilli,lt.kind,lt.status,lt.note,lt.approved_by AS approvedBy,lt.created_at AS createdAt FROM leave_transactions lt JOIN employees e ON e.id=lt.employee_id JOIN leave_types t ON t.id=lt.leave_type_id ${employeeId ? "WHERE lt.employee_id=?" : ""} ORDER BY lt.date DESC,lt.id DESC`,
    )
    .all(...(employeeId ? [employeeId] : [])) as LeaveTxRow[];
}

export function recordLeave(
  db: DB,
  input: {
    employeeId: number;
    leaveTypeId: number;
    date: string;
    qtyMilli: number;
    kind: LeaveTransaction["kind"];
    status: LeaveTransaction["status"];
    note?: string | null;
  },
  author: string,
): LeaveTransaction {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.date))
    throw new Error("Leave date must be YYYY-MM-DD");
  if (!Number.isInteger(input.qtyMilli) || input.qtyMilli === 0)
    throw new Error("Leave quantity must use non-zero thousandths");
  if (input.kind !== "adjustment" && input.qtyMilli < 0)
    throw new Error("Only adjustments may use a negative quantity");
  const approved = input.status === "approved";
  const id = Number(
    db
      .prepare(
        "INSERT INTO leave_transactions(employee_id,leave_type_id,date,qty_milli,kind,status,note,approved_by) VALUES(?,?,?,?,?,?,?,?)",
      )
      .run(
        input.employeeId,
        input.leaveTypeId,
        input.date,
        input.qtyMilli,
        input.kind,
        input.status,
        input.note ?? null,
        approved ? author : null,
      ).lastInsertRowid,
  );
  const after = listLeaveTransactions(db).find((row) => row.id === id)!;
  writeAudit(db, "leave_transaction", id, "create", null, after);
  return after;
}

export function leaveBalances(db: DB, asOn: string): LeaveBalance[] {
  return db
    .prepare(
      `SELECT e.id AS employeeId,e.name AS employeeName,t.id AS leaveTypeId,t.name AS leaveTypeName,
  COALESCE(SUM(CASE WHEN x.status='approved' THEN CASE WHEN x.kind IN ('taken','encashment') THEN -x.qty_milli ELSE x.qty_milli END ELSE 0 END),0) AS balanceMilli,
  COALESCE(SUM(CASE WHEN x.status='approved' AND x.kind='taken' THEN x.qty_milli ELSE 0 END),0) AS takenMilli,
  COALESCE(SUM(CASE WHEN x.status='requested' AND x.kind='taken' THEN x.qty_milli ELSE 0 END),0) AS pendingMilli
  FROM employees e CROSS JOIN leave_types t LEFT JOIN leave_transactions x ON x.employee_id=e.id AND x.leave_type_id=t.id AND x.date<=?
  WHERE e.active=1 AND t.active=1 GROUP BY e.id,t.id ORDER BY e.name,t.name`,
    )
    .all(asOn) as LeaveBalance[];
}

type RevisionRow = {
  id: number;
  employeeId: number;
  employeeName: string;
  effectiveFrom: string;
  headsJson: string;
  reason: string;
  status: SalaryRevision["status"];
  approvedBy: string | null;
  createdBy: string;
  createdAt: string;
};
const mapRevision = (row: RevisionRow): SalaryRevision => ({
  ...row,
  heads: JSON.parse(row.headsJson) as PayHeadSpec[],
});
export function listSalaryRevisions(
  db: DB,
  employeeId?: number,
): SalaryRevision[] {
  return (
    db
      .prepare(
        `SELECT r.id,r.employee_id AS employeeId,e.name AS employeeName,r.effective_from AS effectiveFrom,r.heads_json AS headsJson,r.reason,r.status,r.approved_by AS approvedBy,r.created_by AS createdBy,r.created_at AS createdAt FROM salary_revisions r JOIN employees e ON e.id=r.employee_id ${employeeId ? "WHERE r.employee_id=?" : ""} ORDER BY r.effective_from DESC,r.id DESC`,
      )
      .all(...(employeeId ? [employeeId] : [])) as RevisionRow[]
  ).map(mapRevision);
}

export function saveSalaryRevision(
  db: DB,
  input: {
    employeeId: number;
    effectiveFrom: string;
    heads: PayHeadSpec[];
    reason: string;
    status: "draft" | "approved";
  },
  author: string,
): SalaryRevision {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.effectiveFrom))
    throw new Error("Effective date must be YYYY-MM-DD");
  if (!input.reason.trim()) throw new Error("Revision reason is required");
  if (
    !input.heads.length ||
    input.heads.some(
      (head) =>
        !head.name.trim() || !Number.isInteger(head.value) || head.value < 0,
    )
  )
    throw new Error("Revision needs valid salary heads in integer paise");
  const id = Number(
    db
      .prepare(
        "INSERT INTO salary_revisions(employee_id,effective_from,heads_json,reason,status,approved_by,created_by) VALUES(?,?,?,?,?,?,?)",
      )
      .run(
        input.employeeId,
        input.effectiveFrom,
        JSON.stringify(input.heads),
        input.reason.trim(),
        input.status,
        input.status === "approved" ? author : null,
        author,
      ).lastInsertRowid,
  );
  const after = listSalaryRevisions(db).find((row) => row.id === id)!;
  writeAudit(db, "salary_revision", id, "create", null, after);
  return after;
}

function addMonth(month: string, offset: number): string {
  const [y, m] = month.split("-").map(Number);
  const date = new Date(Date.UTC(y!, m! - 1 + offset, 1));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}
type LoanRow = {
  id: number;
  employeeId: number;
  employeeName: string;
  disbursedDate: string;
  principal: number;
  annualInterestBps: number;
  installmentAmount: number;
  firstDeductionMonth: string;
  status: EmployeeLoan["status"];
  note: string | null;
  createdBy: string;
  createdAt: string;
};
export function listEmployeeLoans(db: DB, employeeId?: number): EmployeeLoan[] {
  const loans = db
    .prepare(
      `SELECT l.id,l.employee_id AS employeeId,e.name AS employeeName,l.disbursed_date AS disbursedDate,l.principal,l.annual_interest_bps AS annualInterestBps,l.installment_amount AS installmentAmount,l.first_deduction_month AS firstDeductionMonth,l.status,l.note,l.created_by AS createdBy,l.created_at AS createdAt FROM employee_loans l JOIN employees e ON e.id=l.employee_id ${employeeId ? "WHERE l.employee_id=?" : ""} ORDER BY l.disbursed_date DESC,l.id DESC`,
    )
    .all(...(employeeId ? [employeeId] : [])) as LoanRow[];
  const installmentQuery = db.prepare(
    "SELECT id,month,principal,interest,payroll_run_id AS payrollRunId,status FROM employee_loan_installments WHERE loan_id=? ORDER BY month",
  );
  return loans.map((loan) => {
    const installments = installmentQuery.all(
      loan.id,
    ) as EmployeeLoan["installments"];
    const repaid = installments
      .filter((row) => row.status === "deducted" || row.status === "waived")
      .reduce((sum, row) => sum + row.principal, 0);
    return {
      ...loan,
      outstanding: Math.max(0, loan.principal - repaid),
      installments,
    };
  });
}

export function createEmployeeLoan(
  db: DB,
  input: {
    employeeId: number;
    disbursedDate: string;
    principal: number;
    annualInterestBps: number;
    installmentAmount: number;
    firstDeductionMonth: string;
    note?: string | null;
  },
  author: string,
): EmployeeLoan {
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(input.disbursedDate) ||
    !/^\d{4}-\d{2}$/.test(input.firstDeductionMonth)
  )
    throw new Error("Loan dates are invalid");
  if (
    !Number.isInteger(input.principal) ||
    input.principal <= 0 ||
    !Number.isInteger(input.installmentAmount) ||
    input.installmentAmount <= 0
  )
    throw new Error(
      "Loan and instalment amounts must be positive integer paise",
    );
  if (!Number.isInteger(input.annualInterestBps) || input.annualInterestBps < 0)
    throw new Error("Interest must be non-negative basis points");
  let id = 0;
  db.transaction(() => {
    id = Number(
      db
        .prepare(
          "INSERT INTO employee_loans(employee_id,disbursed_date,principal,annual_interest_bps,installment_amount,first_deduction_month,note,created_by) VALUES(?,?,?,?,?,?,?,?)",
        )
        .run(
          input.employeeId,
          input.disbursedDate,
          input.principal,
          input.annualInterestBps,
          input.installmentAmount,
          input.firstDeductionMonth,
          input.note ?? null,
          author,
        ).lastInsertRowid,
    );
    let outstanding = input.principal;
    const insert = db.prepare(
      "INSERT INTO employee_loan_installments(loan_id,month,principal,interest) VALUES(?,?,?,?)",
    );
    for (let index = 0; outstanding > 0 && index < 240; index++) {
      const interest = Math.round(
        (outstanding * input.annualInterestBps) / 120000,
      );
      const principal = Math.min(
        outstanding,
        Math.max(1, input.installmentAmount - interest),
      );
      insert.run(
        id,
        addMonth(input.firstDeductionMonth, index),
        principal,
        interest,
      );
      outstanding -= principal;
    }
    if (outstanding > 0)
      throw new Error(
        "Instalment is too small to amortize this loan within 20 years",
      );
  })();
  const after = listEmployeeLoans(db).find((row) => row.id === id)!;
  writeAudit(db, "employee_loan", id, "create", null, after);
  return after;
}

export function setLoanInstallmentStatus(
  db: DB,
  installmentId: number,
  status: "scheduled" | "paused" | "waived",
  author: string,
): EmployeeLoan {
  const row = db
    .prepare(
      "SELECT loan_id AS loanId,status,payroll_run_id AS payrollRunId FROM employee_loan_installments WHERE id=?",
    )
    .get(installmentId) as
    { loanId: number; status: string; payrollRunId: number | null } | undefined;
  if (!row) throw new Error("Loan instalment not found");
  if (row.payrollRunId || row.status === "deducted")
    throw new Error("A payroll-deducted instalment cannot be changed");
  db.prepare("UPDATE employee_loan_installments SET status=? WHERE id=?").run(
    status,
    installmentId,
  );
  const after = listEmployeeLoans(db).find((loan) => loan.id === row.loanId)!;
  writeAudit(
    db,
    "employee_loan",
    row.loanId,
    "update",
    { installmentId, status: row.status },
    { installmentId, status, author },
  );
  return after;
}

type ReimbursementRow = {
  id: number;
  employeeId: number;
  employeeName: string;
  claimDate: string;
  category: string;
  amount: number;
  taxable: number;
  description: string;
  attachmentPath: string | null;
  status: EmployeeReimbursement["status"];
  approvedBy: string | null;
  paymentVoucherId: number | null;
  createdAt: string;
};
const mapReimbursement = (row: ReimbursementRow): EmployeeReimbursement => ({
  ...row,
  taxable: !!row.taxable,
});
export function listReimbursements(
  db: DB,
  status?: EmployeeReimbursement["status"],
): EmployeeReimbursement[] {
  return (
    db
      .prepare(
        `SELECT r.id,r.employee_id AS employeeId,e.name AS employeeName,r.claim_date AS claimDate,r.category,r.amount,r.taxable,r.description,r.attachment_path AS attachmentPath,r.status,r.approved_by AS approvedBy,r.payment_voucher_id AS paymentVoucherId,r.created_at AS createdAt FROM employee_reimbursements r JOIN employees e ON e.id=r.employee_id ${status ? "WHERE r.status=?" : ""} ORDER BY r.claim_date DESC,r.id DESC`,
      )
      .all(...(status ? [status] : [])) as ReimbursementRow[]
  ).map(mapReimbursement);
}

export function submitReimbursement(
  db: DB,
  input: {
    employeeId: number;
    claimDate: string;
    category: string;
    amount: number;
    taxable: boolean;
    description: string;
    attachmentPath?: string | null;
  },
): EmployeeReimbursement {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.claimDate))
    throw new Error("Claim date must be YYYY-MM-DD");
  if (!Number.isInteger(input.amount) || input.amount <= 0)
    throw new Error("Claim amount must be positive integer paise");
  if (!input.category.trim() || !input.description.trim())
    throw new Error("Claim category and description are required");
  const id = Number(
    db
      .prepare(
        "INSERT INTO employee_reimbursements(employee_id,claim_date,category,amount,taxable,description,attachment_path) VALUES(?,?,?,?,?,?,?)",
      )
      .run(
        input.employeeId,
        input.claimDate,
        input.category.trim(),
        input.amount,
        +input.taxable,
        input.description.trim(),
        input.attachmentPath ?? null,
      ).lastInsertRowid,
  );
  const after = listReimbursements(db).find((row) => row.id === id)!;
  writeAudit(db, "employee_reimbursement", id, "create", null, after);
  return after;
}

export function decideReimbursement(
  db: DB,
  id: number,
  decision: "approved" | "rejected",
  author: string,
): EmployeeReimbursement {
  const before = listReimbursements(db).find((row) => row.id === id);
  if (!before) throw new Error("Reimbursement claim not found");
  if (before.status !== "submitted")
    throw new Error("Only submitted claims can be decided");
  db.prepare(
    "UPDATE employee_reimbursements SET status=?,approved_by=? WHERE id=?",
  ).run(decision, author, id);
  const after = listReimbursements(db).find((row) => row.id === id)!;
  writeAudit(db, "employee_reimbursement", id, "update", before, after);
  return after;
}

export function payReimbursement(
  db: DB,
  id: number,
  input: { date: string; bankLedgerId: number },
  author: string,
): EmployeeReimbursement {
  const before = listReimbursements(db).find((row) => row.id === id);
  if (!before) throw new Error("Reimbursement claim not found");
  if (before.status !== "approved")
    throw new Error("Only approved claims can be paid");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.date))
    throw new Error("Payment date must be YYYY-MM-DD");
  let voucherId = 0;
  db.transaction(() => {
    const payment = db
      .prepare(
        "SELECT id FROM voucher_types WHERE kind='payment' AND is_system=1",
      )
      .get() as { id: number };
    const expenseId = findOrCreateLedger(
      db,
      `Employee reimbursement — ${before.category}`,
      "Indirect Expenses",
    );
    const voucher = saveVoucher(db, {
      voucherTypeId: payment.id,
      date: input.date,
      number: undefined,
      partyLedgerId: null,
      narration: `${before.employeeName}: ${before.description}`,
      reference: `REIMB-${before.id}`,
      instrumentNo: null,
      instrumentDate: null,
      transporterId: null,
      vehicleNo: null,
      transportDistanceKm: null,
      currencyCode: null,
      exchangeRate: null,
      lines: [
        {
          ledgerId: expenseId,
          drCr: "dr",
          amount: before.amount,
          costAllocations: [],
        },
        {
          ledgerId: input.bankLedgerId,
          drCr: "cr",
          amount: before.amount,
          costAllocations: [],
        },
      ],
      inventory: [],
      billRefs: [],
      tds: null,
    });
    voucherId = voucher.id;
    db.prepare(
      "UPDATE employee_reimbursements SET status='paid',payment_voucher_id=? WHERE id=?",
    ).run(voucherId, id);
  })();
  const after = listReimbursements(db).find((row) => row.id === id)!;
  writeAudit(db, "employee_reimbursement", id, "update", before, {
    ...after,
    paidBy: author,
  });
  return after;
}

type ContractorRow = {
  id: number;
  name: string;
  pan: string | null;
  bankAccount: string | null;
  bankIfsc: string | null;
  tdsSectionId: number | null;
  tdsSectionCode: string | null;
  active: number;
};
const mapContractor = (row: ContractorRow): Contractor => ({
  ...row,
  active: !!row.active,
});

export function listContractors(db: DB): Contractor[] {
  return (
    db
      .prepare(
        `SELECT c.id,c.name,c.pan,c.bank_account AS bankAccount,c.bank_ifsc AS bankIfsc,
    c.tds_section_id AS tdsSectionId,s.code AS tdsSectionCode,c.active
    FROM contractors c LEFT JOIN tds_sections s ON s.id=c.tds_section_id ORDER BY c.name COLLATE NOCASE`,
      )
      .all() as ContractorRow[]
  ).map(mapContractor);
}

export function saveContractor(
  db: DB,
  input: {
    name: string;
    pan?: string | null;
    bankAccount?: string | null;
    bankIfsc?: string | null;
    tdsSectionId?: number | null;
    active: boolean;
  },
  id?: number,
): Contractor {
  if (!input.name.trim()) throw new Error("Contractor name is required");
  const before = id
    ? listContractors(db).find((row) => row.id === id)
    : undefined;
  if (id) {
    if (!before) throw new Error("Contractor not found");
    db.prepare(
      "UPDATE contractors SET name=?,pan=?,bank_account=?,bank_ifsc=?,tds_section_id=?,active=? WHERE id=?",
    ).run(
      input.name.trim(),
      input.pan ?? null,
      input.bankAccount ?? null,
      input.bankIfsc ?? null,
      input.tdsSectionId ?? null,
      +input.active,
      id,
    );
  } else {
    id = Number(
      db
        .prepare(
          "INSERT INTO contractors(name,pan,bank_account,bank_ifsc,tds_section_id,active) VALUES(?,?,?,?,?,?)",
        )
        .run(
          input.name.trim(),
          input.pan ?? null,
          input.bankAccount ?? null,
          input.bankIfsc ?? null,
          input.tdsSectionId ?? null,
          +input.active,
        ).lastInsertRowid,
    );
  }
  const ledgerId = findOrCreateLedger(
    db,
    input.name.trim(),
    "Sundry Creditors",
  );
  db.prepare("UPDATE ledgers SET pan=?,tds_section_id=? WHERE id=?").run(
    input.pan ?? null,
    input.tdsSectionId ?? null,
    ledgerId,
  );
  const after = listContractors(db).find((row) => row.id === id)!;
  writeAudit(
    db,
    "contractor",
    id,
    before ? "update" : "create",
    before ?? null,
    after,
  );
  return after;
}

type ContractorPaymentRow = {
  id: number;
  contractorId: number;
  contractorName: string;
  periodFrom: string;
  periodTo: string;
  gross: number;
  tds: number;
  voucherId: number | null;
  certificateNo: string | null;
  status: ContractorPayment["status"];
  note: string | null;
  createdBy: string;
  createdAt: string;
};
export function listContractorPayments(db: DB): ContractorPayment[] {
  return db
    .prepare(
      `SELECT p.id,p.contractor_id AS contractorId,c.name AS contractorName,p.period_from AS periodFrom,
    p.period_to AS periodTo,p.gross,p.tds,p.voucher_id AS voucherId,p.certificate_no AS certificateNo,p.status,
    p.note,p.created_by AS createdBy,p.created_at AS createdAt FROM contractor_payments p JOIN contractors c ON c.id=p.contractor_id
    ORDER BY p.period_to DESC,p.id DESC`,
    )
    .all() as ContractorPaymentRow[];
}

export function postContractorPayment(
  db: DB,
  input: {
    contractorId: number;
    periodFrom: string;
    periodTo: string;
    gross: number;
    bankLedgerId: number;
    date: string;
    note?: string | null;
  },
  author: string,
): ContractorPayment {
  const contractor = listContractors(db).find(
    (row) => row.id === input.contractorId,
  );
  if (!contractor?.active) throw new Error("Active contractor not found");
  if (!Number.isInteger(input.gross) || input.gross <= 0)
    throw new Error("Gross fee must be positive integer paise");
  for (const date of [input.periodFrom, input.periodTo, input.date])
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date))
      throw new Error("Contractor payment dates are invalid");
  if (input.periodFrom > input.periodTo)
    throw new Error("Work period is invalid");
  const partyLedgerId = findOrCreateLedger(
    db,
    contractor.name,
    "Sundry Creditors",
  );
  const suggestion = tdsSuggestion(db, partyLedgerId, input.gross, input.date);
  const tds = suggestion?.thresholdCrossed ? suggestion.tdsPaise : 0;
  let id = 0;
  db.transaction(() => {
    const payment = db
      .prepare(
        "SELECT id FROM voucher_types WHERE kind='journal' AND is_system=1",
      )
      .get() as { id: number };
    const expenseId = findOrCreateLedger(
      db,
      "Contract labour and professional fees",
      "Indirect Expenses",
    );
    const lines = [
      {
        ledgerId: expenseId,
        drCr: "dr" as const,
        amount: input.gross,
        costAllocations: [],
      },
      {
        ledgerId: input.bankLedgerId,
        drCr: "cr" as const,
        amount: input.gross - tds,
        costAllocations: [],
      },
    ];
    if (tds && suggestion)
      lines.push({
        ledgerId: suggestion.payableLedgerId,
        drCr: "cr",
        amount: tds,
        costAllocations: [],
      });
    const voucher = saveVoucher(db, {
      voucherTypeId: payment.id,
      date: input.date,
      number: undefined,
      partyLedgerId,
      narration: `Contractor fee: ${contractor.name}, ${input.periodFrom} to ${input.periodTo}`,
      reference: null,
      instrumentNo: null,
      instrumentDate: null,
      transporterId: null,
      vehicleNo: null,
      transportDistanceKm: null,
      currencyCode: null,
      exchangeRate: null,
      lines,
      inventory: [],
      billRefs: [],
      tds:
        suggestion && tds
          ? {
              sectionId: suggestion.sectionId,
              baseAmount: input.gross,
              tdsAmount: tds,
            }
          : null,
    });
    id = Number(
      db
        .prepare(
          "INSERT INTO contractor_payments(contractor_id,period_from,period_to,gross,tds,voucher_id,status,note,created_by) VALUES(?,?,?,?,?,?,'posted',?,?)",
        )
        .run(
          input.contractorId,
          input.periodFrom,
          input.periodTo,
          input.gross,
          tds,
          voucher.id,
          input.note ?? null,
          author,
        ).lastInsertRowid,
    );
  })();
  const after = listContractorPayments(db).find((row) => row.id === id)!;
  writeAudit(db, "contractor_payment", id, "create", null, after);
  return after;
}

export function previewFinalSettlement(
  db: DB,
  employeeId: number,
  lastWorkingDate: string,
): FinalSettlementPreview {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(lastWorkingDate))
    throw new Error("Last working date must be YYYY-MM-DD");
  const employee = db
    .prepare("SELECT joined,basic,hra,special FROM employees WHERE id=?")
    .get(employeeId) as
    | { joined: string | null; basic: number; hra: number; special: number }
    | undefined;
  if (!employee) throw new Error("Employee not found");
  const month = lastWorkingDate.slice(0, 7);
  const workedDay = Number(lastWorkingDate.slice(8, 10));
  const salaryDue = Math.round(
    ((employee.basic + employee.hra + employee.special) * workedDay) /
      daysInMonth(month),
  );
  let completedYears = 0;
  if (employee.joined) {
    const start = new Date(`${employee.joined}T00:00:00Z`);
    const end = new Date(`${lastWorkingDate}T00:00:00Z`);
    completedYears = end.getUTCFullYear() - start.getUTCFullYear();
    if (
      end.getUTCMonth() < start.getUTCMonth() ||
      (end.getUTCMonth() === start.getUTCMonth() &&
        end.getUTCDate() < start.getUTCDate())
    )
      completedYears--;
  }
  const gratuity =
    completedYears >= 5
      ? Math.round((employee.basic * 15 * completedYears) / 26)
      : 0;
  const outstandingAdvance = (
    db
      .prepare(
        `SELECT COALESCE(SUM(l.principal-COALESCE((SELECT SUM(i.principal) FROM employee_loan_installments i WHERE i.loan_id=l.id AND i.status IN ('deducted','waived')),0)),0) AS amount FROM employee_loans l WHERE l.employee_id=? AND l.status IN ('active','paused')`,
      )
      .get(employeeId) as { amount: number }
  ).amount;
  return {
    employeeId,
    lastWorkingDate,
    salaryDue,
    gratuity,
    outstandingAdvance,
    completedYears,
  };
}
type SettlementRow = {
  id: number;
  employeeId: number;
  employeeName: string;
  lastWorkingDate: string;
  salaryDue: number;
  noticePay: number;
  leaveEncashment: number;
  gratuity: number;
  recovery: number;
  advanceRecovery: number;
  netAmount: number;
  status: FinalSettlement["status"];
  voucherId: number | null;
  note: string | null;
  approvedBy: string | null;
  createdBy: string;
  createdAt: string;
};
export function listFinalSettlements(db: DB): FinalSettlement[] {
  return db
    .prepare(
      `SELECT s.id,s.employee_id AS employeeId,e.name AS employeeName,s.last_working_date AS lastWorkingDate,s.salary_due AS salaryDue,s.notice_pay AS noticePay,s.leave_encashment AS leaveEncashment,s.gratuity,s.recovery,s.advance_recovery AS advanceRecovery,s.net_amount AS netAmount,s.status,s.voucher_id AS voucherId,s.note,s.approved_by AS approvedBy,s.created_by AS createdBy,s.created_at AS createdAt FROM final_settlements s JOIN employees e ON e.id=s.employee_id ORDER BY s.last_working_date DESC,s.id DESC`,
    )
    .all() as SettlementRow[];
}
export function createFinalSettlement(
  db: DB,
  input: {
    employeeId: number;
    lastWorkingDate: string;
    salaryDue: number;
    noticePay: number;
    leaveEncashment: number;
    gratuity: number;
    recovery: number;
    advanceRecovery: number;
    note?: string | null;
  },
  author: string,
): FinalSettlement {
  for (const amount of [
    input.salaryDue,
    input.noticePay,
    input.leaveEncashment,
    input.gratuity,
    input.recovery,
    input.advanceRecovery,
  ])
    if (!Number.isInteger(amount) || amount < 0)
      throw new Error("Settlement amounts must be non-negative integer paise");
  const netAmount =
    input.salaryDue +
    input.noticePay +
    input.leaveEncashment +
    input.gratuity -
    input.recovery -
    input.advanceRecovery;
  if (netAmount < 0)
    throw new Error("Settlement recoveries exceed employee dues");
  const id = Number(
    db
      .prepare(
        `INSERT INTO final_settlements(employee_id,last_working_date,salary_due,notice_pay,leave_encashment,gratuity,recovery,advance_recovery,net_amount,note,created_by) VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        input.employeeId,
        input.lastWorkingDate,
        input.salaryDue,
        input.noticePay,
        input.leaveEncashment,
        input.gratuity,
        input.recovery,
        input.advanceRecovery,
        netAmount,
        input.note ?? null,
        author,
      ).lastInsertRowid,
  );
  const after = listFinalSettlements(db).find((row) => row.id === id)!;
  writeAudit(db, "final_settlement", id, "create", null, after);
  return after;
}
export function postFinalSettlement(
  db: DB,
  id: number,
  input: { date: string; bankLedgerId: number },
  author: string,
): FinalSettlement {
  const before = listFinalSettlements(db).find((row) => row.id === id);
  if (!before) throw new Error("Final settlement not found");
  if (before.status !== "draft")
    throw new Error("Only a draft settlement can be posted");
  let voucherId = 0;
  db.transaction(() => {
    const journal = db
      .prepare(
        "SELECT id FROM voucher_types WHERE kind='journal' AND is_system=1",
      )
      .get() as { id: number };
    const lines: {
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
      if (amount)
        lines.push({
          ledgerId: findOrCreateLedger(db, name, group),
          drCr,
          amount,
          costAllocations: [],
        });
    };
    push("Final salary expense", "Indirect Expenses", "dr", before.salaryDue);
    push("Notice pay expense", "Indirect Expenses", "dr", before.noticePay);
    push(
      "Leave encashment expense",
      "Indirect Expenses",
      "dr",
      before.leaveEncashment,
    );
    push("Gratuity expense", "Indirect Expenses", "dr", before.gratuity);
    push(
      "Employee settlement recoveries",
      "Indirect Incomes",
      "cr",
      before.recovery + before.advanceRecovery,
    );
    if (before.netAmount)
      lines.push({
        ledgerId: input.bankLedgerId,
        drCr: "cr",
        amount: before.netAmount,
        costAllocations: [],
      });
    const voucher = saveVoucher(db, {
      voucherTypeId: journal.id,
      date: input.date,
      number: undefined,
      partyLedgerId: null,
      narration: `Full and final settlement: ${before.employeeName}`,
      reference: `FNF-${before.id}`,
      instrumentNo: null,
      instrumentDate: null,
      transporterId: null,
      vehicleNo: null,
      transportDistanceKm: null,
      currencyCode: null,
      exchangeRate: null,
      lines,
      inventory: [],
      billRefs: [],
      tds: null,
    });
    voucherId = voucher.id;
    db.prepare(
      "UPDATE final_settlements SET status='posted',voucher_id=?,approved_by=? WHERE id=?",
    ).run(voucherId, author, id);
    db.prepare("UPDATE employees SET active=0,exit_date=? WHERE id=?").run(
      before.lastWorkingDate,
      before.employeeId,
    );
    db.prepare(
      "UPDATE employee_loans SET status='settled' WHERE employee_id=? AND status IN ('active','paused')",
    ).run(before.employeeId);
  })();
  const after = listFinalSettlements(db).find((row) => row.id === id)!;
  writeAudit(db, "final_settlement", id, "update", before, after);
  return after;
}
