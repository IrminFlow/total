/**
 * Where Total keeps its books (the data root), decided once at startup — pure (fs functions and
 * the paths are injected), so the order is unit-tested without Electron:
 *
 *   1. `TOTAL_DATA_DIR` (scripted / hermetic runs) — used verbatim, always wins;
 *   2. the pointer file `<userData>/data-root.json` `{ "path": "D:\\Total" }` written by
 *      Settings → "Where Total keeps your books" (it lives OUTSIDE the data root, in Electron's
 *      per-user app folder, so it is found before the data root is known);
 *   3. the default `<Documents>/total`.
 *
 * A pointer whose folder is gone (an unplugged drive, a deleted folder) is NOT followed and NOT
 * created: Total opens the default folder and says so (`problem`), and leaves the pointer alone,
 * so the next launch with the drive back opens the moved books again. A pointer that is not JSON
 * or names a relative path is ignored the same way.
 */
import { isAbsolute } from 'path'

export const DATA_ROOT_POINTER_FILE = 'data-root.json'

export type DataRootSource = 'env' | 'pointer' | 'default'

export interface DataRootChoice {
  path: string
  source: DataRootSource
  /** The default folder (Documents/total) — shown next to a moved folder. */
  defaultPath: string
  /** Set when a pointer exists but could not be followed. */
  problem?: { kind: 'pointer_unreadable' | 'pointer_missing_folder'; pointerPath?: string }
}

export interface ResolveDeps {
  env: Record<string, string | undefined>
  /** Absolute path of `<userData>/data-root.json`. */
  pointerFile: string
  defaultRoot: string
  /** The file's text, or null when it does not exist. Throws on any other read failure. */
  readText: (path: string) => string | null
  isDirectory: (path: string) => boolean
  /** Path-style absolute check (win32 / posix) — injected so tests can run both. */
  isAbsolutePath?: (path: string) => boolean
}

/** The `path` of a pointer file's text, or null when it is not a usable pointer. */
export function parsePointer(text: string, isAbs: (p: string) => boolean = isAbsolute): string | null {
  try {
    const raw = JSON.parse(text) as unknown
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
    const p = (raw as { path?: unknown }).path
    if (typeof p !== 'string' || !p.trim() || p.includes('\0')) return null
    return isAbs(p) ? p : null
  } catch {
    return null
  }
}

export function resolveDataRoot(deps: ResolveDeps): DataRootChoice {
  const defaultPath = deps.defaultRoot
  const env = deps.env.TOTAL_DATA_DIR
  if (env) return { path: env, source: 'env', defaultPath }
  let text: string | null
  try {
    text = deps.readText(deps.pointerFile)
  } catch {
    return { path: defaultPath, source: 'default', defaultPath, problem: { kind: 'pointer_unreadable' } }
  }
  if (text === null) return { path: defaultPath, source: 'default', defaultPath }
  const pointed = parsePointer(text, deps.isAbsolutePath ?? isAbsolute)
  if (!pointed) return { path: defaultPath, source: 'default', defaultPath, problem: { kind: 'pointer_unreadable' } }
  let isDir = false
  try {
    isDir = deps.isDirectory(pointed)
  } catch {
    isDir = false
  }
  if (!isDir) return { path: defaultPath, source: 'default', defaultPath, problem: { kind: 'pointer_missing_folder', pointerPath: pointed } }
  return { path: pointed, source: 'pointer', defaultPath }
}

/** The pointer file's text for a folder. */
export function pointerText(path: string): string {
  return `${JSON.stringify({ path }, null, 2)}\n`
}
