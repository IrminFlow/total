import { describe, expect, it } from "vitest";
import { seededDb } from "../db/testdb";
import type { EmployeeInput } from "@shared/schemas";
import { commitRun, previewRun, saveEmployee } from "./payroll";
import { saveAttendance } from "./workforce";
import {
  applyProvisioning,
  assignShift,
  departmentPayrollAnalysis,
  listHolidays,
  listShiftAssignments,
  previewProvisioning,
  saveHoliday,
  saveShiftRule,
  saveStatutoryChallan,
  statutoryWorkspace,
} from "./workforceOperations";

const employee = (code: string, department = "Operations"): EmployeeInput => ({
  name: code === "E001" ? "Asha" : "Ravi",
  code,
  designation: null,
  joined: "2025-04-01",
  pan: "ABCDE1234F",
  uan: "100123456789",
  esicNo: "1234567890",
  bankAccount: "123456789",
  bankIfsc: "HDFC0001234",
  department,
  exitDate: null,
  basic: 26_000_00,
  hra: 0,
  special: 0,
  pfEnabled: true,
  esiEnabled: false,
  ptEnabled: true,
  ptState: "MH",
  active: true,
});

describe("payroll statutory workspace", () => {
  it("derives dues from posted payroll and reconciles exact paid/filed challans", () => {
    const db = seededDb();
    saveEmployee(db, employee("E001"));
    commitRun(db, "2026-08", []);
    const pf = statutoryWorkspace(db, "2026-08").find(
      (row) => row.kind === "pf",
    )!;
    expect(pf.booksAmount).toBeGreaterThan(0);
    expect(pf.reconciled).toBe(false);
    const paid = saveStatutoryChallan(
      db,
      {
        month: "2026-08",
        kind: "pf",
        amount: pf.booksAmount,
        paidDate: "2026-09-10",
        reference: "CP-001",
        status: "filed",
        filedReference: "ECR-ACK-01",
      },
      "Owner",
    );
    expect(paid).toMatchObject({
      difference: 0,
      reconciled: true,
      status: "filed",
    });
    expect(() =>
      saveStatutoryChallan(
        db,
        { month: "2026-08", kind: "esi", amount: 0, status: "paid" },
        "Owner",
      ),
    ).toThrow(/payment date/);
  });
});

describe("shift, overtime and department analysis", () => {
  it("applies the effective shift rate to approved overtime and snapshots department on posting", () => {
    const db = seededDb();
    const asha = saveEmployee(db, employee("E001", "Plant"));
    const shift = saveShiftRule(db, {
      name: "General 8h",
      workMinutes: 480,
      weeklyOffDay: 0,
      overtimeAfterMinutes: 480,
      overtimeRateBps: 15000,
      active: true,
    });
    assignShift(db, {
      employeeId: asha.id,
      shiftRuleId: shift.id,
      effectiveFrom: "2026-04-01",
    });
    saveAttendance(
      db,
      {
        employeeId: asha.id,
        month: "2026-08",
        payableDays: 31,
        presentDays: 31,
        leaveDays: 0,
        unpaidDays: 0,
        overtimeMinutes: 120,
        status: "approved",
      },
      "Owner",
    );
    const line = previewRun(db, "2026-08", [])[0]!;
    expect(line.overtimeAmount).toBe(37_500);
    expect(line.otherEarnings).toBe(37_500);
    const run = commitRun(db, "2026-08", []);
    expect(run.lines[0]).toMatchObject({
      overtimeMinutes: 120,
      overtimeAmount: 37_500,
      department: "Plant",
    });
    expect(
      departmentPayrollAnalysis(db, "2026-08", "2026-08")[0],
    ).toMatchObject({
      department: "Plant",
      headcount: 1,
      overtimeMinutes: 120,
      overtimeAmount: 37_500,
    });
    expect(listShiftAssignments(db)).toHaveLength(1);
  });
  it("stores department-scoped holidays without changing vouchers", () => {
    const db = seededDb();
    saveHoliday(db, { date: "2026-08-15", name: "Independence Day" });
    saveHoliday(db, {
      date: "2026-09-17",
      name: "Plant shutdown",
      department: "Plant",
    });
    expect(listHolidays(db, "2026-08-01", "2026-09-30")).toHaveLength(2);
  });
});

describe("workforce provisioning", () => {
  it("previews and atomically applies joiners, then exits them through a leaver batch", () => {
    const db = seededDb();
    const joiners =
      "employee_code,name,effective_date,department,designation,basic,hra,special,pt_state\nE101,Neha Shah,2026-09-01,Sales,Executive,30000,12000,3000,MH";
    const preview = previewProvisioning(db, "joiners", "joiners.csv", joiners);
    expect(preview).toMatchObject({
      validCount: 1,
      errorCount: 0,
      alreadyImported: false,
    });
    applyProvisioning(db, "joiners", "joiners.csv", joiners, "Owner");
    const neha = db
      .prepare(
        "SELECT active,basic,department FROM employees WHERE code='E101'",
      )
      .get();
    expect(neha).toEqual({ active: 1, basic: 3_000_000, department: "Sales" });
    expect(() =>
      applyProvisioning(db, "joiners", "copy.csv", joiners, "Owner"),
    ).toThrow(/already been imported/);
    const leavers = "employee_code,effective_date\nE101,2026-12-31";
    applyProvisioning(db, "leavers", "leavers.csv", leavers, "Owner");
    expect(
      db
        .prepare(
          "SELECT active,exit_date AS exitDate FROM employees WHERE code='E101'",
        )
        .get(),
    ).toEqual({ active: 0, exitDate: "2026-12-31" });
  });
  it("isolates duplicate codes and unknown leavers before writing", () => {
    const db = seededDb();
    const csv =
      "employee_code,effective_date\nMISSING,2026-09-01\nMISSING,2026-09-02";
    const preview = previewProvisioning(db, "leavers", "bad.csv", csv);
    expect(preview.errorCount).toBe(2);
    expect(() =>
      applyProvisioning(db, "leavers", "bad.csv", csv, "Owner"),
    ).toThrow(/Resolve 2/);
    expect(
      (
        db
          .prepare("SELECT COUNT(*) AS n FROM workforce_import_batches")
          .get() as { n: number }
      ).n,
    ).toBe(0);
  });
});
