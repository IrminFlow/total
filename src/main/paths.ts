import { app } from 'electron'
import { join } from 'path'
import { mkdirSync, readFileSync, statSync } from 'fs'
import { portableSlug } from '@shared/fileNames'
import { DATA_ROOT_POINTER_FILE, resolveDataRoot, type DataRootChoice } from './dataRootResolve'

/** `<userData>/data-root.json` — the pointer Settings → "Where Total keeps your books" writes. */
export function dataRootPointerFile(): string {
  return join(app.getPath('userData'), DATA_ROOT_POINTER_FILE)
}

/** The default data root: ~/Documents/total (the Documents known folder on Windows). */
export function defaultDataRoot(): string {
  return join(app.getPath('documents'), 'total')
}

let chosen: DataRootChoice | null = null

/** How the data root was chosen this session (dataRootResolve.ts). The pointer is read once —
 *  a move writes a new one and relaunches, so a session never changes folder half-way. */
export function dataRootChoice(): DataRootChoice {
  if (process.env.TOTAL_DATA_DIR) return { path: process.env.TOTAL_DATA_DIR, source: 'env', defaultPath: process.env.TOTAL_DATA_DIR }
  chosen ??= resolveDataRoot({
    env: {},
    pointerFile: dataRootPointerFile(),
    defaultRoot: defaultDataRoot(),
    readText: (path) => {
      try {
        return readFileSync(path, 'utf8')
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
        throw err
      }
    },
    isDirectory: (path) => statSync(path).isDirectory()
  })
  return chosen
}

/** Root of all Total data: TOTAL_DATA_DIR, else the folder the pointer names, else ~/Documents/total. */
export function dataRoot(): string {
  // Hermetic override for CI/smoke tests: an absolute TOTAL_DATA_DIR is used verbatim (and is
  // re-read on every call — dbtests point it at a fresh scratch dir per file).
  if (process.env.TOTAL_DATA_DIR) return process.env.TOTAL_DATA_DIR
  return dataRootChoice().path
}

export function registryPath(): string {
  return join(dataRoot(), 'total.json')
}

export function companiesDir(): string {
  return join(dataRoot(), 'companies')
}

export function companyDir(slug: string): string {
  return join(companiesDir(), slug)
}

export function companyDbPath(slug: string): string {
  return join(companyDir(slug), 'company.db')
}

export function companyBackupsDir(slug: string): string {
  return join(companyDir(slug), 'backups')
}

export function companyExportsDir(slug: string): string {
  return join(companyDir(slug), 'exports')
}

/** WP 6.4: attachment bytes, content-addressed (<sha256[0:2]>/<sha256>) — services/attachments.ts. */
export function companyAttachmentsDir(slug: string): string {
  return join(companyDir(slug), 'attachments')
}

/** WP 6.4: attachment copies kept for the backups in backups/ (same layout), so restoring an
 *  older backup brings back files removed since — db/attachmentBackup.ts. */
export function companyBackupAttachmentsDir(slug: string): string {
  return join(companyBackupsDir(slug), 'attachments')
}

export function ensureDataTree(): void {
  mkdirSync(companiesDir(), { recursive: true })
}

export function ensureCompanyTree(slug: string): void {
  mkdirSync(companyDir(slug), { recursive: true })
  mkdirSync(companyBackupsDir(slug), { recursive: true })
  mkdirSync(companyExportsDir(slug), { recursive: true })
}

export function slugify(name: string): string {
  // WP 7.3: a slug names a folder (companies/<slug>) and export files — `con`, `aux`, `nul`, `com1`
  // … are Windows device names, so they get a suffix (portableSlug).
  return portableSlug(
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'company'
  )
}
