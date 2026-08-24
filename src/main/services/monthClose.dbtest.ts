import { describe, expect, it } from 'vitest'
import { seededDb, TEST_INFO } from '../db/testdb'
import { createLedger } from './masters'
import { monthCloseStatus } from './monthClose'
import { setLockDate } from './vouchers'

function groupId(db: ReturnType<typeof seededDb>, name: string): number {
  return (db.prepare('SELECT id FROM groups WHERE name = ?').get(name) as { id: number }).id
}

const backup = { file: '2026-08-31T18-00-00-manual.db', mtime: 1, tag: 'manual', valid: true }

describe('monthCloseStatus', () => {
  it('makes a clean seeded month lockable and records a completed lock', () => {
    const db = seededDb()
    const before = monthCloseStatus(db, TEST_INFO, '2026-08-01', '2026-08-31', backup)
    expect(before.canLock).toBe(true)
    expect(before.readyCount).toBe(4)
    expect(before.gates.map((gate) => [gate.id, gate.status])).toEqual([
      ['bank', 'ready'], ['gst', 'ready'], ['books', 'ready'], ['backup', 'ready'], ['lock', 'attention']
    ])

    setLockDate(db, '2026-08-31')
    const after = monthCloseStatus(db, TEST_INFO, '2026-08-01', '2026-08-31', backup)
    expect(after.canLock).toBe(false)
    expect(after.readyCount).toBe(5)
    expect(after.gates.at(-1)?.status).toBe('complete')
  })

  it('blocks close for suspense and missing backup without counting other months as exceptions', () => {
    const db = seededDb()
    createLedger(db, {
      name: 'Unallocated receipt', groupId: groupId(db, 'Suspense A/c'), openingBalance: 12_345,
      gstin: null, stateCode: null, address: null, taxType: null, gstRate: null, hsn: null,
      tdsSectionId: null, pan: null, creditDays: null, exportType: null
    })
    const status = monthCloseStatus(db, TEST_INFO, '2026-08-01', '2026-08-31', null)
    expect(status.canLock).toBe(false)
    expect(status.metrics.suspenseBalance).toBe(12_345)
    expect(status.gates.find((gate) => gate.id === 'books')?.status).toBe('attention')
    expect(status.gates.find((gate) => gate.id === 'backup')?.status).toBe('attention')
  })
})
