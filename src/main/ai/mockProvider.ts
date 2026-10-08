// Deterministic stand-in for the provider (WP 5.1). Tests hand it a script — a list of steps, or
// a function of the request — and it replays tool calls and answers exactly, streaming text in
// small chunks so the delta path is exercised. Every request it receives is recorded, so a test
// can assert what would have been sent (masking, pseudonyms, tools offered).
//
// `demoScript` is the built-in script behind TOTAL_AI_MOCK=1 (honoured only with TOTAL_DATA_DIR
// in an unpackaged build — see agentEnv.ts) that the e2e scenario drives: "what were sales in
// July?" and "pay … in cash" style questions.
import { draftingDemoStep } from './mockDrafting'
import { AiAbortError, ZERO_USAGE, type AiProvider, type ChatHandlers, type ChatItem, type ChatRequest, type ChatResult, type ChatUsage } from './types'

export type MockStep =
  | { text: string; toolCalls?: undefined; usage?: Partial<ChatUsage>; model?: string; reasoning?: Record<string, unknown>[] }
  | { toolCalls: { name: string; arguments: Record<string, unknown> | string }[]; text?: string; usage?: Partial<ChatUsage>; model?: string; reasoning?: Record<string, unknown>[] }
  | { error: string }

export type MockScript = readonly MockStep[] | ((req: ChatRequest, callIndex: number) => MockStep)

export interface MockProviderOptions {
  models?: string[]
  /** Characters per streamed chunk. */
  chunk?: number
  /** Delay between chunks (ms) — lets a test press Stop mid-stream. */
  delayMs?: number
}

const DEFAULT_USAGE: ChatUsage = { inputTokens: 1000, cachedTokens: 200, outputTokens: 100, reasoningTokens: 0 }

export class MockProvider implements AiProvider {
  readonly name = 'mock'
  readonly requests: ChatRequest[] = []
  private calls = 0

  constructor(
    private readonly script: MockScript,
    private readonly opts: MockProviderOptions = {}
  ) {}

  async chat(req: ChatRequest, handlers: ChatHandlers = {}): Promise<ChatResult> {
    // Snapshot the request (the loop mutates its input array between steps).
    this.requests.push({ ...req, input: [...req.input], signal: undefined })
    const index = this.calls++
    const step = typeof this.script === 'function' ? this.script(req, index) : this.script[index]
    if (!step) throw new Error(`MockProvider: no scripted step #${index + 1}`)
    if (req.signal?.aborted) throw new AiAbortError()
    if ('error' in step) throw new Error(step.error)
    const usage = { ...DEFAULT_USAGE, ...(step.usage ?? {}) }
    const text = step.text ?? ''
    const size = Math.max(1, this.opts.chunk ?? 12)
    for (let i = 0; i < text.length; i += size) {
      if (req.signal?.aborted) throw new AiAbortError()
      handlers.onTextDelta?.(text.slice(i, i + size))
      if (this.opts.delayMs) await new Promise((r) => setTimeout(r, this.opts.delayMs))
    }
    if (req.signal?.aborted) throw new AiAbortError()
    const toolCalls = (step.toolCalls ?? []).map((c, i) => ({ callId: `call_${index + 1}_${i + 1}`, name: c.name, arguments: typeof c.arguments === 'string' ? c.arguments : JSON.stringify(c.arguments) }))
    return { text, toolCalls, usage, model: step.model ?? req.model, finish: toolCalls.length ? 'tool_calls' : 'stop', reasoning: step.reasoning ?? [] }
  }

  async models(): Promise<string[]> {
    return [...(this.opts.models ?? [])]
  }
}

export const mockUsage = (u: Partial<ChatUsage> = {}): ChatUsage => ({ ...ZERO_USAGE, ...u })

// ---------- the built-in demo script (TOTAL_AI_MOCK=1) ----------

/** Items after the last user message (this turn's tool calls and results). */
function sinceLastUser(input: readonly ChatItem[]): { question: string; results: { name: string; output: string }[] } {
  let at = -1
  for (let i = input.length - 1; i >= 0; i--) {
    const it = input[i]!
    if (it.type === 'message' && it.role === 'user') {
      at = i
      break
    }
  }
  const question = at >= 0 ? (input[at] as { content: string }).content : ''
  const names = new Map<string, string>()
  const results: { name: string; output: string }[] = []
  for (const it of input.slice(at + 1)) {
    if (it.type === 'tool_call') names.set(it.callId, it.name)
    if (it.type === 'tool_result') results.push({ name: names.get(it.callId) ?? '?', output: it.output })
  }
  return { question, results }
}

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december']

function workingFyStart(instructions: string): number {
  const m = /Working period: (\d{4})-(\d{2})-\d{2}/.exec(instructions)
  if (!m) return new Date().getFullYear()
  const y = Number(m[1])
  return Number(m[2]) >= 4 ? y : y - 1
}

function monthRange(month: number, fyStart: number): { from: string; to: string } {
  const year = month >= 4 ? fyStart : fyStart + 1
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate()
  const mm = String(month).padStart(2, '0')
  return { from: `${year}-${mm}-01`, to: `${year}-${mm}-${String(last).padStart(2, '0')}` }
}

interface PnlNodeOut {
  name: string
  amount: string
  children?: PnlNodeOut[]
}

function findNode(nodes: PnlNodeOut[] | undefined, re: RegExp): PnlNodeOut | null {
  for (const n of nodes ?? []) {
    if (re.test(n.name)) return n
    const c = findNode(n.children, re)
    if (c) return c
  }
  return null
}

// ---------- WP 5.2: "Explain this" and screen questions ----------

const parse = (text: string): { result?: Record<string, unknown>; error?: string } => {
  try {
    return JSON.parse(text) as { result?: Record<string, unknown>; error?: string }
  } catch {
    return { error: 'unreadable result' }
  }
}

type Row = Record<string, unknown>
const s = (v: unknown): string => (typeof v === 'string' ? v : v == null ? '' : String(v))

/** The answer to an explain_figure result — quoted from it, a markdown table of the largest entries. */
function explainAnswer(r: Row): string {
  if (r.figure === 'ledger') {
    const prev = (r.previousPeriod ?? {}) as Row
    const top = ((r.largestVouchers ?? []) as Row[]).slice(0, 5)
    const anomalies = (r.anomalies ?? []) as Row[]
    const lines = [
      r.periodAmount
        ? `**${s(r.ledger)}** comes to ${s(r.periodAmount)} for ${s((r.period as Row)?.from)} to ${s((r.period as Row)?.to)} (debits ${s(r.totalDebit)}, credits ${s(r.totalCredit)}, ${s(r.vouchers)} vouchers).`
        : `**${s(r.ledger)}** closed at ${s(r.closing)} for ${s((r.period as Row)?.from)} to ${s((r.period as Row)?.to)} (opening ${s(r.opening)}, debits ${s(r.totalDebit)}, credits ${s(r.totalCredit)}, ${s(r.vouchers)} vouchers).`,
      '',
      top.length ? 'The largest entries:' : 'There are no entries in the period.',
      ...(top.length
        ? ['', '| Voucher | Date | Other side | Amount | Share |', '|---|---|---|---:|---:|', ...top.map((v) => `| ${s(v.type)} ${s(v.number)} | ${s(v.date)} | ${s(v.particulars)} | ${s(v.debit) || s(v.credit)} | ${s(v.shareOfTurnover)} |`)]
        : []),
      '',
      `Previous period (${s(prev.from)} to ${s(prev.to)}): ${prev.periodAmount ? s(prev.periodAmount) : `closing ${s(prev.closing)}`}; it ${prev.change === 'unchanged' ? 'is unchanged' : s(prev.change)}${prev.changePct ? ` (${s(prev.changePct)})` : ''}.`,
      '',
      anomalies.length ? `Unusual: ${anomalies.map((a) => s(a.what)).join('; ')}.` : s(r.noAnomalies) || 'Nothing unusual.'
    ]
    return lines.join('\n')
  }
  if (r.figure === 'group') {
    const kids = ((r.madeUpOf ?? []) as Row[]).slice(0, 6)
    const prev = (r.previousPeriod ?? {}) as Row
    return [
      `**${s(r.group)}** is ${s(r.amount)} on the ${s(r.basis)}. It is made up of:`,
      '',
      ...kids.map((k) => `- ${s(k.name)}: ${s(k.amount)}${k.share ? ` (${s(k.share)})` : ''}`),
      '',
      prev.amount ? `Previous period: ${s(prev.amount)}${prev.changePct ? ` (${s(prev.changePct)})` : ''}.` : 'No figure for the previous period.'
    ].join('\n')
  }
  if (r.figure === 'groups') return ((r.parts ?? []) as Row[]).map(explainAnswer).join('\n\n')
  if (r.voucherId && r.lines) {
    const lines = (r.lines as Row[]).slice(0, 8)
    return [`**${s(r.type)} ${s(r.number)}** dated ${s(r.date)} totals ${s(r.total)}:`, '', ...lines.map((l) => `- ${s(l.ledger)} ${s(l.side)} ${s(l.amount)}`)].join('\n')
  }
  if (r.item) return `**${s(r.item)}**: opening ${s((r.opening as Row)?.value)}, inward ${s((r.inward as Row)?.value)}, outward ${s((r.outward as Row)?.value)}, closing ${s((r.closing as Row)?.value)}.`
  return 'The explanation tool returned nothing I can summarise.'
}

/** "What is on this screen" — a short, quoted summary of current_screen_data. */
function screenAnswer(r: Row): string {
  const subject = s(r.ledger) || s(r.item) || s(r.bank) || s(r.budget)
  const title = `${s(r.title) || s(r.screen)}${subject ? ` — ${subject}` : ''}`
  if (r.note) return `${title}: ${s(r.note)}`
  const money = Object.entries(r).filter(([, v]) => typeof v === 'string' && /₹/.test(v)).slice(0, 6)
  const rows = Array.isArray(r.rows) ? (r.rows as Row[]) : []
  const parts = [`**${title}**${money.length ? ':' : ''}`, ...money.map(([k, v]) => `- ${k}: ${s(v)}`)]
  if (rows.length) parts.push('', `It lists ${rows.length} rows${r.truncated ? ` (${s(r.truncated)})` : ''}.`)
  return parts.join('\n')
}

export const demoScript: MockScript = (req) => {
  const { question, results } = sinceLastUser(req.input)
  const q = question.toLowerCase()
  // WP 5.3: drafting questions (sales invoice, payment against bills) — mockDrafting.ts.
  const drafting = draftingDemoStep(question, results, /Today: (\d{4}-\d{2}-\d{2})/.exec(req.instructions)?.[1])
  if (drafting) return drafting

  const figure = /Figure to explain \(JSON\): (\{.*\})/.exec(req.instructions)?.[1]
  if (figure && /^explain this figure/i.test(question)) {
    const done = results.find((r) => r.name === 'explain_figure')
    if (!done) {
      let f: Row = {}
      try {
        f = JSON.parse(figure) as Row
      } catch {
        /* fall through with no ids */
      }
      const args: Row = {}
      for (const k of ['ledgerId', 'voucherId', 'itemId', 'groupName', 'from', 'to', 'asOn']) if (f[k] !== undefined) args[k] = f[k]
      if (!args.ledgerId && !args.voucherId && !args.itemId && !args.groupName) args.groupName = f.label
      return { text: '', toolCalls: [{ name: 'explain_figure', arguments: args }] }
    }
    const d = parse(done.output)
    if (d.error || !d.result) return { text: `I could not explain it: ${d.error ?? 'no result'}` }
    return { text: explainAnswer(d.result) }
  }

  if (/\b(this screen|on screen|why is this|what am i looking at|this report)\b/.test(q)) {
    const done = results.find((r) => r.name === 'current_screen_data')
    if (!done) return { text: '', toolCalls: [{ name: 'current_screen_data', arguments: {} }] }
    const d = parse(done.output)
    if (d.error || !d.result) return { text: `I could not read the screen: ${d.error ?? 'no result'}` }
    return { text: screenAnswer(d.result) }
  }

  if (/\bsales?\b/.test(q)) {
    const monthIdx = MONTHS.findIndex((m) => q.includes(m) || q.includes(m.slice(0, 3) + ' '))
    const month = monthIdx >= 0 ? monthIdx + 1 : 7
    const pnl = results.find((r) => r.name === 'profit_and_loss')
    if (!pnl) {
      const range = monthRange(month, workingFyStart(req.instructions))
      return { text: '', toolCalls: [{ name: 'profit_and_loss', arguments: range }] }
    }
    try {
      const data = JSON.parse(pnl.output) as { result?: { period?: { from: string; to: string }; tradingIncomes?: PnlNodeOut[]; indirectIncomes?: PnlNodeOut[] } }
      const r = data.result ?? {}
      const sales = findNode(r.tradingIncomes, /sales/i) ?? findNode(r.indirectIncomes, /sales/i)
      const label = MONTHS[month - 1]!.replace(/^./, (c) => c.toUpperCase())
      if (!sales) return { text: `The profit and loss for ${label} shows no sales.` }
      return {
        text: `Sales in ${label} were ${sales.amount} (${sales.name}, from the profit and loss for ${r.period?.from} to ${r.period?.to}).`
      }
    } catch {
      return { text: 'I could not read the profit and loss result.' }
    }
  }

  if (/\bpa(y|id|yment)\b/.test(q)) {
    const draft = results.find((r) => r.name === 'draft_voucher')
    if (draft) {
      try {
        const d = JSON.parse(draft.output) as { result?: { draftId?: number; summary?: string }; error?: string }
        if (d.error) return { text: `I could not draft it: ${d.error}` }
        return { text: `I drafted it: ${d.result?.summary}. Review the draft and save it from the voucher editor — nothing is in the books yet.` }
      } catch {
        return { text: 'The draft tool answered with something I could not read.' }
      }
    }
    const list = results.find((r) => r.name === 'list_ledgers')
    if (!list) return { text: '', toolCalls: [{ name: 'list_ledgers', arguments: {} }] }
    const ledgers = ((JSON.parse(list.output) as { result?: { ledgers?: { id: number; name: string; group: string }[] } }).result?.ledgers ?? [])
    const cash = ledgers.find((l) => /^cash$/i.test(l.name)) ?? ledgers.find((l) => /cash/i.test(l.group))
    const words = q.split(/[^a-z0-9]+/).filter((w) => w.length > 2 && !['pay', 'paid', 'payment', 'cash', 'for', 'the', 'from', 'draft', 'rupees', 'and', 'with'].includes(w))
    const payee = ledgers.find((l) => l !== cash && words.some((w) => l.name.toLowerCase().includes(w)))
    const amount = /(\d[\d,]*(?:\.\d{1,2})?)/.exec(question)?.[1]?.replace(/,/g, '')
    if (!cash || !payee || !amount) return { text: 'Tell me who to pay, how much, and from which cash or bank ledger.' }
    return {
      text: '',
      toolCalls: [
        {
          name: 'draft_voucher',
          arguments: {
            kind: 'payment',
            date: /Today: (\d{4}-\d{2}-\d{2})/.exec(req.instructions)?.[1],
            narration: question.slice(0, 120),
            lines: [
              { ledgerId: payee.id, drCr: 'dr', amount },
              { ledgerId: cash.id, drCr: 'cr', amount }
            ]
          }
        }
      ]
    }
  }

  return {
    text: 'This is the offline test assistant (TOTAL_AI_MOCK). It only knows "sales in <month>", "pay <amount> <ledger> in cash", "what is on this screen?" and Explain this.'
  }
}
