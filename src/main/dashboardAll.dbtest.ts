// Launch to Home: `dashboard:all` — the accountant Gateway's four reads in one round trip. Each
// part must be EXACTLY what its own channel returns (report:dashboardSeries, report:dashboard,
// payables:msmeDue, report:dashboardPromised), on the Demo Traders seed and — with
// TOTAL_PERF_DATA pointing at a `total-cli perf-seed` data root (e.g. the 100k seed) — on Perf
// Traders. Viewer-level read, Zod-strict, writes nothing; `parties: false` leaves the two chips out.
import { TRUSTED_EVENT } from './ipcSender.testutil'
import { describe, expect, it, vi } from 'vitest'
import { cpSync, existsSync, mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import Database from 'better-sqlite3-multiple-ciphers'
import { fyOf, todayISO } from '@shared/dates'

const handlers = new Map<string, (event: unknown, payload: unknown) => Promise<{ ok: boolean; data?: unknown; error?: string }>>()

vi.mock('electron', () => ({
  app: { getVersion: () => '0.11.0-test', getPath: () => tmpdir(), isPackaged: false, on: () => {} },
  ipcMain: { handle: (ch: string, fn: (e: unknown, p: unknown) => Promise<{ ok: boolean }>) => handlers.set(ch.replace(/^total:/, ''), fn) },
  dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
  shell: { openPath: async () => '', showItemInFolder: () => {} },
  Notification: class {},
  BrowserWindow: class {},
  safeStorage: { isEncryptionAvailable: () => false }
}))
vi.mock('./updater', () => ({ checkForUpdatesInteractive: async () => null }))

const DATA_DIR = mkdtempSync(join(tmpdir(), 'total-dashboard-all-'))
const PERF_DATA = process.env.TOTAL_PERF_DATA
const withPerf = !!PERF_DATA && existsSync(join(PERF_DATA, 'perf-seed.json'))
// The perf seed's data root (registry + companies/perf-traders) is copied in before main loads.
if (withPerf) cpSync(PERF_DATA!, DATA_DIR, { recursive: true })
process.env.TOTAL_DATA_DIR = DATA_DIR
process.env.TOTAL_SUPPRESS_SYNC_WARNING = '1'

// Imported at collection (WP 7.3: never inside a hook).
const ipc = await import('./ipc')
ipc.registerIpc()

async function call(channel: string, payload?: unknown): Promise<{ ok: boolean; data?: unknown; error?: string }> {
  const h = handlers.get(channel)
  if (!h) throw new Error(`no handler ${channel}`)
  return h(TRUSTED_EVENT, payload)
}
async function ok<T>(channel: string, payload?: unknown): Promise<T> {
  const r = await call(channel, payload)
  if (!r.ok) throw new Error(`${channel}: ${r.error}`)
  return r.data as T
}

type Section = { ok: true; data: unknown } | { ok: false; error: string }
type All = { series: Section; dashboard: Section; msmeDue: Section | null; promised: Section | null }

function auditCount(slug: string): number {
  const db = new Database(join(DATA_DIR, 'companies', slug, 'company.db'), { readonly: true })
  try {
    return (db.prepare('SELECT COUNT(*) AS n FROM audit_log').get() as { n: number }).n
  } finally {
    db.close()
  }
}

/** Every part deep-equals its own channel's output for the Gateway's arguments. */
async function expectSameAsFourChannels(today: string, from: string, to: string): Promise<void> {
  const all = await ok<All>('dashboard:all', { today, from, to })
  const [series, dash, msme, promised] = [
    await ok('report:dashboardSeries', { today, from, to }),
    await ok('report:dashboard', { today, fyFrom: from }),
    await ok('payables:msmeDue', { asOn: today }),
    await ok('report:dashboardPromised', { today })
  ]
  expect(all.series).toEqual({ ok: true, data: series })
  expect(all.dashboard).toEqual({ ok: true, data: dash })
  expect(all.msmeDue).toEqual({ ok: true, data: msme })
  expect(all.promised).toEqual({ ok: true, data: promised })
  // Without the parties cards: the same series and dashboard, the chips left out.
  const lean = await ok<All>('dashboard:all', { today, from, to, parties: false })
  expect(lean).toEqual({ series: all.series, dashboard: all.dashboard, msmeDue: null, promised: null })
}

describe('dashboard:all (launch to Home)', () => {
  it('Demo Traders: each part equals its own channel, and nothing is written', async () => {
    const { slug } = await ok<{ slug: string }>('company:createDemo', {})
    await ok('company:open', { slug })
    const before = auditCount(slug)
    const today = todayISO()
    const fy = fyOf(today)
    await expectSameAsFourChannels(today, fy.from, fy.to)
    // Another period (the previous FY, as on its last day) — the window logic is the series' own.
    const prev = fyOf(`${fy.startYear - 1}-06-01`)
    await expectSameAsFourChannels(prev.to, prev.from, prev.to)
    expect(auditCount(slug)).toBe(before)
  }, 120_000)

  it('is a strict, viewer-level read mapped in auditCoverage', async () => {
    const today = todayISO()
    const fy = fyOf(today)
    expect((await call('dashboard:all', { today, from: fy.from, to: fy.to, extra: 1 })).ok).toBe(false)
    expect((await call('dashboard:all', { today, from: fy.to, to: fy.from })).ok).toBe(false)
    expect((await call('dashboard:all', { today: 'today', from: fy.from, to: fy.to })).ok).toBe(false)
    expect(ipc.CHANNEL_ROLES.get('dashboard:all')).toBe('viewer')
    const { AUDIT_COVERAGE } = await import('./auditCoverage')
    expect(AUDIT_COVERAGE['dashboard:all']).toHaveProperty('read')
  })

  it.skipIf(!withPerf)('Perf Traders (TOTAL_PERF_DATA seed): each part equals its own channel', async () => {
    const { PERF_TODAY } = await import('./perf/seedLarge')
    await ok('company:open', { slug: 'perf-traders' })
    const fy = fyOf(PERF_TODAY)
    await expectSameAsFourChannels(PERF_TODAY, fy.from, fy.to)
  }, 600_000)
})
