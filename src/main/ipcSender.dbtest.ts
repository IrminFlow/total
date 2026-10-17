// D7 Electron hardening: handle() answers only the app's own renderer. A call from a foreign page,
// a child frame or a frame-less event is refused with not_permitted BEFORE the payload is parsed
// (an invalid payload still says not_permitted, a valid one never reaches the service), for every
// registered channel, and each refusing sender is logged once.
import { TRUSTED_EVENT, TEST_RENDERER_URL } from './ipcSender.testutil'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

type Result = { ok: boolean; data?: unknown; error?: string; code?: string }
const handlers = new Map<string, (event: unknown, payload: unknown) => Promise<Result>>()
const opened: string[] = []
const logs = vi.hoisted(() => [] as { level: string; event: string; data?: Record<string, unknown> }[])

vi.mock('electron', () => ({
  app: { getVersion: () => '0.12.0-test', getPath: () => tmpdir(), isPackaged: false, on: () => {} },
  ipcMain: { handle: (ch: string, fn: (e: unknown, p: unknown) => Promise<Result>) => handlers.set(ch.replace(/^total:/, ''), fn) },
  dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }), showSaveDialog: async () => ({ canceled: true }) },
  shell: { openPath: async () => '', showItemInFolder: () => {}, openExternal: async (u: string) => void opened.push(u) },
  Notification: class {},
  BrowserWindow: { getAllWindows: () => [] },
  safeStorage: { isEncryptionAvailable: () => false }
}))
vi.mock('./updater', () => ({ checkForUpdatesInteractive: async () => null }))
vi.mock('./log', () => ({
  log: (level: string, event: string, data?: Record<string, unknown>) => void logs.push({ level, event, data }),
  logsDir: () => tmpdir(),
  initLogging: () => {},
  revealLogs: () => {}
}))

process.env.TOTAL_DATA_DIR = mkdtempSync(join(tmpdir(), 'total-ipc-sender-'))
process.env.TOTAL_SUPPRESS_SYNC_WARNING = '1'
process.env.TOTAL_INSECURE_TEST_SECRETS = '1'

// WP 7.3: import at collection, never inside the hook.
const ipc = await import('./ipc')
beforeAll(() => ipc.registerIpc())

const frame = (url: string, parent: unknown = null) => ({ url, parent, processId: 7, routingId: 9 })
const eventFrom = (url: string, id = 42) => {
  const f = frame(url)
  return { senderFrame: f, sender: { id, mainFrame: f } }
}
const childFrameEvent = () => {
  const main = frame(TEST_RENDERER_URL)
  const child = { ...frame(TEST_RENDERER_URL, main), routingId: 10 }
  return { senderFrame: child, sender: { id: 43, mainFrame: main } }
}
const call = (ch: string, event: unknown, payload?: unknown) => handlers.get(ch)!(event, payload)
const refusalsLogged = () => logs.filter((l) => l.event === 'ipc-sender-refused')

describe('IPC sender validation', () => {
  it('the trusted renderer main frame is answered', async () => {
    expect((await call('company:list', TRUSTED_EVENT)).ok).toBe(true)
    expect((await call('help:openLink', TRUSTED_EVENT, { url: 'https://www.gst.gov.in' })).ok).toBe(true)
    expect(opened).toEqual(['https://www.gst.gov.in/'])
    opened.length = 0
  })

  it('a foreign page is refused with not_permitted before Zod, and the service never runs', async () => {
    const foreign = eventFrom('https://evil.example/index.html')
    const good = await call('help:openLink', foreign, { url: 'https://www.gst.gov.in' })
    expect(good).toEqual({ ok: false, error: 'You do not have permission to do that', code: 'not_permitted' })
    // an invalid payload: still not_permitted (a Zod failure would say invalid_input)
    const bad = await call('help:openLink', foreign, { url: 42, extra: true })
    expect(bad.code).toBe('not_permitted')
    expect(opened).toEqual([])
  })

  it('every registered channel refuses a foreign frame, a child frame and a frame-less event', async () => {
    const leaked: string[] = []
    const senders = [
      eventFrom(TEST_RENDERER_URL.replace(/\/out\/renderer\/index\.html$/, '/other/index.html'), 50),
      eventFrom(TEST_RENDERER_URL.replace(/index\.html$/, 'other.html'), 51),
      eventFrom('http://localhost:5173/', 52),
      childFrameEvent(),
      {},
      { senderFrame: null, sender: { id: 53 } }
    ]
    for (const ch of [...ipc.CHANNEL_ROLES.keys()]) {
      for (const ev of senders) {
        const r = await call(ch, ev, undefined)
        if (r.ok || r.code !== 'not_permitted') leaked.push(ch)
      }
    }
    expect(leaked).toEqual([])
    expect(ipc.CHANNEL_ROLES.size).toBeGreaterThan(300)
  })

  it('each refusing sender is logged once, without the URL path', async () => {
    logs.length = 0
    const ev = eventFrom('https://once.example/some/secret/path?q=1', 77)
    for (let i = 0; i < 5; i++) await call('company:list', ev)
    await call('company:current', ev)
    const mine = refusalsLogged().filter((l) => l.data?.senderId === 77)
    expect(mine).toHaveLength(1)
    expect(mine[0]?.data).toMatchObject({ reason: 'foreign_url', scheme: 'https', host: 'once.example' })
    expect(JSON.stringify(mine[0]?.data)).not.toMatch(/secret|q=1/)
  })
})
