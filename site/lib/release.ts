/**
 * Release lookup for the download button, version badge and the app's update check.
 * The repo is private, so requests authenticate with GITHUB_TOKEN (a fine-grained PAT
 * with read access to releases, set in Vercel env). Works unauthenticated too once
 * the repo is public.
 */
export const GITHUB_REPO = process.env.GITHUB_REPO ?? 'IrminFlow/total'

export const RELEASES_PAGE = `https://github.com/${GITHUB_REPO}/releases/latest`

const TOKEN = process.env.GITHUB_TOKEN

export function githubHeaders(accept = 'application/vnd.github+json'): HeadersInit {
  const headers: Record<string, string> = { Accept: accept, 'X-GitHub-Api-Version': '2022-11-28' }
  if (TOKEN) headers.Authorization = `Bearer ${TOKEN}`
  return headers
}

export type Platform = 'mac' | 'win'

interface AssetRef {
  id: number
  /** Direct asset URL — only downloadable without auth when the repo is public. */
  publicUrl: string
}

export interface ReleaseInfo {
  version: string
  htmlUrl: string
  assets: Partial<Record<Platform, AssetRef>>
}

/** Latest release, or null when the repo has no releases yet / token is missing on a private repo. */
export async function latestRelease(): Promise<ReleaseInfo | null> {
  try {
    const res = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/releases/latest`, {
      headers: githubHeaders(),
      next: { revalidate: 3600 }
    })
    if (!res.ok) return null
    const data = (await res.json()) as {
      tag_name?: string
      html_url?: string
      assets?: { id: number; name: string; browser_download_url: string }[]
    }
    if (!data.tag_name) return null
    const find = (suffix: string): AssetRef | undefined => {
      const asset = data.assets?.find((a) => a.name.endsWith(suffix))
      return asset ? { id: asset.id, publicUrl: asset.browser_download_url } : undefined
    }
    return {
      version: data.tag_name.replace(/^v/, ''),
      htmlUrl: data.html_url ?? RELEASES_PAGE,
      assets: { mac: find('.dmg'), win: find('.exe') }
    }
  } catch {
    return null
  }
}

/**
 * A URL the browser can actually download from. For a private repo, asking the API
 * for the asset as octet-stream returns a redirect to a short-lived unauthenticated
 * URL — we hand that to the visitor.
 */
export async function resolveDownloadUrl(release: ReleaseInfo, platform: Platform): Promise<string> {
  const asset = release.assets[platform]
  if (!asset) return release.htmlUrl
  if (!TOKEN) return asset.publicUrl
  try {
    const res = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/releases/assets/${asset.id}`, {
      headers: githubHeaders('application/octet-stream'),
      redirect: 'manual',
      cache: 'no-store'
    })
    const location = res.headers.get('location')
    if (location) return location
  } catch {
    // fall through
  }
  return asset.publicUrl
}
