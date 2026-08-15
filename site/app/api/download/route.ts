import { redirect } from 'next/navigation'
import { latestRelease, resolveDownloadUrl, RELEASES_PAGE } from '@/lib/release'

/** /api/download → the latest DMG (works for the private repo via a short-lived asset URL). */
export async function GET(): Promise<never> {
  const release = await latestRelease()
  if (!release) redirect(RELEASES_PAGE)
  redirect(await resolveDownloadUrl(release))
}
