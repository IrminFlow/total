export type MonthCloseGateId = 'bank' | 'gst' | 'books' | 'backup' | 'lock'

export interface MonthCloseGate {
  id: MonthCloseGateId
  status: 'ready' | 'attention' | 'complete'
  title: string
  detail: string
  count: number
}

export interface MonthCloseStatus {
  from: string
  to: string
  readyCount: number
  totalGates: number
  canLock: boolean
  gates: MonthCloseGate[]
  metrics: {
    unreconciledBankLines: number
    gstBlocking: number
    gstWarnings: number
    bookExceptions: number
    suspenseBalance: number
  }
  latestBackup: { file: string; mtime: number; tag: string } | null
  lockedThrough: string | null
}
