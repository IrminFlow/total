// Typed client for receivables (WP 4.2) — the channels in src/main/ipcReceivables.ts.
import { call } from './client'
import type { ReceivablesConfig, ReceivablesConfigInput, ReminderChannel } from '@shared/receivables/config'
import type { RuleSource } from '@shared/receivables/sources'
import type {
  CollectionReport, CreditControlRow, FollowupRow, InterestChargeRow, InterestPostResult, InterestRow, PromisedSummary,
  ReminderBulkResult, ReminderCandidate, ReminderLogRow, ReminderResult, StatementData, StatementPdfResult, StatementsBulkResult, TopOverdueRow
} from '@shared/receivables/types'
import type { FollowupInput } from '@shared/receivables/schemas'

export type {
  CollectionReport, CreditControlRow, FollowupRow, InterestChargeRow, InterestPostResult, InterestRow, PromisedSummary,
  ReminderBulkResult, ReminderCandidate, ReminderLogRow, ReminderResult, StatementData, StatementPdfResult, StatementsBulkResult, TopOverdueRow
} from '@shared/receivables/types'

export const receivablesApi = {
  config: () => call<{ config: ReceivablesConfig; sources: RuleSource[] }>('receivables:config'),
  setConfig: (config: ReceivablesConfigInput) => call<ReceivablesConfig>('receivables:setConfig', config),
  statement: (ledgerId: number, from: string, to: string) => call<{ html: string; data: StatementData }>('receivables:statement', { ledgerId, from, to }),
  statementPdf: (ledgerId: number, from: string, to: string) => call<StatementPdfResult>('receivables:statementPdf', { ledgerId, from, to }),
  statementsBulk: (from: string, to: string, pickFolder = false) => call<StatementsBulkResult>('receivables:statementsBulk', { from, to, pickFolder }),
  reveal: (path: string) => call<null>('receivables:reveal', { path }),
  reminderCandidates: (asOn: string) => call<ReminderCandidate[]>('receivables:reminderCandidates', { asOn }),
  remind: (ledgerId: number, asOn: string, channel: ReminderChannel, force = false) =>
    call<ReminderResult>('receivables:remind', { ledgerId, asOn, channel, force }),
  remindBulk: (asOn: string, channel: ReminderChannel, ledgerIds?: number[]) =>
    call<ReminderBulkResult>('receivables:remindBulk', { asOn, channel, ...(ledgerIds ? { ledgerIds } : {}) }),
  reminderLog: (from: string, to: string, ledgerId?: number) => call<ReminderLogRow[]>('receivables:reminderLog', { from, to, ledgerId }),
  interestPreview: (asOn: string, gstOnInterest?: boolean, ledgerId?: number) =>
    call<InterestRow[]>('receivables:interestPreview', { asOn, gstOnInterest, ledgerId }),
  postInterest: (q: { asOn: string; date?: string; ledgerId: number; keys?: string[]; gstOnInterest?: boolean }) =>
    call<InterestPostResult>('receivables:postInterest', q),
  interestCharges: (ledgerId?: number) => call<InterestChargeRow[]>('receivables:interestCharges', { ledgerId }),
  setHold: (ledgerId: number, hold: boolean, reason: string) =>
    call<{ hold: boolean; reason: string | null; at: string | null }>('receivables:setHold', { ledgerId, hold, reason }),
  creditControl: (asOn: string) => call<CreditControlRow[]>('receivables:creditControl', { asOn }),
  followups: (ledgerId?: number) => call<FollowupRow[]>('receivables:followups', { ledgerId }),
  addFollowup: (input: FollowupInput) => call<FollowupRow>('receivables:addFollowup', input),
  deleteFollowup: (id: number) => call<null>('receivables:deleteFollowup', { id }),
  promisedThisWeek: (today: string) => call<PromisedSummary>('receivables:promisedThisWeek', { today }),
  dashboardPromised: (today: string) =>
    call<{ count: number; amount: number; overdueCount: number; weekFrom: string; weekTo: string }>('report:dashboardPromised', { today }),
  collections: (from: string, to: string) => call<CollectionReport>('receivables:collections', { from, to }),
  topOverdue: (asOn: string, limit = 25) => call<TopOverdueRow[]>('receivables:topOverdue', { asOn, limit })
}
