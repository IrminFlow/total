import type {
  BomLine, CompanyInfo, Currency, Employee, Godown, Group, Ledger, PayrollLine, PayrollRun,
  StockGroup, StockItem, Unit, Voucher, VoucherType
} from '@shared/domain'
import type {
  BalanceSheet, BankRecon, DashboardData, DayBookRow, EdocListRow, GroupTreeNode, LedgerBalanceRow,
  LedgerStatement, OutstandingParty, ProfitAndLoss, RegisterMonthRow, StockSummaryRow, TrialBalance, VoucherListRow
} from '@shared/reports'
import type { Gstr1Result, Gstr3bResult } from '@shared/gst/returns'
import type {
  BomInput, CompanyCreateInput, CurrencyInput, EmployeeInput, GodownInput, GroupInput, LedgerInput,
  NicCredentials, RendererLogInput, StockGroupInput, StockItemInput, UnitInput, VoucherTypeInput, VoucherInputParsed
} from '@shared/schemas'
import type { Registry } from '../types'

/** Invoke a main-process channel; throws the error message on failure. */
async function call<T>(channel: string, payload?: unknown): Promise<T> {
  const result = await window.total.invoke(channel, payload)
  if (!result.ok) throw new Error(result.error ?? 'Unknown error')
  return result.data as T
}

export const api = {
  company: {
    list: () => call<Registry>('company:list'),
    create: (input: CompanyCreateInput) => call<{ slug: string }>('company:create', input),
    open: (slug: string) => call<{ slug: string; info: CompanyInfo }>('company:open', { slug }),
    close: () => call<null>('company:close'),
    current: () => call<{ slug: string; info: CompanyInfo } | null>('company:current'),
    updateInfo: (input: CompanyCreateInput) => call<CompanyInfo>('company:updateInfo', input),
    backup: () => call<{ path: string | null }>('company:backup'),
    revealExports: () => call<null>('company:revealExports')
  },
  groups: {
    list: () => call<Group[]>('master:groups:list'),
    tree: () => call<GroupTreeNode[]>('master:groups:tree'),
    create: (data: GroupInput) => call<Group>('master:groups:create', data),
    update: (id: number, data: GroupInput) => call<Group>('master:groups:update', { id, data }),
    remove: (id: number) => call<null>('master:groups:delete', { id })
  },
  ledgers: {
    list: () => call<Ledger[]>('master:ledgers:list'),
    create: (data: LedgerInput) => call<Ledger>('master:ledgers:create', data),
    update: (id: number, data: LedgerInput) => call<Ledger>('master:ledgers:update', { id, data }),
    remove: (id: number) => call<null>('master:ledgers:delete', { id }),
    balances: (asOn: string) => call<LedgerBalanceRow[]>('master:ledgerBalances', { asOn })
  },
  voucherTypes: {
    list: () => call<VoucherType[]>('master:voucherTypes:list'),
    create: (data: VoucherTypeInput) => call<VoucherType>('master:voucherTypes:create', data),
    update: (id: number, data: VoucherTypeInput) => call<VoucherType>('master:voucherTypes:update', { id, data })
  },
  units: {
    list: () => call<Unit[]>('master:units:list'),
    create: (data: UnitInput) => call<Unit>('master:units:create', data)
  },
  stockGroups: {
    list: () => call<StockGroup[]>('master:stockGroups:list'),
    create: (data: StockGroupInput) => call<StockGroup>('master:stockGroups:create', data)
  },
  stockItems: {
    list: () => call<StockItem[]>('master:stockItems:list'),
    create: (data: StockItemInput) => call<StockItem>('master:stockItems:create', data),
    update: (id: number, data: StockItemInput) => call<StockItem>('master:stockItems:update', { id, data }),
    remove: (id: number) => call<null>('master:stockItems:delete', { id })
  },
  godowns: {
    list: () => call<Godown[]>('master:godowns:list'),
    create: (data: GodownInput) => call<Godown>('master:godowns:create', data)
  },
  vouchers: {
    list: (from: string, to: string, voucherTypeId?: number) =>
      call<VoucherListRow[]>('voucher:list', { from, to, voucherTypeId }),
    get: (id: number) => call<Voucher | null>('voucher:get', { id }),
    save: (data: VoucherInputParsed, id?: number) => call<Voucher>('voucher:save', { data, id }),
    remove: (id: number) => call<null>('voucher:delete', { id }),
    nextNumber: (voucherTypeId: number, date: string, excludeId?: number) =>
      call<{ number: string }>('voucher:nextNumber', { voucherTypeId, date, excludeId }),
    duplicates: (data: VoucherInputParsed, excludeId?: number) =>
      call<{ voucherId: number; number: string; date: string }[]>('voucher:duplicates', { data, excludeId })
  },
  reports: {
    dayBook: (from: string, to: string) => call<DayBookRow[]>('report:dayBook', { from, to }),
    ledger: (ledgerId: number, from: string, to: string) =>
      call<LedgerStatement>('report:ledger', { ledgerId, from, to }),
    trialBalance: (asOn: string) => call<TrialBalance>('report:trialBalance', { asOn }),
    profitLoss: (from: string, to: string) => call<ProfitAndLoss>('report:profitLoss', { from, to }),
    balanceSheet: (asOn: string) => call<BalanceSheet>('report:balanceSheet', { asOn }),
    stockSummary: (asOn: string) => call<StockSummaryRow[]>('report:stockSummary', { asOn }),
    dashboard: (today: string, fyFrom: string) => call<DashboardData>('report:dashboard', { today, fyFrom })
  },
  gst: {
    gstr1: (from: string, to: string, period: string) => call<Gstr1Result>('gst:gstr1', { from, to, period }),
    gstr3b: (from: string, to: string, period: string) => call<Gstr3bResult>('gst:gstr3b', { from, to, period }),
    exportGstr1: (from: string, to: string, period: string) =>
      call<{ jsonPath: string; csvPath: string }>('gst:exportGstr1', { from, to, period }),
    exportGstr3b: (from: string, to: string, period: string) =>
      call<{ jsonPath: string }>('gst:exportGstr3b', { from, to, period })
  },
  analysis: {
    register: (kind: 'sales' | 'purchase', from: string, to: string) =>
      call<RegisterMonthRow[]>('analysis:register', { kind, from, to }),
    outstandings: (side: 'receivable' | 'payable', asOn: string) =>
      call<OutstandingParty[]>('analysis:outstandings', { side, asOn })
  },
  bank: {
    ledgers: () => call<{ id: number; name: string }[]>('bank:ledgers'),
    recon: (ledgerId: number, from: string, to: string) => call<BankRecon>('bank:recon', { ledgerId, from, to }),
    setBankDate: (lineId: number, bankDate: string | null) => call<null>('bank:setBankDate', { lineId, bankDate }),
    importCsv: (ledgerId: number) =>
      call<{ statementRows: number; matched: number; unmatched: { date: string; description: string; amount: number; kind: string }[] } | null>(
        'bank:importCsv',
        { ledgerId }
      )
  },
  edoc: {
    list: (from: string, to: string) => call<EdocListRow[]>('edoc:list', { from, to }),
    exportEInvoice: (from: string, to: string, period: string) =>
      call<{ path: string; count: number }>('edoc:exportEInvoice', { from, to, period }),
    exportEwb: (from: string, to: string, period: string) =>
      call<{ path: string; count: number }>('edoc:exportEwb', { from, to, period })
  },
  invoice: {
    pdf: (voucherId: number) => call<{ path: string }>('invoice:pdf', { voucherId })
  },
  currencies: {
    list: () => call<Currency[]>('currency:list'),
    create: (data: CurrencyInput) => call<Currency>('currency:create', data),
    remove: (id: number) => call<null>('currency:delete', { id })
  },
  bom: {
    get: (itemId: number) => call<BomLine[]>('bom:get', { itemId }),
    set: (data: BomInput) => call<BomLine[]>('bom:set', data),
    items: () => call<{ itemId: number; name: string; components: number }[]>('bom:items')
  },
  payroll: {
    employees: () => call<Employee[]>('payroll:employees:list'),
    saveEmployee: (data: EmployeeInput, id?: number) => call<Employee>('payroll:employees:save', { data, id }),
    removeEmployee: (id: number) => call<null>('payroll:employees:delete', { id }),
    preview: (month: string, days: { employeeId: number; payableDays: number }[]) =>
      call<Omit<PayrollLine, 'id'>[]>('payroll:preview', { month, days }),
    commit: (month: string, days: { employeeId: number; payableDays: number }[]) =>
      call<PayrollRun>('payroll:commit', { month, days }),
    runs: () => call<PayrollRun[]>('payroll:runs'),
    removeRun: (id: number) => call<null>('payroll:deleteRun', { id }),
    payslip: (runId: number, employeeId: number) => call<{ path: string }>('payroll:payslip', { runId, employeeId })
  },
  tally: {
    import: () =>
      call<{ groups: number; ledgers: number; units: number; items: number; vouchers: number; skipped: number; warnings: string[] } | null>(
        'tally:import'
      )
  },
  nic: {
    get: () => call<NicCredentials>('nic:get'),
    save: (creds: NicCredentials) => call<{ configured: boolean }>('nic:save', creds),
    status: () => call<{ configured: boolean }>('nic:status'),
    generateIrn: (voucherId: number) => call<{ irn: string; ackNo: string; ackDate: string }>('nic:generateIrn', { voucherId }),
    generateEwb: (voucherId: number) => call<{ ewbNo: string; validUpto: string }>('nic:generateEwb', { voucherId })
  },
  intel: {
    suggestLedgers: (kind: string, query: string) =>
      call<{ ledgerId: number; name: string; groupName: string; uses: number }[]>('intel:suggestLedgers', { kind, query }),
    anomaly: (ledgerId: number, amount: number) =>
      call<{ unusual: boolean; typicalAmount: number | null }>('intel:anomaly', { ledgerId, amount })
  },
  log: {
    renderer: (input: RendererLogInput) => call<null>('log:renderer', input),
    reveal: () => call<null>('log:reveal')
  }
}
