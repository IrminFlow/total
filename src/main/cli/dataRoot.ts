// WP 7.3 — the CLI's default data root when TOTAL_DATA_DIR is not set: the same folder the app
// uses (Electron's app.getPath('documents') + 'total'). On Windows that is the Documents known
// folder from the registry — OneDrive folder backup or a redirect moves it away from
// %USERPROFILE%\Documents (shared/windowsPaths.ts); elsewhere ~/Documents. A registry answer that
// is unreadable (non-ASCII through reg.exe's code page) or missing is checked with PowerShell.
import { execFileSync } from 'child_process'
import { existsSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { chooseWindowsDocumentsDir } from '@shared/windowsPaths'

const SHELL_FOLDERS = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\User Shell Folders'

function run(cmd: string, args: string[]): string | null {
  try {
    return execFileSync(cmd, args, { encoding: 'utf8', windowsHide: true, timeout: 10000, stdio: ['ignore', 'pipe', 'ignore'] })
  } catch {
    return null // a missing key / no PowerShell: the next fallback
  }
}

export function defaultDataRoot(platform: NodeJS.Platform = process.platform): string {
  if (platform !== 'win32') return join(homedir(), 'Documents', 'total')
  const reg = run('reg', ['query', SHELL_FOLDERS, '/v', 'Personal'])
  const askKnownFolder = (): string | null =>
    run('powershell', ['-NoProfile', '-NonInteractive', '-Command', "[Console]::OutputEncoding=[Text.Encoding]::UTF8; [Environment]::GetFolderPath('MyDocuments')"])
  return join(chooseWindowsDocumentsDir(reg, askKnownFolder, process.env, homedir(), existsSync), 'total')
}
