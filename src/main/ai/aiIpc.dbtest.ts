// WP 5.1 through the real IPC registration (registerIpc, Electron mocked, TOTAL_AI_MOCK demo
// provider): a draft consumed by voucher:save, a re-save of a used draft, thread delete and
// "Delete all AI data" (audited), and the company closing in the middle of an answer.
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import Database from 'better-sqlite3'
import type { AiEvent } from '@shared/ai'

const handlers = new Map<string, (event: unknown, payload: unknown) => Promise<{ ok: boolean; data?: unknown; error?: string }>>()
const events: AiEvent[] = []

vi.mock('electron', () => ({
  app: { getVersion: () => '0.7.0-test', getPath: () => tmpdir(), isPackaged: false, on: () => {} },
  ipcMain: { handle: (ch: string, fn: (e: unknown, p: unknown) => Promise<{ ok: boolean }>) => handlers.set(ch.replace(/^total:/, ''), fn) },
  dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
  shell: { openPath: async () => '', showItemInFolder: () => {} },
  Notification: class {},
  BrowserWindow: { getAllWindows: () => [{ isDestroyed: () => false, webContents: { send: (_ch: string, e: AiEvent) => events.push(e) } }] },
  safeStorage: { isEncryptionAvailable: () => false }
}))
vi.mock('../updater', () => ({ checkForUpdatesInteractive: async () => null }))

const DATA_DIR = mkdtempSync(join(tmpdir(), 'total-ai-ipc-'))
process.env.TOTAL_DATA_DIR = DATA_DIR
process.env.TOTAL_SUPPRESS_SYNC_WARNING = '1'
process.env.TOTAL_AI_MOCK = '1'

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
const until = async (pred: () => boolean, ms = 5000): Promise<void> => {
  const t0 = Date.now()
  while (!pred()) {
    if (Date.now() - t0 > ms) throw new Error('timed out')
    await new Promise((r) => setTimeout(r, 10))
  }
}

let ipc: typeof import('../ipc')
let aiIpc: typeof import('./ipc')
let slug = ''
const companyDb = (): Database.Database => new Database(join(DATA_DIR, 'companies', slug, 'company.db'), { readonly: true })
const audit = (entity: string): { action: string; after_json: string | null }[] => {
  const db = companyDb()
  try {
    return db.prepare('SELECT action, after_json FROM audit_log WHERE entity = ? ORDER BY id').all(entity) as { action: string; after_json: string | null }[]
  } finally {
    db.close()
  }
}

interface Draft { id: number; status: string; voucherId: number | null; payload: { voucherTypeId: number; date: string; narration: string | null; lines: { ledgerId: number; drCr: 'dr' | 'cr'; amount: number }[] } }

const voucherFrom = (d: Draft): unknown => ({
  voucherTypeId: d.payload.voucherTypeId, date: d.payload.date, partyLedgerId: null, narration: d.payload.narration, reference: null,
  lines: d.payload.lines.map((l) => ({ ...l, costAllocations: [] })), inventory: [], billRefs: [], tds: null
})

beforeAll(async () => {
  ipc = await import('../ipc')
  aiIpc = await import('./ipc')
  ipc.registerIpc()
  const created = await ok<{ slug: string }>('company:create', {
    name: 'AI IPC Co', stateCode: '27', gstin: null, gstRegistrationType: 'regular', address: 'Pune', booksFrom: 2025, email: null, phone: null, pan: null, tan: null
  })
  slug = created.slug
  await ok('company:open', { slug })
  const groups = await ok<{ id: number; name: string }[]>('master:groups:list')
  const gid = (n: string): number => groups.find((g) => g.name === n)!.id
  const mk = (name: string, group: string): Promise<{ id: number }> =>
    ok('master:ledgers:create', { name, groupId: gid(group), openingBalance: 0, gstin: null, stateCode: null, address: null, taxType: null, gstRate: null, hsn: null, tdsSectionId: null, pan: null, creditDays: null, exportType: null })
  await mk('Shop Rent', 'Indirect Expenses')
  await mk('Sales', 'Sales Accounts')
  await ok('ai:notice:accept')
  await ok('ai:settings:set', { enabled: true })
})

describe('AI through the real IPC', () => {
  it('the demo provider is in use and ready without a key', async () => {
    expect(await ok('ai:settings:get')).toMatchObject({ mock: true, ready: true, keyPresent: false })
  })

  it('voucher:save with aiDraftId consumes the draft; saving with a used draft still saves and records it', async () => {
    const sent = await ok<{ threadId: number; runId: string }>('ai:send', { text: 'Pay 1,500 shop rent in cash' })
    await until(() => events.some((e) => e.runId === sent.runId && (e.type === 'done' || e.type === 'error')))
    expect(events.filter((e) => e.runId === sent.runId).at(-1)!.type).toBe('done')
    const [draft] = await ok<Draft[]>('ai:drafts', { status: 'open' })
    expect(draft).toBeTruthy()

    const saved = await ok<{ id: number }>('voucher:save', { data: voucherFrom(draft!), aiDraftId: draft!.id })
    expect(await ok('ai:draft:get', { id: draft!.id })).toMatchObject({ status: 'consumed', voucherId: saved.id })
    expect(audit('ai_draft').map((r) => r.action)).toEqual(['create', 'update'])

    // the same draft again (e.g. two windows): the voucher saves; the trail notes the draft was used
    const again = await ok<{ id: number }>('voucher:save', { data: voucherFrom(draft!), aiDraftId: draft!.id })
    expect(again.id).not.toBe(saved.id)
    expect(audit('ai_draft').at(-1)!.after_json).toContain('draft no longer open (consumed)')
    expect(await ok('ai:draft:get', { id: draft!.id })).toMatchObject({ voucherId: saved.id })
  })

  it('deleting a thread and all AI data is audited; vouchers stay', async () => {
    const threads = await ok<{ id: number }[]>('ai:threads')
    await ok('ai:thread:delete', { id: threads[0]!.id })
    expect(audit('ai_thread').map((r) => r.action)).toEqual(['delete'])
    await ok('ai:send', { text: 'What were sales in July?' })
    await until(() => events.at(-1)?.type === 'done')
    const counts = await ok<{ threads: number; drafts: number }>('ai:data:deleteAll')
    expect(counts.threads).toBe(1)
    expect(audit('ai_data').map((r) => r.action)).toEqual(['delete'])
    expect(await ok('ai:threads')).toEqual([])
    const vouchers = await ok<unknown[]>('voucher:list', { from: '2025-04-01', to: '2030-03-31' })
    expect(vouchers.length).toBe(2)
  })

  it('closing the company mid-answer stops the run cleanly', async () => {
    const before = events.length
    const sent = await ok<{ runId: string }>('ai:send', { text: 'What were sales in July?' })
    await ok('company:close')
    await until(() => events.slice(before).some((e) => e.runId === sent.runId && (e.type === 'cancelled' || e.type === 'error' || e.type === 'done')))
    await until(() => aiIpc.aiRuns.size === 0)
    const last = events.slice(before).filter((e) => e.runId === sent.runId).at(-1)!
    expect(['cancelled', 'error']).toContain(last.type)
    // the company reopens fine, nothing half-written blocks it
    await ok('company:open', { slug })
    expect((await ok<unknown[]>('ai:threads')).length).toBe(1)
  })
})
