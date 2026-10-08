// IPC channels for the assistants (WP 5.5): close checklist, anomalies, GSTR-2B mismatches and
// the deterministic "report from a question". Registered from ipc.ts with its `handle` (role gate
// + { ok, data | error } envelope); every payload is Zod-parsed here. They work with AI off — the
// AI tools in src/main/ai/tools/assistantTools.ts call the same services. Write channels (marks,
// dismissals, settings, the stored 2B statement, 2B drafts) are mapped in auditCoverage.ts.
import type { DB } from './db/connection'
import type { CompanyInfo } from '@shared/domain'
import type { Role } from './services/roles'
import { todayISO } from '@shared/dates'
import {
  anomalyDismissSchema, anomalyQuerySchema, assistantSettingsSchema, closeMarkSchema, closeQuerySchema, gst2bDraftSchema, gst2bQuerySchema, gst2bResolveSchema,
  gst2bStoreSchema, nlReportSchema
} from '@shared/assistants'
import { parseReportQuestion, requestToModel } from '@shared/reportBuilder/nl'
import * as assist from './services/assistants'
import { insertPlanDraft } from './ai/assistantDrafts'
import { nameLookup } from './ai/tools/assistantTools'

type Handle = (channel: string, fn: (payload: unknown) => unknown, minRole?: Role) => void
interface Company {
  db: DB
  info: CompanyInfo
}

export function registerAssistantsIpc(handle: Handle, company: () => Company, userName: () => string | null): void {
  const db = (): DB => company().db

  // ---------- month-end close checklist ----------
  handle('assist:close', (p) => assist.closeChecklist(db(), company().info, closeQuerySchema.parse(p).period, todayISO()), 'viewer')
  handle('assist:close:mark', (p) => {
    const m = closeMarkSchema.parse(p)
    assist.markCloseCheck(db(), m.period, m.key, m.status, m.note ?? null, userName())
    return assist.closeChecklist(db(), company().info, m.period, todayISO())
  })

  // ---------- anomalies ----------
  handle('assist:anomalies', (p) => {
    const q = anomalyQuerySchema.parse(p)
    if (q.from > q.to) throw new Error('The period starts after it ends')
    return assist.anomalies(db(), q.from, q.to, { includeDismissed: q.includeDismissed })
  }, 'viewer')
  handle('assist:anomaly:dismiss', (p) => {
    const d = anomalyDismissSchema.parse(p)
    return assist.dismissAnomaly(db(), d.key, d.dismissed, d.note ?? null, userName())
  })
  handle('assist:settings:get', () => assist.getAssistantSettings(db()), 'viewer')
  handle('assist:settings:set', (p) => assist.setAssistantSettings(db(), assistantSettingsSchema.parse(p)))

  // ---------- GSTR-2B mismatches ----------
  handle('assist:gst2b', (p) => {
    const q = gst2bQuerySchema.parse(p)
    return assist.gst2bMismatches(db(), q.period, { includeResolved: q.includeResolved })
  }, 'viewer')
  handle('assist:gst2b:store', (p) => assist.store2bStatement(db(), gst2bStoreSchema.parse(p), userName()))
  handle('assist:gst2b:resolve', (p) => {
    const r = gst2bResolveSchema.parse(p)
    return assist.resolve2bMismatch(db(), r.period, r.key, r.status, r.note ?? null, userName())
  })
  handle('assist:gst2b:draft', (p) => {
    const { period, key } = gst2bDraftSchema.parse(p)
    const m = assist.gst2bMismatches(db(), period).rows.find((x) => x.key === key)
    if (!m) throw new Error('That mismatch is no longer open — refresh')
    const action = m.actions.find((a) => a.kind === 'draft')
    if (!action || action.kind !== 'draft') throw new Error('This mismatch has no draft to prepare')
    return insertPlanDraft(db(), action.plan, { threadId: null, messageId: null, source: 'chat', origin: 'GST 2B assistant' })
  })

  // ---------- report from a question (deterministic — no AI) ----------
  handle('assist:nlReport', (p) => {
    const { question, from, to } = nlReportSchema.parse(p)
    const req = parseReportQuestion(question, { from, to })
    if (!req) {
      return { ok: false as const, problems: ['I could not map that to a report. Try “sales by month”, “top 10 customers by sales this year”, “expenses by ledger last quarter” or “GST on purchases by month”.'] }
    }
    const r = requestToModel(req, nameLookup(db()))
    return r.ok ? { ok: true as const, title: r.title, model: r.model, request: req } : { ok: false as const, problems: r.problems, request: req }
  }, 'viewer')
}
