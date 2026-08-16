import { readFileSync, writeFileSync, existsSync, renameSync, rmSync, statSync } from 'fs'
import type { CompanySummary } from '@shared/domain'
import { registryPath, ensureDataTree } from './paths'

export interface Registry {
  version: 1
  companies: CompanySummary[]
  lastOpened: string | null
}

/** Always a FRESH object: callers mutate the returned registry (push into `companies`) before
 *  writing it back, so a shared `{ ...EMPTY }` spread (which reuses one companies array) would
 *  let one caller's push leak into every later empty read. */
function emptyRegistry(): Registry {
  return { version: 1, companies: [], lastOpened: null }
}

export function readRegistry(): Registry {
  ensureDataTree()
  const path = registryPath()
  if (!existsSync(path)) return emptyRegistry()
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Registry
    if (!Array.isArray(parsed.companies)) return emptyRegistry()
    return parsed
  } catch {
    return emptyRegistry()
  }
}

export function writeRegistry(registry: Registry): void {
  ensureDataTree()
  const path = registryPath()
  const tmpPath = `${path}.tmp`
  writeFileSync(tmpPath, JSON.stringify(registry, null, 2))
  renameSync(tmpPath, path)
}

// ---------- write lock (task Q3 #99) ----------
// The app itself is single-instance, but the registry is also touched by external tooling (e.g.
// the agent CLI writing through the same data dir), so every read-modify-write below runs under
// an exclusive lockfile beside registry.json. `wx` creation is atomic; a lock older than
// STALE_LOCK_MS (a crashed writer) is broken rather than waited on.

const LOCK_WAIT_MS = 2000
const STALE_LOCK_MS = 10_000

function lockPath(): string {
  return `${registryPath()}.lock`
}

function acquireRegistryLock(): void {
  ensureDataTree()
  const deadline = Date.now() + LOCK_WAIT_MS
  for (;;) {
    try {
      writeFileSync(lockPath(), String(process.pid), { flag: 'wx' })
      return
    } catch {
      try {
        const age = Date.now() - statSync(lockPath()).mtimeMs
        if (age > STALE_LOCK_MS) {
          rmSync(lockPath(), { force: true })
          continue
        }
      } catch {
        continue // lock vanished between our failed create and the stat — try again immediately
      }
      if (Date.now() > deadline) {
        throw new Error('The company registry is locked by another process — try again in a moment')
      }
      // Contention is near-impossible in practice (single-instance app); a brief synchronous
      // spin keeps this dependency-free rather than pulling in async plumbing for a rare case.
      const spinUntil = Date.now() + 25
      while (Date.now() < spinUntil) {
        // busy-wait
      }
    }
  }
}

function releaseRegistryLock(): void {
  rmSync(lockPath(), { force: true })
}

/** Run `fn` while holding the exclusive registry lock. Exported for external writers (agent CLI). */
export function withRegistryLock<T>(fn: () => T): T {
  acquireRegistryLock()
  try {
    return fn()
  } finally {
    releaseRegistryLock()
  }
}

export function upsertCompany(summary: CompanySummary): void {
  withRegistryLock(() => {
    const reg = readRegistry()
    const idx = reg.companies.findIndex((c) => c.slug === summary.slug)
    if (idx >= 0) reg.companies[idx] = summary
    else reg.companies.push(summary)
    writeRegistry(reg)
  })
}

export function touchLastOpened(slug: string): void {
  withRegistryLock(() => {
    const reg = readRegistry()
    const company = reg.companies.find((c) => c.slug === slug)
    if (company) company.lastOpenedAt = new Date().toISOString()
    reg.lastOpened = slug
    writeRegistry(reg)
  })
}

/** Drop `slug` from the registry (its on-disk company directory is removed separately by the
 *  caller — see company:delete in ipc.ts). No-op if the slug isn't in the registry. */
export function removeCompany(slug: string): void {
  withRegistryLock(() => {
    const reg = readRegistry()
    reg.companies = reg.companies.filter((c) => c.slug !== slug)
    if (reg.lastOpened === slug) reg.lastOpened = null
    writeRegistry(reg)
  })
}
