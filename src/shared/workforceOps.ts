export type StatutoryKind = "pf" | "esi" | "pt" | "tds";

export interface StatutoryWorkspaceRow {
  month: string;
  kind: StatutoryKind;
  label: string;
  booksAmount: number;
  challanAmount: number;
  difference: number;
  status: "due" | "paid" | "filed";
  paidDate: string | null;
  reference: string | null;
  filedReference: string | null;
  reconciled: boolean;
}

export interface ShiftRule {
  id: number;
  name: string;
  workMinutes: number;
  weeklyOffDay: number;
  overtimeAfterMinutes: number;
  overtimeRateBps: number;
  active: boolean;
}

export interface ShiftAssignment {
  id: number;
  employeeId: number;
  employeeName: string;
  shiftRuleId: number;
  shiftRuleName: string;
  effectiveFrom: string;
  effectiveTo: string | null;
}

export interface WorkforceHoliday {
  id: number;
  date: string;
  name: string;
  department: string;
}

export interface DepartmentPayrollRow {
  department: string;
  headcount: number;
  gross: number;
  overtimeMinutes: number;
  overtimeAmount: number;
  employerCost: number;
  netPay: number;
  priorGross: number;
  grossChange: number | null;
}

export type ProvisioningKind = "joiners" | "leavers";
export interface ProvisioningRow {
  sourceRow: number;
  employeeCode: string;
  name: string | null;
  effectiveDate: string | null;
  data: Record<string, string>;
  status: "valid" | "warning" | "error";
  message: string | null;
}
export interface ProvisioningPreview {
  kind: ProvisioningKind;
  sourceName: string;
  sourceHash: string;
  rows: ProvisioningRow[];
  validCount: number;
  warningCount: number;
  errorCount: number;
  alreadyImported: boolean;
}
