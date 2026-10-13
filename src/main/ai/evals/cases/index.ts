// The evaluation catalogue. Add a case to the file it belongs to; ids are stable and unique
// (cases.test.ts). Tools added to the registry later (WP 5.4 capture, …) are offered with no change
// here; their cases go in a new file listed below (assistants.ts = WP 5.5, memory.ts = WP 5.6).
import type { EvalCase } from '../types'
import { ACCURACY_CASES } from './accuracy'
import { TOOL_CHOICE_CASES } from './toolChoice'
import { DRAFT_CASES } from './drafts'
import { INJECTION_CASES } from './injection'
import { CLARIFICATION_CASES } from './clarification'
import { NAVIGATION_CASES } from './navigation'
import { EXPLAIN_CASES } from './explain'
import { PRIVACY_CASES } from './privacy'
import { ROLE_CASES } from './roles'
import { MCP_CASES } from './mcp'
import { ASSISTANT_CASES } from './assistants'
import { MEMORY_CASES } from './memory'

export const EVAL_CASES: EvalCase[] = [
  ...ACCURACY_CASES,
  ...TOOL_CHOICE_CASES,
  ...DRAFT_CASES,
  ...INJECTION_CASES,
  ...CLARIFICATION_CASES,
  ...NAVIGATION_CASES,
  ...EXPLAIN_CASES,
  ...PRIVACY_CASES,
  ...ROLE_CASES,
  ...MCP_CASES,
  ...ASSISTANT_CASES,
  ...MEMORY_CASES
]
