/**
 * Auto-update via GitHub Releases.
 *
 * Primary path: electron-updater downloads the new version and installs on restart.
 * On macOS, silent install requires a code-signed build — if the update engine
 * errors (typical for unsigned beta builds), we fall back to a manual check
 * against the GitHub API and offer the release page to download.
 *
 * Windows (WP 7.3): the NSIS build updates through electron-updater itself — it reads
 * latest.yml from the release and verifies the download's sha512; with no `publisherName`
 * configured it does not require a signature, so the unsigned installer installs in place on
 * quit. latest.yml names the installer `Total-Setup-<version>.exe` and the release asset must
 * carry exactly that name (package.json `nsis.artifactName`). The manual fallback opens
 * /api/download?platform=win.
 *
 * The app stays fully offline otherwise: this runs only in packaged builds,
 * never blocks anything, and failing silently is the correct behavior.
 */
import { app, dialog, shell } from 'electron'
import electronUpdater from 'electron-updater'
import { log } from './log'
import { GITHUB_REPO, SITE_URL } from '@shared/product'
import { downloadUrlFor, updateAvailableDetail, updateCheckDisabled, updateReadyDetail } from '@shared/updateText'

const { autoUpdater } = electronUpdater

const RELEASES_URL = `https://github.com/${GITHUB_REPO}/releases/latest`
/** The marketing site proxies release info for the private repo (see site/app/api/latest). */
const SITE_LATEST_URL = `${SITE_URL}/api/latest`

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
  } catch (err) {
    // Site unreachable — try GitHub directly.
    log('warn', 'updater', { error: String(err) })
  }
  try {
    const res = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/releases/latest`, {
      headers: { Accept: 'application/vnd.github+json' }
    })
    if (!res.ok) return null
    const release = (await res.json()) as { tag_name?: string; html_url?: string }
    if (!release.tag_name) return null
    return { version: release.tag_name, downloadUrl: release.html_url ?? RELEASES_URL }
  } catch (err) {
    log('warn', 'updater', { error: String(err) })
    return null
  }
}

export interface UpdateCheckResult {
  status: 'dev' | 'available' | 'up-to-date' | 'error'
  current: string
  latest?: string
}

/** Shared fetch+compare+offer-download logic behind both the silent startup fallback
 *  (manualCheck) and the interactive Settings → About "Check for updates" button. */
async function checkAndOffer(): Promise<UpdateCheckResult> {
  const current = app.getVersion()
  try {
    const latest = await fetchLatest()
    if (!latest) return { status: 'error', current }
    if (!isNewer(latest.version, current)) return { status: 'up-to-date', current }
    const choice = await dialog.showMessageBox({
      type: 'info',
      message: `Total ${latest.version.replace(/^v/, '')} is available`,
      // WP 7.3: the data folder as this platform writes it, plus the unsigned-build note
      // (SmartScreen on Windows, Gatekeeper on macOS).
      detail: updateAvailableDetail(process.platform, current),
      buttons: ['Download update', 'Later'],
      defaultId: 0,
      cancelId: 1
    })
    if (choice.response === 0) shell.openExternal(downloadUrlFor(latest.downloadUrl, process.platform))
    return { status: 'available', current, latest: latest.version }
  } catch (err) {
    log('warn', 'updater', { error: String(err) })
    return { status: 'error', current }
  }
}

/** Manual fallback: compare versions and point at a download the user can reach. */
async function manualCheck(): Promise<void> {
  if (fallbackDone) return
  fallbackDone = true
  await checkAndOffer()
}

/** Interactive check triggered from Settings → About. Clears the startup-fallback dedupe
 *  guard before running, so this always performs a real check regardless of whether the
 *  automatic startup check (or its fallback) already ran — and leaves the guard clear
 *  afterward too, so a later autoUpdater 'error' event can still trigger its own one-shot
 *  manual fallback rather than finding the guard already tripped. */
export async function checkForUpdatesInteractive(): Promise<UpdateCheckResult> {
  if (!app.isPackaged) return { status: 'dev', current: app.getVersion() }
  fallbackDone = false
  return checkAndOffer()
}

export function initUpdater(): void {
  if (!app.isPackaged) return
  // WP 7.3: scripted runs against a packaged build (the Windows CI smoke) never check.
  if (updateCheckDisabled(process.env)) return

  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true

  autoUpdater.on('update-downloaded', (info) => {
    void dialog
      .showMessageBox({
        type: 'info',
        message: `Total ${info.version} is ready`,
        detail: updateReadyDetail(process.platform),
        buttons: ['Restart now', 'On next quit'],
        defaultId: 0,
        cancelId: 1
      })
      .then((choice) => {
        if (choice.response === 0) autoUpdater.quitAndInstall()
      })
  })

  autoUpdater.on('error', (err) => {
    // Unsigned builds can check but not install silently — offer the release page instead.
    log('warn', 'updater', { error: String(err) })
    void manualCheck()
  })

  // Give the window a moment to appear; updates are never the first thing on screen.
  setTimeout(() => {
    autoUpdater.checkForUpdates().catch(() => void manualCheck())
  }, 5_000)
}
