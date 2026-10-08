// Typed client for the payables channels (WP 4.3) — src/main/ipcPayables.ts.
import { call } from './client'
import type { BankRateRow } from '@shared/payables/msme'
import type { PaymentRunInput } from '@shared/payables/schemas'
import type {
  MsmeDueSummary, MsmeReport, PayablesPlan, PaymentRun, PaymentRunPreview, SupplierReconResult, SupplierStatement
} from '@shared/payables/types'

export interface MsmeReportQuery {
  asOn: string
  fyStartYear?: number
  formPeriodDate?: string
}

export const payablesApi = {
  plan: (asOn: string) => call<PayablesPlan>('payables:plan', { asOn }),
  msmeDue: (asOn: string) => call<MsmeDueSummary>('payables:msmeDue', { asOn }),
  previewRun: (input: PaymentRunInput) => call<PaymentRunPreview>('payables:previewRun', input),
  createRun: (input: PaymentRunInput) => call<PaymentRun>('payables:createRun', input),
  runs: () => call<PaymentRun[]>('payables:runs'),
  run: (id: number) => call<PaymentRun | null>('payables:run', { id }),
  runExportCsv: (id: number) => call<{ path: string }>('payables:runExportCsv', { id }),
  msmeReport: (q: MsmeReportQuery) => call<MsmeReport>('payables:msmeReport', q),
  msmeForm1Csv: (q: MsmeReportQuery) => call<{ path: string; rows: number }>('payables:msmeForm1Csv', q),
  bankRates: () => call<BankRateRow[]>('payables:bankRates'),
  saveBankRate: (data: { fromDate: string; rateBp: number; source: string }, id?: number) =>
    call<BankRateRow>('payables:bankRateSave', { id, data }),
  deleteBankRate: (id: number) => call<null>('payables:bankRateDelete', { id }),
  supplierStatement: (ledgerId: number, from: string, to: string) =>
    call<SupplierStatement>('payables:supplierStatement', { ledgerId, from, to }),
  supplierRecon: (q: { ledgerId: number; from: string; to: string; csvText: string; amountPaise?: number; dateDays?: number }) =>
    call<SupplierReconResult>('payables:supplierRecon', q)
}
