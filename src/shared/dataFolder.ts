/** Settings → "Where Total keeps your books" — what main tells the renderer (ipcDataRoot.ts). */

export type DataFolderSource = 'env' | 'pointer' | 'default'

export type DataFolderProblem = 'same' | 'inside_current' | 'contains_current' | 'not_empty' | 'not_a_folder' | 'not_writable' | 'no_space' | 'old_copy'

export interface DataFolderView {
  /** The folder in use this session. */
  path: string
  source: DataFolderSource
  defaultPath: string
  /** In a OneDrive folder (shared/windowsPaths.ts `isOneDrivePath`). */
  oneDrive: boolean
  /** Another cloud-sync folder (Dropbox, Google Drive, iCloud …) — shared/syncpath.ts. */
  synced: boolean
  /** A moved folder could not be found at launch (the default one is open instead). */
  missingPointer: string | null
  /** The folder in use holds MOVED-TO.txt: it is the old copy a move left behind (the pointer to
   *  the moved books is gone — a reinstall, a new user profile), so its books may be stale. */
  oldCopy: boolean
}

export interface DataFolderPick {
  path: string
  ok: boolean
  /** empty / new = the books are copied there; total = the folder already holds Total books. */
  kind?: 'empty' | 'new' | 'total'
  problem?: DataFolderProblem
  bytes?: number
  /** The picked folder is itself in OneDrive / a synced folder (a warning, not a refusal). */
  oneDrive: boolean
  synced: boolean
}

export interface DataFolderMoved {
  path: string
  copied: boolean
  files: number
  /** The app restarts on its own a moment after this answer. */
  relaunching: boolean
}
