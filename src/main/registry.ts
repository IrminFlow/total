import { readFileSync, writeFileSync, existsSync, renameSync } from 'fs'
import type { CompanySummary } from '@shared/domain'
import { registryPath, ensureDataTree } from './paths'

export interface Registry {
  version: 1
  companies: CompanySummary[]
  lastOpened: string | null
}

const EMPTY: Registry = { version: 1, companies: [], lastOpened: null }

export function readRegistry(): Registry {
  ensureDataTree()
  const path = registryPath()
  if (!existsSync(path)) return { ...EMPTY }
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Registry
    if (!Array.isArray(parsed.companies)) return { ...EMPTY }
    return parsed
  } catch {
    return { ...EMPTY }
  }
}

export function writeRegistry(registry: Registry): void {
  ensureDataTree()
  const path = registryPath()
  const tmpPath = `${path}.tmp`
  writeFileSync(tmpPath, JSON.stringify(registry, null, 2))
  renameSync(tmpPath, path)
}

export function upsertCompany(summary: CompanySummary): void {
  const reg = readRegistry()
  const idx = reg.companies.findIndex((c) => c.slug === summary.slug)
  if (idx >= 0) reg.companies[idx] = summary
  else reg.companies.push(summary)
  writeRegistry(reg)
}

export function touchLastOpened(slug: string): void {
  const reg = readRegistry()
  const company = reg.companies.find((c) => c.slug === slug)
  if (company) company.lastOpenedAt = new Date().toISOString()
  reg.lastOpened = slug
  writeRegistry(reg)
}
