/**
 * Screen context, "Explain this" and palette detection for the assistant (WP 5.2). Pure — shared
 * by the renderer (which builds the context and shows it in the panel's context strip) and main
 * (which puts exactly the same lines in the system prompt), so what the user is shown as "what
 * the model will be told" is what the model is told. Tested in aiExplain.test.ts.
 *
 * The numbers rule holds here too: an explain request names the figure and where it came from
 * (screen, ids, period) — it never asks the model to add anything up. The `explain_figure` tool
 * returns the breakdown, the period comparison and the anomalies already computed.
 */
import { z } from 'zod'
import { toDisplayDate } from './dates'

const iso = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)
const id = z.number().int().positive()

/** Screen parameters the agent may be told (ledger on a statement, tab, as-on date…). */
export const aiScreenParamsSchema = z
  .record(z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,39}$/), z.union([z.string().max(120), z.number().int()]))
  .refine((o) => Object.keys(o).length <= 12, 'At most 12 screen parameters')

/** The figure an "Explain this" click is about — its source, never a computation. */
export const aiExplainSchema = z.object({
  /** "Cash", "Sales Accounts", "Receivables" — the row or tile the figure belongs to. */
  label: z.string().trim().min(1).max(200),
  /** The figure as displayed ("₹1,23,456.00 Dr"). */
  value: z.string().max(60),
  paise: z.number().int().optional(),
  /** The column / line the figure sits in ("Debit", "Closing balance"). */
  column: z.string().max(80).optional(),
  ledgerId: id.optional(),
  voucherId: id.optional(),
  itemId: id.optional(),
  /** A group / report line; several joined by " + " (a dashboard's "Cash & bank"). */
  groupName: z.string().max(240).optional(),
  from: iso.optional(),
  to: iso.optional(),
  asOn: iso.optional()
})
export type AiExplain = z.infer<typeof aiExplainSchema>

/** What the screen the user is on tells the agent (WP 5.1 had screen + period; 5.2 adds the
 *  screen's title, its parameters and the figure being explained). */
export const aiContextSchema = z.object({
  screen: z.string().max(60).optional(),
  /** Human title of the screen ("Trial balance"). */
  label: z.string().max(120).optional(),
  from: iso.optional(),
  to: iso.optional(),
  params: aiScreenParamsSchema.optional(),
  explain: aiExplainSchema.optional()
})
export type AiContext = z.infer<typeof aiContextSchema>

const period = (from?: string, to?: string): string | null =>
  from && to ? `${toDisplayDate(from)} to ${toDisplayDate(to)}` : to ? `as on ${toDisplayDate(to)}` : null

/** The figure's own period wording ("as on 31-Mar-26", "01-Apr-25 to 31-Mar-26"). */
export function explainPeriodText(f: Pick<AiExplain, 'from' | 'to' | 'asOn'>): string | null {
  if (f.asOn) return `as on ${toDisplayDate(f.asOn)}`
  return period(f.from, f.to)
}

/** The figure's source, compact and JSON — the line the tools key off (and the mock parses). */
export function explainSourceJson(f: AiExplain): string {
  const o: Record<string, unknown> = { label: f.label, value: f.value }
  for (const k of ['column', 'ledgerId', 'voucherId', 'itemId', 'groupName', 'from', 'to', 'asOn'] as const) {
    if (f[k] !== undefined) o[k] = f[k]
  }
  return JSON.stringify(o)
}

/**
 * The context lines for the system prompt — and, verbatim, for the panel's "what the model will be
 * told" strip. Only what the user can see on screen: its name, title, period and parameters, and
 * the figure being explained.
 */
export function screenContextLines(ctx: AiContext | null | undefined): string[] {
  if (!ctx) return []
  const out: string[] = []
  if (ctx.screen) out.push(`Screen: ${ctx.label ? `${ctx.label} (${ctx.screen})` : ctx.screen}`)
  const p = period(ctx.from, ctx.to)
  if (p) out.push(`Period on screen: ${p} (${ctx.from} to ${ctx.to})`)
  const params = Object.entries(ctx.params ?? {})
  if (params.length) out.push(`Screen parameters: ${params.map(([k, v]) => `${k}=${v}`).join(', ')}`)
  if (ctx.explain) out.push(`Figure to explain (JSON): ${explainSourceJson(ctx.explain)}`)
  return out
}

/** What an Explain-this affordance knows about the figure it sits on. */
export interface ExplainFigure extends AiExplain {
  /** The screen it is on (nav screen name) and its title. */
  screen: string
  screenLabel?: string
  /** The screen's parameters (statement ledger, tab …). */
  params?: Record<string, string | number>
}

/**
 * Builds the prefilled question and the context an "Explain this" click sends. The question names
 * the figure, the screen and the period; the context carries the ids the tools need. The model is
 * asked to explain with tools — the breakdown, comparison and anomalies come from `explain_figure`.
 */
export function explainContextFor(f: ExplainFigure): { question: string; context: AiContext } {
  const where = f.screenLabel ?? f.screen
  const when = explainPeriodText(f)
  const what = f.column && f.column !== f.label ? `${f.label} — ${f.column}` : f.label
  const question =
    `Explain this figure: ${what} = ${f.value} on ${where}${when ? `, ${when}` : ''}. ` +
    'Which vouchers and ledgers make it up, how does it compare with the previous period, and is anything unusual?'
  const explain: AiExplain = {
    label: f.label.slice(0, 200),
    value: f.value.slice(0, 60),
    ...(f.paise !== undefined ? { paise: f.paise } : {}),
    ...(f.column ? { column: f.column.slice(0, 80) } : {}),
    ...(f.ledgerId ? { ledgerId: f.ledgerId } : {}),
    ...(f.voucherId ? { voucherId: f.voucherId } : {}),
    ...(f.itemId ? { itemId: f.itemId } : {}),
    ...(f.groupName ? { groupName: f.groupName.slice(0, 240) } : {}),
    ...(f.asOn ? { asOn: f.asOn } : {}),
    ...(!f.asOn && f.from ? { from: f.from } : {}),
    ...(!f.asOn && f.to ? { to: f.to } : {})
  }
  const context: AiContext = {
    screen: f.screen.slice(0, 60),
    ...(f.screenLabel ? { label: f.screenLabel.slice(0, 120) } : {}),
    ...(f.from && f.to ? { from: f.from, to: f.to } : {}),
    ...(f.params && Object.keys(f.params).length ? { params: f.params } : {}),
    explain
  }
  return { question: question.slice(0, 8000), context }
}

// ---------- the command palette ----------

/**
 * A natural-language question typed into the palette: a trailing "?" ("why is rent high?") or a
 * leading "ask:" ("ask: sales in july"). Returns the question to send, or null. A search query
 * (filters, numbers) without either marker is never a question.
 */
export function paletteQuestion(text: string): string | null {
  const t = text.trim()
  const ask = /^ask\s*:\s*(.*)$/is.exec(t)
  if (ask) {
    const q = ask[1]!.trim()
    return q.length >= 2 ? q : null
  }
  if (!t.endsWith('?')) return null
  const body = t.replace(/\?+$/, '').trim()
  // At least two words or a word of 3+ letters: "?" alone or "x?" is not a question.
  if (!/[A-Za-z]{3,}/.test(body) && body.split(/\s+/).length < 2) return null
  return t
}

export type NavIntentKind = 'ledger' | 'item' | 'voucher'

/**
 * "open the ledger for Acme", "go to Acme Traders statement", "show item Widget", "open invoice
 * S/12" — navigation the app resolves itself through the search service (never the model).
 * Returns the search text and the kind, or null when the text is not a navigation request.
 */
export function parseNavIntent(text: string): { kind: NavIntentKind | null; target: string } | null {
  const t = text.trim().replace(/[?.!]+$/, '').trim()
  const m = /^(?:please\s+)?(?:open|go\s+to|show(?:\s+me)?|take\s+me\s+to|jump\s+to)\s+(.+)$/i.exec(t)
  if (!m) return null
  let rest = m[1]!.trim().replace(/^(?:the|a|an)\s+/i, '')
  let kind: NavIntentKind | null = null
  const KIND_WORDS: [RegExp, NavIntentKind][] = [
    [/^(?:ledger\s+statement|ledger|statement|account)\b/i, 'ledger'],
    [/^(?:stock\s+item|item|product)\b/i, 'item'],
    [/^(?:voucher|invoice|bill|receipt|payment|entry)\b/i, 'voucher']
  ]
  for (const [re, k] of KIND_WORDS) {
    if (re.test(rest)) {
      kind = k
      rest = rest.replace(re, '').trim()
      break
    }
  }
  rest = rest.replace(/^(?:for|of|called|named|no\.?|number)\s+/i, '').trim()
  // "Acme Traders statement" / "Acme's ledger"
  const tail = /\s+(?:ledger\s+statement|statement|ledger|account)$/i
  if (!kind && tail.test(rest)) {
    kind = 'ledger'
    rest = rest.replace(tail, '').trim()
  }
  rest = rest.replace(/['’]s$/i, '').trim()
  if (rest.length < 2) return null
  return { kind, target: rest.slice(0, 120) }
}
