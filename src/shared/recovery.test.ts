import { describe, it, expect } from 'vitest'
import { recoveryGuidance, recoverySeverity } from './recovery'

const sound = { quickCheck: 'ok', unbalancedVoucherIds: [], backupsNewestFirst: ['2026-04-01 10:00'] }

describe('what to do when the books will not open', () => {
  it('says so plainly when nothing is wrong', () => {
    const guidance = recoveryGuidance(sound)
    expect(guidance.severity).toBe('ok')
    expect(guidance.steps[0]!.action).toBe('verify-backup')
  })

  it('ranks a damaged file above unbalanced vouchers', () => {
    expect(recoverySeverity({ ...sound, quickCheck: 'malformed', unbalancedVoucherIds: [3] })).toBe('file')
    expect(recoverySeverity({ ...sound, unbalancedVoucherIds: [3] })).toBe('books')
  })

  it('puts "copy the folder first" ahead of every other step', () => {
    // Every later step can make things worse; this one cannot, which is why it is first.
    const guidance = recoveryGuidance({ ...sound, quickCheck: 'database disk image is malformed' })
    expect(guidance.steps[0]!.action).toBe('reveal-folder')
    expect(guidance.headline).toContain('malformed')
  })

  it('offers a restore only when there is something to restore', () => {
    const withBackups = recoveryGuidance({
      ...sound,
      quickCheck: 'malformed',
      backupsNewestFirst: ['2026-04-01 10:00', '2026-03-31 10:00']
    })
    expect(withBackups.steps.some((s) => s.action === 'restore')).toBe(true)
    expect(withBackups.steps.find((s) => s.action === 'restore')!.detail).toContain('2 backups')

    const without = recoveryGuidance({ ...sound, quickCheck: 'malformed', backupsNewestFirst: [] })
    expect(without.steps.some((s) => s.action === 'restore')).toBe(false)
    expect(without.steps.some((s) => s.action === 'export')).toBe(true)
  })

  it('warns when the newest backup has already failed verification', () => {
    const guidance = recoveryGuidance({
      ...sound,
      quickCheck: 'malformed',
      newestBackupVerified: false
    })
    expect(guidance.steps.find((s) => s.action === 'restore')!.detail).toMatch(/not passed verification/)
  })

  it('names the vouchers when the file is fine and the books are not', () => {
    const guidance = recoveryGuidance({ ...sound, unbalancedVoucherIds: [12, 40] })
    expect(guidance.severity).toBe('books')
    expect(guidance.steps[0]!.detail).toContain('12, 40')
    expect(guidance.steps.some((s) => s.action === 'restore')).toBe(false)
  })
})
