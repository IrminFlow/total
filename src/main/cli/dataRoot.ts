// WP 7.3 — the CLI's default data root when TOTAL_DATA_DIR is not set: the same folder the app
// uses (Electron's app.getPath('documents') + 'total'). On Windows that is the Documents known
// folder from the registry — OneDrive folder backup or a redirect moves it away from
// %USERPROFILE%\Documents (shared/windowsPaths.ts); elsewhere ~/Documents. A registry answer that
// is unreadable (non-ASCII through reg.exe's code page) or missing is checked with PowerShell.
import { execFileSync } from 'child_process'
import { existsSync, readFileSync, statSync } from 'fs'
import { homedir } from 'os'
import { join, posix, win32 } from 'path'
import { chooseWindowsDocumentsDir } from '@shared/windowsPaths'
import { DATA_ROOT_POINTER_FILE, resolveDataRoot, type DataRootChoice } from '../dataRootResolve'

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

/** Electron's per-user app folder for Total (`app.getPath('userData')`) without Electron: the
 *  packaged app is named by productName ("Total"); an unpackaged run by package.json name
 *  ("total") — both are tried, the first holding a pointer wins (same folder on case-insensitive
 *  file systems). */
export function userDataCandidates(
  platform: NodeJS.Platform = process.platform,
  env: Record<string, string | undefined> = process.env,
  home: string = homedir()
): string[] {
  const base =
    platform === 'win32' ? env.APPDATA || join(home, 'AppData', 'Roaming')
    : platform === 'darwin' ? join(home, 'Library', 'Application Support')
    : env.XDG_CONFIG_HOME || join(home, '.config')
  return [join(base, 'Total'), join(base, 'total')]
}

export function readPointerText(path: string): string | null {
  try {
    return readFileSync(path, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw err
  }
}

/** The CLI / MCP data root, in the app's order: TOTAL_DATA_DIR → the data-root.json pointer (while
 *  its folder exists) → Documents/total. `warn` gets the one-line message when a pointer exists
 *  but cannot be followed; the default opens meanwhile. */
export function resolveCliDataRoot(
  opts: {
    env?: Record<string, string | undefined>
    platform?: NodeJS.Platform
    home?: string
    defaultRoot?: () => string
    warn?: (line: string) => void
  } = {}
): DataRootChoice {
  const env = opts.env ?? process.env
  const warn = opts.warn ?? ((l: string) => process.stderr.write(l + '\n'))
  if (env.TOTAL_DATA_DIR) return { path: env.TOTAL_DATA_DIR, source: 'env', defaultPath: env.TOTAL_DATA_DIR }
  const candidates = userDataCandidates(opts.platform, env, opts.home).map((d) => join(d, DATA_ROOT_POINTER_FILE))
  let pointerFile = candidates[0]!
  for (const c of candidates) {
    try {
      if (readPointerText(c) !== null) { pointerFile = c; break }
    } catch { pointerFile = c; break }
  }
  const choice = resolveDataRoot({
    env: {},
    pointerFile,
    defaultRoot: (opts.defaultRoot ?? (() => defaultDataRoot(opts.platform)))(),
    readText: readPointerText,
    isDirectory: (p) => statSync(p).isDirectory(),
    isAbsolutePath: (opts.platform ?? process.platform) === 'win32' ? win32.isAbsolute : posix.isAbsolute
  })
  if (choice.problem) {
    warn(
      choice.problem.kind === 'pointer_missing_folder'
        ? `total-cli: the data folder ${choice.problem.pointerPath} (from ${pointerFile}) does not exist; using ${choice.path} instead.`
        : `total-cli: ${pointerFile} is unreadable or names no absolute folder; using ${choice.path} instead.`
    )
  }
  return choice
}
