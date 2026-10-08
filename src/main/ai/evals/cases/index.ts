// The evaluation catalogue. Add a case to the category file it belongs to; ids are stable and
// unique (cases.test.ts). Tools added to the registry later (WP 5.4 capture, 5.5 assistants, 5.6
// memory) need no change here to be offered — new cases for them go in a new file listed below.
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
  ...MCP_CASES
]
