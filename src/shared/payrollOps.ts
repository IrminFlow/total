export interface PayrollPreflightIssue {
  employeeId: number | null
  employeeName: string | null
  category: 'attendance' | 'salary' | 'bank' | 'statutory' | 'net_pay'
  severity: 'error' | 'warning'
  message: string
}
export interface PayrollPreflight {
  month: string
  employeeCount: number
  gross: number
  deductions: number
  employerCost: number
  netPay: number
  issues: PayrollPreflightIssue[]
  canPost: boolean
}
export interface PayrollTieOutRow { key: string; label: string; expected: number; posted: number; difference: number }
export interface PayrollTieOut { runId: number; month: string; voucherId: number | null; rows: PayrollTieOutRow[]; totalDifference: number; reconciled: boolean }
