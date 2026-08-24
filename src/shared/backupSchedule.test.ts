import { describe, it, expect } from 'vitest'
import {
  DEFAULT_EXTERNAL_BACKUP,
  describeExternalSchedule,
  dueForExternalBackup,
  externalBackupName,
  externalDestinationVerdict,
  isExternalBackupOf,
  parseExternalBackup
} from './backupSchedule'

const at = (iso: string): Date => new Date(iso)

describe('scheduled backup to somewhere else', () => {
  it('is off until a folder is chosen', () => {
    expect(dueForExternalBackup(DEFAULT_EXTERNAL_BACKUP, at('2026-04-01T10:00:00Z'))).toBe(false)
  })

  it('is due immediately the first time, then on the interval', () => {
    const cfg = { ...DEFAULT_EXTERNAL_BACKUP, dir: '/Volumes/Backup', everyHours: 24 }
    expect(dueForExternalBackup(cfg, at('2026-04-01T10:00:00Z'))).toBe(true)
    const ran = { ...cfg, lastRunAt: '2026-04-01T10:00:00.000Z' }
    expect(dueForExternalBackup(ran, at('2026-04-02T09:59:00Z'))).toBe(false)
    expect(dueForExternalBackup(ran, at('2026-04-02T10:00:00Z'))).toBe(true)
  })

  it('treats an unreadable last-run stamp as never run, not as just run', () => {
    const cfg = { ...DEFAULT_EXTERNAL_BACKUP, dir: '/Volumes/Backup', lastRunAt: 'sometime' }
    expect(dueForExternalBackup(cfg, at('2026-04-01T10:00:00Z'))).toBe(true)
  })

  it('refuses a destination inside the data folder, which is not a second copy', () => {
    const verdict = externalDestinationVerdict('/Users/a/Documents/total/backups2', '/Users/a/Documents/total', false)
    expect(verdict.ok).toBe(false)
  })

  it('refuses plaintext books into a synced folder, and allows an encrypted copy with a warning', () => {
    const plain = externalDestinationVerdict('/Users/a/Dropbox/books', '/Users/a/Documents/total', false)
    expect(plain.ok).toBe(false)
    expect(plain.ok === false && plain.error).toMatch(/dropbox/i)

    const sealed = externalDestinationVerdict('/Users/a/Dropbox/books', '/Users/a/Documents/total', true)
    expect(sealed.ok).toBe(true)
    expect(sealed.ok === true && sealed.warning).toMatch(/passphrase/i)
  })

  it('accepts an external drive with nothing to say about it', () => {
    expect(externalDestinationVerdict('/Volumes/Backup', '/Users/a/Documents/total', false)).toEqual({
      ok: true,
      warning: null
    })
  })

  it('only ever prunes files it wrote for this company', () => {
    expect(isExternalBackupOf(externalBackupName('acme', '2026-04-01T10-00-00', false), 'acme')).toBe(true)
    expect(isExternalBackupOf(externalBackupName('acme', '2026-04-01T10-00-00', true), 'acme')).toBe(true)
    expect(isExternalBackupOf('total-other-2026-04-01T10-00-00.db', 'acme')).toBe(false)
    expect(isExternalBackupOf('tax-return-2025.db', 'acme')).toBe(false)
    expect(isExternalBackupOf('holiday.jpg', 'acme')).toBe(false)
  })

  it('re-validates whatever the meta column holds', () => {
    expect(parseExternalBackup(null)).toEqual(DEFAULT_EXTERNAL_BACKUP)
    expect(parseExternalBackup({ dir: '  ', everyHours: 99, keep: 1 })).toEqual({
      ...DEFAULT_EXTERNAL_BACKUP,
      dir: null
    })
    expect(parseExternalBackup({ dir: '/Volumes/B', everyHours: 6, encrypt: true, keep: 10 })).toMatchObject({
      dir: '/Volumes/B',
      everyHours: 6,
      encrypt: true,
      keep: 10
    })
  })

  it('states the schedule the way it behaves', () => {
    expect(describeExternalSchedule(DEFAULT_EXTERNAL_BACKUP)).toMatch(/^Off/)
    expect(describeExternalSchedule({ ...DEFAULT_EXTERNAL_BACKUP, dir: '/Volumes/B', encrypt: true })).toBe(
      'An encrypted copy once a day, keeping the last 7.'
    )
    expect(
      describeExternalSchedule({ ...DEFAULT_EXTERNAL_BACKUP, dir: '/Volumes/B', everyHours: 168, keep: 4 })
    ).toBe('A copy once a week, keeping the last 4.')
  })
})
