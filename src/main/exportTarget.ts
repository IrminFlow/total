import { join } from 'path'

/**
 * Where an accountant export goes (to-do §4: labels PDF, CA pack, e-invoice JSON wrote straight
 * into `<company>/exports/` with no way to choose). The user now gets a native save dialog that
 * starts in the company's exports folder with the file (or folder) name the export always had.
 *
 * Hermetic runs (smoke / e2e / dbtests / the CLI — TOTAL_DATA_DIR set) skip the dialog and write
 * to exports/ exactly as before, so scripted runs never block on a modal.
 *
 * Pure: the dialog is injected by ipc.ts (no electron import here — unit-tested in exportTarget.test.ts).
 */
export interface SaveDialogResult {
  canceled: boolean
  filePath?: string
}
export interface ExportTargetDeps {
  /** True when no dialog may be shown (TOTAL_DATA_DIR set). */
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

export const hermeticRun = (env: NodeJS.ProcessEnv = process.env): boolean => !!env.TOTAL_DATA_DIR

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
