// Typed client for the report builder, saved reports, comparatives, ratios and scheduled packs
// (WP 6.1 / 6.2) — the channels in src/main/ipcReports.ts. Kept beside client.ts like
// pricingClient.ts.
import { call } from './client'
import type { ReportModel, ReportModelInput, ReportResult } from '@shared/reportBuilder/model'
import type { PackInputPayload, PackRun, ReportPack } from '@shared/reportBuilder/packs'
import type { RatioReport } from '@shared/ratios'
import type { BalanceSheet, ProfitAndLoss } from '@shared/reports'

/** Mirrors reportBuilder.SavedReport (main-process only). */
export interface SavedReport {
  id: number
  name: string
  model: ReportModel | null
  problem: string | null
  owner: string | null
  pinned: boolean
  createdAt: string
  updatedAt: string
}

export interface ComparativeColumn {
  key: 'current' | 'previous' | 'lastYear'
  label: string
  from: string
  to: string
}

export interface BudgetAmounts {
  budgetId: number
  name: string
  ledgers: Record<number, number>
  groups: Record<number, number>
}

export const reportsApi = {
  run: (model: ReportModelInput, working: { from: string; to: string }) => call<ReportResult>('rb:run', { model, working }),
  list: () => call<SavedReport[]>('rb:list'),
  get: (id: number) => call<SavedReport>('rb:get', { id }),
  users: () => call<string[]>('rb:users'),
  save: (name: string, model: ReportModelInput, id?: number, pinned?: boolean) => call<SavedReport>('rb:save', { id, name, model, pinned }),
  rename: (id: number, name: string) => call<SavedReport>('rb:rename', { id, name }),
  pin: (id: number, pinned: boolean) => call<SavedReport>('rb:pin', { id, pinned }),
  duplicate: (id: number) => call<SavedReport>('rb:duplicate', { id }),
  remove: (id: number) => call<null>('rb:delete', { id }),
  importJson: (json: string, name?: string) => call<SavedReport>('rb:import', { json, name }),
  exportJson: (id: number) => call<{ path: string; json: string }>('rb:exportJson', { id }),

  comparativePnl: (from: string, to: string) => call<{ columns: ComparativeColumn[]; statements: ProfitAndLoss[] }>('report:comparative', { kind: 'pnl', from, to }),
  comparativeBs: (from: string, to: string) => call<{ columns: ComparativeColumn[]; statements: BalanceSheet[] }>('report:comparative', { kind: 'bs', from, to }),
  budgetAmounts: (budgetId: number, from: string, to: string) => call<BudgetAmounts>('report:budgetAmounts', { budgetId, from, to }),
  ratios: (from: string, to: string) => call<RatioReport>('report:ratios', { from, to }),

  packs: () => call<ReportPack[]>('pack:list'),
  packRuns: (packId?: number) => call<PackRun[]>('pack:runs', packId ? { packId } : {}),
  savePack: (data: PackInputPayload, id?: number) => call<ReportPack>('pack:save', { id, data }),
  deletePack: (id: number) => call<null>('pack:delete', { id }),
  runPackNow: (id: number) => call<PackRun>('pack:runNow', { id }),
  chooseFolder: () => call<string | null>('pack:chooseFolder'),
  revealRun: (runId: number) => call<null>('pack:reveal', { runId })
}
