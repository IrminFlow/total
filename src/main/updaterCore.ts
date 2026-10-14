/**
 * The updater's consent flow, free of Electron so it is unit-tested with fakes.
 *
 *   available -> (Download now | Later | Skip this version)
 *   Download now -> downloading -> ready -> (Restart to update | Install when I quit | Later)
 *
 * Nothing is downloaded or installed without a user action: `autoDownload` and
 * `autoInstallOnAppQuit` stay false (the latter flips only on "Install when I quit").
 * With "Check for updates automatically" off, launch makes no request at all; "Check now" still works.
 */
import { bareVersion, isNewerVersion, type UpdateAction, type UpdateCheckResult, type UpdateNotice, type UpdateSettings, type UpdatesView } from '@shared/updates'

/** The slice of electron-updater's autoUpdater this flow uses. */
export interface UpdateEngine {
  autoDownload: boolean
  autoInstallOnAppQuit: boolean
  checkForUpdates(): Promise<unknown>
  downloadUpdate(): Promise<unknown>
  quitAndInstall(): void
  on(event: 'update-available' | 'update-downloaded' | 'error', listener: (arg: never) => void): unknown
}

export interface LatestInfo {
  version: string
  downloadUrl: string
}

export interface UpdaterDeps {
  engine: UpdateEngine
  currentVersion: string
  /** The release page, used when the engine can't download (unsigned builds). */
  releasesUrl: string
  readSettings(): UpdateSettings
  writeSettings(patch: Partial<UpdateSettings>): UpdateSettings
  /** Site / GitHub version lookup (the only request besides electron-updater's feed). */
  fetchLatest(): Promise<LatestInfo | null>
  openExternal(url: string): void
  publish(notice: UpdateNotice | null): void
  log(level: 'warn' | 'info', message: string, extra?: Record<string, unknown>): void
  /** Delay before the launch check (ms). */
  launchDelayMs?: number
  setTimer?(fn: () => void, ms: number): unknown
}

export function createUpdater(deps: UpdaterDeps) {
  let notice: UpdateNotice | null = null
  let siteUrl: string | null = null
  let fallbackDone = false
  const timer = deps.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms))

  const set = (next: UpdateNotice | null): void => {
    notice = next
    deps.publish(next)
  }

  const isSkipped = (version: string): boolean => deps.readSettings().skippedVersion === bareVersion(version)

  /** Show the "available" notice. `force` = the user asked (Check now), so a skipped version still shows. */
  const offer = (version: string, via: 'engine' | 'site', force: boolean): boolean => {
    if (!force && isSkipped(version)) return false
    // A download already under way / finished is not replaced by a re-check.
    if (notice && notice.phase !== 'available' && notice.version === bareVersion(version)) return false
    set({ phase: 'available', version: bareVersion(version), via })
    return true
  }

  /** Compare against the site / GitHub release info and point at a download. */
  async function siteCheck(force: boolean): Promise<UpdateCheckResult> {
    const current = deps.currentVersion
    try {
      const latest = await deps.fetchLatest()
      if (!latest) return { status: 'error', current }
      if (!isNewerVersion(latest.version, current)) return { status: 'up-to-date', current }
      siteUrl = latest.downloadUrl
      offer(latest.version, 'site', force)
      return { status: 'available', current, latest: latest.version }
    } catch (err) {
      deps.log('warn', 'updater', { error: String(err) })
      return { status: 'error', current }
    }
  }

  async function autoFallback(): Promise<void> {
    if (fallbackDone || !deps.readSettings().autoCheck) return
    fallbackDone = true
    await siteCheck(false)
  }

  return {
    /** Wire the engine and schedule the launch check (only when the setting is on). */
    init(): void {
      deps.engine.autoDownload = false
      deps.engine.autoInstallOnAppQuit = false
      deps.engine.on('update-available', ((info: { version: string }) => {
        offer(info.version, 'engine', false)
      }) as (arg: never) => void)
      deps.engine.on('update-downloaded', ((info: { version: string }) => {
        set({ phase: 'ready', version: bareVersion(info.version), via: 'engine' })
      }) as (arg: never) => void)
      deps.engine.on('error', ((err: unknown) => {
        deps.log('warn', 'updater', { error: String(err) })
        if (notice?.phase === 'downloading') {
          // The engine could not fetch it (typical for unsigned builds): hand over the release page.
          deps.openExternal(siteUrl ?? deps.releasesUrl)
          set(null)
          return
        }
        void autoFallback()
      }) as (arg: never) => void)
      if (!deps.readSettings().autoCheck) return
      timer(() => {
        // Re-read: the user may have switched it off during the delay.
        if (!deps.readSettings().autoCheck) return
        deps.engine.checkForUpdates().catch(() => void autoFallback())
      }, deps.launchDelayMs ?? 5_000)
    },

    /** "Check now": always a real check (via the site), whatever the automatic setting says. */
    async checkNow(): Promise<UpdateCheckResult> {
      fallbackDone = false
      return siteCheck(true)
    },

    view(): UpdatesView {
      return { settings: deps.readSettings(), notice, current: deps.currentVersion }
    },

    setAutoCheck(autoCheck: boolean): UpdatesView {
      deps.writeSettings({ autoCheck })
      return this.view()
    },

    act(action: UpdateAction): UpdatesView {
      const n = notice
      if (action === 'download' && n?.phase === 'available') {
        if (n.via === 'engine') {
          set({ ...n, phase: 'downloading' })
          deps.engine.downloadUpdate().catch((err: unknown) => {
            deps.log('warn', 'updater', { error: String(err) })
            deps.openExternal(siteUrl ?? deps.releasesUrl)
            set(null)
          })
        } else {
          deps.openExternal(siteUrl ?? deps.releasesUrl)
          set(null)
        }
      } else if (action === 'skip' && n && n.phase === 'available') {
        deps.writeSettings({ skippedVersion: n.version })
        set(null)
      } else if (action === 'install' && n?.phase === 'ready') {
        deps.engine.quitAndInstall()
      } else if (action === 'installOnQuit' && n?.phase === 'ready') {
        deps.engine.autoInstallOnAppQuit = true
        set(null)
      }
      return this.view()
    }
  }
}

export type Updater = ReturnType<typeof createUpdater>
