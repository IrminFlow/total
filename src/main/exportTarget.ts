import { join } from 'path'

/**
 * Where an accountant export goes (to-do §4: labels PDF, CA pack, e-invoice JSON wrote straight
 * into `<company>/exports/` with no way to choose). The user now gets a native save dialog that
 * starts in the company's exports folder with the file (or folder) name the export always had.
 *
 * Hermetic runs (smoke / e2e / dbtests — TOTAL_DATA_DIR set AND an unpackaged build, the repo's
 * rule for test-only switches, as e2eClock / the insecure test cipher) skip the dialog and write
 * to exports/ exactly as before, so scripted runs never block on a modal. A packaged app always
 * asks, whatever the environment says.
 *
 * Pure: the dialog is injected by ipc.ts (no electron import here — unit-tested in exportTarget.test.ts).
 */
export interface SaveDialogResult {
  canceled: boolean
  filePath?: string
}
export interface ExportTargetDeps {
  /** True when no dialog may be shown (TOTAL_DATA_DIR set in an unpackaged build). */
  hermetic: () => boolean
  showSaveDialog: (opts: {
    title: string
    defaultPath: string
    buttonLabel?: string
    filters?: { name: string; extensions: string[] }[]
    properties?: ('createDirectory' | 'showOverwriteConfirmation')[]
  }) => Promise<SaveDialogResult>
}

export interface ExportTargetRequest {
  exportsDir: string
  /** The name the export always had (a file name, or a folder name for `kind: 'folder'`). */
  defaultName: string
  title: string
  kind?: 'file' | 'folder'
  filters?: { name: string; extensions: string[] }[]
}

/** `isPackaged` null = Electron-as-Node (the dbtest runner: `app` is undefined), treated as unpackaged. */
export const hermeticRun = (env: { TOTAL_DATA_DIR?: string }, isPackaged: boolean | null): boolean =>
  isPackaged !== true && !!env.TOTAL_DATA_DIR

/** The chosen path, the exports-folder default in a hermetic run, or null when the user cancelled. */
export async function chooseExportPath(req: ExportTargetRequest, deps: ExportTargetDeps): Promise<string | null> {
  const fallback = join(req.exportsDir, req.defaultName)
  if (deps.hermetic()) return fallback
  const res = await deps.showSaveDialog({
    title: req.title,
    defaultPath: fallback,
    buttonLabel: 'Save',
    filters: req.kind === 'folder' ? undefined : req.filters,
    properties: ['createDirectory', 'showOverwriteConfirmation']
  })
  if (res.canceled || !res.filePath) return null
  return res.filePath
}
