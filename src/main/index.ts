import { app, BrowserWindow, dialog, shell } from 'electron'
import { join } from 'path'
import { existsSync } from 'fs'
import { homedir } from 'os'
import { electronApp, is } from '@electron-toolkit/utils'
import { registerIpc, closeCurrentCompany, getCurrentCompany, getSessionUserName } from './ipc'
import { ensureDataTree, dataRoot } from './paths'
import { initUpdater } from './updater'
import { installMenu } from './menu'
import { initLogging, log } from './log'
import { startBackupScheduler, backupOnQuit } from './backup-scheduler'
import { startHeartbeat } from './deviceLock'
import { syncFolderWarning } from '@shared/syncpath'

const gotSingleInstanceLock = app.requestSingleInstanceLock()

if (!gotSingleInstanceLock) {
  app.quit()
}

let syncWarningShown = false
let iCloudDesktopWarningShown = false

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
        'Total stores your books as a live SQLite database. Cloud-sync tools (Dropbox, OneDrive, Google Drive, iCloud, etc.) can corrupt the database if it is edited on two machines at once, or synced mid-write. Moving ~/Documents/total out of the synced folder is strongly recommended.',
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

function createWindow(): void {
  const isMac = process.platform === 'darwin'
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1080,
    minHeight: 700,
    show: false,
    title: 'Total',
    ...(isMac ? { titleBarStyle: 'hiddenInset' as const, trafficLightPosition: { x: 18, y: 16 } } : {}),
    backgroundColor: '#f4f4ef',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  win.on('ready-to-show', () => win.show())

  // A renderer that dies outright (OOM, a GPU fault, a native crash) never reaches React's
  // ErrorBoundary — the whole window goes blank instead. Record it so the support report can
  // show what happened, and reload once so the user is not left staring at nothing.
  let reloadedAfterCrash = false
  win.webContents.on('render-process-gone', (_e, details) => {
    log('error', 'render-process-gone', { reason: details.reason, exitCode: details.exitCode })
    if (details.reason === 'clean-exit' || reloadedAfterCrash) return
    reloadedAfterCrash = true
    win.reload()
  })
  win.webContents.on('unresponsive', () => log('warn', 'renderer-unresponsive', {}))
  app.on('child-process-gone', (_e, details) => {
    log('error', 'child-process-gone', { type: details.type, reason: details.reason })
  })

  win.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

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
    log('info', 'app-start', { version: app.getVersion(), platform: process.platform })
    electronApp.setAppUserModelId('com.irminlabs.total')
    installMenu()
    // `optimizer.watchWindowShortcuts` is deliberately NOT used: in development it intercepts
    // F12 via before-input-event to toggle devtools, which would silently eat the renderer's
    // F12 (configure columns) for every developer while working fine in the packaged build.
    // Devtools live in the View menu under `is.dev` instead.
    ensureDataTree()
    registerIpc()
    startBackupScheduler(getCurrentCompany)
    // Keep this machine's claim on the open company warm, so a second machine can tell a live
    // session from a crashed one (roadmap #259).
    startHeartbeat(() => getCurrentCompany()?.slug ?? null, getSessionUserName)
    createWindow()
    warnIfSyncedFolder()
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
  })
}
