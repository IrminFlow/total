// Typed client for payroll statutory (WP 3.7) — the channels in src/main/ipcPayrollStatutory.ts.
// Kept beside client.ts so the statutory surface stays in one place.
import { call } from './client'
import type {
  Form16Data, Form24qData, Form24qSalaryRow, StatutoryDueRow, StatutoryPayment, StatutoryRate, TaxDeclaration
} from '@shared/payrollStatutoryTypes'
import type { StatutoryPaymentInput, StatutoryRateInput, TaxDeclarationsSetInput } from '@shared/schemas'

export type {
  Form16Data, Form24qData, Form24qSalaryRow, StatutoryDueRow, StatutoryPayment, StatutoryRate, TaxDeclaration
} from '@shared/payrollStatutoryTypes'

export const statApi = {
  rates: () => call<StatutoryRate[]>('payroll:rates:list'),
  rateSave: (data: StatutoryRateInput, id?: number) => call<StatutoryRate>('payroll:rates:save', { data, id }),
  rateDelete: (id: number) => call<null>('payroll:rates:delete', { id }),
  ptStates: () => call<string[]>('payroll:ptStates'),

  declarations: (employeeId: number, fyStartYear: number) => call<TaxDeclaration[]>('payroll:declarations:get', { employeeId, fyStartYear }),
  setDeclarations: (input: TaxDeclarationsSetInput) => call<TaxDeclaration[]>('payroll:declarations:set', input),
  workings: (employeeId: number, fyStartYear: number) => call<Form24qSalaryRow | null>('payroll:workings', { employeeId, fyStartYear }),

  dues: (fyStartYear: number) => call<StatutoryDueRow[]>('payroll:dues', { fyStartYear }),
  payments: (fyStartYear: number) => call<StatutoryPayment[]>('payroll:payments:list', { fyStartYear }),
  recordPayment: (input: StatutoryPaymentInput) => call<StatutoryPayment>('payroll:payments:record', input),
  deletePayment: (id: number) => call<null>('payroll:payments:delete', { id }),
  ptReturnCsv: (runId: number, state: string) => call<{ path: string }>('payroll:ptReturnCsv', { runId, state }),

  form24q: (fyStartYear: number, quarter: 1 | 2 | 3 | 4) => call<Form24qData>('tds:form24q', { fyStartYear, quarter }),
  form24qCsv: (fyStartYear: number, quarter: 1 | 2 | 3 | 4) => call<{ path: string }>('tds:form24qCsv', { fyStartYear, quarter }),
  form16: (fyStartYear: number, employeeId?: number) => call<Form16Data>('payroll:form16', { fyStartYear, employeeId }),
  form16Pdf: (fyStartYear: number, employeeId?: number) => call<{ path: string }>('payroll:form16Pdf', { fyStartYear, employeeId })
}
