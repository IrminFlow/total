export interface VarianceDriver {
  key: string
  dimension: 'customer' | 'supplier' | 'item'
  name: string
  current: number
  comparison: number
  change: number
  currentQtyMilli: number | null
  comparisonQtyMilli: number | null
  priceImpact: number | null
  quantityImpact: number | null
  timingResidual: number | null
  voucherIds: number[]
}

export interface VarianceExplanation {
  current: { from: string; to: string }
  comparison: { from: string; to: string }
  salesChange: number
  purchaseChange: number
  drivers: VarianceDriver[]
}

export interface ManagementScenarioInput {
  name: string
  salesGrowthPct: number
  grossMarginPct: number | null
  expenseChangePct: number
  collectionDaysChange: number
  paymentDaysChange: number
  note: string | null
}

export interface ManagementScenario extends ManagementScenarioInput {
  id: number
  createdBy: string
  createdAt: string
  updatedAt: string
}

export interface ScenarioProjection {
  scenario: ManagementScenarioInput
  base: { sales: number; grossProfit: number; netProfit: number; receivables: number; payables: number }
  projected: { sales: number; grossProfit: number; netProfit: number; receivables: number; payables: number }
  assumptions: string[]
}

export interface ReportAnnotation {
  id: number
  reportKey: string
  rowKey: string
  from: string
  to: string
  note: string
  includeInExport: boolean
  author: string
  createdAt: string
  updatedAt: string
}

export interface ScheduleIiiMapping {
  id: number
  groupId: number
  groupName: string
  side: 'equity_liability' | 'asset' | 'income' | 'expense'
  section: string
  noteCode: string | null
  sortOrder: number
  updatedBy: string
  updatedAt: string
}

export interface ScheduleIiiRow {
  side: ScheduleIiiMapping['side']
  section: string
  noteCode: string | null
  current: number
  prior: number
  groupIds: number[]
  voucherIds: number[]
}

export interface ScheduleIiiStatement {
  asOn: string
  priorAsOn: string
  rows: ScheduleIiiRow[]
  unmapped: { groupId: number; groupName: string; nature: string; amount: number }[]
}
