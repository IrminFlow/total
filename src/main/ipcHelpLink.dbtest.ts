// WP 10.3 review: `help:openLink` is the help panel's only way to the system browser. Main checks
// the allow-list itself (the renderer's check is not trusted): exact GST portal / CBIC hosts over
// https, a strict { url } payload, and the browser is handed the parser's normalised URL.
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const handlers = new Map<string, (event: unknown, payload: unknown) => Promise<{ ok: boolean; data?: unknown; error?: string }>>()
const opened: string[] = []

vi.mock('electron', () => ({
  app: { getVersion: () => '0.11.0-test', getPath: () => tmpdir(), isPackaged: false, on: () => {} },
  ipcMain: { handle: (ch: string, fn: (e: unknown, p: unknown) => Promise<{ ok: boolean }>) => handlers.set(ch.replace(/^total:/, ''), fn) },
  dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
  shell: { openPath: async () => '', showItemInFolder: () => {}, openExternal: async (u: string) => void opened.push(u) },
  Notification: class {},
  BrowserWindow: class {},
  safeStorage: { isEncryptionAvailable: () => false }
}))
vi.mock('./updater', () => ({ checkForUpdatesInteractive: async () => null }))

process.env.TOTAL_DATA_DIR = mkdtempSync(join(tmpdir(), 'total-help-link-'))
process.env.TOTAL_SUPPRESS_SYNC_WARNING = '1'

const call = (payload: unknown): Promise<{ ok: boolean; error?: string }> => handlers.get('help:openLink')!({}, payload)

beforeAll(async () => {
  const ipc = await import('./ipc')
  ipc.registerIpc()
})
beforeEach(() => {
  opened.length = 0
})

describe('help:openLink (main-side allow-list)', () => {
  it('opens an allowed page, normalised', async () => {
    expect((await call({ url: 'https://WWW.gst.gov.in' })).ok).toBe(true)
    expect(opened).toEqual(['https://www.gst.gov.in/'])
  })

  it('refuses anything else and never reaches the browser', async () => {
    for (const url of [
      'https://gst.gov.in.evil.com', 'https://evil.gst.gov.in/', 'https://user@gst.gov.in', 'http://www.gst.gov.in',
      'javascript:alert(1)', 'file:///etc/passwd', 'https://example.com', 'https://evil.com\\@gst.gov.in'
    ]) {
      const r = await call({ url })
      expect(r.ok, url).toBe(false)
    }
    // Strict payload: no extra keys, a string url of bounded length.
    expect((await call({ url: 'https://www.gst.gov.in', target: '_blank' })).ok).toBe(false)
    expect((await call({ url: 42 })).ok).toBe(false)
    expect((await call({ url: `https://www.gst.gov.in/${'a'.repeat(600)}` })).ok).toBe(false)
    expect(opened).toEqual([])
  })
})
