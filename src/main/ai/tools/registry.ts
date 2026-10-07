// Tool registry (WP 5.1). A tool is a plain function over the existing services (never IPC):
// name, description, Zod input schema, kind ('read' | 'draft'), minimum role and a handler that
// returns data plus `sources` (what the panel links to). NO tool writes to the books — read tools
// only query; draft tools write an ai_drafts row the user later opens in the voucher editor.
//
// The registry validates arguments (JSON → Zod), enforces the role, catches handler errors and
// reports them to the model as data rather than failing the conversation.
import type { z } from 'zod'
import type { DB } from '../../db/connection'
import type { CompanyInfo } from '@shared/domain'
import type { AiSource, AiToolInfo } from '@shared/ai'
import { roleAllows, type Role } from '../../services/roles'
import { zodToJsonSchema } from '../jsonSchema'
import type { ToolSpec } from '../types'

export interface ToolContext {
  db: DB
  company: CompanyInfo
  role: Role
  userName: string | null
  threadId: number | null
  /** The assistant message whose tool call this is (draft rows point back at it). */
  messageId: number | null
  today: string
  period: { from: string; to: string }
}

export interface ToolOutput<T = unknown> {
  data: T
  sources: AiSource[]
  /** Set by draft tools: the ai_drafts row created. */
  draftId?: number
}

export interface ToolDef<S extends z.ZodTypeAny = z.ZodTypeAny> {
  name: string
  description: string
  input: S
  kind: 'read' | 'draft'
  minRole: Role
  handler: (input: z.infer<S>, ctx: ToolContext) => ToolOutput | Promise<ToolOutput>
}

/** Type-checks the handler against its own schema, then erases the schema type so tools of
 *  different shapes live in one registry (the registry parses input with `input` before calling). */
export function defineTool<S extends z.ZodTypeAny>(def: ToolDef<S>): ToolDef {
  if (!/^[a-z][a-z0-9_]{1,63}$/.test(def.name)) throw new Error(`Bad tool name ${def.name}`)
  return def as unknown as ToolDef
}

export type ToolRun =
  | { ok: true; name: string; input: unknown; data: unknown; sources: AiSource[]; draftId: number | null }
  | { ok: false; name: string; input: unknown; error: string }

export class ToolRegistry {
  private readonly tools = new Map<string, ToolDef>()

  constructor(tools: readonly ToolDef[]) {
    for (const t of tools) {
      if (this.tools.has(t.name)) throw new Error(`Duplicate tool ${t.name}`)
      this.tools.set(t.name, t)
    }
  }

  get(name: string): ToolDef | undefined {
    return this.tools.get(name)
  }

  /** Tools this role may call. */
  available(role: Role): ToolDef[] {
    return [...this.tools.values()].filter((t) => roleAllows(role, t.minRole))
  }

  info(): AiToolInfo[] {
    return [...this.tools.values()].map((t) => ({ name: t.name, description: t.description, kind: t.kind, minRole: t.minRole }))
  }

  specs(role: Role): ToolSpec[] {
    return this.available(role).map((t) => ({ name: t.name, description: t.description, parameters: zodToJsonSchema(t.input) }))
  }

  /** Run one call. `args` is the model's JSON text, already mapped back from pseudonyms. */
  async run(name: string, args: string, ctx: ToolContext): Promise<ToolRun> {
    let input: unknown = null
    try {
      input = args.trim() ? JSON.parse(args) : {}
    } catch {
      return { ok: false, name, input: args, error: 'The arguments are not valid JSON.' }
    }
    const tool = this.tools.get(name)
    if (!tool) return { ok: false, name, input, error: `There is no tool called ${name}.` }
    if (!roleAllows(ctx.role, tool.minRole)) {
      return { ok: false, name, input, error: `The signed-in user (${ctx.role}) may not use ${name}; it needs ${tool.minRole}.` }
    }
    const parsed = tool.input.safeParse(input)
    if (!parsed.success) {
      return { ok: false, name, input, error: `Invalid arguments: ${parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ')}` }
    }
    try {
      const out = await tool.handler(parsed.data, ctx)
      return { ok: true, name, input: parsed.data, data: out.data, sources: out.sources, draftId: out.draftId ?? null }
    } catch (err) {
      return { ok: false, name, input: parsed.data, error: err instanceof Error ? err.message : String(err) }
    }
  }
}
