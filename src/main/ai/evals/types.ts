// WP 5.8 — the shape of an evaluation case. Cases are data plus small functions of the seeded
// fixture (ids and expected figures are looked up at run time, never hard-coded), and they only
// import types — so a plain-Node unit test can check the catalogue (cases.test.ts).
//
// A case has a stable id ("acc.net-profit-fy"), a category, one or more turns (question + screen
// context), what is expected, and — for the mocked run — a ROUTE: the scripted behaviour of an
// ideal model for that case (which tools it calls with which arguments, and an answer that quotes
// the tool results it got). The route never states a figure: answers are built from the tool
// results the mock actually received, so the numbers check sees real quoting. A live run ignores
// routes and lets the real model choose.
import type { AiContext, AiPrivacy } from '@shared/ai'
import type { EvalCategory, ExpectedCall, ExpectedDraft, InjectionProbe } from '@shared/aiEvalScoring'
import type { Role } from '../../services/roles'
import type { EvalFixture } from './fixture'

/** A tool result as the (mock) model saw it in the request. */
export interface SeenToolResult {
  name: string
  ok: boolean
  /** `result` of a successful call (parsed JSON), else undefined. */
  result: any // eslint-disable-line @typescript-eslint/no-explicit-any
  error?: string
  text: string
}

export interface RouteCtx {
  f: EvalFixture
  question: string
  /** The question as SENT (masked / pseudonymised) — what a real model would read. */
  sentQuestion: string
  /** This turn's tool results so far, in order. */
  results: SeenToolResult[]
  /** The latest result of a tool (its `result`), or undefined. */
  last(name: string): any // eslint-disable-line @typescript-eslint/no-explicit-any
  /** The system prompt the mock received (masked / pseudonymised as sent). */
  instructions: string
}

export type RouteStep =
  | { calls: (c: RouteCtx) => { name: string; arguments: Record<string, unknown> }[] }
  | { answer: (c: RouteCtx) => string }

export type Route = RouteStep[]

export interface EvalTurn {
  question: string | ((f: EvalFixture) => string)
  context?: (f: EvalFixture) => AiContext
  /** The mocked model's behaviour for this turn. */
  route?: Route
}

export interface EvalExpect {
  /** Figures (paise) the final answer must contain, each sourced from a tool result. */
  figures?: (f: EvalFixture) => number[]
  /** No unsourced money figure in the answer (default true for chat cases). */
  allFiguresSourced?: boolean
  /** Words the final answer must contain (case-insensitive). */
  answerIncludes?: (f: EvalFixture) => string[]
  /** Tool calls expected (over all turns). */
  tools?: { calls: (f: EvalFixture) => ExpectedCall[]; ordered?: boolean; allowExtra?: string[] }
  /** Tool name globs that must never be called. */
  forbidTools?: string[]
  /** The drafts this case must create — exactly these (none = []). */
  drafts?: (f: EvalFixture) => ExpectedDraft[]
  /** A draft tool must answer needs_clarification listing these ledger / item ids. */
  clarification?: (f: EvalFixture) => { candidates: number[] }
  /** A draft tool must REFUSE (validation error matching this). */
  draftRefused?: RegExp
  /** Injection: the planted instruction this case's data carries. */
  injection?: InjectionProbe
  /** Every draft that appears must be flagged unrequested (the app's defence). */
  draftsUnrequested?: boolean
  /** Privacy: none of these may appear in anything sent; `mustSend` proves the probe can see. */
  privacy?: { mustNotSend?: (f: EvalFixture) => string[]; mustSend?: (f: EvalFixture) => string[]; aliasesConsistent?: boolean }
  /** Draft tools must (not) be offered to the model. */
  draftToolsOffered?: boolean
  /** A tool call must have been refused with an error matching this. */
  toolRefused?: RegExp
  /** WP 5.6: the memory proposals this case must create (exactly these; none = []). */
  memories?: (f: EvalFixture) => { kind?: string; status: string; unrequested: boolean }[]
  /** Text the system prompt sent must contain (e.g. the memory block). */
  promptIncludes?: (f: EvalFixture) => string[]
}

interface CaseBase {
  /** Stable, unique: "<category prefix>.<slug>". */
  id: string
  category: EvalCategory
  title: string
}

export interface ChatCase extends CaseBase {
  kind: 'chat'
  turns: EvalTurn[]
  role?: Role
  privacy?: AiPrivacy
  expect: EvalExpect
  /** Mocked run only: the route plays a COMPROMISED model (it obeys the planted text), and the
   *  case checks the app's defences. Skipped in live runs — a real model cannot be made to obey. */
  mockOnly?: boolean
}

/** Navigation ("open the ledger for X"): resolved by the app through the search service; the
 *  provider must not be called at all. */
export interface NavCase extends CaseBase {
  kind: 'nav'
  text: string | ((f: EvalFixture) => string)
  /** null = not a navigation request (the question goes to the model). */
  expect: (f: EvalFixture) => { kind: 'ledger' | 'item' | 'voucher'; id: number } | null
}

/** MCP parity: the same tool through the MCP server and through the registry gives the same result. */
export interface McpCase extends CaseBase {
  kind: 'mcp'
  tool: string
  args: (f: EvalFixture) => Record<string, unknown>
  role?: Role
  /** Compare with masking on (both sides masked by field, as MCP does). */
  masked?: boolean
  /** Expect the MCP side to refuse (e.g. a draft tool for a viewer). */
  refused?: boolean
}

export type EvalCase = ChatCase | NavCase | McpCase
