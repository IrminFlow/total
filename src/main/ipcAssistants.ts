// IPC channels for the assistants (WP 5.5): close checklist, anomalies and GSTR-2B mismatches.
// Registered from ipc.ts with its `handle` (role gate
// + { ok, data | error } envelope); every payload is Zod-parsed here. They work with AI off — the
// AI tools in src/main/ai/tools/assistantTools.ts call the same services. Write channels (marks,
// dismissals, settings, the stored 2B statement, 2B drafts) are mapped in auditCoverage.ts.
import type { DB } from './db/connection'
import type { CompanyInfo } from '@shared/domain'
import type { Role } from './services/roles'
import { fyOf, todayISO } from '@shared/dates'
import {
  anomalyDismissSchema, anomalyQuerySchema, assistantSettingsSchema, closeMarkSchema, closeQuerySchema, gst2bDraftSchema, gst2bQuerySchema, gst2bResolveSchema,
  gst2bStoreSchema
} from '@shared/assistants'
import * as assist from './services/assistants'
import { insertPlanDraft } from './ai/assistantDrafts'

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
    assist.markCloseCheck(db(), company().info, m.period, m.key, m.status, m.note ?? null, userName(), todayISO())
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
    // A ref (the AI assistant's letters-only alias) is resolved to the stored key here; the mark
    // is keyed by the key as before.
    const today = todayISO()
    const key = d.key ?? assist.anomalyKeyForRef(db(), d.ref!, d.from ?? fyOf(today).from, d.to ?? today)
    return assist.dismissAnomaly(db(), key, d.dismissed, d.note ?? null, userName())
  })
  handle('assist:settings:get', () => assist.getAssistantSettings(db()), 'viewer')
  handle('assist:settings:set', (p) => assist.setAssistantSettings(db(), assistantSettingsSchema.parse(p)), 'owner')

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
    return insertPlanDraft(db(), company().info, todayISO(), action.plan, { threadId: null, messageId: null, origin: 'GST 2B assistant' })
  })
}
