import { app } from 'electron'
import { join } from 'path'
import { existsSync, mkdirSync } from 'fs'
import { configuredDataRoot } from './dataRootConfig'

/** Root of all Total data: ~/Documents/total, unless the user has moved it. */
export function dataRoot(): string {
  // Hermetic override for CI/smoke tests: an absolute TOTAL_DATA_DIR is used verbatim, and beats
  // a configured location so a driver script can never be pointed at somebody's real books.
  if (process.env.TOTAL_DATA_DIR) return process.env.TOTAL_DATA_DIR
  // Moved out of a synced folder (roadmap #244). Falls back to the default when the chosen
  // folder has gone — an unplugged drive should leave the app usable rather than pathless.
  const chosen = configuredDataRoot()
  if (chosen && existsSync(chosen)) return chosen
  return join(app.getPath('documents'), 'total')
}

/** True when the configured data folder has gone missing (drive unplugged, folder deleted). */
export function dataRootMissing(): boolean {
  if (process.env.TOTAL_DATA_DIR) return false
  const chosen = configuredDataRoot()
  return chosen !== null && !existsSync(chosen)
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

export function ensureDataTree(): void {
  mkdirSync(companiesDir(), { recursive: true })
}

export function ensureCompanyTree(slug: string): void {
  mkdirSync(companyDir(slug), { recursive: true })
  mkdirSync(companyBackupsDir(slug), { recursive: true })
  mkdirSync(companyExportsDir(slug), { recursive: true })
}

export function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'company'
  )
}
