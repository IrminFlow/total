/**
 * WP 7.3 — where Windows keeps the user's Documents folder, for the headless CLI (which runs as
 * plain Node, without Electron's `app.getPath('documents')`). Pure: the CLI runs
 * `reg query "HKCU\Software\Microsoft\Windows\CurrentVersion\Explorer\User Shell Folders" /v Personal`
 * and hands the output here.
 *
 * The folder is NOT always %USERPROFILE%\Documents: OneDrive's "folder backup" (on by default on
 * many Windows 11 machines) moves it to %USERPROFILE%\OneDrive\Documents, and IT departments
 * redirect it elsewhere. The app (SHGetKnownFolderPath via Electron) and the CLI must agree, or
 * the CLI would open a different, empty data folder.
 */

/** The data of one value in `reg query … /v <name>` output (REG_SZ or REG_EXPAND_SZ), or null. */
export function regQueryValue(stdout: string, name: string): string | null {
  for (const line of stdout.split(/\r?\n/)) {
    const m = line.match(/^\s*(\S.*?)\s+(REG_EXPAND_SZ|REG_SZ)\s+(.*?)\s*$/)
    if (m && m[1]!.toLowerCase() === name.toLowerCase()) return m[3]! || null
  }
  return null
}

/** %VAR% expansion as Windows does it (names case-insensitive; unknown ones are left as typed). */
export function expandWindowsEnv(s: string, env: Record<string, string | undefined>): string {
  const lower = new Map(Object.entries(env).map(([k, v]) => [k.toLowerCase(), v]))
  return s.replace(/%([^%]+)%/g, (whole, name: string) => lower.get(name.toLowerCase()) ?? whole)
}

/** The Documents folder from the registry output, else `<home>\Documents`. */
export function windowsDocumentsDir(regStdout: string | null, env: Record<string, string | undefined>, home: string): string {
  const raw = regStdout ? regQueryValue(regStdout, 'Personal') : null
  const expanded = raw ? expandWindowsEnv(raw, env) : null
  if (expanded && !/%[^%]+%/.test(expanded) && /^([a-z]:[\\/]|\\\\)/i.test(expanded)) return expanded.replace(/[\\/]+$/, '')
  return `${home.replace(/[\\/]+$/, '')}\\Documents`
}
