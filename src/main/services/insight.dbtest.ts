import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { seededDb, TEST_INFO, postSimpleVoucher } from '../db/testdb'
import { monthEndChecklist } from './closeCheck'
import { anomalyWatch } from './anomalies'
import { dispatch, TOOLS_BY_NAME, type AiToolCtx } from './ai/tools'
import type { DB } from '../db/connection'

/**
 * The read-only assistant services that compute rather than converse: the month-end checklist
 * (#210) and anomaly watch (#211).
 *
 * Both are tested through the SERVICE and again through the tool that exposes them, because the
 * tool layer is where an AI answer is grounded — a tool that silently returns a different shape
 * from the screen is how a model comes to quote a figure nobody can find.
 */

// The checklist reads the company's backup directory, so the data root has to be a real one.
// TOTAL_DATA_DIR is read verbatim by dataRoot(), which is how every driver and CI script keeps
// out of ~/Documents/total.
let scratch: string

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'total-insight-'))
  process.env.TOTAL_DATA_DIR = scratch
})

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true })
  delete process.env.TOTAL_DATA_DIR
})

function ctxFor(db: DB): AiToolCtx {
  return { db, slug: 'test-co', info: TEST_INFO, today: '2025-06-15', fyFrom: '2025-04-01', fyTo: '2026-03-31' }
}

describe('month-end close checklist', () => {
  it('computes every item from the service that owns the figure', () => {
    const db = seededDb()
    postSimpleVoucher(db, { date: '2025-05-10', amount: 50_000, kind: 'receipt' })
    const list = monthEndChecklist(db, 'test-co', TEST_INFO, '2025-05-01', '2025-05-31', '2025-06-15')

    expect(list.items.map((i) => i.id)).toEqual([
      'unbalanced',
      'suspense',
      'bank',
      'gst',
      'stock',
      'approvals',
      'recurring',
      'payroll',
      'overdue',
      'backup',
      'lock'
    ])
    // A company that has never been backed up cannot be closed — that is the point of the item.
    expect(list.items.find((i) => i.id === 'backup')).toMatchObject({ status: 'blocked' })
    expect(list.readyToLock).toBe(false)
    db.close()
  })

  it('reports the lock item against the month being closed, not against today', () => {
    const db = seededDb()
    db.prepare("INSERT INTO meta (key, value) VALUES ('lock_before', '2025-05-31')").run()
    const may = monthEndChecklist(db, 'test-co', TEST_INFO, '2025-05-01', '2025-05-31', '2025-06-15')
    const june = monthEndChecklist(db, 'test-co', TEST_INFO, '2025-06-01', '2025-06-30', '2025-07-15')
    expect(may.items.find((i) => i.id === 'lock')?.status).toBe('ok')
    expect(june.items.find((i) => i.id === 'lock')?.status).toBe('attention')
    db.close()
  })

  it('is reachable as a tool, with its totals computed rather than narrated', () => {
    const db = seededDb()
    const result = dispatch(ctxFor(db), 'close_checklist', { from: '2025-05-01', to: '2025-05-31' }) as {
      rows: { check: string; status: string }[]
      totals: Record<string, unknown>
    }
    expect(result.rows.length).toBeGreaterThan(5)
    expect(result.totals).toHaveProperty('blocked')
    expect(result.totals).toHaveProperty('readyToLock')
    db.close()
  })
})

describe('anomaly watch', () => {
  /** Six ordinary receipts, then one that is nothing like them. */
  function withHistory(db: DB): void {
    for (let i = 0; i < 8; i++) {
      postSimpleVoucher(db, { date: `2025-04-0${(i % 8) + 1}`, amount: 2_000_000 + i * 10_000, kind: 'receipt' })
    }
  }

  it('flags an amount unlike anything before it, and leaves the ordinary ones alone', () => {
    const db = seededDb()
    withHistory(db)
    postSimpleVoucher(db, { date: '2025-05-10', amount: 2_010_000, kind: 'receipt' })
    const outlier = postSimpleVoucher(db, { date: '2025-05-11', amount: 90_000_000, kind: 'receipt' })

    const found = anomalyWatch(db, '2025-05-01', '2025-05-31')
    expect(found.map((f) => f.voucherId)).toEqual([outlier.id])
    expect(found[0]!.reasons).toContain('amount-outlier')
    // The comparison is stated, so the person who posted it can disagree with it.
    expect(found[0]!.explanation).toMatch(/typical/)
    db.close()
  })

  it('compares against history BEFORE the window, so a run of identical entries cannot normalise itself', () => {
    const db = seededDb()
    withHistory(db)
    // Six identical large entries inside the window. If the window were part of its own history
    // they would become the distribution and none would be flagged.
    for (let i = 1; i <= 6; i++) {
      postSimpleVoucher(db, { date: `2025-05-0${i}`, amount: 90_000_000, kind: 'receipt' })
    }
    const found = anomalyWatch(db, '2025-05-01', '2025-05-31')
    expect(found.length).toBe(6)
    db.close()
  })

  it('says nothing about a period with nothing unusual in it', () => {
    const db = seededDb()
    withHistory(db)
    postSimpleVoucher(db, { date: '2025-05-10', amount: 2_030_000, kind: 'receipt' })
    expect(anomalyWatch(db, '2025-05-01', '2025-05-31')).toEqual([])
    db.close()
  })

  it('is reachable as a tool, carrying the voucher ref the answer cites', () => {
    const db = seededDb()
    withHistory(db)
    const outlier = postSimpleVoucher(db, { date: '2025-05-11', amount: 90_000_000, kind: 'receipt' })
    const result = dispatch(ctxFor(db), 'anomaly_watch', { from: '2025-05-01', to: '2025-05-31' }) as {
      rows: { ref: string; amount: { text: string; paise: number } }[]
    }
    expect(result.rows[0]!.ref).toBe(`v:${outlier.id}`)
    // Money reaches the model twice: a string to quote and an exact integer to pass back.
    expect(result.rows[0]!.amount).toEqual({ text: '9,00,000.00', paise: 90_000_000 })
    db.close()
  })
})

describe('GST explanation as a tool (roadmap #209)', () => {
  it('carries a written explanation for every issue it reports', () => {
    const db = seededDb()
    const result = dispatch(ctxFor(db), 'gst_explain', { from: '2025-04-01', to: '2025-06-30' }) as {
      rows: { code: string; what: string; why: string; fix: string }[]
      totals: { summary: string }
    }
    for (const row of result.rows) {
      expect(row.what.length, row.code).toBeGreaterThan(20)
      expect(row.fix.length, row.code).toBeGreaterThan(10)
    }
    expect(result.totals.summary.length).toBeGreaterThan(20)
    db.close()
  })
})

describe('the tool surface as a whole', () => {
  it('has no tool that writes', () => {
    // Restated here as well as in ai-boundaries.test.ts: that test greps the source, this one
    // reads the list the model is actually offered.
    for (const name of TOOLS_BY_NAME.keys()) {
      expect(name, name).not.toMatch(/^(post|save|create|update|delete|write)_/)
    }
    expect(TOOLS_BY_NAME.has('post_voucher')).toBe(false)
    expect(TOOLS_BY_NAME.get('propose_voucher')?.description).toMatch(/does NOT post/)
  })
})
