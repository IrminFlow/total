// Typed client for the assistants (WP 5.5) — the channels in src/main/ipcAssistants.ts.
import { call } from './client'
import type { AnomalyReport, AssistantSettings, Gst2bMismatchReport, Gst2bStatementInfo } from '@shared/assistants'
import type { CloseChecklist, CloseCheckKey } from '@shared/closeChecklist'
import type { ReportModel } from '@shared/reportBuilder/model'
import type { ReportRequest } from '@shared/reportBuilder/nl'
import type { AiDraftDto } from '@shared/ai'

export type NlReportReply = { ok: true; title: string; model: ReportModel; request: ReportRequest } | { ok: false; problems: string[]; request?: ReportRequest }

export const assistantsApi = {
  close: (period: string) => call<CloseChecklist>('assist:close', { period }),
  markClose: (period: string, key: CloseCheckKey, status: 'done' | 'na' | null, note?: string) =>
    call<CloseChecklist>('assist:close:mark', { period, key, status, ...(note ? { note } : {}) }),
  anomalies: (from: string, to: string, includeDismissed = false) => call<AnomalyReport>('assist:anomalies', { from, to, includeDismissed }),
  dismissAnomaly: (key: string, dismissed: boolean, note?: string) => call<unknown>('assist:anomaly:dismiss', { key, dismissed, ...(note ? { note } : {}) }),
  settings: () => call<AssistantSettings>('assist:settings:get'),
  setSettings: (patch: Partial<AssistantSettings>) => call<AssistantSettings>('assist:settings:set', patch),
  gst2b: (period: string, includeResolved = false) => call<Gst2bMismatchReport>('assist:gst2b', { period, includeResolved }),
  store2b: (jsonText: string, period: string, fileName?: string) => call<Gst2bStatementInfo>('assist:gst2b:store', { jsonText, period, ...(fileName ? { fileName } : {}) }),
  resolve2b: (period: string, key: string, status: 'resolved' | 'dismissed' | null, note?: string) =>
    call<unknown>('assist:gst2b:resolve', { period, key, status, ...(note ? { note } : {}) }),
  draft2b: (period: string, key: string) => call<AiDraftDto>('assist:gst2b:draft', { period, key }),
  nlReport: (question: string, from: string, to: string) => call<NlReportReply>('assist:nlReport', { question, from, to })
}
