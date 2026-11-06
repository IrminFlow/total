// Zod 4's own messages, with one change: a value that is missing reads "Required", as it did in
// Zod 3 ("name: Required"), instead of "Invalid input: expected string, received undefined".
// Accountant screens show the service's wording (WP 8.5) and the AI tools quote it to the model,
// so the commonest message stays the short one. A message a schema sets itself still wins.
// Process-wide (z.config): imported once by every entry — main, the renderer, the CLI and the
// vitest setups.
import { z } from 'zod'

const REQUIRED = 'Required'

interface RawIssue {
  code?: string
  input?: unknown
  inst?: unknown
}

const isEnum = (inst: unknown): boolean => (inst as { _zod?: { def?: { type?: string } } } | undefined)?._zod?.def?.type === 'enum'

export function zodCustomError(issue: RawIssue): string | undefined {
  if (issue.input !== undefined) return undefined
  // Zod 3 reported a missing enum value as invalid_type "Required"; Zod 4 says invalid_value.
  if (issue.code === 'invalid_type' || (issue.code === 'invalid_value' && isEnum(issue.inst))) return REQUIRED
  return undefined
}

/** The issue code the WP 8.5 mapping (errors/map.ts) reads, as `zod.<code>`: Zod 4's, except a
 *  missing enum value, which stays invalid_type as in Zod 3 (→ "needed", not "invalid"). */
export function zodIssueCode(issue: { code: string; message: string }): string {
  return issue.code === 'invalid_value' && issue.message === REQUIRED ? 'invalid_type' : issue.code
}

z.config({ customError: zodCustomError })
