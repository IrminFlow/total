// Assistant tools (WP 5.5). Read tools over the deterministic assistants — the close checklist,
// the GSTR-2B mismatches, the anomaly finder — and build_report, which turns the model's
// structured REPORT REQUEST (names, not ids) into a report-builder model, validates it with the
// WP 6.1 schema and runs the compiled report. The model only ever produces the request JSON;
// every figure comes from the services and leaves here formatted (the numbers rule).
// draft_gst_2b_fix is the one draft tool: it turns a mismatch's suggested action into an
// ai_drafts row — never a posting.
import { z } from 'zod'
import { formatQtyMilli } from '@shared/money'
import type { AiSource } from '@shared/ai'
import { ANOMALY_LABELS, type AnomalyKind } from '@shared/anomalies'
import { MISMATCH_LABELS, type MismatchCategory } from '@shared/gst/mismatch2b'
import { reportRequestSchema, requestToModel, type NameKind, type NameLookup } from '@shared/reportBuilder/nl'
import type { ReportResult } from '@shared/reportBuilder/model'
import { anomalies, closeChecklist, gst2bMismatches } from '../../services/assistants'
import { runReport } from '../../services/reportBuilder'
import { buildPlanDraft } from '../assistantDrafts'
import { runDraft } from '../drafting/tools'
import { capRows, drCr, rupees } from './readTools'
import { defineTool, type ToolContext, type ToolDef } from './registry'
import type { DB } from '../../db/connection'
import { descendantIdsByName } from '../../services/masters'

const month = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Expected YYYY-MM')
const iso = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD')

/** Row caps (said in `truncated` when hit). */
export const ASSISTANT_CAPS = { checkRows: 8, mismatches: 60, anomalies: 80, reportRows: 50 } as const

/** The month a tool works on when none is given: the screen's, else the month of the working
 *  period's end — never past today. */
export function defaultMonth(ctx: Pick<ToolContext, 'screen' | 'period' | 'today'>): string {
  const p = ctx.screen?.params?.period
  if (typeof p === 'string' && /^\d{4}-\d{2}$/.test(p)) return p
  const end = ctx.screen?.to ?? ctx.period.to
  return (end < ctx.today ? end : ctx.today).slice(0, 7)
}

const assistantsScreen = (tab: string, label: string, params: Record<string, string | number> = {}): AiSource => ({ kind: 'screen', screen: 'assistants', label, params: { tab, ...params } })

// ---------- close_checklist ----------

export const closeChecklistTool = defineTool({
  name: 'close_checklist',
  description:
    'The month-end close checklist for one month: each check (bank reconciliation, unallocated receipts/payments, overdue bills, GSTR-1/3B prepared, TDS/TCS deposited, negative stock, unbilled challans/GRNs, suspense, post-dated cheques, depreciation, regular expenses missing, blank narrations, rounding, open drafts, lock date) with its status (ok / warn / fail / done / na), a summary, the screen that fixes it and the first rows behind it.',
  input: z.object({ period: month.optional().describe('The month (YYYY-MM); omit for the current one') }),
  kind: 'read',
  minRole: 'viewer',
  handler: ({ period }, ctx) => {
    const p = period ?? defaultMonth(ctx)
    const c = closeChecklist(ctx.db, ctx.company, p, ctx.today)
    const sources: AiSource[] = [assistantsScreen('close', `Close checklist ${c.label}`, { period: p })]
    for (const ch of c.checks) {
      if (ch.effective === 'warn' || ch.effective === 'fail') sources.push({ kind: 'screen', screen: ch.fix.screen, label: ch.fix.label, ...(ch.fix.params ? { params: ch.fix.params } : {}) })
      for (const r of ch.rows.slice(0, 3)) {
        if (r.voucherId) sources.push({ kind: 'voucher', voucherId: r.voucherId, label: r.label })
        else if (r.ledgerId) sources.push({ kind: 'ledger', ledgerId: r.ledgerId, label: r.label })
        else if (r.itemId) sources.push({ kind: 'item', itemId: r.itemId, label: r.label })
      }
    }
    return {
      data: {
        period: p,
        month: c.label,
        progress: `${c.progress.cleared} of ${c.progress.total} checks cleared (${c.progress.pct}%)`,
        failing: c.progress.fail,
        warnings: c.progress.warn,
        checks: c.checks.map((ch) => ({
          key: ch.key,
          check: ch.title,
          status: ch.effective,
          summary: ch.summary,
          count: ch.count,
          amount: ch.amount != null && ch.amount !== 0 ? rupees(ch.amount) : undefined,
          due: ch.dueDate ?? undefined,
          markedBy: ch.mark ? `${ch.mark.status === 'na' ? 'not applicable' : 'done'} by ${ch.mark.by ?? 'a user'}${ch.mark.note ? ` — ${ch.mark.note}` : ''}` : undefined,
          fixOn: ch.fix.label,
          rowsTruncated: ch.rows.length + ch.more > ASSISTANT_CAPS.checkRows ? `showing ${ASSISTANT_CAPS.checkRows} of ${ch.rows.length + ch.more}` : undefined,
          rows: ch.rows.slice(0, ASSISTANT_CAPS.checkRows).map((r) => ({
            label: r.label,
            detail: r.detail,
            date: r.date ?? undefined,
            amount: r.amount ? rupees(r.amount) : undefined,
            voucherId: r.voucherId,
            ledgerId: r.ledgerId,
            itemId: r.itemId,
            draftId: r.draftId
          }))
        }))
      },
      sources: sources.slice(0, 30)
    }
  }
})

// ---------- gst_2b_mismatches ----------

export const gst2bMismatchesTool = defineTool({
  name: 'gst_2b_mismatches',
  description:
    'GSTR-2B vs the purchase register for one month, from the 2B JSON imported in the app: the mismatches by category (missing in books, missing in 2B, amount differs, period differs, GSTIN differs), each with the documents, the difference, a suggested action and whether a draft can be prepared (use draft_gst_2b_fix with its key).',
  input: z.object({
    period: month.optional().describe('The month (YYYY-MM); omit for the current one'),
    category: z.enum(['missing_in_books', 'missing_in_2b', 'amount_differs', 'period_differs', 'gstin_differs']).optional()
  }),
  kind: 'read',
  minRole: 'viewer',
  handler: ({ period, category }, ctx) => {
    const p = period ?? defaultMonth(ctx)
    const r = gst2bMismatches(ctx.db, p, { today: ctx.today })
    const screen = assistantsScreen('gst2b', `GSTR-2B mismatches ${p}`, { period: p })
    if (!r.statement) {
      return { data: { period: p, note: `No GSTR-2B JSON has been imported for ${p}. Import it on the GSTR-2B screen or Assistants → GST 2B.` }, sources: [screen] }
    }
    const list = category ? r.rows.filter((m) => m.category === category) : r.rows
    const cap = capRows(list, ASSISTANT_CAPS.mismatches, 'ask for one category')
    const sources: AiSource[] = [screen]
    for (const m of cap.rows.slice(0, 15)) {
      if (m.book) sources.push({ kind: 'voucher', voucherId: m.book.voucherId, label: `${m.book.supplierRef ?? m.book.number}` })
      else if (m.ledgerId) sources.push({ kind: 'ledger', ledgerId: m.ledgerId, label: m.supplier ?? 'Supplier' })
    }
    return {
      data: {
        period: p,
        returnPeriod: r.returnPeriod,
        statement: `${r.statement.documents} documents, imported ${r.statement.importedAt.slice(0, 10)}${r.statement.fileName ? ` from ${r.statement.fileName}` : ''}`,
        matched: r.matched,
        summary: r.summary.map((s) => ({ category: s.label, count: s.count, tax: rupees(s.tax) })),
        truncated: cap.truncated,
        mismatches: cap.rows.map((m) => ({
          key: m.key,
          category: MISMATCH_LABELS[m.category as MismatchCategory],
          supplier: m.supplier ?? m.portal?.gstin ?? undefined,
          gstin: m.portal?.gstin ?? m.book?.partyGstin ?? undefined,
          invoice: m.portal?.number ?? m.book?.supplierRef ?? m.book?.number,
          date: m.portal?.date ?? m.book?.date,
          in2b: m.portal ? { value: rupees(m.portal.value), tax: rupees(m.portal.igst + m.portal.cgst + m.portal.sgst + m.portal.cess) } : undefined,
          inBooks: m.book ? { voucherId: m.book.voucherId, value: rupees(m.book.invoiceValue), tax: rupees(m.book.igst + m.book.cgst + m.book.sgst + m.book.cess), month: m.bookMonth ?? undefined } : undefined,
          valueDifference: m.valueDiff ? rupees(m.valueDiff) : undefined,
          suggestion: m.suggestion,
          flags: m.flags.length ? m.flags : undefined,
          reopened: m.reopened ? `figures changed since it was ${m.reopened.previous}` : undefined,
          actions: m.actions.map((a) => a.label),
          canDraft: m.actions.some((a) => a.kind === 'draft') || undefined
        }))
      },
      sources
    }
  }
})

export const draftGst2bFixTool = defineTool({
  name: 'draft_gst_2b_fix',
  description:
    'Prepare (NOT save) the draft a GSTR-2B mismatch suggests — the purchase for an invoice missing in the books, or a debit note for an entry above what the supplier reported. Pass the mismatch key from gst_2b_mismatches. The user reviews and saves it in the voucher editor.',
  input: z.object({ period: month.describe('The month (YYYY-MM)'), key: z.string().min(3).max(200).describe('The mismatch key from gst_2b_mismatches') }),
  kind: 'draft',
  minRole: 'accountant',
  handler: ({ period, key }, ctx) => {
    const m = gst2bMismatches(ctx.db, period, { today: ctx.today }).rows.find((x) => x.key === key)
    if (!m) throw new Error(`No open mismatch ${key} for ${period}`)
    const action = m.actions.find((a) => a.kind === 'draft')
    if (!action || action.kind !== 'draft') throw new Error(`This mismatch has no draft to prepare — suggested: ${m.actions.map((a) => a.label).join('; ')}`)
    // The WP 5.3 pipeline: the accounting form's state, a rehearsed save, sources + assumptions,
    // one ai_drafts row (unrequested when the question asked for no entry).
    return runDraft(ctx, 'draft_gst_2b_fix', (w) => buildPlanDraft(w, action.plan))
  }
})

// ---------- find_anomalies ----------

const ANOMALY_KINDS = Object.keys(ANOMALY_LABELS) as [AnomalyKind, ...AnomalyKind[]]

export const findAnomaliesTool = defineTool({
  name: 'find_anomalies',
  description:
    'Unusual entries in a period: possible duplicates (same party and amount within days, same bill number, same narration and amount), large round amounts, ledger pairings never used before, amounts far above a party’s or ledger’s usual (z-score), weekend / holiday dates, back-dated entries, GST charged unlike the item rates and items of one HSN at different rates. Dismissed findings are left out.',
  input: z.object({
    from: iso.optional().describe('First day (YYYY-MM-DD); omit for the working period'),
    to: iso.optional().describe('Last day (YYYY-MM-DD)'),
    kinds: z.array(z.enum(ANOMALY_KINDS)).max(11).optional().describe('Only these kinds')
  }),
  kind: 'read',
  minRole: 'viewer',
  handler: ({ from, to, kinds }, ctx) => {
    const f = from ?? ctx.screen?.from ?? ctx.period.from
    const t = to ?? ctx.screen?.to ?? ctx.period.to
    const r = anomalies(ctx.db, f, t)
    const rows = kinds?.length ? r.rows.filter((a) => kinds.includes(a.kind)) : r.rows
    const cap = capRows(rows, ASSISTANT_CAPS.anomalies, 'ask for one kind or a shorter period')
    return {
      data: {
        from: f,
        to: t,
        found: rows.length,
        bySeverity: r.counts,
        truncated: cap.truncated,
        anomalies: cap.rows.map((a) => ({
          key: a.key,
          kind: ANOMALY_LABELS[a.kind],
          severity: a.severity,
          voucher: a.voucherId ? a.label : undefined,
          voucherId: a.voucherId ?? undefined,
          relatedVoucherIds: a.relatedVoucherIds.length ? a.relatedVoucherIds : undefined,
          item: a.itemId && !a.voucherId ? a.label : undefined,
          itemId: a.itemId ?? undefined,
          date: a.date ?? undefined,
          party: a.partyName ?? undefined,
          amount: a.amount != null ? rupees(a.amount) : undefined,
          why: a.detail
        }))
      },
      sources: [
        assistantsScreen('anomalies', `Anomalies ${f} to ${t}`),
        ...cap.rows.slice(0, 15).map((a): AiSource => (a.voucherId ? { kind: 'voucher', voucherId: a.voucherId, label: a.label } : { kind: 'item', itemId: a.itemId!, label: a.label }))
      ]
    }
  }
})

// ---------- build_report ----------

/** Names → ids over the masters: exact (case-insensitive) first, else contains (the request is
 *  then refused with the candidates). Parties are the ledgers under Sundry Debtors / Creditors. */
export function nameLookup(db: DB): NameLookup {
  const partyGroups = [...descendantIdsByName(db, ['Sundry Debtors', 'Sundry Creditors'])]
  const tables: Record<NameKind, string> = {
    ledger: 'SELECT id, name FROM ledgers',
    party: partyGroups.length ? `SELECT id, name FROM ledgers WHERE group_id IN (${partyGroups.join(',')})` : 'SELECT id, name FROM ledgers WHERE 0',
    group: 'SELECT id, name FROM groups',
    item: 'SELECT id, name FROM stock_items'
  }
  return (kind, name) => {
    const n = name.trim().toLowerCase()
    const all = db.prepare(tables[kind]).all() as { id: number; name: string }[]
    const exact = all.filter((r) => r.name.toLowerCase() === n)
    return exact.length ? exact : all.filter((r) => r.name.toLowerCase().includes(n)).slice(0, 10)
  }
}

/** One report cell as text (money formatted, Dr/Cr for signed measures). */
export function cellText(v: number | null, kind: 'money' | 'quantity' | 'number', signed: boolean): string | undefined {
  if (v === null) return undefined
  if (kind === 'money') return signed ? drCr(v) : rupees(v)
  if (kind === 'quantity') return formatQtyMilli(v)
  return String(v)
}

export function reportForModel(r: ReportResult, cap: number): Record<string, unknown> {
  const rows = capRows(r.rows, cap, 'open it in the report builder for every row')
  const rowOut = (keys: { label: string }[], values: (number | null)[]): Record<string, string | undefined> => {
    const o: Record<string, string | undefined> = {}
    r.dims.forEach((d, i) => (o[d.label] = keys[i]?.label))
    r.measures.forEach((m, i) => (o[m.label] = cellText(values[i] ?? null, m.kind, m.signed)))
    return o
  }
  return {
    from: r.from,
    to: r.to,
    columns: [...r.dims.map((d) => d.label), ...r.measures.map((m) => m.label)],
    rowCount: r.rows.length,
    truncated: rows.truncated ?? (r.truncated ? `the report stopped at ${r.rowCap} rows` : undefined),
    rows: rows.rows.map((row) => rowOut(row.keys, row.values)),
    totals: Object.fromEntries(r.measures.map((m, i) => [m.label, cellText(r.totals[i] ?? null, m.kind, m.signed)])),
    warnings: r.warnings.length ? r.warnings : undefined
  }
}

export const buildReportTool = defineTool({
  name: 'build_report',
  description:
    'Build and run a custom report with the report builder: give a REQUEST (source, dimensions to group by, measures, period, filters by name, sort, top N). It is checked against the report builder’s rules (problems come back as an error to fix), run over the books, and the result rows and totals returned with a link that opens it in the report builder pre-filled (where the user can save it). Measures: debit, credit, net, count, taxable, cgst, sgst, igst, cess, gst, tds, tcs, profit, balance (accounts); qtyIn, qtyOut, qtyNet, value, count (inventory). For sales / purchases use taxable with voucherKinds ["sales"] / ["purchase"].',
  input: reportRequestSchema,
  kind: 'read',
  minRole: 'viewer',
  handler: (req, ctx) => {
    const res = requestToModel(req, nameLookup(ctx.db))
    if (!res.ok) throw new Error(`The report request is not valid: ${res.problems.join('; ')}`)
    const working = { from: ctx.screen?.from ?? ctx.period.from, to: ctx.screen?.to ?? ctx.period.to }
    const r = runReport(ctx.db, res.model, { working, today: ctx.today })
    const modelJson = JSON.stringify(res.model)
    return {
      data: { title: res.title, resolvedNames: res.resolved.length ? res.resolved.map((x) => `${x.asked} → ${x.name}`) : undefined, ...reportForModel(r, ASSISTANT_CAPS.reportRows) },
      sources: [{ kind: 'screen', screen: 'report-builder', label: `Open “${res.title}” in the report builder`, params: { model: modelJson, title: res.title } }]
    }
  }
})

export const ASSISTANT_TOOLS: ToolDef[] = [closeChecklistTool, gst2bMismatchesTool, findAnomaliesTool, buildReportTool, draftGst2bFixTool]
