// WP 7.1 — `total-cli perf-seed` and `total-cli perf` (npm run perf). Both work on their own data
// root (never ~/Documents/total): perf-seed writes a registered "Perf Traders" company into
// --out; perf measures one (--data, or a fresh seed in a temp dir that is removed afterwards).
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'fs'
import { homedir, tmpdir } from 'os'
import { join, resolve } from 'path'
import { createHash } from 'crypto'
import { closeCompanyDb, openCompanyDb, type DB } from '../db/connection'
import { readCompanyInfo } from '../db/seed'
import { upsertCompany } from '../registry'
import { companyDbPath, ensureDataTree } from '../paths'
import { MIGRATIONS } from '../db/migrations'
import { PERF_COMPANY, PERF_DEFAULT_SEED, PERF_TODAY, booksFingerprint, seedLarge, type LargeSeedSummary } from './seedLarge'
import { PERF_CASES, formatTable, overBudget, perfContext, runPerf, type PerfResult } from './bench'

export const PERF_SLUG = 'perf-traders'

export interface PerfSeedManifest {
  vouchers: number
  seed: number
  migrations: number
  summary: LargeSeedSummary
  fingerprint: Record<string, number | string>
  /** SHA-256 of the fingerprint — the same seed and code give the same hash. */
  hash: string
}

/** Point the data root at `dir` — refusing the user's real data folder. */
export function usePerfDataRoot(dir: string): string {
  const root = resolve(dir)
  const real = resolve(join(homedir(), 'Documents', 'total'))
  if (root === real || root.startsWith(real + '/')) throw new Error(`Refusing to use ${root}: the perf commands never touch ~/Documents/total`)
  mkdirSync(root, { recursive: true })
  process.env.TOTAL_DATA_DIR = root
  ensureDataTree()
  return root
}

export function fingerprintHash(fp: Record<string, number | string>): string {
  return createHash('sha256').update(JSON.stringify(fp)).digest('hex')
}

/** Seed Perf Traders (registered, slug perf-traders) into the data root `out`. */
export function perfSeed(opts: { vouchers: number; out: string; seed?: number; log?: (s: string) => void }): PerfSeedManifest {
  const root = usePerfDataRoot(opts.out)
  if (existsSync(companyDbPath(PERF_SLUG))) throw new Error(`${companyDbPath(PERF_SLUG)} already exists — use an empty --out`)
  const db = openCompanyDb(PERF_SLUG)
  const seed = opts.seed ?? PERF_DEFAULT_SEED
  const t0 = Date.now()
  let summary: LargeSeedSummary
  try {
    summary = seedLarge(db, {
      vouchers: opts.vouchers, seed,
      onProgress: (done, total) => {
        if (done % 20_000 === 0 || done === total) opts.log?.(`seeded ${done}/${total} (${Math.round((Date.now() - t0) / 1000)} s)`)
      }
    })
    db.pragma('wal_checkpoint(TRUNCATE)')
  } finally {
    closeCompanyDb(db)
  }
  upsertCompany({ slug: PERF_SLUG, name: PERF_COMPANY.name, stateCode: PERF_COMPANY.stateCode, gstin: PERF_COMPANY.gstin, lastOpenedAt: null })
  const check = openCompanyDb(PERF_SLUG)
  const fingerprint = booksFingerprint(check)
  closeCompanyDb(check)
  const manifest: PerfSeedManifest = { vouchers: opts.vouchers, seed, migrations: MIGRATIONS.length, summary, fingerprint, hash: fingerprintHash(fingerprint) }
  writeFileSync(join(root, 'perf-seed.json'), JSON.stringify(manifest, null, 2))
  return manifest
}

export interface PerfRunOptions {
  vouchers: number
  /** A data root written by perf-seed; absent = seed a fresh one in a temp dir (removed after). */
  data?: string
  keep?: boolean
  repeat?: number
  only?: string[]
  log?: (s: string) => void
}

export interface PerfRunReport {
  vouchers: number
  dataRoot: string
  openMs: number
  results: PerfResult[]
}

/** Seed (or reuse) a company, time the cold open, then every budgeted case. */
export async function perfRun(opts: PerfRunOptions): Promise<PerfRunReport> {
  const temp = opts.data ? null : mkdtempSync(join(tmpdir(), 'total-perf-'))
  const root = opts.data ? usePerfDataRoot(opts.data) : temp!
  try {
    if (temp) {
      opts.log?.(`seeding ${opts.vouchers} vouchers into ${temp} …`)
      perfSeed({ vouchers: opts.vouchers, out: temp, log: opts.log })
    } else {
      const manifest = JSON.parse(readFileSync(join(root, 'perf-seed.json'), 'utf8')) as PerfSeedManifest
      if (manifest.vouchers !== opts.vouchers) opts.log?.(`note: ${root} holds ${manifest.vouchers} vouchers (asked ${opts.vouchers}) — measuring what is there`)
      opts.vouchers = manifest.vouchers
    }
    usePerfDataRoot(root)
    const t0 = performance.now()
    const db: DB = openCompanyDb(PERF_SLUG)
    const openMs = performance.now() - t0
    try {
      const info = readCompanyInfo(db)
      const ctx = perfContext(db, info, PERF_TODAY)
      const results = await runPerf(ctx, opts.vouchers, {
        repeat: opts.repeat,
        ...(opts.only?.length ? { cases: PERF_CASES.filter((c) => opts.only!.includes(c.id)) } : {}),
        onResult: (r) => opts.log?.(`${r.label}: ${r.medianMs.toFixed(0)} ms`)
      })
      return { vouchers: opts.vouchers, dataRoot: root, openMs, results }
    } finally {
      closeCompanyDb(db)
    }
  } finally {
    if (temp && !opts.keep) rmSync(temp, { recursive: true, force: true })
  }
}

export function perfReportText(r: PerfRunReport, scale: number): string {
  const over = overBudget(r.results, scale)
  return [
    `Perf Traders, ${r.vouchers.toLocaleString('en-IN')} vouchers — as on ${PERF_TODAY}${scale !== 1 ? ` — budgets × ${scale}` : ''}`,
    `Company DB open (migrate + ANALYZE): ${r.openMs.toFixed(0)} ms`,
    '',
    formatTable(r.results, scale),
    '',
    over.length ? `${over.length} over budget by more than 50 %: ${over.map((o) => o.id).join(', ')}` : 'Every operation within 150 % of its budget.'
  ].join('\n')
}
