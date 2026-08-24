import { describe, it, expect } from 'vitest'
import { HEARTBEAT_MS, lockMessage, lockVerdict, parseDeviceLock, STALE_AFTER_MS, type DeviceLock } from './deviceLock'

const NOW = Date.parse('2026-04-01T10:00:00.000Z')
const self = { host: 'MINE', pid: 42 }

const lockAt = (msAgo: number, over: Partial<DeviceLock> = {}): DeviceLock => ({
  host: 'RECEPTION-PC',
  pid: 7,
  startedAt: new Date(NOW - msAgo - 60_000).toISOString(),
  heartbeatAt: new Date(NOW - msAgo).toISOString(),
  userName: 'Ravi',
  ...over
})

describe('one company, two machines', () => {
  it('is free when nobody holds it', () => {
    expect(lockVerdict(null, self, NOW)).toEqual({ kind: 'free' })
  })

  it('recognises our own lock rather than refusing ourselves', () => {
    expect(lockVerdict(lockAt(0, { host: 'MINE', pid: 42 }), self, NOW).kind).toBe('ours')
  })

  it('holds while the heartbeat is warm, including a missed beat or two', () => {
    expect(lockVerdict(lockAt(0), self, NOW).kind).toBe('held')
    expect(lockVerdict(lockAt(HEARTBEAT_MS * 2), self, NOW).kind).toBe('held')
  })

  it('goes stale once the heartbeat stops, so a crash cannot lock the owner out', () => {
    expect(lockVerdict(lockAt(STALE_AFTER_MS + 1000), self, NOW).kind).toBe('stale')
    expect(lockVerdict(lockAt(6 * 3600_000), self, NOW).kind).toBe('stale')
  })

  it('treats a heartbeat nobody can read as ancient, not as fresh', () => {
    const broken = lockVerdict(lockAt(0, { heartbeatAt: 'yesterday-ish' }), self, NOW)
    expect(broken.kind).toBe('stale')
  })

  it('names the machine, because that is what the second person acts on', () => {
    expect(lockMessage(lockVerdict(lockAt(0), self, NOW))).toContain('RECEPTION-PC')
    expect(lockMessage(lockVerdict(lockAt(0), self, NOW))).toContain('Ravi')
    expect(lockMessage(lockVerdict(null, self, NOW))).toBeNull()
    expect(lockMessage(lockVerdict(lockAt(3 * 3600_000), self, NOW))).toMatch(/crash/)
  })

  it('rejects a lock file that has been mangled', () => {
    expect(parseDeviceLock(null)).toBeNull()
    expect(parseDeviceLock({ host: 'A' })).toBeNull()
    expect(parseDeviceLock({ host: 'A', pid: 1, heartbeatAt: '2026-04-01T10:00:00.000Z' })).toMatchObject({
      host: 'A',
      userName: null
    })
  })
})
