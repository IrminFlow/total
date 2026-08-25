import { describe, expect, it } from "vitest";
import { seededDb } from "../db/testdb";
import { commitRun, deleteRun, saveEmployee } from "./payroll";
import { previewRun } from "./payroll";
import type { EmployeeInput } from "@shared/schemas";
import {
  applyAttendanceImport,
  approveAttendanceMonth,
  attendanceSummary,
  listAttendance,
  previewAttendanceImport,
  saveAttendance,
} from "./workforce";
import {
  leaveBalances,
  listSalaryRevisions,
  recordLeave,
  saveLeaveType,
  saveSalaryRevision,
} from "./workforce";
import {
  createEmployeeLoan,
  listEmployeeLoans,
  setLoanInstallmentStatus,
} from "./workforce";
import {
  decideReimbursement,
  listReimbursements,
  payReimbursement,
  submitReimbursement,
} from "./workforce";
import {
  listContractorPayments,
  postContractorPayment,
  saveContractor,
} from "./workforce";
import {
  createFinalSettlement,
  postFinalSettlement,
  previewFinalSettlement,
} from "./workforce";

const employee = (code: string, name: string): EmployeeInput => ({
  name,
  code,
  designation: null,
  joined: null,
  pan: null,
  uan: null,
  esicNo: null,
  bankAccount: null,
  bankIfsc: null,
  department: null,
  exitDate: null,
  basic: 20_000_00,
  hra: 8_000_00,
  special: 4_000_00,
  pfEnabled: true,
  esiEnabled: true,
  ptEnabled: true,
  ptState: "MH",
  active: true,
});

describe("contractor payments", () => {
  it("posts net cash plus TDS and feeds the statutory TDS register", () => {
    const db = seededDb();
    const section = db
      .prepare("SELECT id FROM tds_sections WHERE code='194C'")
      .get() as { id: number };
    const contractor = saveContractor(db, {
      name: "Build Right Services",
      pan: "ABCDE1234F",
      tdsSectionId: section.id,
      active: true,
    });
    const cash = db
      .prepare("SELECT id FROM ledgers WHERE name='Cash'")
      .get() as { id: number };
    const payment = postContractorPayment(
      db,
      {
        contractorId: contractor.id,
        periodFrom: "2026-08-01",
        periodTo: "2026-08-31",
        date: "2026-08-31",
        gross: 40_000_00,
        bankLedgerId: cash.id,
      },
      "Owner",
    );
    expect(payment).toMatchObject({
      gross: 40_000_00,
      tds: 80_000,
      status: "posted",
    });
    expect(
      (
        db
          .prepare("SELECT COUNT(*) AS n FROM tds_entries WHERE voucher_id=?")
          .get(payment.voucherId) as { n: number }
      ).n,
    ).toBe(1);
    const totals = db
      .prepare(
        "SELECT SUM(CASE WHEN dr_cr='dr' THEN amount ELSE 0 END) AS dr,SUM(CASE WHEN dr_cr='cr' THEN amount ELSE 0 END) AS cr FROM voucher_lines WHERE voucher_id=?",
      )
      .get(payment.voucherId) as { dr: number; cr: number };
    expect(totals.dr).toBe(totals.cr);
    expect(listContractorPayments(db)).toHaveLength(1);
  });
  it("does not deduct below the configured threshold", () => {
    const db = seededDb();
    const section = db
      .prepare("SELECT id FROM tds_sections WHERE code='194C'")
      .get() as { id: number };
    const contractor = saveContractor(db, {
      name: "Small Works",
      pan: "ABCDE1234F",
      tdsSectionId: section.id,
      active: true,
    });
    const cash = db
      .prepare("SELECT id FROM ledgers WHERE name='Cash'")
      .get() as { id: number };
    expect(
      postContractorPayment(
        db,
        {
          contractorId: contractor.id,
          periodFrom: "2026-08-01",
          periodTo: "2026-08-10",
          date: "2026-08-10",
          gross: 20_000_00,
          bankLedgerId: cash.id,
        },
        "Owner",
      ).tds,
    ).toBe(0);
  });
});

describe("employee reimbursements", () => {
  it("moves a supported claim through approval into a balanced payment voucher", () => {
    const db = seededDb();
    const asha = saveEmployee(db, employee("E001", "Asha"));
    const claim = submitReimbursement(db, {
      employeeId: asha.id,
      claimDate: "2026-08-12",
      category: "Travel",
      amount: 1_250_00,
      taxable: false,
      description: "Client-site taxi",
    });
    expect(claim.status).toBe("submitted");
    expect(
      decideReimbursement(db, claim.id, "approved", "Manager").approvedBy,
    ).toBe("Manager");
    const bank = db
      .prepare("SELECT id FROM ledgers WHERE name='Cash'")
      .get() as { id: number };
    const paid = payReimbursement(
      db,
      claim.id,
      { date: "2026-08-15", bankLedgerId: bank.id },
      "Owner",
    );
    expect(paid.status).toBe("paid");
    expect(paid.paymentVoucherId).toBeTruthy();
    const totals = db
      .prepare(
        "SELECT SUM(CASE WHEN dr_cr='dr' THEN amount ELSE 0 END) AS dr,SUM(CASE WHEN dr_cr='cr' THEN amount ELSE 0 END) AS cr FROM voucher_lines WHERE voucher_id=?",
      )
      .get(paid.paymentVoucherId) as { dr: number; cr: number };
    expect(totals.dr).toBe(totals.cr);
    expect(listReimbursements(db, "paid")).toHaveLength(1);
  });
  it("does not pay unapproved or repeatedly decided claims", () => {
    const db = seededDb();
    const asha = saveEmployee(db, employee("E001", "Asha"));
    const claim = submitReimbursement(db, {
      employeeId: asha.id,
      claimDate: "2026-08-12",
      category: "Meals",
      amount: 500_00,
      taxable: true,
      description: "Customer meeting",
    });
    const bank = db
      .prepare("SELECT id FROM ledgers WHERE name='Cash'")
      .get() as { id: number };
    expect(() =>
      payReimbursement(
        db,
        claim.id,
        { date: "2026-08-15", bankLedgerId: bank.id },
        "Owner",
      ),
    ).toThrow(/approved/);
    decideReimbursement(db, claim.id, "rejected", "Manager");
    expect(() =>
      decideReimbursement(db, claim.id, "approved", "Owner"),
    ).toThrow(/submitted/);
  });
});

describe("employee loans", () => {
  it("creates a reducing-balance schedule and deducts the due instalment through payroll", () => {
    const db = seededDb();
    const asha = saveEmployee(db, employee("E001", "Asha"));
    const loan = createEmployeeLoan(
      db,
      {
        employeeId: asha.id,
        disbursedDate: "2026-07-01",
        principal: 10_000_00,
        annualInterestBps: 1200,
        installmentAmount: 2_100_00,
        firstDeductionMonth: "2026-08",
      },
      "Owner",
    );
    expect(loan.installments[0]).toMatchObject({
      month: "2026-08",
      principal: 2_000_00,
      interest: 10_000,
      status: "scheduled",
    });
    const ordinary = previewRun(db, "2026-07", [])[0]!;
    const withLoan = previewRun(db, "2026-08", [])[0]!;
    expect(ordinary.net - withLoan.net).toBe(2_100_00);
    const partialAttendance = previewRun(db, "2026-08", [
      { employeeId: asha.id, payableDays: 15 },
    ])[0]!;
    expect(partialAttendance.headAmounts).toContainEqual({
      name: "Employee loan instalment",
      kind: "deduction",
      amount: 2_100_00,
    });
    const run = commitRun(db, "2026-08", []);
    expect(listEmployeeLoans(db, asha.id)[0]!.installments[0]).toMatchObject({
      status: "deducted",
      payrollRunId: run.id,
    });
    deleteRun(db, run.id);
    expect(listEmployeeLoans(db, asha.id)[0]!.installments[0]).toMatchObject({
      status: "scheduled",
      payrollRunId: null,
    });
  });

  it("allows a future instalment to be paused but not a deducted instalment", () => {
    const db = seededDb();
    const asha = saveEmployee(db, employee("E001", "Asha"));
    const loan = createEmployeeLoan(
      db,
      {
        employeeId: asha.id,
        disbursedDate: "2026-07-01",
        principal: 4_000_00,
        annualInterestBps: 0,
        installmentAmount: 2_000_00,
        firstDeductionMonth: "2026-08",
      },
      "Owner",
    );
    expect(
      setLoanInstallmentStatus(db, loan.installments[1]!.id, "paused", "Owner")
        .installments[1]!.status,
    ).toBe("paused");
    const run = commitRun(db, "2026-08", []);
    expect(() =>
      setLoanInstallmentStatus(db, loan.installments[0]!.id, "waived", "Owner"),
    ).toThrow(/cannot be changed/);
    expect(run.lines[0]!.otherDeductions).toBe(2_000_00);
  });

  it("deducts only instalments for employees included in the payroll run", () => {
    const db = seededDb();
    const included = saveEmployee(db, employee("E001", "Asha"));
    const excluded = saveEmployee(db, employee("E002", "Ravi"));
    const includedLoan = createEmployeeLoan(
      db,
      {
        employeeId: included.id,
        disbursedDate: "2026-07-01",
        principal: 2_000_00,
        annualInterestBps: 0,
        installmentAmount: 2_000_00,
        firstDeductionMonth: "2026-08",
      },
      "Owner",
    );
    const excludedLoan = createEmployeeLoan(
      db,
      {
        employeeId: excluded.id,
        disbursedDate: "2026-07-01",
        principal: 2_000_00,
        annualInterestBps: 0,
        installmentAmount: 2_000_00,
        firstDeductionMonth: "2026-08",
      },
      "Owner",
    );
    saveEmployee(db, { ...employee("E002", "Ravi"), active: false }, excluded.id);

    const run = commitRun(db, "2026-08", []);

    expect(listEmployeeLoans(db, included.id)[0]!.installments[0]).toMatchObject({
      id: includedLoan.installments[0]!.id,
      status: "deducted",
      payrollRunId: run.id,
    });
    expect(listEmployeeLoans(db, excluded.id)[0]!.installments[0]).toMatchObject({
      id: excludedLoan.installments[0]!.id,
      status: "scheduled",
      payrollRunId: null,
    });
  });
});

describe("leave and salary history", () => {
  it("computes approved and pending leave without storing a derived balance", () => {
    const db = seededDb();
    const asha = saveEmployee(db, employee("E001", "Asha"));
    const earned = saveLeaveType(db, {
      name: "Earned leave",
      annualAccrualMilli: 18_000,
      carryForwardLimitMilli: 45_000,
      encashable: true,
      paid: true,
      active: true,
    });
    recordLeave(
      db,
      {
        employeeId: asha.id,
        leaveTypeId: earned.id,
        date: "2026-04-01",
        qtyMilli: 18_000,
        kind: "accrual",
        status: "approved",
      },
      "Owner",
    );
    recordLeave(
      db,
      {
        employeeId: asha.id,
        leaveTypeId: earned.id,
        date: "2026-07-08",
        qtyMilli: 2_000,
        kind: "taken",
        status: "approved",
      },
      "Owner",
    );
    recordLeave(
      db,
      {
        employeeId: asha.id,
        leaveTypeId: earned.id,
        date: "2026-08-08",
        qtyMilli: 1_000,
        kind: "taken",
        status: "requested",
      },
      "Asha",
    );
    expect(leaveBalances(db, "2026-08-31")[0]).toMatchObject({
      balanceMilli: 16_000,
      takenMilli: 2_000,
      pendingMilli: 1_000,
    });
  });

  it("applies only the latest approved salary revision effective for the pay month", () => {
    const db = seededDb();
    const asha = saveEmployee(db, employee("E001", "Asha"));
    saveSalaryRevision(
      db,
      {
        employeeId: asha.id,
        effectiveFrom: "2026-08-01",
        reason: "Annual review",
        status: "approved",
        heads: [
          { name: "Basic", kind: "earning", calc: "flat", value: 30_000_00 },
          { name: "HRA", kind: "earning", calc: "flat", value: 12_000_00 },
        ],
      },
      "Owner",
    );
    expect(previewRun(db, "2026-07", [])[0]!.gross).toBe(32_000_00);
    expect(previewRun(db, "2026-08", [])[0]!.gross).toBe(42_000_00);
    expect(listSalaryRevisions(db, asha.id)).toHaveLength(1);
  });
});

describe("workforce attendance", () => {
  it("previews mapped rows and isolates unknown employees and arithmetic exceptions", () => {
    const db = seededDb();
    saveEmployee(db, employee("E001", "Asha"));
    const csv =
      "employee_code,payable_days,present_days,leave_days,unpaid_days,overtime_minutes\nE001,30,28,1,1,90\nE999,30,30,0,0,0";
    const preview = previewAttendanceImport(db, "2026-07", "clock.csv", csv);
    expect(preview.validCount).toBe(0);
    expect(preview.warningCount).toBe(1);
    expect(preview.errorCount).toBe(1);
    expect(preview.rows[0]).toMatchObject({
      employeeName: "Asha",
      status: "warning",
    });
    expect(preview.rows[1]).toMatchObject({
      employeeId: null,
      status: "error",
    });
  });

  it("applies an idempotent import, preserves warnings as exceptions, and requires resolution before approval", () => {
    const db = seededDb();
    const asha = saveEmployee(db, employee("E001", "Asha"));
    const csv =
      "employee_code,payable_days,present_days,leave_days,unpaid_days,overtime_minutes\nE001,30,28,1,1,90";
    applyAttendanceImport(db, "2026-07", "clock.csv", csv, "Owner");
    expect(listAttendance(db, "2026-07")[0]).toMatchObject({
      employeeId: asha.id,
      status: "exception",
      overtimeMinutes: 90,
    });
    expect(() => approveAttendanceMonth(db, "2026-07", "Owner")).toThrow(
      /exception/,
    );
    expect(() =>
      applyAttendanceImport(db, "2026-07", "copy.csv", csv, "Owner"),
    ).toThrow(/already been imported/);

    saveAttendance(
      db,
      {
        employeeId: asha.id,
        month: "2026-07",
        payableDays: 30,
        presentDays: 29,
        leaveDays: 1,
        unpaidDays: 1,
        overtimeMinutes: 90,
        status: "review",
      },
      "Owner",
    );
    approveAttendanceMonth(db, "2026-07", "Owner");
    expect(attendanceSummary(db, "2026-07")).toMatchObject({
      employees: 1,
      approved: 1,
      exceptions: 0,
      overtimeMinutes: 90,
    });
  });

  it("supports a reviewed manual attendance row", () => {
    const db = seededDb();
    const asha = saveEmployee(db, employee("E001", "Asha"));
    const row = saveAttendance(
      db,
      {
        employeeId: asha.id,
        month: "2026-08",
        payableDays: 31,
        presentDays: 30,
        leaveDays: 1,
        unpaidDays: 0,
        overtimeMinutes: 0,
        status: "approved",
      },
      "Payroll Admin",
    );
    expect(row.approvedBy).toBe("Payroll Admin");
    expect(row.approvedAt).toBeTruthy();
  });
});

describe("full and final settlement", () => {
  it("calculates gratuity and advances, posts balanced books, and exits the employee", () => {
    const db = seededDb();
    const asha = saveEmployee(db, {
      ...employee("E001", "Asha"),
      joined: "2020-07-01",
    });
    createEmployeeLoan(
      db,
      {
        employeeId: asha.id,
        disbursedDate: "2026-01-01",
        principal: 2_000_00,
        annualInterestBps: 0,
        installmentAmount: 1_000_00,
        firstDeductionMonth: "2026-07",
      },
      "Owner",
    );
    const preview = previewFinalSettlement(db, asha.id, "2026-08-20");
    expect(preview.completedYears).toBe(6);
    expect(preview.gratuity).toBe(Math.round((20_000_00 * 15 * 6) / 26));
    expect(preview.outstandingAdvance).toBe(2_000_00);
    const draft = createFinalSettlement(
      db,
      {
        employeeId: asha.id,
        lastWorkingDate: "2026-08-20",
        salaryDue: preview.salaryDue,
        noticePay: 0,
        leaveEncashment: 10_000_00,
        gratuity: preview.gratuity,
        recovery: 0,
        advanceRecovery: preview.outstandingAdvance,
      },
      "Owner",
    );
    const cash = db
      .prepare("SELECT id FROM ledgers WHERE name='Cash'")
      .get() as { id: number };
    const posted = postFinalSettlement(
      db,
      draft.id,
      { date: "2026-08-20", bankLedgerId: cash.id },
      "Owner",
    );
    expect(posted.status).toBe("posted");
    expect(
      db
        .prepare(
          "SELECT active,exit_date AS exitDate FROM employees WHERE id=?",
        )
        .get(asha.id),
    ).toEqual({ active: 0, exitDate: "2026-08-20" });
    const totals = db
      .prepare(
        "SELECT SUM(CASE WHEN dr_cr='dr' THEN amount ELSE 0 END) AS dr,SUM(CASE WHEN dr_cr='cr' THEN amount ELSE 0 END) AS cr FROM voucher_lines WHERE voucher_id=?",
      )
      .get(posted.voucherId) as { dr: number; cr: number };
    expect(totals.dr).toBe(totals.cr);
  });
});
