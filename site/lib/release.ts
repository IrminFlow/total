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
  id: number | null
  /** Direct asset URL — only downloadable without auth when the repo is public. */
  publicUrl: string
}

function stagingRelease(): ReleaseInfo | null {
  if (process.env.TOTAL_STAGING_MODE !== '1') return null
  const version = process.env.TOTAL_STAGING_VERSION?.trim() ?? ''
  const mac = process.env.TOTAL_STAGING_MAC_URL?.trim() ?? ''
  const win = process.env.TOTAL_STAGING_WIN_URL?.trim() ?? ''
  if (!/^\d+\.\d+\.\d+$/.test(version)) return null
  const asset = (value: string, suffix: string): AssetRef | undefined => {
    try {
      const url = new URL(value)
      return url.protocol === 'https:' && url.pathname.endsWith(suffix)
        ? { id: null, publicUrl: url.toString() }
        : undefined
    } catch {
      return undefined
    }
  }
  const macAsset = asset(mac, '.dmg')
  const winAsset = asset(win, '.exe')
  if (!macAsset || !winAsset) return null
  return {
    version,
    htmlUrl: process.env.NEXT_PUBLIC_SITE_URL ?? RELEASES_PAGE,
    assets: { mac: macAsset, win: winAsset },
  }
}

export interface ReleaseInfo {
  version: string
  htmlUrl: string
  assets: Partial<Record<Platform, AssetRef>>
}

export type ReleaseChannel = 'stable' | 'beta' | 'internal'

interface GitHubRelease {
  tag_name?: string
  html_url?: string
  draft?: boolean
  prerelease?: boolean
  assets?: { id: number; name: string; browser_download_url: string }[]
}

function mapRelease(data: GitHubRelease): ReleaseInfo | null {
  if (!data.tag_name) return null
  const find = (suffix: string): AssetRef | undefined => {
    const asset = data.assets?.find((item) => item.name.endsWith(suffix))
    return asset ? { id: asset.id, publicUrl: asset.browser_download_url } : undefined
  }
  return {
    version: data.tag_name.replace(/^v/, ''),
    htmlUrl: data.html_url ?? RELEASES_PAGE,
    assets: { mac: find('.dmg'), win: find('.exe') },
  }
}

/** Latest release, or null when the repo has no releases yet / token is missing on a private repo. */
export async function latestRelease(channel: ReleaseChannel = 'stable'): Promise<ReleaseInfo | null> {
  if (process.env.TOTAL_STAGING_MODE === '1') return stagingRelease()
  try {
    const endpoint = channel === 'stable' ? 'releases/latest' : 'releases?per_page=30'
    const res = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/${endpoint}`, {
      headers: githubHeaders(),
      next: { revalidate: 300 }
    })
    if (!res.ok) return null
    const payload = (await res.json()) as GitHubRelease | GitHubRelease[]
    if (!Array.isArray(payload)) return mapRelease(payload)
    const release = payload.find((item) => {
      if (item.draft || !item.prerelease) return false
      if (channel === 'beta') return true
      return /(?:internal|nightly|alpha)/i.test(item.tag_name ?? '')
    })
    return release ? mapRelease(release) : null
  } catch {
    return null
  }
}

export interface ReleaseNote {
  version: string
  name: string
  date: string
  body: string
}

/** Published (non-draft, non-prerelease) releases, newest first. Empty on any failure. */
export async function listReleases(): Promise<ReleaseNote[]> {
  try {
    const res = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/releases?per_page=20`, {
      headers: githubHeaders(),
      next: { revalidate: 300 }
    })
    if (!res.ok) return []
    const data = (await res.json()) as {
      tag_name?: string
      name?: string | null
      published_at?: string | null
      body?: string | null
      draft?: boolean
      prerelease?: boolean
    }[]
    return data
      .filter((r) => !r.draft && !r.prerelease && r.tag_name)
      .map((r) => ({
        version: (r.tag_name as string).replace(/^v/, ''),
        name: r.name ?? (r.tag_name as string),
        date: r.published_at ?? '',
        body: r.body ?? ''
      }))
  } catch {
    return []
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
  if (asset.id === null) return asset.publicUrl
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
