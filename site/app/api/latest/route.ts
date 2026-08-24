import { NextResponse, type NextRequest } from 'next/server'
import { latestRelease } from '@/lib/release'

/**
 * Version feed for the app's update check (the repo is private, so installed
 * apps ask the site instead of GitHub). Returns 204 when nothing is released.
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  const release = await latestRelease()
  if (!release) return new NextResponse(null, { status: 204 })
  return NextResponse.json({
    version: release.version,
    downloadUrl: new URL('/api/download', request.nextUrl.origin).toString(),
    // So the app can show what changed BEFORE someone updates. An update is a decision, and this
    // is an accounting application in the middle of a filing season.
    notes: release.notes
  })
}
