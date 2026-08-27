import { z } from 'zod'

export const UpdateChannelSchema = z.enum(['stable', 'beta', 'internal'])
export type UpdateChannel = z.infer<typeof UpdateChannelSchema>

const UpdateRolloutSchema = z.object({
  percentage: z.number().int().min(0).max(100),
  salt: z.string().min(8).max(128).regex(/^[0-9A-Za-z._-]+$/, 'invalid rollout salt')
}).strict()

const UpdateKillSwitchesSchema = z.object({
  updates: z.boolean(),
  autoDownload: z.boolean(),
  manualDownload: z.boolean()
}).strict()

/** Public contract shared by the site's /api/latest response and the desktop updater. */
export const UpdateFeedSchema = z.object({
  version: z.string().regex(/^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/, 'invalid release version'),
  downloadUrl: z.string().url().refine((value) => value.startsWith('https://'), 'download URL must use HTTPS'),
  channel: UpdateChannelSchema.optional(),
  rollout: UpdateRolloutSchema.optional(),
  killSwitches: UpdateKillSwitchesSchema.optional()
}).strict()

export type UpdateFeed = z.infer<typeof UpdateFeedSchema>

export function parseUpdateFeed(value: unknown): UpdateFeed | null {
  const parsed = UpdateFeedSchema.safeParse(value)
  return parsed.success ? parsed.data : null
}

/** Stable FNV-1a bucket. The installation identifier never leaves the device; only the
 * manifest salt and percentage are public. Changing the salt deliberately reshuffles a rollout. */
export function updateCohortBucket(installationId: string, salt: string): number {
  let hash = 0x811c9dc5
  const value = `${salt}:${installationId}`
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0) % 100
}

export function isUpdateEligible(
  feed: UpdateFeed,
  installationId: string,
  requestedChannel: UpdateChannel
): boolean {
  if (feed.killSwitches?.updates === false) return false
  if ((feed.channel ?? 'stable') !== requestedChannel) return false
  const rollout = feed.rollout ?? { percentage: 100, salt: 'legacy-full-rollout' }
  return updateCohortBucket(installationId, rollout.salt) < rollout.percentage
}
