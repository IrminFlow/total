// WP 2.4 — the new manufacturing IPC channels end to end through registerIpc(): Zod parsing, the
// { ok, data | error } envelope, BOM versions / explode, by-products on manufacture:save, job-work
// challans and the reports. Electron is mocked the same way as stockVisibilityIpc.dbtest.ts.
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

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

process.env.TOTAL_DATA_DIR = mkdtempSync(join(tmpdir(), 'total-mfgdepth-ipc-'))
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
let offcut = 0
let sj = 0
let own = 0
let jw = 0

beforeAll(async () => {
  const { registerIpc } = await import('./ipc')
  registerIpc()
  const { slug } = await ok<{ slug: string }>('company:create', {
    name: 'IPC Manufacturing Co', stateCode: '27', gstin: null, gstRegistrationType: 'regular', address: 'Pune',
    booksFrom: 2025, email: null, phone: null, pan: null, tan: null
  })
  await ok('company:open', { slug })
  const units = await ok<{ id: number }[]>('master:units:list')
  const mk = async (name: string, q = 0, v = 0) =>
    (await ok<{ id: number }>('master:stockItems:create', { name, unitId: units[0]!.id, openingQtyMilli: q, openingValue: v })).id
  steel = await mk('Steel', 10000, 150000)
  chair = await mk('Chair')
  offcut = await mk('Offcut')
  sj = (await ok<{ id: number; kind: string }[]>('master:voucherTypes:list')).find((t) => t.kind === 'stock_journal')!.id
  const groups = await ok<{ id: number; name: string }[]>('master:groups:list')
  const party = await ok<{ id: number }>('master:ledgers:create', {
    name: 'Job Worker', groupId: groups.find((g) => g.name === 'Sundry Creditors')!.id, openingBalance: 0
  })
  own = (await ok<{ id: number }>('master:godowns:create', { name: 'Main' })).id
  jw = (await ok<{ id: number; kind: string }>('master:godowns:create', { name: 'JW', kind: 'job_worker', partyLedgerId: party.id })).id
})

describe('WP 2.4 IPC', () => {
  it('godowns carry kind + party ledger', async () => {
    const list = await ok<{ id: number; kind: string; partyLedgerId: number | null }[]>('master:godowns:list')
    expect(list.find((g) => g.id === jw)).toMatchObject({ kind: 'job_worker' })
    expect(list.find((g) => g.id === own)).toMatchObject({ kind: 'own', partyLedgerId: null })
    expect((await call('master:godowns:create', { name: 'Bad', kind: 'job_worker' })).error).toMatch(/party ledger/)
  })

  it('bom:saveVersion / bom:versions / bom:explode, and bom:get keeps working', async () => {
    const v = await ok<{ id: number; isDefault: boolean }>('bom:saveVersion', { itemId: chair, name: 'v1', lines: [{ componentId: steel, qtyMilliPerUnit: 2000, scrapPctBp: 500 }] })
    expect(v.isDefault).toBe(true)
    expect(await ok<unknown[]>('bom:versions', { itemId: chair })).toHaveLength(1)
    expect(await ok<{ ok: boolean; rows: unknown[] }>('bom:explode', { itemId: chair, qtyMilli: 2000, date: '2025-06-01', levels: 'full' })).toMatchObject({
      ok: true, rows: [{ componentId: steel, qtyMilli: 4200 }]
    })
    expect(await ok<{ componentId: number }[]>('bom:get', { itemId: chair })).toEqual([expect.objectContaining({ componentId: steel, qtyMilliPerUnit: 2000 })])
    expect((await call('bom:saveVersion', { itemId: chair, name: '', lines: [] })).ok).toBe(false)
  })

  it('manufacture:save with by-products → register / production / cost sheet / margin / variance', async () => {
    const versions = await ok<{ id: number }[]>('bom:versions', { itemId: chair })
    const saved = await ok<{ id: number; manufacture: { byProducts: unknown[] } }>('manufacture:save', {
      data: {
        date: '2025-06-10', finishedItemId: chair, qtyMilli: 2000, saleRatePaise: 100000, godownId: own,
        raw: [{ stockItemId: steel, qtyMilli: 4200 }], labourPaise: 1000, labourPosted: true, bomVersionId: versions[0]!.id,
        byProducts: [{ stockItemId: offcut, qtyMilli: 200, valuePaise: 3000, kind: 'scrap' }],
        profitPaise: 200000 - (63000 + 1000 - 3000)
      }
    })
    expect(saved.manufacture.byProducts).toHaveLength(1)
    const reg = await ok<{ productionCost: number; costAtSave: number }[]>('manufacture:register', { from: '2025-04-01', to: '2026-03-31' })
    expect(reg[0]).toMatchObject({ productionCost: 61000, costAtSave: 61000 })
    expect((await ok<{ byProductPaise: number }[]>('manufacture:production', { from: '2025-04-01', to: '2026-03-31' }))[0]).toMatchObject({ byProductPaise: 3000 })
    expect((await ok<{ average: { unitCostPaise: number } }>('manufacture:costSheet', { from: '2025-04-01', to: '2026-03-31', itemId: chair })).average.unitCostPaise).toBe(30500)
    expect(await ok<unknown[]>('manufacture:margin', { from: '2025-04-01', to: '2026-03-31' })).toHaveLength(1)
    const variance = await ok<{ qtyVarianceMilli: number }[]>('manufacture:variance', { from: '2025-04-01', to: '2026-03-31' })
    expect(variance.map((r) => r.qtyVarianceMilli)).toEqual([0])
    expect((await call('manufacture:costSheet', { from: '2025-04-01', to: '2026-03-31' })).ok).toBe(false)
  })

  it('jobWork:saveChallan / get / sendChallans / pending / itc04', async () => {
    const send = await ok<{ id: number }>('jobWork:saveChallan', {
      voucher: {
        voucherTypeId: sj, date: '2025-06-15', lines: [],
        inventory: [
          { stockItemId: steel, godownId: own, qtyMilli: 1000, ratePaise: 15000, amount: 15000, direction: 'out' },
          { stockItemId: steel, godownId: jw, qtyMilli: 1000, ratePaise: 15000, amount: 15000, direction: 'in' }
        ]
      },
      challan: { kind: 'send', godownId: jw, natureOfProcessing: 'Cutting' }
    })
    expect(await ok('jobWork:get', { id: send.id })).toMatchObject({ kind: 'send', godownId: jw, natureOfProcessing: 'Cutting', goodsType: 'inputs' })
    expect(await ok<unknown[]>('jobWork:sendChallans', { id: jw })).toHaveLength(1)
    const pending = await ok<{ qtyMilli: number }[]>('jobWork:pending', { asOn: '2025-06-30' })
    expect(pending.map((r) => r.qtyMilli)).toEqual([1000])
    const itc = await ok<{ sent: unknown[] }>('jobWork:itc04', { from: '2025-04-01', to: '2026-03-31' })
    expect(itc.sent).toHaveLength(1)
    expect((await call('jobWork:saveChallan', { voucher: {}, challan: { kind: 'receive', godownId: jw } })).ok).toBe(false)
  })
})
