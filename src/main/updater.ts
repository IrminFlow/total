/**
 * Auto-update via GitHub Releases — with consent.
 *
 * Nothing is downloaded or installed without the user's say-so: electron-updater only CHECKS
 * (`autoDownload` / `autoInstallOnAppQuit` are false); a found version becomes an in-app notice
 * ("Download now / Later / Skip this version"), and a finished download another ("Restart to
 * update"). The flow lives in updaterCore.ts (unit-tested); this file wires it to Electron.
 * If the update engine errors (typical for unsigned macOS builds) the site / GitHub release
 * page is offered instead. "Check for updates automatically" (default on) and the skipped
 * version live in <dataRoot>/app-settings.json; when it is off no request is made at launch.
 *
 * The app stays fully offline otherwise: this runs only in packaged builds and never blocks.
 */
import { app, BrowserWindow, shell } from 'electron'
import electronUpdater from 'electron-updater'
import { log } from './log'
import { GITHUB_REPO, SITE_URL } from '@shared/product'
import { type UpdateAction, type UpdateCheckResult, type UpdatesView } from '@shared/updates'
import { dataRoot } from './paths'
import { readUpdateSettings, writeUpdateSettings } from './services/appSettings'
import { createUpdater, type LatestInfo, type Updater } from './updaterCore'

const { autoUpdater } = electronUpdater

const RELEASES_URL = `https://github.com/${GITHUB_REPO}/releases/latest`
/** The marketing site proxies release info for the private repo (see site/app/api/latest). */
const SITE_LATEST_URL = `${SITE_URL}/api/latest`

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

let updater: Updater | null = null
let actor: string | null = null

function publish(notice: unknown): void {
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send('total:updates:event', notice)
  }
}

function build(): Updater {
  updater ??= createUpdater({
    engine: autoUpdater as never,
    currentVersion: app.getVersion(),
    releasesUrl: RELEASES_URL,
    readSettings: () => readUpdateSettings(dataRoot()),
    writeSettings: (patch) => writeUpdateSettings(dataRoot(), patch, actor, app.getVersion()),
    fetchLatest,
    openExternal: (url) => void shell.openExternal(url),
    publish,
    log: (level, message, extra) => log(level, message, extra)
  })
  return updater
}

/** Interactive check from Settings → About / the simple Updates card ("Check now"). */
export async function checkForUpdatesInteractive(): Promise<UpdateCheckResult> {
  if (!app.isPackaged) return { status: 'dev', current: app.getVersion() }
  return build().checkNow()
}

/** The settings + the notice now showing (dev runs: the stored settings, never a notice). */
export function updatesView(): UpdatesView {
  if (!app.isPackaged) return { settings: readUpdateSettings(dataRoot()), notice: null, current: app.getVersion() }
  return build().view()
}

export function setAutoCheck(autoCheck: boolean, who: string | null): UpdatesView {
  actor = who
  if (!app.isPackaged) {
    writeUpdateSettings(dataRoot(), { autoCheck }, who, app.getVersion())
    return updatesView()
  }
  return build().setAutoCheck(autoCheck)
}

export function updateAction(action: UpdateAction, who: string | null): UpdatesView {
  actor = who
  if (!app.isPackaged) return updatesView()
  return build().act(action)
}

export function initUpdater(): void {
  if (!app.isPackaged) return
  build().init()
}
