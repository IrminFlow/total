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
import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { log } from './log'
import { SITE_URL } from '@shared/product'
import {
  isUpdateEligible,
  parseUpdateFeed,
  UpdateChannelSchema,
  type UpdateChannel,
  type UpdateFeed
} from '@shared/updateFeed'

const { autoUpdater } = electronUpdater

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
  feed: UpdateFeed
}

function updateChannel(): UpdateChannel {
  const configured = UpdateChannelSchema.safeParse(process.env.TOTAL_UPDATE_CHANNEL)
  if (configured.success) return configured.data
  return app.getVersion().includes('-') ? 'beta' : 'stable'
}

/** A device-local random identifier used only for cohort calculation. It is never sent to the
 * update service, included in logs or stored beside company data. */
function updateInstallationId(): string {
  const directory = app.getPath('userData')
  const path = join(directory, 'update-installation.json')
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as { id?: unknown }
    if (typeof parsed.id === 'string' && /^[0-9a-f-]{36}$/i.test(parsed.id)) return parsed.id
  } catch {
    // First run or a damaged optional cohort file: replace it with a fresh identifier.
  }
  const id = randomUUID()
  mkdirSync(directory, { recursive: true })
  writeFileSync(path, `${JSON.stringify({ version: 1, id })}\n`, { encoding: 'utf8', mode: 0o600 })
  return id
}

/** The site is authoritative for rollout controls. Falling back to GitHub here would bypass a
 * percentage gate or emergency stop, so feed failure safely means no update check this run. */
async function fetchLatest(channel = updateChannel()): Promise<LatestInfo | null> {
  try {
    const url = new URL(SITE_LATEST_URL)
    url.searchParams.set('channel', channel)
    const res = await fetch(url)
    if (res.ok) {
      const data = parseUpdateFeed(await res.json())
      if (data) return { version: data.version, downloadUrl: data.downloadUrl, feed: data }
    }
  } catch (err) {
    log('warn', 'updater', { error: String(err) })
  }
  return null
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
    const channel = updateChannel()
    const latest = await fetchLatest(channel)
    if (!latest) return { status: 'error', current }
    if (!isNewer(latest.version, current)) return { status: 'up-to-date', current }
    if (!isUpdateEligible(latest.feed, updateInstallationId(), channel)) {
      return { status: 'up-to-date', current }
    }
    if (latest.feed.killSwitches?.manualDownload === false) {
      return { status: 'up-to-date', current }
    }
    const choice = await dialog.showMessageBox({
      type: 'info',
      message: `Total ${latest.version.replace(/^v/, '')} is available`,
      detail: `You're on ${current}. Download the new version — your data in ~/Documents/total is untouched by updates.`,
      buttons: ['Download update', 'Later'],
      defaultId: 0,
      cancelId: 1
    })
    if (choice.response === 0) shell.openExternal(latest.downloadUrl)
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

  autoUpdater.on('error', (err) => {
    // Unsigned builds can check but not install silently — offer the release page instead.
    log('warn', 'updater', { error: String(err) })
    void manualCheck()
  })

  // Give the window a moment to appear; updates are never the first thing on screen.
  setTimeout(() => {
    void (async () => {
      const channel = updateChannel()
      const latest = await fetchLatest(channel)
      if (!latest || !isNewer(latest.version, app.getVersion())) return
      if (!isUpdateEligible(latest.feed, updateInstallationId(), channel)) return

      autoUpdater.allowPrerelease = channel !== 'stable'
      autoUpdater.autoDownload = latest.feed.killSwitches?.autoDownload !== false
      if (!autoUpdater.autoDownload) {
        if (latest.feed.killSwitches?.manualDownload !== false) await manualCheck()
        return
      }
      await autoUpdater.checkForUpdates().catch(() => void manualCheck())
    })()
  }, 5_000)
}
