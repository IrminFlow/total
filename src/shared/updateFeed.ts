import { z } from 'zod'

/** Public contract shared by the site's /api/latest response and the desktop updater. */
export const UpdateFeedSchema = z.object({
  version: z.string().regex(/^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/, 'invalid release version'),
  downloadUrl: z.string().url().refine((value) => value.startsWith('https://'), 'download URL must use HTTPS')
}).strict()

export type UpdateFeed = z.infer<typeof UpdateFeedSchema>

export function parseUpdateFeed(value: unknown): UpdateFeed | null {
  const parsed = UpdateFeedSchema.safeParse(value)
  return parsed.success ? parsed.data : null
}
