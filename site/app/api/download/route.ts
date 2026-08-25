import { redirect } from 'next/navigation'
import type { NextRequest } from 'next/server'
import { latestRelease, resolveDownloadUrl, RELEASES_PAGE, type Platform } from '@/lib/release'
import { parseAttribution, recordAttribution } from '@/lib/attribution'

/**
 * /api/download → the latest installer (private-repo assets served via short-lived URLs).
 * Platform comes from ?platform=mac|win, else from the browser's User-Agent (default mac).
 */
export async function GET(request: NextRequest): Promise<never> {
  const release = await latestRelease()
  if (!release) redirect(RELEASES_PAGE)
  const param = request.nextUrl.searchParams.get('platform')
  const platform: Platform =
    param === 'win' || param === 'mac'
      ? param
      : (request.headers.get('user-agent') ?? '').includes('Windows')
        ? 'win'
        : 'mac'
  const attribution = parseAttribution({
    event: 'download',
    platform,
    source: request.nextUrl.searchParams.get('source') ?? undefined,
    medium: request.nextUrl.searchParams.get('medium') ?? undefined,
    campaign: request.nextUrl.searchParams.get('campaign') ?? undefined,
  })
  if (attribution) await recordAttribution(attribution)
  redirect(await resolveDownloadUrl(release, platform))
}
