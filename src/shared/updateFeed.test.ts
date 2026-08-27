import { describe, expect, it } from 'vitest'
import { isUpdateEligible, parseUpdateFeed, updateCohortBucket } from './updateFeed'

describe('update feed contract', () => {
  it('accepts the exact production response shape', () => {
    expect(parseUpdateFeed({ version: '0.5.0', downloadUrl: 'https://total.irminlabs.com/api/download' })).toEqual({
      version: '0.5.0',
      downloadUrl: 'https://total.irminlabs.com/api/download'
    })
  })

  it.each([
    { version: 'latest', downloadUrl: 'https://total.irminlabs.com/api/download' },
    { version: '0.5.0', downloadUrl: 'http://total.irminlabs.com/api/download' },
    { version: '0.5.0', downloadUrl: 'javascript:alert(1)' },
    { version: '0.5.0', downloadUrl: 'https://total.irminlabs.com/api/download', extra: true },
    { downloadUrl: 'https://total.irminlabs.com/api/download' }
  ])('rejects malformed or expanded payloads: %j', (payload) => {
    expect(parseUpdateFeed(payload)).toBeNull()
  })

  it('accepts staged release controls', () => {
    expect(parseUpdateFeed({
      version: '0.6.0-beta.2',
      downloadUrl: 'https://total.irminlabs.com/api/download?channel=beta',
      channel: 'beta',
      rollout: { percentage: 10, salt: 'v0.6-beta-2' },
      killSwitches: { updates: true, autoDownload: false, manualDownload: true }
    })).not.toBeNull()
  })

  it.each([
    { percentage: -1, salt: 'valid-salt' },
    { percentage: 101, salt: 'valid-salt' },
    { percentage: 1.5, salt: 'valid-salt' },
    { percentage: 10, salt: 'short' }
  ])('rejects unsafe rollout controls: %j', (rollout) => {
    expect(parseUpdateFeed({
      version: '0.6.0',
      downloadUrl: 'https://total.irminlabs.com/api/download',
      channel: 'stable',
      rollout,
      killSwitches: { updates: true, autoDownload: true, manualDownload: true }
    })).toBeNull()
  })
})

describe('staged update cohorts', () => {
  const feed = parseUpdateFeed({
    version: '0.6.0',
    downloadUrl: 'https://total.irminlabs.com/api/download',
    channel: 'stable',
    rollout: { percentage: 50, salt: 'release-0.6.0' },
    killSwitches: { updates: true, autoDownload: true, manualDownload: true }
  })!

  it('assigns the same installation to the same bucket', () => {
    expect(updateCohortBucket('install-abc', 'release-0.6.0')).toBe(updateCohortBucket('install-abc', 'release-0.6.0'))
    expect(updateCohortBucket('install-abc', 'release-0.6.0')).toBeGreaterThanOrEqual(0)
    expect(updateCohortBucket('install-abc', 'release-0.6.0')).toBeLessThan(100)
  })

  it('honours zero/full rollout, channel matching and the emergency stop', () => {
    expect(isUpdateEligible({ ...feed, rollout: { percentage: 0, salt: 'release-0.6.0' } }, 'install-abc', 'stable')).toBe(false)
    expect(isUpdateEligible({ ...feed, rollout: { percentage: 100, salt: 'release-0.6.0' } }, 'install-abc', 'stable')).toBe(true)
    expect(isUpdateEligible(feed, 'install-abc', 'beta')).toBe(false)
    expect(isUpdateEligible({ ...feed, killSwitches: { ...feed.killSwitches!, updates: false } }, 'install-abc', 'stable')).toBe(false)
  })
})
