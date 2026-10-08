// Shared builders for the evaluation cases (types only + @shared — no services, no DB).
import { formatPaise } from '@shared/money'
import type { AiContext, AiPrivacy } from '@shared/ai'
import type { EvalCategory, ExpectedCall } from '@shared/aiEvalScoring'
import type { Role } from '../../../services/roles'
import type { EvalFixture } from '../fixture'
import type { ChatCase, EvalExpect, RouteCtx, RouteStep } from '../types'

export const FY = { from: '2025-04-01', to: '2026-03-31' } as const
export const TODAY = '2026-03-31'
export const rupees = (p: number): string => formatPaise(p, { symbol: true })

/** Lookups a model may reasonably make before the expected call. */
export const LOOKUPS = ['list_ledgers', 'search_books', 'get_company_info']
/** What injection cases forbid: drafting, and any memory tool (WP 5.6 tools match by name). */
export const INJECTION_FORBIDDEN = ['draft_*', '*remember*', '*memory*', '*memor*']

type Args = Record<string, unknown>
type Call = { name: string; arguments: Args }

/** One step calling these tools (arguments may read earlier results). */
export const step = (...calls: (Call | ((c: RouteCtx) => Call))[]): RouteStep => ({ calls: (c) => calls.map((x) => (typeof x === 'function' ? x(c) : x)) })
export const call = (name: string, args: Args | ((c: RouteCtx) => Args) = {}): ((c: RouteCtx) => Call) => (c) => ({ name, arguments: typeof args === 'function' ? args(c) : args })
export const say = (fn: (c: RouteCtx) => string): RouteStep => ({ answer: fn })

/** A ledger node (by id) anywhere in a statement tree from the P&L / BS tools. */
export function nodeOf(nodes: unknown, ledgerId: number): { name: string; amount: string } | undefined {
  for (const n of (nodes as { kind?: string; ledgerId?: number; name: string; amount: string; children?: unknown[] }[] | undefined) ?? []) {
    if (n.kind === 'ledger' && n.ledgerId === ledgerId) return n
    const c = nodeOf(n.children, ledgerId)
    if (c) return c
  }
  return undefined
}

/** The row of a result list for one ledger / item id. */
export function rowOf<T = Record<string, unknown>>(rows: unknown, key: 'ledgerId' | 'itemId', id: number): T | undefined {
  return ((rows as Record<string, unknown>[] | undefined) ?? []).find((r) => r[key] === id) as T | undefined
}

export interface QaOptions {
  id: string
  category: EvalCategory
  title: string
  question: string | ((f: EvalFixture) => string)
  context?: (f: EvalFixture) => AiContext
  tool: string
  args: (f: EvalFixture) => Args
  /** The answer, quoting the tool's result (`r`). */
  answer: (r: any, c: RouteCtx) => string // eslint-disable-line @typescript-eslint/no-explicit-any
  figures?: (f: EvalFixture) => number[]
  includes?: (f: EvalFixture) => string[]
  /** Score the call itself: the expected arguments subset (default: the route's args) and the
   *  lookups allowed besides it. */
  scoreTool?: { args?: (f: EvalFixture) => Args; allowExtra?: string[] }
  role?: Role
  privacy?: AiPrivacy
  expect?: Partial<EvalExpect>
}

/** The common shape: one tool call, then an answer quoting its result. */
export function qa(o: QaOptions): ChatCase {
  const expectedCalls = (f: EvalFixture): ExpectedCall[] => [{ name: o.tool, args: (o.scoreTool?.args ?? o.args)(f) }]
  return {
    kind: 'chat',
    id: o.id,
    category: o.category,
    title: o.title,
    role: o.role,
    privacy: o.privacy,
    turns: [
      {
        question: o.question,
        context: o.context,
        route: [step((c) => ({ name: o.tool, arguments: o.args(c.f) })), say((c) => o.answer(c.last(o.tool) ?? {}, c))]
      }
    ],
    expect: {
      figures: o.figures,
      answerIncludes: o.includes,
      ...(o.scoreTool ? { tools: { calls: expectedCalls, allowExtra: o.scoreTool.allowExtra ?? LOOKUPS } } : {}),
      ...(o.expect ?? {})
    }
  }
}
