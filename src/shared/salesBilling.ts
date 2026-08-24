export type SalesBillingCadence = 'monthly' | 'quarterly' | 'yearly'
export type SalesRateMode = 'fixed' | 'price_list'

export interface SalesRecurringLineInput {
  stockItemId: number
  description: string
  qtyMilli: number
  rateMode: SalesRateMode
  fixedRate: number | null
  discountBps: number
}

export interface SalesRecurringScheduleInput {
  name: string
  partyLedgerId: number
  voucherTypeId: number
  cadence: SalesBillingCadence
  nextDue: string
  endDate: string | null
  dueDays: number
  lines: SalesRecurringLineInput[]
  narration: string | null
  active: boolean
}

export interface SalesRecurringSchedule extends SalesRecurringScheduleInput {
  id: number
  partyName: string
  voucherTypeName: string
  lastGenerated: string | null
  createdBy: string
  createdAt: string
  updatedAt: string
}

export interface SalesRecurringPreviewRow {
  scheduleId: number
  scheduleName: string
  partyName: string
  dueDate: string
  amount: number
  status: 'ready' | 'exception'
  message: string | null
  resolvedLines: Array<SalesRecurringLineInput & { rate: number }>
}

export interface SalesRecurringPreview {
  asOn: string
  readyCount: number
  exceptionCount: number
  totalAmount: number
  rows: SalesRecurringPreviewRow[]
}

export interface SalesRecurringBatchRow extends Omit<SalesRecurringPreviewRow, 'status' | 'resolvedLines'> {
  id: number
  status: 'exception' | 'generated' | 'skipped'
  voucherDraftId: number | null
}

export interface SalesRecurringBatch {
  id: number
  asOn: string
  createdBy: string
  createdAt: string
  rows: SalesRecurringBatchRow[]
}

export type DiscountScopeKind = 'global' | 'role' | 'item' | 'customer'
export type DiscountActorRole = 'owner' | 'accountant' | 'viewer'

export interface SalesDiscountPolicyInput {
  name: string
  scopeKind: DiscountScopeKind
  role: DiscountActorRole | null
  stockItemId: number | null
  customerLedgerId: number | null
  maxDiscountBps: number
  active: boolean
}

export interface SalesDiscountPolicy extends SalesDiscountPolicyInput {
  id: number
  scopeLabel: string
  createdBy: string
  createdAt: string
  updatedAt: string
}

export interface DiscountAuthorityResult {
  allowed: boolean
  requestedDiscountBps: number
  maxDiscountBps: number
  policyNames: string[]
}

export function nextSalesBillingDate(cadence: SalesBillingCadence, date: string): string {
  const [year,month,day]=date.split('-').map(Number) as [number,number,number]
  const addMonths=cadence==='monthly'?1:cadence==='quarterly'?3:12
  const zeroMonth=month-1+addMonths
  const nextYear=year+Math.floor(zeroMonth/12),nextMonth=zeroMonth%12+1
  const lastDay=new Date(Date.UTC(nextYear,nextMonth,0)).getUTCDate()
  return `${nextYear}-${String(nextMonth).padStart(2,'0')}-${String(Math.min(day,lastDay)).padStart(2,'0')}`
}
