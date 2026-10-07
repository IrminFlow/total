// WP 2.1 — the stock:costAsOf IPC channel end to end through registerIpc(): Zod parsing of the
// payload, the { ok, data | error } envelope, and the viewer role gate. Electron is mocked the
// same way as printTemplatesIpc.dbtest.ts.
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { CostAsOfResult } from './services/stockAnalysis'

const handlers = new Map<string, (event: unknown, payload: unknown) => Promise<{ ok: boolean; data?: unknown; error?: string }>>()

vi.mock('electron', () => ({
  app: { getVersion: () => '0.0.0-test', getPath: () => tmpdir(), isPackaged: false, on: () => {} },
  ipcMain: { handle: (ch: string, fn: (e: unknown, p: unknown) => Promise<{ ok: boolean }>) => handlers.set(ch.replace(/^total:/, ''), fn) },
  dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
  shell: { openPath: async () => '', showItemInFolder: () => {} },
  Notification: class {},
  BrowserWindow: class {},
  safeStorage: { isEncryptionAvailable: () => false }
}))
vi.mock('./updater', () => ({ checkForUpdatesInteractive: async () => null }))

process.env.TOTAL_DATA_DIR = mkdtempSync(join(tmpdir(), 'total-stockcost-ipc-'))
process.env.TOTAL_SUPPRESS_SYNC_WARNING = '1'

async function call<T = unknown>(channel: string, payload?: unknown): Promise<{ ok: boolean; data?: T; error?: string }> {
  const h = handlers.get(channel)
  if (!h) throw new Error(`no handler ${channel}`)
  return (await h({}, payload)) as { ok: boolean; data?: T; error?: string }
}
async function ok<T = unknown>(channel: string, payload?: unknown): Promise<T> {
  const r = await call<T>(channel, payload)
  if (!r.ok) throw new Error(`${channel}: ${r.error}`)
  return r.data as T
}

let steel = 0

beforeAll(async () => {
  const { registerIpc } = await import('./ipc')
  registerIpc()
  const { slug } = await ok<{ slug: string }>('company:create', {
    name: 'IPC Stock Cost Co', stateCode: '27', gstin: null, gstRegistrationType: 'regular', address: 'Pune',
    booksFrom: 2025, email: null, phone: null, pan: null, tan: null
  })
  await ok('company:open', { slug })
  const units = await ok<{ id: number }[]>('master:units:list')
  steel = (await ok<{ id: number }>('master:stockItems:create', {
    name: 'Steel Rod', unitId: units[0]!.id, openingQtyMilli: 10000, openingValue: 250000, valuationMethod: 'weighted_avg'
  })).id
})

describe('stock:costAsOf IPC', () => {
  it('returns exact positions and prices proposed lines', async () => {
    const r = await ok<CostAsOfResult>('stock:costAsOf', { date: '2025-06-01', lines: [{ itemId: steel, qtyMilli: 2500 }] })
    expect(r.positions).toEqual([
      expect.objectContaining({ itemId: steel, qtyMilli: 10000, value: 250000, averageCostPerUnitPaise: 25000, unitCostPaise: 25000 })
    ])
    expect(r.consumption).toEqual({ lines: [{ itemId: steel, qtyMilli: 2500, costPaise: 62500 }], totalPaise: 62500 })
    const noLines = await ok<CostAsOfResult>('stock:costAsOf', { date: '2025-06-01', itemIds: [steel] })
    expect(noLines.consumption).toBeNull()
  })

  it('rejects malformed payloads with a Zod error', async () => {
    for (const bad of [{ date: '01-06-2025' }, { date: '2025-06-01', lines: [{ itemId: steel, qtyMilli: 1.5 }] }, { date: '2025-06-01', voucherId: -1 }]) {
      const r = await call('stock:costAsOf', bad)
      expect(r.ok).toBe(false)
      expect(r.error).toBeTruthy()
    }
  })

  it('is readable by a viewer', async () => {
    await ok('users:save', { data: { name: 'Olive', role: 'owner', pin: '1111' } })
    const viewer = await ok<{ id: number }>('users:save', { data: { name: 'Vik', role: 'viewer', pin: '2222' } })
    await ok('auth:logout')
    await ok('auth:login', { userId: viewer.id, pin: '2222' })
    expect((await call('stock:costAsOf', { date: '2025-06-01', itemIds: [steel] })).ok).toBe(true)
    // The gate is live: the same viewer can't write.
    const denied = await call('master:stockItems:delete', { id: steel })
    expect(denied.ok).toBe(false)
    expect(denied.error).toMatch(/permission/)
  })
})
