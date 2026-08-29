export type UpdateChannel = 'stable' | 'beta' | 'internal'

export interface UpdateRolloutControls {
  channel: UpdateChannel
  rollout: { percentage: number; salt: string }
  killSwitches: { updates: boolean; autoDownload: boolean; manualDownload: boolean }
}

export function parseUpdateChannel(value: string | null | undefined): UpdateChannel {
  return value === 'beta' || value === 'internal' ? value : 'stable'
}

function envBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback
  return value.trim().toLowerCase() === 'true'
}

function rolloutPercentage(channel: UpdateChannel): number {
  const channelValue = process.env[`UPDATE_ROLLOUT_PERCENTAGE_${channel.toUpperCase()}`]
  const parsed = Number(channelValue ?? process.env.UPDATE_ROLLOUT_PERCENTAGE ?? '100')
  return Number.isInteger(parsed) && parsed >= 0 && parsed <= 100 ? parsed : 0
}

export function updateRolloutControls(channel: UpdateChannel, version: string): UpdateRolloutControls {
  const configuredSalt = process.env[`UPDATE_ROLLOUT_SALT_${channel.toUpperCase()}`] ?? process.env.UPDATE_ROLLOUT_SALT
  const fallbackSalt = `${channel}-${version.replace(/[^0-9A-Za-z._-]/g, '-')}`
  const salt = configuredSalt && /^[0-9A-Za-z._-]{8,128}$/.test(configuredSalt) ? configuredSalt : fallbackSalt
  return {
    channel,
    rollout: { percentage: rolloutPercentage(channel), salt },
    killSwitches: {
      updates: !envBoolean(process.env.UPDATE_KILL_SWITCH, false),
      autoDownload: envBoolean(process.env.UPDATE_AUTO_DOWNLOAD, true),
      manualDownload: envBoolean(process.env.UPDATE_MANUAL_DOWNLOAD, true),
    },
  }
}
