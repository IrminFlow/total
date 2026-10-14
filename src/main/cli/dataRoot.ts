// WP 7.3 — the CLI's default data root when TOTAL_DATA_DIR is not set: the same folder the app
// uses (Electron's app.getPath('documents') + 'total'). On Windows that is the Documents known
// folder from the registry — OneDrive folder backup or a redirect moves it away from
// %USERPROFILE%\Documents (shared/windowsPaths.ts); elsewhere ~/Documents.
import { execFileSync } from 'child_process'
import { homedir } from 'os'
import { join } from 'path'
import { windowsDocumentsDir } from '@shared/windowsPaths'

const SHELL_FOLDERS = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\User Shell Folders'

export function defaultDataRoot(platform: NodeJS.Platform = process.platform): string {
  if (platform !== 'win32') return join(homedir(), 'Documents', 'total')
  let out: string | null = null
  try {
    out = execFileSync('reg', ['query', SHELL_FOLDERS, '/v', 'Personal'], { encoding: 'utf8', windowsHide: true, timeout: 5000 })
  } catch {
    out = null
  }
  return join(windowsDocumentsDir(out, process.env, homedir()), 'total')
}
