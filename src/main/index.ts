import { e2eToday } from './e2eClock'
import { app, BrowserWindow, dialog, shell } from 'electron'
import { join } from 'path'
import { existsSync } from 'fs'
import { homedir } from 'os'
import { electronApp, is, optimizer } from '@electron-toolkit/utils'
import { registerIpc, closeCurrentCompany, getCurrentCompany, getUnlockedCompany, canSeeProfitNow } from './ipc'
import { ensureDataTree, dataRoot, dataRootChoice } from './paths'
import { initUpdater } from './updater'
import { initLogging, log } from './log'
import { startBackupScheduler, backupOnQuit } from './backup-scheduler'
import { startPackScheduler } from './packScheduler'
import { cleanupOpenedCopies, sweepStaleOpenCopies } from './services/attachments'
import { syncFolderWarning } from '@shared/syncpath'
import { configureI18n } from '@shared/i18n'
import { allowedExternalUrl } from '@shared/externalLinks'
import { dataFolderLabel } from '@shared/updateText'

// Hermetic scripted runs (smoke/e2e/CI, TOTAL_DATA_DIR set): keep Electron's userData —
// localStorage (theme, sidebar sections, report columns), caches, the single-instance lock —
// inside the scratch dir too, so a run never writes to the user's real app profile. Relaunches
// against the same scratch dir (e2e 01/12) still see what the previous launch persisted. Must
// run before requestSingleInstanceLock(), which places its lock under userData: each scratch dir
// then gets its own lock, so a scripted run doesn't collide with the user's open app either.
if (process.env.TOTAL_DATA_DIR) {
  app.setPath('userData', join(process.env.TOTAL_DATA_DIR, '.electron-userdata'))
}

const gotSingleInstanceLock = app.requestSingleInstanceLock()

if (!gotSingleInstanceLock) {
  app.quit()
}

let syncWarningShown = false
let iCloudDesktopWarningShown = false

const appIconPath = app.isPackaged
  ? join(process.resourcesPath, 'total.png')
  : join(app.getAppPath(), 'resources/total.png')

// Automated drivers (CI smoke test, Playwright scripts) set this to skip the native
// dialog.showMessageBox() calls below — on macOS an unattended modal alert can wedge the
// main-thread run loop that also pumps CDP messages, hanging Playwright's electron.launch().
const SUPPRESS_SYNC_WARNINGS = process.env.TOTAL_SUPPRESS_SYNC_WARNING === '1'

function warnIfSyncedFolder(): void {
  if (SUPPRESS_SYNC_WARNINGS) return
  const marker = syncFolderWarning(dataRoot())
  if (marker && !syncWarningShown) {
    syncWarningShown = true
    log('warn', 'sync-folder-detected', { marker })
    dialog.showMessageBox({
      type: 'warning',
      title: 'Cloud sync folder detected',
      message: 'Total’s data folder appears to be inside a cloud-sync folder.',
      detail:
        `Total stores your books as a live SQLite database. Cloud-sync tools (Dropbox, OneDrive, Google Drive, iCloud, etc.) can corrupt the database if it is edited on two machines at once, or synced mid-write. Moving ${dataFolderLabel(process.platform)} out of the synced folder is strongly recommended.`,
      buttons: ['OK']
    })
  }

  if (process.platform === 'darwin' && !iCloudDesktopWarningShown) {
    const iCloudDesktopDocs = join(homedir(), 'Library', 'Mobile Documents', 'com~apple~CloudDocs', 'Documents')
    if (existsSync(iCloudDesktopDocs)) {
      iCloudDesktopWarningShown = true
      log('warn', 'icloud-desktop-documents-sync-detected', {})
      dialog.showMessageBox({
        type: 'info',
        title: 'iCloud Desktop & Documents sync is on',
        message: 'macOS is syncing your Documents folder to iCloud.',
        detail:
          'If Total’s data folder ends up inside your Documents folder, iCloud may sync it in the background while it is open elsewhere. This is usually fine, but if you notice odd behavior, consider excluding the total folder from iCloud sync.',
        buttons: ['OK']
      })
    }
  }
}

/** A moved data folder (Settings → "Where Total keeps your books") that is not there at launch —
 *  an unplugged drive, a renamed folder: say so, once. The default folder is open instead and the
 *  pointer is kept, so the next launch with the folder back opens the moved books again. */
function warnIfMovedFolderMissing(): void {
  const problem = dataRootChoice().problem
  if (!problem) return
  log('warn', 'data-root-pointer-not-followed', { kind: problem.kind })
  if (SUPPRESS_SYNC_WARNINGS) return
  dialog.showMessageBox({
    type: 'warning',
    title: 'Your books folder was not found',
    message: problem.pointerPath ? `Total could not find the folder it keeps your books in: ${problem.pointerPath}` : 'Total could not read where it keeps your books.',
    detail:
      `Total opened ${dataRootChoice().defaultPath} instead. If the folder is on a drive that is not connected, connect it and start Total again. ` +
      'Settings → About → "Where Total keeps your books" shows the folder in use.',
    buttons: ['OK']
  })
}

function createWindow(): void {
  const isMac = process.platform === 'darwin'
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1080,
    minHeight: 700,
    show: false,
    title: 'Total',
    icon: appIconPath,
    ...(isMac ? { titleBarStyle: 'hiddenInset' as const, trafficLightPosition: { x: 18, y: 16 } } : {}),
    backgroundColor: '#f4f4ef',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
      // Scripted runs only (TOTAL_E2E_TODAY, e2eClock.ts): the preload hands the day to the renderer.
      ...(e2eToday ? { additionalArguments: [`--total-e2e-today=${e2eToday}`] } : {})
    }
  })

  win.on('ready-to-show', () => win.show())

  // WP 7.2: no window is ever opened, and only the allow-listed links (help pages, mailto:, a
  // WhatsApp chat — shared/externalLinks.ts) go to the OS; anything else is refused and logged.
  win.webContents.setWindowOpenHandler((details) => {
    const safe = allowedExternalUrl(details.url)
    if (safe) void shell.openExternal(safe)
    else log('warn', 'window-open-refused', { scheme: details.url.split(':')[0]?.slice(0, 16) ?? '' })
    return { action: 'deny' }
  })
  // The window never navigates away from the app itself (a dropped file, a stray link).
  win.webContents.on('will-navigate', (event, url) => {
    const devUrl = is.dev ? process.env.ELECTRON_RENDERER_URL : undefined
    if (devUrl && url.startsWith(devUrl)) return
    event.preventDefault()
    log('warn', 'navigation-refused', { scheme: url.split(':')[0]?.slice(0, 16) ?? '' })
  })
  win.webContents.on('will-attach-webview', (event) => event.preventDefault())

  if (is.dev && process.env.ELECTRON_RENDERER_URL) {
    win.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

if (gotSingleInstanceLock) {
  app.on('second-instance', () => {
    const [win] = BrowserWindow.getAllWindows()
    if (win) {
      if (win.isMinimized()) win.restore()
      win.focus()
    }
  })

  app.whenReady().then(() => {
    initLogging()
    configureI18n({ dev: !app.isPackaged })
    log('info', 'app-start', { version: app.getVersion(), platform: process.platform, dataRoot: dataRootChoice().source })
    electronApp.setAppUserModelId('com.irminlabs.total')
    if (process.platform === 'darwin') app.dock?.setIcon(appIconPath)
    app.on('browser-window-created', (_, window) => optimizer.watchWindowShortcuts(window))
    ensureDataTree()
    registerIpc()
    startBackupScheduler(getCurrentCompany)
    // WP 6.2: scheduled report packs — hourly due-check (the on-open pass runs from company:open).
    startPackScheduler(getUnlockedCompany, 60, canSeeProfitNow)
    // WP 6.4: opened attachment copies left by a crash (> 1 day old) — this session's go on quit.
    try {
      const swept = sweepStaleOpenCopies()
      if (swept > 0) log('info', 'attachment-copies-swept', { swept })
    } catch {
      // housekeeping only
    }
    createWindow()
    warnIfSyncedFolder()
    warnIfMovedFolderMissing()
    initUpdater()
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })

  app.on('window-all-closed', () => {
    closeCurrentCompany()
    app.quit()
  })

  app.on('before-quit', () => {
    backupOnQuit(getCurrentCompany)
    closeCurrentCompany()
    cleanupOpenedCopies()
  })
}
