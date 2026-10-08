/**
 * Agent-facing docs, bundled into the CLI at build time (esbuild `.md` text loader — see
 * scripts/total-cli.mjs). `ensureAgentDocs` drops AGENTS.md + voucher.schema.json into the data
 * root on first CLI run so any agent pointed at ~/Documents/total self-discovers the contract;
 * `init-agent-docs` rewrites them unconditionally.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { agentsMdAction } from './agentsDoc'
import agentsMd from '../../../agent-skill/AGENTS.md'
import { dataRoot } from '../paths'
import { voucherJsonSchema } from './schemaDoc'

export const AGENTS_MD: string = agentsMd

export function voucherSchemaJsonText(): string {
  return JSON.stringify(voucherJsonSchema(), null, 2) + '\n'
}

/** Write AGENTS.md + voucher.schema.json into the data root if either is missing; an AGENTS.md
 *  from an older release is updated, a user-edited one kept (see agentsMdAction). Best-effort. */
export function ensureAgentDocs(): void {
  try {
    const root = dataRoot()
    mkdirSync(root, { recursive: true })
    const agentsPath = join(root, 'AGENTS.md')
    const schemaPath = join(root, 'voucher.schema.json')
    const action = agentsMdAction(existsSync(agentsPath) ? readFileSync(agentsPath, 'utf8') : null, AGENTS_MD)
    if (action === 'write') writeFileSync(agentsPath, AGENTS_MD)
    else if (action === 'write-new') writeFileSync(`${agentsPath}.new`, AGENTS_MD)
    if (!existsSync(schemaPath)) writeFileSync(schemaPath, voucherSchemaJsonText())
  } catch {
    /* docs are a convenience — never block a command on them */
  }
}
