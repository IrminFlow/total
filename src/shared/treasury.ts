export interface LiquidityScenarioInput {
  name: string
  collectionDelayDays: number
  collectionRealizationBp: number
  paymentDelayDays: number
  events: { date: string; label: string; direction: 'inflow' | 'outflow'; amount: number; kind: 'purchase' | 'loan' | 'tax' | 'other' }[]
}

export interface LiquidityScenario extends LiquidityScenarioInput {
  id: number
  createdBy: string
  createdAt: string
  updatedAt: string
}

export interface TreasuryAccountBalance {
  ledgerId: number
  name: string
  kind: 'cash' | 'bank'
  balance: number
}

export interface TreasuryForecastEvent {
  date: string
  label: string
  direction: 'inflow' | 'outflow'
  amount: number
  source: 'receivable' | 'payable' | 'recurring' | 'scenario'
  sourceId: number | null
}

export interface TreasuryForecastWeek {
  week: number
  from: string
  to: string
  inflows: number
  outflows: number
  net: number
  closing: number
  events: TreasuryForecastEvent[]
}

export interface TreasuryForecast {
  asOn: string
  scenarioId: number | null
  scenarioName: string
  accounts: TreasuryAccountBalance[]
  openingLiquidity: number
  weeks: TreasuryForecastWeek[]
  lowestClosing: number
  lowestWeek: number
}

export interface DailyCashPosition {
  asOn: string
  horizonTo: string
  accounts: TreasuryAccountBalance[]
  availableNow: number
  expectedReceipts: number
  expectedPayments: number
  projectedAvailable: number
  events: TreasuryForecastEvent[]
}

export interface TreasuryAlertSettings {
  minimumLiquidity: number
  idleCashThreshold: number
  sustainedWeeks: number
}

export interface TreasuryAlert {
  kind: 'shortfall' | 'idle_cash'
  title: string
  detail: string
  amount: number
  firstWeek: number
  sustainedWeeks: number
}
