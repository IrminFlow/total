/**
 * Where the books live (roadmap #244).
 *
 * Kept in its own module, importing nothing but Electron and fs, because `paths.ts` reads it and
 * everything reads `paths.ts` — a data-location module that pulled in the database layer would
 * make an import cycle out of the most basic function in the app. The moving itself, which does
 * need the database layer to prove the copy, lives in `dataLocation.ts`.
 *
 * The pointer is stored in the app's own userData directory rather than under the data folder: a
 * pointer stored inside the thing it points at cannot survive the thing moving.
 */
import { app } from 'electron'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { join } from 'path'

interface LocationFile {
  version: 1
  /** Absolute path to the data root, or null to mean "wherever the default is". */
  root: string | null
}

/** Cached: `dataRoot()` is called on every path lookup and must not stat a file each time. */
let cached: string | null | undefined

function locationPath(): string {
  return join(app.getPath('userData'), 'data-location.json')
}

/** The user's chosen data root, or null when they have never chosen one. */
export function configuredDataRoot(): string | null {
  if (cached !== undefined) return cached
  try {
    const parsed = JSON.parse(readFileSync(locationPath(), 'utf8')) as LocationFile
    cached = parsed?.version === 1 && typeof parsed.root === 'string' ? parsed.root : null
  } catch {
    // No file, an unreadable one, or no Electron app at all (dbtests): the default applies.
    cached = null
  }
  return cached
}

export function setConfiguredDataRoot(root: string | null): void {
  const file: LocationFile = { version: 1, root }
  const path = locationPath()
  mkdirSync(join(path, '..'), { recursive: true })
  // Same-directory temp + rename: a crash mid-write must never leave a half-written pointer and
  // an app that cannot find its own books.
  const temp = `${path}.tmp`
  writeFileSync(temp, JSON.stringify(file, null, 2), 'utf8')
  renameSync(temp, path)
  cached = root
}

/** Test seam: forget the cached location so a changed file is read again. */
export function __resetDataLocationCache(): void {
  cached = undefined
}
