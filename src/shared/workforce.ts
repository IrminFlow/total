export type AttendanceStatus = "review" | "approved" | "exception";

export interface AttendanceRecord {
  id: number;
  importId: number | null;
  employeeId: number;
  employeeName: string;
  employeeCode: string | null;
  month: string;
  payableDays: number;
  presentDays: number;
  leaveDays: number;
  unpaidDays: number;
  overtimeMinutes: number;
  status: AttendanceStatus;
  note: string | null;
  approvedBy: string | null;
  approvedAt: string | null;
}

export interface AttendanceInput {
  employeeId: number;
  month: string;
  payableDays: number;
  presentDays: number;
  leaveDays: number;
  unpaidDays: number;
  overtimeMinutes: number;
  status: AttendanceStatus;
  note?: string | null;
}

export interface AttendanceImportRow {
  sourceRow: number;
  employeeCode: string;
  employeeId: number | null;
  employeeName: string | null;
  payableDays: number;
  presentDays: number;
  leaveDays: number;
  unpaidDays: number;
  overtimeMinutes: number;
  status: "valid" | "warning" | "error";
  message: string | null;
}

export interface AttendanceImportPreview {
  month: string;
  sourceName: string;
  sourceHash: string;
  rows: AttendanceImportRow[];
  validCount: number;
  warningCount: number;
  errorCount: number;
  alreadyImported: boolean;
}

export interface AttendanceMonthSummary {
  month: string;
  employees: number;
  approved: number;
  review: number;
  exceptions: number;
  payableDays: number;
  overtimeMinutes: number;
}

export interface LeaveType {
  id: number;
  name: string;
  annualAccrualMilli: number;
  carryForwardLimitMilli: number | null;
  encashable: boolean;
  paid: boolean;
  active: boolean;
}

export interface LeaveTransaction {
  id: number;
  employeeId: number;
  employeeName: string;
  leaveTypeId: number;
  leaveTypeName: string;
  date: string;
  qtyMilli: number;
  kind: "accrual" | "taken" | "carry_forward" | "encashment" | "adjustment";
  status: "requested" | "approved" | "rejected";
  note: string | null;
  approvedBy: string | null;
  createdAt: string;
}

export interface LeaveBalance {
  employeeId: number;
  employeeName: string;
  leaveTypeId: number;
  leaveTypeName: string;
  balanceMilli: number;
  takenMilli: number;
  pendingMilli: number;
}

export interface SalaryRevision {
  id: number;
  employeeId: number;
  employeeName: string;
  effectiveFrom: string;
  heads: {
    name: string;
    kind: "earning" | "deduction";
    calc: "flat" | "percent_of_basic";
    value: number;
  }[];
  reason: string;
  status: "draft" | "approved" | "superseded";
  approvedBy: string | null;
  createdBy: string;
  createdAt: string;
}

export interface EmployeeLoanInstallment {
  id: number;
  month: string;
  principal: number;
  interest: number;
  payrollRunId: number | null;
  status: "scheduled" | "deducted" | "paused" | "waived";
}

export interface EmployeeLoan {
  id: number;
  employeeId: number;
  employeeName: string;
  disbursedDate: string;
  principal: number;
  annualInterestBps: number;
  installmentAmount: number;
  firstDeductionMonth: string;
  status: "active" | "paused" | "settled" | "written_off";
  note: string | null;
  createdBy: string;
  createdAt: string;
  outstanding: number;
  installments: EmployeeLoanInstallment[];
}

export interface EmployeeReimbursement {
  id: number;
  employeeId: number;
  employeeName: string;
  claimDate: string;
  category: string;
  amount: number;
  taxable: boolean;
  description: string;
  attachmentPath: string | null;
  status: "submitted" | "approved" | "rejected" | "paid";
  approvedBy: string | null;
  paymentVoucherId: number | null;
  createdAt: string;
}

export interface Contractor {
  id: number;
  name: string;
  pan: string | null;
  bankAccount: string | null;
  bankIfsc: string | null;
  tdsSectionId: number | null;
  tdsSectionCode: string | null;
  active: boolean;
}

export interface ContractorPayment {
  id: number;
  contractorId: number;
  contractorName: string;
  periodFrom: string;
  periodTo: string;
  gross: number;
  tds: number;
  voucherId: number | null;
  certificateNo: string | null;
  status: "draft" | "approved" | "posted" | "cancelled";
  note: string | null;
  createdBy: string;
  createdAt: string;
}

export interface FinalSettlement {
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
  status: "draft" | "approved" | "posted" | "cancelled";
  voucherId: number | null;
  note: string | null;
  approvedBy: string | null;
  createdBy: string;
  createdAt: string;
}

export interface FinalSettlementPreview {
  employeeId: number;
  lastWorkingDate: string;
  salaryDue: number;
  gratuity: number;
  outstandingAdvance: number;
  completedYears: number;
}
