import { app } from 'electron'
import { join } from 'path'
import { mkdirSync } from 'fs'

/** Root of all Total data: ~/Documents/total */
export function dataRoot(): string {
  // Hermetic override for CI/smoke tests: an absolute TOTAL_DATA_DIR is used verbatim.
  if (process.env.TOTAL_DATA_DIR) return process.env.TOTAL_DATA_DIR
  return join(app.getPath('documents'), 'total')
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
