import { describe, it, expect } from 'vitest'
import { formatLine, isExpiredLogName } from './logformat'

describe('formatLine', () => {
  it('emits a JSONL line with ts/level/event/v and spread data fields', () => {
    const now = new Date('2026-08-15T10:30:00.000Z')
    const line = formatLine(now, 'info', 'app-start', '0.1.1', { platform: 'darwin' })
    expect(line.endsWith('\n')).toBe(true)
    const parsed = JSON.parse(line)
    expect(parsed).toEqual({
      ts: '2026-08-15T10:30:00.000Z',
      level: 'info',
      event: 'app-start',
      v: '0.1.1',
      platform: 'darwin'
    })
  })

  it('omits extra fields when data is not passed', () => {
    const now = new Date('2026-08-15T10:30:00.000Z')
    const line = formatLine(now, 'warn', 'updater', '0.1.1')
    const parsed = JSON.parse(line)
    expect(parsed).toEqual({ ts: '2026-08-15T10:30:00.000Z', level: 'warn', event: 'updater', v: '0.1.1' })
  })

  it('serializes Error instances as {message, stack}', () => {
    const now = new Date('2026-08-15T10:30:00.000Z')
    const err = new Error('boom')
    const line = formatLine(now, 'error', 'ipc-handler', '0.1.1', { error: err })
    const parsed = JSON.parse(line)
    expect(parsed.error.message).toBe('boom')
    expect(typeof parsed.error.stack).toBe('string')
  })

  it('never throws on circular data structures', () => {
    const now = new Date('2026-08-15T10:30:00.000Z')
    const circular: Record<string, unknown> = { name: 'x' }
    circular.self = circular
    expect(() => formatLine(now, 'error', 'crash', '0.1.1', { payload: circular })).not.toThrow()
    const line = formatLine(now, 'error', 'crash', '0.1.1', { payload: circular })
    expect(() => JSON.parse(line)).not.toThrow()
  })
})

describe('isExpiredLogName', () => {
  it('matches total-YYYY-MM-DD.log names and flags files strictly older than keepDays', () => {
    // today - 15 days is strictly older than the 14-day retention window
    expect(isExpiredLogName('total-2026-07-31.log', '2026-08-15', 14)).toBe(true)
  })

  it('does not flag the boundary day (exactly keepDays old)', () => {
    // today - 14 days is the boundary — not expired
    expect(isExpiredLogName('total-2026-08-01.log', '2026-08-15', 14)).toBe(false)
  })

  it('does not flag recent files', () => {
    expect(isExpiredLogName('total-2026-08-14.log', '2026-08-15', 14)).toBe(false)
  })

  it('returns false for non-matching names', () => {
    expect(isExpiredLogName('total.json', '2026-08-15', 14)).toBe(false)
    expect(isExpiredLogName('total-2026-08-01.txt', '2026-08-15', 14)).toBe(false)
    expect(isExpiredLogName('other-2026-08-01.log', '2026-08-15', 14)).toBe(false)
  })
})
