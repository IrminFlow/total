// WP 2.2 — manufacture:* IPC channels through registerIpc(): Zod parsing, the { ok, data | error }
// envelope, accountant+ to save, viewer to read. Electron is mocked as in stockCostIpc.dbtest.ts.
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { CostPreview, ManufactureRecord, SaveManufactureResult } from './services/manufacture'

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

process.env.TOTAL_DATA_DIR = mkdtempSync(join(tmpdir(), 'total-manufacture-ipc-'))
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
let chair = 0
const input = () => ({
  date: '2025-06-01', finishedItemId: chair, qtyMilli: 1000, saleRatePaise: 100000,
  raw: [{ stockItemId: steel, qtyMilli: 2000 }], labourPaise: 10000, labourPosted: true,
  profitPaise: 100000 - (50000 + 10000)
})

beforeAll(async () => {
  const { registerIpc } = await import('./ipc')
  registerIpc()
  const { slug } = await ok<{ slug: string }>('company:create', {
    name: 'IPC Manufacture Co', stateCode: '27', gstin: null, gstRegistrationType: 'regular', address: 'Pune',
    booksFrom: 2025, email: null, phone: null, pan: null, tan: null
  })
  await ok('company:open', { slug })
  const units = await ok<{ id: number }[]>('master:units:list')
  steel = (await ok<{ id: number }>('master:stockItems:create', { name: 'Steel Rod', unitId: units[0]!.id, openingQtyMilli: 10000, openingValue: 250000 })).id
  chair = (await ok<{ id: number }>('master:stockItems:create', { name: 'Chair', unitId: units[0]!.id })).id
})

describe('manufacture IPC', () => {
  it('previews, saves, reads back and lists', async () => {
    const preview = await ok<CostPreview>('manufacture:costPreview', { date: '2025-06-01', finishedItemId: chair, lines: [{ itemId: steel, qtyMilli: 2000 }] })
    expect(preview).toMatchObject({ totalPaise: 50000, saleRate: { ratePaise: null, source: null } })
    const saved = await ok<SaveManufactureResult>('manufacture:save', { data: input() })
    expect(saved.manufacture).toMatchObject({ finishedItemId: chair, profitPaise: 40000 })
    const rec = await ok<ManufactureRecord>('manufacture:get', { id: saved.id })
    expect(rec.details?.voucherId).toBe(saved.id)
    expect(rec.voucher.inventory).toHaveLength(2)
    expect(await ok<unknown[]>('manufacture:register', { from: '2025-04-01', to: '2026-03-31' })).toHaveLength(1)
    expect(await ok<unknown[]>('stock:movements', { stockItemId: chair, from: '2025-04-01', to: '2026-03-31' })).toHaveLength(1)
  })

  it('rejects malformed payloads and rule violations with an error envelope', async () => {
    for (const bad of [{ data: { ...input(), date: '1-6-25' } }, { data: { ...input(), qtyMilli: 1.5 } }, { data: input(), id: -1 }]) {
      const r = await call('manufacture:save', bad)
      expect(r.ok).toBe(false)
    }
    const mismatch = await call('manufacture:save', { data: { ...input(), profitPaise: 1 } })
    expect(mismatch).toMatchObject({ ok: false, error: expect.stringMatching(/Profit must equal/) })
    expect((await call('manufacture:costPreview', { date: 'x' })).ok).toBe(false)
  })

  it('viewer reads, cannot save', async () => {
    await ok('users:save', { data: { name: 'Olive', role: 'owner', pin: '1111' } })
    const viewer = await ok<{ id: number }>('users:save', { data: { name: 'Vik', role: 'viewer', pin: '2222' } })
    await ok('auth:logout')
    await ok('auth:login', { userId: viewer.id, pin: '2222' })
    expect((await call('manufacture:costPreview', { date: '2025-06-01', lines: [] })).ok).toBe(true)
    expect((await call('manufacture:register', { from: '2025-04-01', to: '2026-03-31' })).ok).toBe(true)
    const denied = await call('manufacture:save', { data: input() })
    expect(denied).toMatchObject({ ok: false, error: expect.stringMatching(/permission/) })
  })
})
