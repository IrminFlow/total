// Settings → "Where Total keeps your books": the data root in use, picking another folder and
// moving the books there (services/dataRootMove.ts), then a relaunch. Registered from ipc.ts with
// its `handle` (role gate + { ok, data | error } envelope). App-level, like the update setting:
// owner-only where the open company has users. The folder is always picked in main — the
// renderer never hands a path in (the move uses the folder the picker returned, and the payload
// only has to name the same one, so a stale screen cannot move to an older pick).
import { app, BrowserWindow, dialog } from 'electron'
import { z } from 'zod'
import type { Role } from './services/roles'
import { AppError } from '@shared/errors'
import { isOneDrivePath } from '@shared/windowsPaths'
import { syncFolderWarning } from '@shared/syncpath'
import type { DataFolderMoved, DataFolderPick, DataFolderView } from '@shared/dataFolder'
import { dataRootChoice, dataRootPointerFile } from './paths'
import { inspectTarget, isOldCopy, moveDataRoot, problemMessage } from './services/dataRootMove'
import { log } from './log'

type Handle = (channel: string, fn: (payload: unknown) => unknown, minRole?: Role) => void

export interface DataRootIpcDeps {
  /** Close the open company (its handle, watchers, key) before the files are copied. */
  closeCompany: () => void | Promise<void>
  who: () => string | null
}

function view(): DataFolderView {
  const c = dataRootChoice()
  return {
    path: c.path,
    source: c.source,
    defaultPath: c.defaultPath,
    oneDrive: isOneDrivePath(c.path),
    synced: !isOneDrivePath(c.path) && syncFolderWarning(c.path) !== null,
    missingPointer: c.problem?.kind === 'pointer_missing_folder' ? (c.problem.pointerPath ?? null) : null,
    oldCopy: c.source !== 'env' && isOldCopy(c.path)
  }
}

let picked: string | null = null
let moving = false

export function registerDataRootIpc(handle: Handle, deps: DataRootIpcDeps): void {
  handle('app:dataRoot:get', () => view(), 'viewer')

  handle('app:dataRoot:pick', async (): Promise<DataFolderPick | null> => {
    const current = dataRootChoice()
    if (current.source === 'env') throw new AppError('data_folder_env', 'The folder is set by the environment (TOTAL_DATA_DIR) — it cannot be changed here')
    const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
    const options: Electron.OpenDialogOptions = {
      title: 'Choose where Total keeps your books',
      buttonLabel: 'Use this folder',
      properties: ['openDirectory', 'createDirectory', 'promptToCreate']
    }
    const r = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options)
    const chosen = r.canceled ? undefined : r.filePaths[0]
    if (!chosen) return null
    const check = inspectTarget(chosen, current.path)
    picked = check.ok ? check.path : null
    return {
      path: check.path,
      ok: check.ok,
      ...(check.kind ? { kind: check.kind } : {}),
      ...(check.problem ? { problem: check.problem } : {}),
      ...(check.bytes !== undefined ? { bytes: check.bytes } : {}),
      oneDrive: isOneDrivePath(check.path),
      synced: !isOneDrivePath(check.path) && syncFolderWarning(check.path) !== null
    }
  }, 'owner')

  handle('app:dataRoot:move', async (p): Promise<DataFolderMoved> => {
    const { path } = z.object({ path: z.string().min(1).max(4096) }).strict().parse(p)
    const current = dataRootChoice()
    if (current.source === 'env') throw new AppError('data_folder_env', 'The folder is set by the environment (TOTAL_DATA_DIR) — it cannot be changed here')
    if (!picked || picked !== path) throw new AppError('data_folder_not_picked', 'Pick the folder again')
    if (moving) throw new AppError('data_folder_busy', 'The books are already being moved')
    // Refuse a folder that no longer fits BEFORE the company is closed (it may have changed since the pick).
    const check = inspectTarget(picked, current.path)
    if (!check.ok) throw new AppError(`data_folder_${check.problem ?? 'not_writable'}`, problemMessage(check.problem ?? 'not_writable'))
    moving = true
    try {
      // Only this process writes the folder: the single-instance lock keeps a second Total out,
      // and the open company is closed now (its database, watchers and background checks).
      await deps.closeCompany()
      const r = moveDataRoot({
        from: current.path,
        to: picked,
        pointerFile: dataRootPointerFile(),
        defaultRoot: current.defaultPath,
        who: deps.who(),
        appVersion: app.getVersion()
      })
      picked = null
      log('info', 'data-root-moved', { copied: !!r.copied, files: r.copied?.files ?? 0, bytes: r.copied?.bytes ?? 0, kind: r.kind })
      // Answer first, then restart into the new folder (every path in this session is the old one).
      setTimeout(() => {
        app.relaunch()
        app.exit(0)
      }, 1500)
      return { path: r.path, copied: !!r.copied, files: r.copied?.files ?? 0, relaunching: true }
    } finally {
      moving = false
    }
  }, 'owner')
}
