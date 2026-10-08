// WP 5.5 assistants: close_checklist, find_anomalies, gst_2b_mismatches and build_report — the
// right tool for the question, and figures equal to the services' (build_report's to compile() +
// runReport); draft_gst_2b_fix makes a draft only (books unchanged, checked on every case).
import { parseReportQuestion } from '@shared/reportBuilder/nl'
import type { EvalCase } from '../types'
import { FY, call, qa, rupees, say, step } from './util'

type Row = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any

const missingRow = (r: Row | undefined): Row | undefined => (r?.mismatches as Row[] | undefined)?.find((m) => m.canDraft)

export const ASSISTANT_CASES: EvalCase[] = [
  qa({
    id: 'tool.close-checklist', category: 'tool_choice', title: 'Month-end readiness → close_checklist for that month',
    question: 'Are we ready to close the books for March 2026?',
    tool: 'close_checklist', args: () => ({ period: '2026-03' }),
    scoreTool: {},
    answer: (r) => `${r.month}: ${r.progress}; ${r.failing} failing, ${r.warnings} warnings.`
  }),
  qa({
    id: 'acc.close-checklist', category: 'accuracy', title: 'A close-checklist figure equals the service',
    question: 'What is still open on the March 2026 close checklist, with amounts?',
    tool: 'close_checklist', args: () => ({ period: '2026-03' }),
    answer: (r, c) => {
      const k = (r.checks as Row[]).find((x) => x.key === c.f.facts.close.key)
      return `${k?.check}: ${k?.summary} (${k?.amount}).`
    },
    figures: (f) => [f.facts.close.amount]
  }),
  qa({
    id: 'tool.find-anomalies', category: 'tool_choice', title: 'Unusual entries → find_anomalies',
    question: 'Is there anything unusual in the books this year?',
    tool: 'find_anomalies', args: () => ({ ...FY }),
    scoreTool: { args: () => ({}) },
    answer: (r) => `${r.found} finding(s); for example ${(r.anomalies as Row[])[0]?.kind} on ${(r.anomalies as Row[])[0]?.date ?? 'an item'}.`
  }),
  qa({
    id: 'acc.anomaly-amount', category: 'accuracy', title: 'An anomaly amount equals the service',
    question: 'Which entries look unusual this year, and for how much?',
    tool: 'find_anomalies', args: () => ({ ...FY }),
    answer: (r, c) => {
      // Picked by its row, not its key: anomaly keys carry long digit runs that outbound masking
      // rewrites (unlike the identifier-free 2B keys), so the key the model sees is not the stored one.
      const a = (r.anomalies as Row[]).find((x) => x.amount === rupees(c.f.facts.anomaly.amount))
      return `${a?.kind}: ${a?.voucher ?? a?.item} for ${a?.amount} — ${a?.why}`
    },
    figures: (f) => [f.facts.anomaly.amount]
  }),
  qa({
    id: 'tool.gst-2b', category: 'tool_choice', title: 'GSTR-2B differences → gst_2b_mismatches for the month',
    question: 'Does our purchase register match GSTR-2B for September 2025?',
    tool: 'gst_2b_mismatches', args: () => ({ period: '2025-09' }),
    scoreTool: {},
    answer: (r) => `${r.matched} matched; differences: ${(r.summary as Row[]).map((s) => `${s.category} ${s.count}`).join(', ')}.`
  }),
  qa({
    id: 'acc.gst-2b-missing', category: 'accuracy', title: 'The 2B invoice missing in the books — value and tax',
    question: 'Which September 2025 GSTR-2B invoice is missing from our books, and for how much?',
    tool: 'gst_2b_mismatches', args: () => ({ period: '2025-09' }),
    answer: (r) => {
      const m = missingRow(r)
      return `${m?.supplier} invoice ${m?.invoice} dated ${m?.date}: value ${m?.in2b?.value}, tax ${m?.in2b?.tax}. ${m?.suggestion}`
    },
    figures: (f) => [f.facts.gst2b.missingValue, f.facts.gst2b.missingTax]
  }),
  qa({
    id: 'tool.build-report', category: 'tool_choice', title: 'A custom report → build_report',
    question: 'Build me a report of sales by month for this year.',
    tool: 'build_report', args: () => parseReportQuestion('sales by month', FY) as unknown as Record<string, unknown>,
    scoreTool: { args: () => ({ source: 'accounts' }) },
    answer: (r) => `“${r.title}”: ${r.rowCount} rows (${(r.columns as string[]).join(', ')}).`
  }),
  qa({
    id: 'acc.build-report-total', category: 'accuracy', title: 'build_report totals equal compile() + runReport',
    question: 'What were total sales this year, month by month?',
    tool: 'build_report', args: () => parseReportQuestion('sales by month', FY) as unknown as Record<string, unknown>,
    answer: (r) => `Total ${Object.keys(r.totals)[0]}: ${Object.values(r.totals)[0]} over ${r.rowCount} months.`,
    figures: (f) => [f.facts.reportSalesTotal]
  }),
  {
    kind: 'chat', id: 'draft.gst-2b-fix', category: 'draft', title: 'draft_gst_2b_fix: the missing purchase as a DRAFT only',
    turns: [{
      question: 'Draft the purchase entry for the GSTR-2B invoice missing from our books in September 2025.',
      route: [
        step(call('gst_2b_mismatches', { period: '2025-09' })),
        step(call('draft_gst_2b_fix', (c) => ({ period: '2025-09', key: missingRow(c.last('gst_2b_mismatches'))?.key ?? 'none' }))),
        say((c) => `Draft ready for review: ${c.last('draft_gst_2b_fix')?.summary}. Nothing is posted until you save it.`)
      ]
    }],
    expect: {
      tools: { calls: () => [{ name: 'gst_2b_mismatches', args: { period: '2025-09' } }, { name: 'draft_gst_2b_fix', args: { period: '2025-09' } }], ordered: true },
      drafts: (f) => [{
        voucherKind: 'purchase', partyLedgerId: f.ids.sharmaSteel,
        lines: [{ ledgerId: f.ids.purchase, drCr: 'dr', amount: 1_000_000 }, { ledgerId: f.ids.sharmaSteel, drCr: 'cr', amount: f.facts.gst2b.missingValue }]
      }]
    }
  }
]
