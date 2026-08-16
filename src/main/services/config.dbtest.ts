import { describe, expect, it } from 'vitest'
import { seededDb } from '../db/testdb'
import { shouldNotifyDeadlinesToday } from './config'

describe('shouldNotifyDeadlinesToday (meta.deadline_notified once-per-day guard)', () => {
  it('fires the first time it is called for a given day', () => {
    const db = seededDb()
    expect(shouldNotifyDeadlinesToday(db, '2026-01-15')).toBe(true)
  })

  it('is a no-op on subsequent calls the same day', () => {
    const db = seededDb()
    expect(shouldNotifyDeadlinesToday(db, '2026-01-15')).toBe(true)
    expect(shouldNotifyDeadlinesToday(db, '2026-01-15')).toBe(false)
    expect(shouldNotifyDeadlinesToday(db, '2026-01-15')).toBe(false)
  })

  it('fires again once the date rolls over', () => {
    const db = seededDb()
    expect(shouldNotifyDeadlinesToday(db, '2026-01-15')).toBe(true)
    expect(shouldNotifyDeadlinesToday(db, '2026-01-15')).toBe(false)
    expect(shouldNotifyDeadlinesToday(db, '2026-01-16')).toBe(true)
    expect(shouldNotifyDeadlinesToday(db, '2026-01-16')).toBe(false)
  })
})
