/**
 * Agent-facing docs, bundled into the CLI at build time (esbuild `.md` text loader — see
 * scripts/total-cli.mjs). `ensureAgentDocs` drops AGENTS.md + voucher.schema.json into the data
 * root on first CLI run so any agent pointed at ~/Documents/total self-discovers the contract;
 * `init-agent-docs` rewrites them unconditionally.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import agentsMd from '../../../agent-skill/AGENTS.md'
import { dataRoot } from '../paths'
import { voucherJsonSchema } from './schemaDoc'

export const AGENTS_MD: string = agentsMd

export function voucherSchemaJsonText(): string {
  return JSON.stringify(voucherJsonSchema(), null, 2) + '\n'
}

/** Write AGENTS.md + voucher.schema.json into the data root if either is missing (AGENTS.md also when it predates the MCP server). Best-effort. */
export function ensureAgentDocs(): void {
  try {
    const root = dataRoot()
    mkdirSync(root, { recursive: true })
    const agentsPath = join(root, 'AGENTS.md')
    const schemaPath = join(root, 'voucher.schema.json')
    // A pre-0.9 AGENTS.md still says inbox drops are posted — replace it (WP 5.7: they are drafts).
    if (!existsSync(agentsPath) || !readFileSync(agentsPath, 'utf8').includes('total-cli mcp')) writeFileSync(agentsPath, AGENTS_MD)
    if (!existsSync(schemaPath)) writeFileSync(schemaPath, voucherSchemaJsonText())
  } catch {
    /* docs are a convenience — never block a command on them */
  }
}
