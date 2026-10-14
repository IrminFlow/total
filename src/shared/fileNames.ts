/**
 * WP 7.3 — file and folder names that work on Windows as well as macOS. Pure (no fs / path
 * import) so it is unit-tested with plain vitest and usable from the renderer.
 *
 * Windows refuses (or silently maps to a device) these base names in ANY folder and with ANY
 * extension: CON, PRN, AUX, NUL, COM0–COM9, LPT0–LPT9 (plus the superscript-digit variants), case
 * insensitive — `con.csv` is as reserved as `CON`. It also refuses the characters < > : " / \ | ? *
 * and the control characters, and drops a trailing dot or space. Source: Microsoft, "Naming Files,
 * Paths, and Namespaces" (learn.microsoft.com/windows/win32/fileio/naming-a-file).
 */

const RESERVED = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])$/i

/** Whether `name` (a base name, with or without extension) is reserved on Windows. */
export function isWindowsReservedName(name: string): boolean {
  const base = name.split(/[\\/]/).pop() ?? ''
  // Windows ignores trailing dots / spaces and everything from the FIRST dot when checking.
  const stem = base.replace(/[. ]+$/, '').split('.')[0] ?? ''
  return RESERVED.test(stem.trim())
}

/** Characters no Windows file name may hold (and the control characters). */
const INVALID = /[<>:"/\\|?*\u0000-\u001f\u007f]/g

function extensionOf(name: string): string {
  const i = name.lastIndexOf('.')
  return i > 0 && i < name.length - 1 ? name.slice(i + 1) : ''
}

/**
 * A file name that is valid on Windows and macOS: invalid characters become '-', trailing dots /
 * spaces go, a reserved stem gets a '_' prefix (`CON.pdf` → `_CON.pdf`), and the name is cut to
 * `maxLength` characters keeping its extension. `fallback` when nothing is left.
 */
export function portableFileName(raw: string, opts: { maxLength?: number; fallback?: string } = {}): string {
  const maxLength = opts.maxLength ?? 255
  let name = (raw.split(/[\\/]/).pop() ?? '').replace(INVALID, '-').trim().replace(/[. ]+$/, '')
  if (!name || /^[.-]+$/.test(name)) name = opts.fallback ?? 'file'
  if (isWindowsReservedName(name)) name = `_${name}`
  if (name.length > maxLength) {
    const ext = extensionOf(name)
    const withExt = ext !== '' && ext.length < maxLength - 1
    const stem = (ext ? name.slice(0, name.length - ext.length - 1) : name)
      .slice(0, withExt ? maxLength - ext.length - 1 : maxLength)
      .replace(/[. ]+$/, '')
    name = withExt ? `${stem}.${ext}` : stem
  }
  return name
}

/**
 * Windows' classic MAX_PATH is 260 characters (drive and terminating NUL included); Node itself
 * copes with longer paths, but Explorer and many of the viewers an opened attachment is handed to
 * do not. `fitFileName` shortens `name` (keeping its extension) so `dir` + separator + name stays
 * within `maxPath` (default 250, a margin under 259). A name is never cut below 16 characters.
 */
export function fitFileName(dir: string, name: string, maxPath = 250): string {
  const room = Math.max(16, maxPath - dir.length - 1)
  return name.length <= room ? name : portableFileName(name, { maxLength: room })
}

/**
 * A folder slug (company folders) valid on Windows: slugs are already [a-z0-9-], so only the
 * reserved device names need care — `con` → `con-company`.
 */
export function portableSlug(slug: string): string {
  return isWindowsReservedName(slug) ? `${slug}-company` : slug
}
