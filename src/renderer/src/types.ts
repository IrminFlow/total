import type { CompanySummary } from '@shared/domain'

export interface Registry {
  version: 1
  companies: CompanySummary[]
  lastOpened: string | null
}
