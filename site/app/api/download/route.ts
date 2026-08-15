import { redirect } from 'next/navigation'
import { latestRelease, RELEASES_PAGE } from '@/lib/release'

/** /api/download → the latest DMG asset, or the releases page if none is published yet. */
export async function GET(): Promise<never> {
  const release = await latestRelease()
  redirect(release?.dmgUrl ?? RELEASES_PAGE)
}
