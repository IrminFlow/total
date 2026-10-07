import { app, BrowserWindow, dialog, shell } from 'electron'
import { join } from 'path'
import { existsSync } from 'fs'
import { homedir } from 'os'
import { electronApp, is, optimizer } from '@electron-toolkit/utils'
import { registerIpc, closeCurrentCompany, getCurrentCompany } from './ipc'
import { ensureDataTree, dataRoot } from './paths'
import { initUpdater } from './updater'
import { initLogging, log } from './log'
import { startBackupScheduler, backupOnQuit } from './backup-scheduler'
import { startPackScheduler } from './packScheduler'
import { syncFolderWarning } from '@shared/syncpath'

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
    icon: appIconPath,
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
    if (process.platform === 'darwin') app.dock?.setIcon(appIconPath)
    app.on('browser-window-created', (_, window) => optimizer.watchWindowShortcuts(window))
    ensureDataTree()
    registerIpc()
    startBackupScheduler(getCurrentCompany)
    // WP 6.2: scheduled report packs — hourly due-check (the on-open pass runs from company:open).
    startPackScheduler(getCurrentCompany)
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
