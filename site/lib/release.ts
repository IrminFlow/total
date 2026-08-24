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
  /** The release body, so the app can show what changed before someone updates. */
  notes: string
}

/** Latest release, or null when the repo has no releases yet / token is missing on a private repo. */
export async function latestRelease(): Promise<ReleaseInfo | null> {
  try {
    const res = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/releases/latest`, {
      headers: githubHeaders(),
      next: { revalidate: 300 }
    })
    if (!res.ok) return null
    const data = (await res.json()) as {
      tag_name?: string
      html_url?: string
      body?: string | null
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
      assets: { mac: find('.dmg'), win: find('.exe') },
      notes: data.body ?? ''
    }
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

export interface Checksum {
  /** Installer file name, exactly as it downloads. */
  name: string
  /** Base64 SHA-512, which is the form electron-builder publishes and the updater checks. */
  sha512: string
  bytes: number
}

/**
 * Checksums for the current release.
 *
 * These are not typed out by hand. electron-builder publishes latest-mac.yml and latest.yml
 * beside the installers, carrying the SHA-512 of each file, and the auto-updater already
 * verifies against them. Reading the same files means the download page cannot quote a hash that
 * the updater disagrees with, which would be worse than quoting none.
 */
export async function releaseChecksums(): Promise<Checksum[]> {
  const release = await latestRelease()
  if (!release) return []
  const manifests = ['latest-mac.yml', 'latest.yml']
  const out: Checksum[] = []
  for (const manifest of manifests) {
    const text = await fetchAssetText(manifest)
    if (!text) continue
    out.push(...parseUpdateManifest(text))
  }
  // One entry per file. Both manifests can name the same blockmap, and a page listing a file
  // twice looks like a mistake even when it is not.
  const seen = new Set<string>()
  return out.filter((c) => (seen.has(c.name) ? false : (seen.add(c.name), true)))
}

async function fetchAssetText(name: string): Promise<string | null> {
  try {
    const list = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/releases/latest`, {
      headers: githubHeaders(),
      next: { revalidate: 300 }
    })
    if (!list.ok) return null
    const data = (await list.json()) as { assets?: { id: number; name: string }[] }
    const asset = data.assets?.find((a) => a.name === name)
    if (!asset) return null
    const res = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/releases/assets/${asset.id}`, {
      headers: githubHeaders('application/octet-stream'),
      next: { revalidate: 300 }
    })
    if (!res.ok) return null
    return await res.text()
  } catch {
    return null
  }
}

/**
 * The three fields we need out of an electron-builder update manifest. Deliberately not a YAML
 * parser: the file shape is fixed, and a dependency to read four lines is a poor trade.
 */
export function parseUpdateManifest(text: string): Checksum[] {
  const out: Checksum[] = []
  let current: Partial<Checksum> = {}
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    const url = /^-?\s*url:\s*(.+)$/.exec(line)
    if (url) {
      if (current.name && current.sha512) out.push(current as Checksum)
      current = { name: url[1].trim() }
      continue
    }
    const sha = /^sha512:\s*(.+)$/.exec(line)
    if (sha && current.name) current.sha512 = sha[1].trim()
    const size = /^size:\s*(\d+)$/.exec(line)
    if (size && current.name) current.bytes = Number(size[1])
  }
  if (current.name && current.sha512) out.push(current as Checksum)
  return out.filter((c) => !c.name.endsWith('.blockmap'))
}
