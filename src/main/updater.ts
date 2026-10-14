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
import { createUpdater, makeFetchLatest, type Updater } from './updaterCore'

const { autoUpdater } = electronUpdater

const RELEASES_URL = `https://github.com/${GITHUB_REPO}/releases/latest`
/** The marketing site proxies release info for the private repo (see site/app/api/latest). */
const SITE_LATEST_URL = `${SITE_URL}/api/latest`

const fetchLatest = makeFetchLatest((url, init) => fetch(url, init), {
  siteLatestUrl: SITE_LATEST_URL,
  githubRepo: GITHUB_REPO,
  releasesUrl: RELEASES_URL,
  log: (level, message, extra) => log(level, message, extra)
})

/** A corrupt app-settings.json reads as the defaults; say so in the log once per run (it is read often). */
let corruptLogged = false
const onCorrupt = (error: string): void => {
  if (corruptLogged) return
  corruptLogged = true
  log('warn', 'app-settings-unreadable', { error })
}
const readSettings = (): ReturnType<typeof readUpdateSettings> => readUpdateSettings(dataRoot(), onCorrupt)

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
    readSettings,
    writeSettings: (patch) => writeUpdateSettings(dataRoot(), patch, actor, app.getVersion(), onCorrupt),
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
  if (!app.isPackaged) return { settings: readSettings(), notice: null, current: app.getVersion() }
  return build().view()
}

export function setAutoCheck(autoCheck: boolean, who: string | null): UpdatesView {
  actor = who
  if (!app.isPackaged) {
    writeUpdateSettings(dataRoot(), { autoCheck }, who, app.getVersion(), onCorrupt)
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
