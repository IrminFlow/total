/**
 * Auto-update via GitHub Releases.
 *
 * Primary path: electron-updater downloads the new version and installs on restart.
 * On macOS, silent install requires a code-signed build — if the update engine
 * errors (typical for unsigned beta builds), we fall back to a manual check
 * against the GitHub API and offer the release page to download.
 *
 * The app stays fully offline otherwise: this runs only in packaged builds,
 * never blocks anything, and failing silently is the correct behavior.
 */
import { app, dialog, shell } from 'electron'
import electronUpdater from 'electron-updater'

const { autoUpdater } = electronUpdater

export const GITHUB_REPO = 'IrminFlow/total'
const RELEASES_URL = `https://github.com/${GITHUB_REPO}/releases/latest`
/** The marketing site proxies release info for the private repo (see site/app/api/latest). */
const SITE_LATEST_URL = 'https://total-site.vercel.app/api/latest'

let fallbackDone = false

function isNewer(remote: string, local: string): boolean {
  const parse = (v: string): number[] => v.replace(/^v/, '').split('.').map((n) => parseInt(n, 10) || 0)
  const [r, l] = [parse(remote), parse(local)]
  for (let i = 0; i < 3; i++) {
    if ((r[i] ?? 0) !== (l[i] ?? 0)) return (r[i] ?? 0) > (l[i] ?? 0)
  }
  return false
}

interface LatestInfo {
  version: string
  downloadUrl: string
}

/** The site's /api/latest works even while the repo is private; GitHub's API is the public-repo fallback. */
async function fetchLatest(): Promise<LatestInfo | null> {
  try {
    const res = await fetch(SITE_LATEST_URL)
    if (res.ok) {
      const data = (await res.json()) as { version?: string; downloadUrl?: string }
      if (data.version) return { version: data.version, downloadUrl: data.downloadUrl ?? SITE_LATEST_URL.replace('/api/latest', '/api/download') }
    }
  } catch {
    // Site unreachable — try GitHub directly.
  }
  try {
    const res = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/releases/latest`, {
      headers: { Accept: 'application/vnd.github+json' }
    })
    if (!res.ok) return null
    const release = (await res.json()) as { tag_name?: string; html_url?: string }
    if (!release.tag_name) return null
    return { version: release.tag_name, downloadUrl: release.html_url ?? RELEASES_URL }
  } catch {
    return null
  }
}

/** Manual fallback: compare versions and point at a download the user can reach. */
async function manualCheck(): Promise<void> {
  if (fallbackDone) return
  fallbackDone = true
  const latest = await fetchLatest()
  if (!latest || !isNewer(latest.version, app.getVersion())) return
  const choice = await dialog.showMessageBox({
    type: 'info',
    message: `Total ${latest.version.replace(/^v/, '')} is available`,
    detail: `You're on ${app.getVersion()}. Download the new version — your data in ~/Documents/total is untouched by updates.`,
    buttons: ['Download update', 'Later'],
    defaultId: 0,
    cancelId: 1
  })
  if (choice.response === 0) shell.openExternal(latest.downloadUrl)
}

export function initUpdater(): void {
  if (!app.isPackaged) return

  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true

  autoUpdater.on('update-downloaded', (info) => {
    void dialog
      .showMessageBox({
        type: 'info',
        message: `Total ${info.version} is ready`,
        detail: 'The update installs when the app restarts. Your data in ~/Documents/total is untouched.',
        buttons: ['Restart now', 'On next quit'],
        defaultId: 0,
        cancelId: 1
      })
      .then((choice) => {
        if (choice.response === 0) autoUpdater.quitAndInstall()
      })
  })

  autoUpdater.on('error', () => {
    // Unsigned builds can check but not install silently — offer the release page instead.
    void manualCheck()
  })

  // Give the window a moment to appear; updates are never the first thing on screen.
  setTimeout(() => {
    autoUpdater.checkForUpdates().catch(() => void manualCheck())
  }, 5_000)
}
