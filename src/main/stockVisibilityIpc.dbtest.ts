// WP 2.3 — the stock visibility IPC channels end to end through registerIpc(): Zod parsing, the
// { ok, data | error } envelope, serials on voucher:save, and the viewer role gate. Electron is
// mocked the same way as stockCostIpc.dbtest.ts.
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { StockMovementRegister, ReorderRow, SerialListRow } from '@shared/stockPlanning'

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

process.env.TOTAL_DATA_DIR = mkdtempSync(join(tmpdir(), 'total-stockvis-ipc-'))
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

let phone = 0
let stockJournal = 0

beforeAll(async () => {
  const { registerIpc } = await import('./ipc')
  registerIpc()
  const { slug } = await ok<{ slug: string }>('company:create', {
    name: 'IPC Stock Visibility Co', stateCode: '27', gstin: null, gstRegistrationType: 'regular', address: 'Pune',
    booksFrom: 2025, email: null, phone: null, pan: null, tan: null
  })
  await ok('company:open', { slug })
  const units = await ok<{ id: number }[]>('master:units:list')
  phone = (await ok<{ id: number }>('master:stockItems:create', {
    name: 'Phone', unitId: units[0]!.id, reorderLevelMilli: 5000, barcode: 'PH-1', trackSerials: true
  })).id
  const types = await ok<{ id: number; kind: string }[]>('master:voucherTypes:list')
  stockJournal = types.find((t) => t.kind === 'stock_journal')!.id
  await ok('voucher:save', {
    data: {
      voucherTypeId: stockJournal, date: '2025-06-01', lines: [],
      inventory: [{ stockItemId: phone, godownId: null, qtyMilli: 2000, ratePaise: 500_000, amount: 1_000_000, direction: 'in', serials: ['A', 'B'] }]
    }
  })
})

describe('stock visibility IPC', () => {
  it('stock:register, stock:reorder, stock:expiryReport, serials:* answer', async () => {
    const reg = await ok<StockMovementRegister>('stock:register', { itemId: phone, from: '2025-04-01', to: '2026-03-31' })
    expect(reg.closing).toEqual({ qtyMilli: 2000, value: 1_000_000 })
    expect(reg.rows[0]!.serials).toEqual(['A', 'B'])
    const reorder = await ok<ReorderRow[]>('stock:reorder', { from: '2025-04-01', to: '2026-03-31' })
    expect(reorder).toEqual([expect.objectContaining({ stockItemId: phone, suggestedMilli: 8000 })])
    expect(await ok('stock:expiryReport', { asOn: '2025-06-30', withinDays: 30 })).toEqual([])
    const serials = await ok<SerialListRow[]>('serials:list', { stockItemId: phone })
    expect(serials.map((s) => [s.serial, s.status])).toEqual([['A', 'in_stock'], ['B', 'in_stock']])
    expect(await ok('serials:available', { stockItemId: phone })).toEqual(['A', 'B'])
    const { html } = await ok<{ html: string }>('stock:labelsHtml', { items: [{ itemId: phone, copies: 2 }], date: '2025-06-01' })
    expect(html.match(/<svg /g)).toHaveLength(2)
    expect(html).toContain('IPC Stock Visibility Co')
  })

  it('voucher:save enforces the serial rules', async () => {
    const r = await call('voucher:save', {
      data: { voucherTypeId: stockJournal, date: '2025-06-02', lines: [], inventory: [{ stockItemId: phone, godownId: null, qtyMilli: 1000, ratePaise: 0, amount: 0, direction: 'out', serials: ['Z'] }] }
    })
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/serial Z is not in stock/)
  })

  it('rejects malformed payloads with a Zod error', async () => {
    const bad: [string, unknown][] = [
      ['stock:register', { itemId: phone, from: '2025-04-01' }],
      ['stock:register', { itemId: -1, from: '2025-04-01', to: '2026-03-31' }],
      ['stock:reorder', { from: 'x', to: '2026-03-31' }],
      ['stock:expiryReport', { asOn: '2025-06-30', withinDays: -1 }],
      ['stock:labelsHtml', { items: [], date: '2025-06-01' }],
      ['serials:list', { status: 'lost' }],
      ['serials:available', {}]
    ]
    for (const [channel, payload] of bad) {
      const r = await call(channel, payload)
      expect(r.ok, channel).toBe(false)
    }
  })

  it('reports are readable by a viewer', async () => {
    await ok('users:save', { data: { name: 'Olive', role: 'owner', pin: '1111' } })
    const viewer = await ok<{ id: number }>('users:save', { data: { name: 'Vik', role: 'viewer', pin: '2222' } })
    await ok('auth:logout')
    await ok('auth:login', { userId: viewer.id, pin: '2222' })
    expect((await call('stock:register', { itemId: phone, from: '2025-04-01', to: '2026-03-31' })).ok).toBe(true)
    expect((await call('serials:list', {})).ok).toBe(true)
    expect((await call('stock:reorder', { from: '2025-04-01', to: '2026-03-31' })).ok).toBe(true)
    const denied = await call('voucher:save', { data: { voucherTypeId: stockJournal, date: '2025-06-03', lines: [], inventory: [] } })
    expect(denied.ok).toBe(false)
    expect(denied.error).toMatch(/permission/)
  })
})
