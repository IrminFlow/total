import { describe, expect, it } from 'vitest'
import { seededDb, TEST_INFO } from '../db/testdb'
import { contextPreview, selectedContext } from './ai'

describe('AI context inspector', () => {
  it('shows every shareable field as exact JSON and recalculates bytes after removal', () => {
    const db = seededDb()
    const all = contextPreview(db, TEST_INFO, '2025-04-01', '2026-03-31')
    expect(all.fields.map((field) => field.id)).toEqual([
      'company', 'period', 'dashboard', 'trial_balance', 'receivables', 'payables', 'units'
    ])
    expect(all.selected).toHaveLength(7)
    expect(all.fields.every((field) => JSON.parse(field.json) !== undefined)).toBe(true)

    const minimal = contextPreview(db, TEST_INFO, '2025-04-01', '2026-03-31', ['period', 'units'])
    expect(minimal.selected).toEqual(['period', 'units'])
    expect(minimal.bytes).toBeLessThan(all.bytes)
    expect(minimal.fields).toHaveLength(7) // removed fields remain visible for opt-in inspection
  })

  it('sends only selected fields and exposes only deterministic local citation URIs', () => {
    const db = seededDb()
    const context = selectedContext(db, TEST_INFO, '2025-04-01', '2026-03-31', ['dashboard'])
    expect(Object.keys(JSON.parse(context.summary))).toEqual(['dashboard'])
    expect(context.citations).toHaveLength(1)
    expect(context.citations[0]!.uri).toMatch(/^total:\/\/gateway\?/)
    expect(context.summary).not.toContain(TEST_INFO.gstin ?? 'never-present-gstin')
  })
})
