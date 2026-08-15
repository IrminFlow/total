/** GitHub repo that hosts the app's releases — override with GITHUB_REPO on Vercel. */
export const GITHUB_REPO = process.env.GITHUB_REPO ?? 'irminlabs/total'

export const RELEASES_PAGE = `https://github.com/${GITHUB_REPO}/releases/latest`

interface ReleaseInfo {
  version: string
  dmgUrl: string | null
}

/** Latest release version + DMG asset URL; null when the repo has no releases yet. */
export async function latestRelease(): Promise<ReleaseInfo | null> {
  try {
    const res = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/releases/latest`, {
      headers: { Accept: 'application/vnd.github+json' },
      next: { revalidate: 3600 }
    })
    if (!res.ok) return null
    const data = (await res.json()) as {
      tag_name?: string
      assets?: { name: string; browser_download_url: string }[]
    }
    if (!data.tag_name) return null
    const dmg = data.assets?.find((a) => a.name.endsWith('.dmg'))
    return { version: data.tag_name.replace(/^v/, ''), dmgUrl: dmg?.browser_download_url ?? null }
  } catch {
    return null
  }
}
