import { NextResponse, type NextRequest } from 'next/server'
import { latestRelease } from '@/lib/release'
import { parseUpdateChannel, updateRolloutControls } from '@/lib/updateRollout'

/**
 * Version feed for the app's update check (the repo is private, so installed
 * apps ask the site instead of GitHub). Returns 204 when nothing is released.
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  const channel = parseUpdateChannel(request.nextUrl.searchParams.get('channel'))
  const release = await latestRelease(channel)
  if (!release) return new NextResponse(null, { status: 204 })
  return NextResponse.json({
    version: release.version,
    downloadUrl: new URL(`/api/download?channel=${channel}`, request.nextUrl.origin).toString(),
    ...updateRolloutControls(channel, release.version),
  })
}
