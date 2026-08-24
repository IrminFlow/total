import { createHash } from "crypto";
import type { DB } from "../db/connection";
import { parseCsv } from "@shared/csv";
import type {
  DepartmentPayrollRow,
  ProvisioningKind,
  ProvisioningPreview,
  ProvisioningRow,
  ShiftAssignment,
  ShiftRule,
  StatutoryKind,
  StatutoryWorkspaceRow,
  WorkforceHoliday,
} from "@shared/workforceOps";
import { writeAudit } from "./audit";
import { saveEmployee } from "./payroll";
import { PT_STATES, type PtState } from "@shared/payroll";

const STATUTORY_LABELS: Record<StatutoryKind, string> = {
  pf: "Provident fund",
  esi: "Employee state insurance",
  pt: "Professional tax",
  tds: "Tax deducted at source",
};

export function statutoryWorkspace(
  db: DB,
  month: string,
): StatutoryWorkspaceRow[] {
  const payroll = db
    .prepare(
      `SELECT
    COALESCE(SUM(pl.pf_emp+pl.pf_er+pl.pf_admin+pl.edli),0) AS pf,
    COALESCE(SUM(pl.esi_emp+pl.esi_er),0) AS esi,COALESCE(SUM(pl.pt),0) AS pt
    FROM payroll_lines pl JOIN payroll_runs pr ON pr.id=pl.run_id WHERE pr.month=?`,
    )
    .get(month) as { pf: number; esi: number; pt: number };
  const tds = (
    db
      .prepare(
        `SELECT COALESCE(SUM(te.tds_amount),0) AS amount FROM tds_entries te JOIN vouchers v ON v.id=te.voucher_id WHERE substr(v.date,1,7)=? AND v.deleted_at IS NULL AND v.is_optional=0`,
      )
      .get(month) as { amount: number }
  ).amount;
  const due: Record<StatutoryKind, number> = {
    pf: payroll.pf,
    esi: payroll.esi,
    pt: payroll.pt,
    tds,
  };
  const challans = db
    .prepare(
      "SELECT kind,amount,paid_date AS paidDate,reference,status,filed_reference AS filedReference FROM payroll_statutory_challans WHERE month=?",
    )
    .all(month) as {
    kind: StatutoryKind;
    amount: number;
    paidDate: string | null;
    reference: string | null;
    status: "due" | "paid" | "filed";
    filedReference: string | null;
  }[];
  const byKind = new Map(challans.map((row) => [row.kind, row]));
  return (Object.keys(STATUTORY_LABELS) as StatutoryKind[]).map((kind) => {
    const challan = byKind.get(kind);
    const challanAmount = challan?.amount ?? 0;
    const difference = challanAmount - due[kind];
    return {
      month,
      kind,
      label: STATUTORY_LABELS[kind],
      booksAmount: due[kind],
      challanAmount,
      difference,
      status: challan?.status ?? "due",
      paidDate: challan?.paidDate ?? null,
      reference: challan?.reference ?? null,
      filedReference: challan?.filedReference ?? null,
      reconciled:
        due[kind] > 0 &&
        difference === 0 &&
        (challan?.status === "paid" || challan?.status === "filed"),
    };
  });
}

export function saveStatutoryChallan(
  db: DB,
  input: {
    month: string;
    kind: StatutoryKind;
    amount: number;
    paidDate?: string | null;
    reference?: string | null;
    status: "due" | "paid" | "filed";
    filedReference?: string | null;
  },
  author: string,
): StatutoryWorkspaceRow {
  if (
    !/^\d{4}-\d{2}$/.test(input.month) ||
    !Number.isInteger(input.amount) ||
    input.amount < 0
  )
    throw new Error("Invalid challan period or amount");
  if (input.status !== "due" && (!input.paidDate || !input.reference?.trim()))
    throw new Error("Paid challans require a payment date and reference");
  if (input.status === "filed" && !input.filedReference?.trim())
    throw new Error("Filed challans require a filing reference");
  const before = statutoryWorkspace(db, input.month).find(
    (row) => row.kind === input.kind,
  )!;
  db.prepare(
    `INSERT INTO payroll_statutory_challans(month,kind,amount,paid_date,reference,status,filed_reference,created_by) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(month,kind) DO UPDATE SET amount=excluded.amount,paid_date=excluded.paid_date,reference=excluded.reference,status=excluded.status,filed_reference=excluded.filed_reference`,
  ).run(
    input.month,
    input.kind,
    input.amount,
    input.paidDate ?? null,
    input.reference?.trim() || null,
    input.status,
    input.filedReference?.trim() || null,
    author,
  );
  const after = statutoryWorkspace(db, input.month).find(
    (row) => row.kind === input.kind,
  )!;
  const id = (
    db
      .prepare(
        "SELECT id FROM payroll_statutory_challans WHERE month=? AND kind=?",
      )
      .get(input.month, input.kind) as { id: number }
  ).id;
  writeAudit(
    db,
    "payroll_statutory_challan",
    id,
    before.challanAmount ? "update" : "create",
    before,
    after,
  );
  return after;
}

type ShiftRow = {
  id: number;
  name: string;
  workMinutes: number;
  weeklyOffDay: number;
  overtimeAfterMinutes: number;
  overtimeRateBps: number;
  active: number;
};
const mapShift = (row: ShiftRow): ShiftRule => ({
  ...row,
  active: !!row.active,
});
export function listShiftRules(db: DB): ShiftRule[] {
  return (
    db
      .prepare(
        "SELECT id,name,work_minutes AS workMinutes,weekly_off_day AS weeklyOffDay,overtime_after_minutes AS overtimeAfterMinutes,overtime_rate_bps AS overtimeRateBps,active FROM shift_rules ORDER BY name",
      )
      .all() as ShiftRow[]
  ).map(mapShift);
}
export function saveShiftRule(
  db: DB,
  input: Omit<ShiftRule, "id">,
  id?: number,
): ShiftRule {
  if (
    !input.name.trim() ||
    !Number.isInteger(input.workMinutes) ||
    input.workMinutes <= 0 ||
    !Number.isInteger(input.overtimeAfterMinutes) ||
    input.overtimeAfterMinutes < 0
  )
    throw new Error("Shift name and valid work minutes are required");
  const before = id
    ? listShiftRules(db).find((row) => row.id === id)
    : undefined;
  if (id) {
    if (!before) throw new Error("Shift rule not found");
    db.prepare(
      "UPDATE shift_rules SET name=?,work_minutes=?,weekly_off_day=?,overtime_after_minutes=?,overtime_rate_bps=?,active=? WHERE id=?",
    ).run(
      input.name.trim(),
      input.workMinutes,
      input.weeklyOffDay,
      input.overtimeAfterMinutes,
      input.overtimeRateBps,
      +input.active,
      id,
    );
  } else {
    id = Number(
      db
        .prepare(
          "INSERT INTO shift_rules(name,work_minutes,weekly_off_day,overtime_after_minutes,overtime_rate_bps,active) VALUES(?,?,?,?,?,?)",
        )
        .run(
          input.name.trim(),
          input.workMinutes,
          input.weeklyOffDay,
          input.overtimeAfterMinutes,
          input.overtimeRateBps,
          +input.active,
        ).lastInsertRowid,
    );
  }
  const after = mapShift(
    db
      .prepare(
        "SELECT id,name,work_minutes AS workMinutes,weekly_off_day AS weeklyOffDay,overtime_after_minutes AS overtimeAfterMinutes,overtime_rate_bps AS overtimeRateBps,active FROM shift_rules WHERE id=?",
      )
      .get(id) as ShiftRow,
  );
  writeAudit(
    db,
    "shift_rule",
    id,
    before ? "update" : "create",
    before ?? null,
    after,
  );
  return after;
}
export function listShiftAssignments(db: DB): ShiftAssignment[] {
  return db
    .prepare(
      `SELECT a.id,a.employee_id AS employeeId,e.name AS employeeName,a.shift_rule_id AS shiftRuleId,s.name AS shiftRuleName,a.effective_from AS effectiveFrom,a.effective_to AS effectiveTo FROM employee_shift_assignments a JOIN employees e ON e.id=a.employee_id JOIN shift_rules s ON s.id=a.shift_rule_id ORDER BY a.effective_from DESC`,
    )
    .all() as ShiftAssignment[];
}
export function assignShift(
  db: DB,
  input: {
    employeeId: number;
    shiftRuleId: number;
    effectiveFrom: string;
    effectiveTo?: string | null;
  },
): ShiftAssignment {
  if (input.effectiveTo && input.effectiveTo < input.effectiveFrom)
    throw new Error("Shift assignment end date precedes its start");
  const returned = db
    .prepare(
      "INSERT INTO employee_shift_assignments(employee_id,shift_rule_id,effective_from,effective_to) VALUES(?,?,?,?) ON CONFLICT(employee_id,effective_from) DO UPDATE SET shift_rule_id=excluded.shift_rule_id,effective_to=excluded.effective_to RETURNING id",
    )
    .get(
      input.employeeId,
      input.shiftRuleId,
      input.effectiveFrom,
      input.effectiveTo ?? null,
    ) as { id: number };
  const id = returned.id;
  const after = listShiftAssignments(db).find((row) => row.id === id)!;
  writeAudit(db, "shift_assignment", id, "create", null, after);
  return after;
}
export function listHolidays(
  db: DB,
  from: string,
  to: string,
): WorkforceHoliday[] {
  return db
    .prepare(
      "SELECT id,date,name,department FROM workforce_holidays WHERE date BETWEEN ? AND ? ORDER BY date,department",
    )
    .all(from, to) as WorkforceHoliday[];
}
export function saveHoliday(
  db: DB,
  input: { date: string; name: string; department?: string },
): WorkforceHoliday {
  const department = input.department?.trim() ?? "";
  const id = Number(
    (
      db
        .prepare(
          "INSERT INTO workforce_holidays(date,name,department) VALUES(?,?,?) ON CONFLICT(date,department) DO UPDATE SET name=excluded.name RETURNING id",
        )
        .get(input.date, input.name.trim(), department) as { id: number }
    ).id,
  );
  const after = db
    .prepare(
      "SELECT id,date,name,department FROM workforce_holidays WHERE id=?",
    )
    .get(id) as WorkforceHoliday;
  writeAudit(db, "workforce_holiday", id, "create", null, after);
  return after;
}

export function departmentPayrollAnalysis(
  db: DB,
  fromMonth: string,
  toMonth: string,
): DepartmentPayrollRow[] {
  const priorFrom = `${Number(fromMonth.slice(0, 4)) - 1}${fromMonth.slice(4)}`;
  const priorTo = `${Number(toMonth.slice(0, 4)) - 1}${toMonth.slice(4)}`;
  const query = (from: string, to: string) =>
    db
      .prepare(
        `SELECT COALESCE(NULLIF(pl.department,''),'General') AS department,COUNT(DISTINCT pl.employee_id) AS headcount,SUM(pl.gross) AS gross,SUM(pl.overtime_minutes) AS overtimeMinutes,SUM(pl.overtime_amount) AS overtimeAmount,SUM(pl.pf_er+pl.esi_er+pl.pf_admin+pl.edli) AS employerCost,SUM(pl.net) AS netPay FROM payroll_lines pl JOIN payroll_runs pr ON pr.id=pl.run_id WHERE pr.month BETWEEN ? AND ? GROUP BY COALESCE(NULLIF(pl.department,''),'General')`,
      )
      .all(from, to) as Omit<
      DepartmentPayrollRow,
      "priorGross" | "grossChange"
    >[];
  const current = query(fromMonth, toMonth);
  const prior = new Map(
    query(priorFrom, priorTo).map((row) => [row.department, row.gross]),
  );
  return current.map((row) => {
    const priorGross = prior.get(row.department) ?? 0;
    return {
      ...row,
      priorGross,
      grossChange: priorGross
        ? Math.round(((row.gross - priorGross) * 10000) / priorGross) / 100
        : null,
    };
  });
}

function normalizedHeaders(cells: string[]): string[] {
  return cells.map((cell) =>
    cell
      .trim()
      .toLowerCase()
      .replace(/[\s-]+/g, "_"),
  );
}
export function previewProvisioning(
  db: DB,
  kind: ProvisioningKind,
  sourceName: string,
  csvText: string,
): ProvisioningPreview {
  const sourceHash = createHash("sha256").update(csvText).digest("hex");
  const records = parseCsv(csvText.replace(/^\uFEFF/, ""));
  if (records.length < 2)
    throw new Error("Provisioning CSV needs a header and at least one row");
  const headers = normalizedHeaders(records[0]!.cells);
  const index = (name: string) => headers.indexOf(name);
  const codeIndex = index("employee_code");
  const effectiveIndex = index("effective_date");
  const nameIndex = index("name");
  if (
    codeIndex < 0 ||
    effectiveIndex < 0 ||
    (kind === "joiners" && nameIndex < 0)
  )
    throw new Error(
      `${kind === "joiners" ? "Joiner" : "Leaver"} CSV needs employee_code, effective_date${kind === "joiners" ? " and name" : ""}`,
    );
  const employees = db
    .prepare("SELECT id,code,active FROM employees WHERE code IS NOT NULL")
    .all() as { id: number; code: string; active: number }[];
  const byCode = new Map(
    employees.map((employee) => [employee.code.toLowerCase(), employee]),
  );
  const seen = new Set<string>();
  const rows: ProvisioningRow[] = records.slice(1).map((record) => {
    const data = Object.fromEntries(
      headers.map((header, i) => [header, record.cells[i]?.trim() ?? ""]),
    );
    const employeeCode = record.cells[codeIndex]?.trim() ?? "";
    const effectiveDate = record.cells[effectiveIndex]?.trim() || null;
    const name =
      kind === "joiners" ? record.cells[nameIndex]?.trim() || null : null;
    let status: ProvisioningRow["status"] = "valid";
    let message: string | null = null;
    if (!employeeCode) {
      status = "error";
      message = "Employee code is blank";
    } else if (seen.has(employeeCode.toLowerCase())) {
      status = "error";
      message = "Duplicate employee code in this file";
    } else if (!effectiveDate || !/^\d{4}-\d{2}-\d{2}$/.test(effectiveDate)) {
      status = "error";
      message = "Effective date must be YYYY-MM-DD";
    } else if (kind === "joiners" && byCode.has(employeeCode.toLowerCase())) {
      status = "error";
      message = "Employee code already exists";
    } else if (kind === "joiners" && !name) {
      status = "error";
      message = "Employee name is blank";
    } else if (
      kind === "leavers" &&
      !byCode.get(employeeCode.toLowerCase())?.active
    ) {
      status = "error";
      message = "No active employee matches this code";
    }
    seen.add(employeeCode.toLowerCase());
    return {
      sourceRow: record.line,
      employeeCode,
      name,
      effectiveDate,
      data,
      status,
      message,
    };
  });
  return {
    kind,
    sourceName,
    sourceHash,
    rows,
    validCount: rows.filter((row) => row.status === "valid").length,
    warningCount: rows.filter((row) => row.status === "warning").length,
    errorCount: rows.filter((row) => row.status === "error").length,
    alreadyImported: !!db
      .prepare("SELECT 1 FROM workforce_import_batches WHERE source_hash=?")
      .get(sourceHash),
  };
}

const paise = (value?: string): number =>
  Math.round((Number(value) || 0) * 100);
export function applyProvisioning(
  db: DB,
  kind: ProvisioningKind,
  sourceName: string,
  csvText: string,
  author: string,
): ProvisioningPreview {
  const preview = previewProvisioning(db, kind, sourceName, csvText);
  if (preview.alreadyImported)
    throw new Error("This workforce file has already been imported");
  if (preview.errorCount)
    throw new Error(
      `Resolve ${preview.errorCount} provisioning error(s) before applying`,
    );
  db.transaction(() => {
    const batchId = Number(
      db
        .prepare(
          "INSERT INTO workforce_import_batches(kind,source_name,source_hash,status,created_by) VALUES(?,?,?,'applied',?)",
        )
        .run(kind, sourceName, preview.sourceHash, author).lastInsertRowid,
    );
    for (const row of preview.rows) {
      db.prepare(
        "INSERT INTO workforce_import_rows(batch_id,source_row,employee_code,data_json,status,message) VALUES(?,?,?,?,?,?)",
      ).run(
        batchId,
        row.sourceRow,
        row.employeeCode,
        JSON.stringify(row.data),
        "applied",
        row.message,
      );
      if (kind === "joiners")
        saveEmployee(db, {
          name: row.name!,
          code: row.employeeCode,
          designation: row.data.designation || null,
          joined: row.effectiveDate,
          pan: row.data.pan || null,
          uan: row.data.uan || null,
          esicNo: row.data.esic_no || null,
          bankAccount: row.data.bank_account || null,
          bankIfsc: row.data.bank_ifsc || null,
          department: row.data.department || null,
          exitDate: null,
          basic: paise(row.data.basic),
          hra: paise(row.data.hra),
          special: paise(row.data.special),
          pfEnabled: row.data.pf_enabled !== "false",
          esiEnabled: row.data.esi_enabled !== "false",
          ptEnabled: row.data.pt_enabled !== "false",
          ptState: PT_STATES.includes(row.data.pt_state as PtState)
            ? (row.data.pt_state as PtState)
            : "MH",
          active: true,
        });
      else
        db.prepare(
          "UPDATE employees SET active=0,exit_date=? WHERE lower(code)=lower(?)",
        ).run(row.effectiveDate, row.employeeCode);
    }
    writeAudit(db, "workforce_import", batchId, "import", null, {
      kind,
      sourceName,
      rows: preview.rows.length,
    });
  })();
  return preview;
}
