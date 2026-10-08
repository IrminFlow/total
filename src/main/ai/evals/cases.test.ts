// WP 5.8 — the case catalogue, checked without a DB: stable unique ids with their category's
// prefix, at least 80 cases, every category present, every chat turn has a mock route, and
// every mock-only (compromised-model) case is an injection / role defence.
import { describe, expect, it } from 'vitest'
import { EVAL_CATEGORIES } from '@shared/aiEvalScoring'
import { EVAL_CASES } from './cases'
import { selectCases } from './select'

const PREFIX: Record<string, string> = {
  accuracy: 'acc.', tool_choice: 'tool.', draft: 'draft.', injection: 'inj.', clarification: 'clar.', navigation: 'nav.', explain: 'exp.',
  privacy: 'priv.', roles: 'role.', mcp_parity: 'mcp.'
}

describe('the evaluation catalogue', () => {
  it('has ≥ 80 cases with unique, prefixed, stable ids', () => {
    expect(EVAL_CASES.length).toBeGreaterThanOrEqual(80)
    const ids = EVAL_CASES.map((c) => c.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const c of EVAL_CASES) {
      expect(c.id.startsWith(PREFIX[c.category]!), c.id).toBe(true)
      expect(c.id, c.id).toMatch(/^[a-z]+\.[a-z0-9-]+$/)
    }
  })

  it('covers every category', () => {
    expect([...new Set(EVAL_CASES.map((c) => c.category))].sort()).toEqual([...EVAL_CATEGORIES].sort())
  })

  it('every chat turn has a mock route; mock-only cases are defences', () => {
    for (const c of EVAL_CASES) {
      if (c.kind !== 'chat') continue
      for (const t of c.turns) expect(t.route?.length, c.id).toBeGreaterThan(0)
      if (c.mockOnly) expect(['injection', 'roles'], c.id).toContain(c.category)
    }
  })

  it('--case filters (exact or prefix*) and --sample keeps an even spread', () => {
    expect(selectCases(EVAL_CASES, ['acc.net-profit-fy']).map((c) => c.id)).toEqual(['acc.net-profit-fy'])
    expect(selectCases(EVAL_CASES, ['nav.*']).every((c) => c.id.startsWith('nav.'))).toBe(true)
    const s = selectCases(EVAL_CASES, [], 10)
    expect(s).toHaveLength(10)
    expect(new Set(s.map((c) => c.category)).size).toBeGreaterThanOrEqual(6)
  })
})
