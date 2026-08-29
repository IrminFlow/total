import { afterEach, describe, expect, it } from 'vitest'
import { parseUpdateChannel, updateRolloutControls } from './updateRollout'

const original = { ...process.env }
afterEach(() => { process.env = { ...original } })

describe('update rollout configuration', () => {
  it('defaults to a full stable rollout with deterministic release salt', () => {
    delete process.env.UPDATE_ROLLOUT_PERCENTAGE
    delete process.env.UPDATE_ROLLOUT_SALT
    expect(updateRolloutControls('stable', '0.6.0')).toEqual({
      channel: 'stable',
      rollout: { percentage: 100, salt: 'stable-0.6.0' },
      killSwitches: { updates: true, autoDownload: true, manualDownload: true },
    })
  })

  it('supports per-channel percentages and emergency stops', () => {
    process.env.UPDATE_ROLLOUT_PERCENTAGE_BETA = '10'
    process.env.UPDATE_ROLLOUT_SALT_BETA = 'beta-wave-02'
    process.env.UPDATE_KILL_SWITCH = 'true'
    process.env.UPDATE_AUTO_DOWNLOAD = 'false'
    expect(updateRolloutControls('beta', '0.6.0-beta.2')).toEqual({
      channel: 'beta',
      rollout: { percentage: 10, salt: 'beta-wave-02' },
      killSwitches: { updates: false, autoDownload: false, manualDownload: true },
    })
  })

  it('fails a malformed percentage closed and rejects unknown channels', () => {
    process.env.UPDATE_ROLLOUT_PERCENTAGE_INTERNAL = 'lots'
    expect(updateRolloutControls('internal', '0.6.0').rollout.percentage).toBe(0)
    expect(parseUpdateChannel('nightly')).toBe('stable')
  })
})
