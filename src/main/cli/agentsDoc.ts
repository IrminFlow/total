// Whether the CLI may replace the data root's AGENTS.md (WP 5.7 review). Pure; tested in agentsDoc.test.ts.
import { createHash } from 'crypto'

/** SHA-256 of every AGENTS.md Total shipped before the current one. A data-root copy that still
 *  equals one of them is Total's own and is replaced; anything else was edited by the user and is
 *  left alone (the new text goes to AGENTS.md.new). Add the outgoing hash here whenever
 *  agent-skill/AGENTS.md changes. */
export const SHIPPED_AGENTS_MD_SHA256: readonly string[] = [
  '5276c5f2f4b18ffe2bf9762cfff659fbc860321784598a9797c633acbd540b6a' // ≤ 0.8 (inbox posts vouchers)
]

const sha256 = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex')

/** Decide what to do with an existing data-root AGENTS.md. Pure; tested. */
export function agentsMdAction(existing: string | null, current: string): 'write' | 'keep' | 'write-new' {
  if (existing === null) return 'write'
  if (existing === current) return 'keep'
  return SHIPPED_AGENTS_MD_SHA256.includes(sha256(existing)) ? 'write' : 'write-new'
}
