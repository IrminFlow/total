import { app } from 'electron'
import { isAbsolute, join, relative, resolve, sep } from 'path'
import { existsSync, lstatSync, mkdirSync, realpathSync } from 'fs'

const COMPANY_SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

/** Company slugs are directory names, not arbitrary path fragments. Keep this assertion at the
 * path boundary so a future caller cannot accidentally turn a slug into a traversal primitive. */
export function assertCanonicalCompanySlug(slug: string): string {
  if (slug.length < 1 || slug.length > 60 || !COMPANY_SLUG_RE.test(slug)) {
    throw new Error('Invalid company identifier')
  }
  return slug
}

function assertContained(root: string, target: string, label: string): void {
  const rel = relative(root, target)
  if (rel === '' || rel.startsWith(`..${sep}`) || rel === '..' || isAbsolute(rel)) {
    throw new Error(`${label} is outside Total's company storage`)
  }
}

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

/** Recoverable holding area for companies removed through the UI. Nothing here is pruned
 * automatically: recovery material remains available until the owner deliberately removes it. */
export function deletedCompaniesDir(): string {
  return join(dataRoot(), 'deleted-companies')
}

export function ensureDeletedCompaniesDir(): string {
  const directory = deletedCompaniesDir()
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  const entry = lstatSync(directory)
  if (entry.isSymbolicLink() || !entry.isDirectory()) {
    throw new Error('Deleted-company storage is not a regular directory')
  }
  const dataReal = realpathSync(dataRoot())
  const directoryReal = realpathSync(directory)
  assertContained(dataReal, directoryReal, 'Deleted-company storage')
  return directory
}

export function companyDir(slug: string): string {
  const safeSlug = assertCanonicalCompanySlug(slug)
  const root = resolve(companiesDir())
  const target = resolve(root, safeSlug)
  assertContained(root, target, 'Company directory')
  return target
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

export interface ExistingCompanyPaths {
  directory: string
  database: string
}

/** Resolve an existing company without following directory/file symlinks. Besides lexical slug
 * validation, realpath containment prevents a locally-modified registry or symlink from making
 * Total open a database outside its own companies directory (or a different registered company). */
export function existingCompanyPaths(slug: string): ExistingCompanyPaths {
  const directory = companyDir(slug)
  const database = companyDbPath(slug)
  if (!existsSync(directory)) throw new Error('Company directory is missing; no files were changed')
  if (!existsSync(database)) throw new Error('Company database is missing; no files were changed')
  const companiesEntry = lstatSync(companiesDir())
  if (companiesEntry.isSymbolicLink() || !companiesEntry.isDirectory()) {
    throw new Error('Company storage is not a regular directory')
  }
  const directoryEntry = lstatSync(directory)
  if (directoryEntry.isSymbolicLink() || !directoryEntry.isDirectory()) {
    throw new Error('Company directory is not a regular directory')
  }
  const databaseEntry = lstatSync(database)
  if (databaseEntry.isSymbolicLink() || !databaseEntry.isFile()) {
    throw new Error('Company database is not a regular file')
  }

  const dataReal = realpathSync(dataRoot())
  const rootReal = realpathSync(companiesDir())
  const directoryReal = realpathSync(directory)
  const databaseReal = realpathSync(database)
  assertContained(dataReal, rootReal, 'Company storage')
  assertContained(rootReal, directoryReal, 'Company directory')
  assertContained(directoryReal, databaseReal, 'Company database')
  return { directory, database }
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
