import { describe, expect, it } from 'vitest'
import { tmpdir } from 'os'
import { join } from 'path'
import { pathToFileURL } from 'url'
import { checkSender, isTrustedRendererUrl } from './ipcSender'

// Fixtures are built the way main/index.ts builds the trusted URL (pathToFileURL of a real path), so
// they are valid on every platform — `file:///C:/…` on Windows, `file:///…` elsewhere.
const P = process.platform
const fileUrl = (...parts: string[]): string => pathToFileURL(join(tmpdir(), ...parts)).href
const FILE = fileUrl('Total', 'resources', 'app.asar', 'out', 'renderer', 'index.html')
const T = { fileUrl: FILE }
const mainEvent = (url: string) => {
  const f = { url, parent: null, processId: 1, routingId: 2 }
  return { senderFrame: f, sender: { id: 1, mainFrame: f } }
}

describe('isTrustedRendererUrl', () => {
  it('accepts the renderer page, ignoring query and hash', () => {
    expect(isTrustedRendererUrl(FILE, T, P)).toBe(true)
    expect(isTrustedRendererUrl(`${FILE}?x=1#/home`, T, P)).toBe(true)
  })
  it('handles encoded paths (spaces)', () => {
    const spaced = fileUrl('My Books', 'out', 'renderer', 'index.html')
    expect(spaced).toMatch(/My%20Books/)
    expect(isTrustedRendererUrl(spaced, { fileUrl: spaced }, P)).toBe(true)
    expect(isTrustedRendererUrl(fileUrl('My Books', 'out', 'renderer', 'index.html'), { fileUrl: spaced }, P)).toBe(true)
  })
  it('refuses other files, hosts and schemes', () => {
    for (const u of [
      fileUrl('Total', 'resources', 'app.asar', 'out', 'renderer', 'other.html'),
      fileUrl('index.html'),
      FILE.replace('file:///', 'file://evil.host/'),
      'https://evil.example/out/renderer/index.html',
      'data:text/html,hi',
      'about:blank',
      '',
      42
    ]) expect(isTrustedRendererUrl(u, T, P), String(u)).toBe(false)
  })
  it('nothing is trusted until configured', () => {
    expect(isTrustedRendererUrl(FILE, null, P)).toBe(false)
  })
  it('dev: the dev server origin only', () => {
    const dev = { fileUrl: FILE, devOrigin: 'http://localhost:5173' }
    expect(isTrustedRendererUrl('http://localhost:5173/', dev, P)).toBe(true)
    expect(isTrustedRendererUrl('http://localhost:5173/src/x?y', dev, P)).toBe(true)
    expect(isTrustedRendererUrl('http://localhost:5174/', dev, P)).toBe(false)
    expect(isTrustedRendererUrl('http://127.0.0.1:5173/', dev, P)).toBe(false)
    expect(isTrustedRendererUrl('http://localhost:5173/', T, P)).toBe(false)
  })
})

describe.runIf(process.platform === 'win32')('win32: Chromium-shaped URLs', () => {
  // What pathToFileURL gives for C:\Program Files\Total\resources\app.asar\out\renderer\index.html,
  // and how Chromium may report the same page (drive letter / name case differ).
  const TRUSTED = 'file:///C:/Program%20Files/Total/resources/app.asar/out/renderer/index.html'
  it('matches case-insensitively, ignoring query and hash', () => {
    expect(isTrustedRendererUrl('file:///c:/program%20files/total/resources/app.asar/out/renderer/INDEX.html#/x', { fileUrl: TRUSTED }, 'win32')).toBe(true)
  })
  it('refuses a POSIX-style file URL (no drive letter) and another drive', () => {
    expect(isTrustedRendererUrl('file:///Program%20Files/Total/resources/app.asar/out/renderer/index.html', { fileUrl: TRUSTED }, 'win32')).toBe(false)
    expect(isTrustedRendererUrl('file:///D:/Program%20Files/Total/resources/app.asar/out/renderer/index.html', { fileUrl: TRUSTED }, 'win32')).toBe(false)
  })
})

describe.runIf(process.platform !== 'win32')('POSIX: names are case-sensitive', () => {
  it('a different case is another file', () => {
    expect(isTrustedRendererUrl(FILE.replace(/index\.html$/, 'INDEX.html'), T, P)).toBe(false)
  })
})

describe('checkSender', () => {
  it('main frame of the renderer page = ok', () => {
    expect(checkSender(mainEvent(FILE), T, P)).toEqual({ ok: true })
  })
  it('matching ids count as the main frame (a fresh wrapper object)', () => {
    const e = { senderFrame: { url: FILE, parent: null, processId: 1, routingId: 2 }, sender: { mainFrame: { url: FILE, parent: null, processId: 1, routingId: 2 } } }
    expect(checkSender(e, T, P).ok).toBe(true)
  })
  it('refuses a missing frame, a child frame, a frame that is not the sender main frame, a foreign URL', () => {
    expect(checkSender({}, T, P)).toEqual({ ok: false, reason: 'no_frame' })
    expect(checkSender(null, T, P)).toEqual({ ok: false, reason: 'no_frame' })
    const main = { url: FILE, parent: null, processId: 1, routingId: 2 }
    expect(checkSender({ senderFrame: { url: FILE, parent: main, processId: 1, routingId: 3 }, sender: { mainFrame: main } }, T, P)).toEqual({ ok: false, reason: 'child_frame' })
    expect(checkSender({ senderFrame: { url: FILE, parent: null, processId: 1, routingId: 3 }, sender: { mainFrame: main } }, T, P)).toEqual({ ok: false, reason: 'child_frame' })
    expect(checkSender({ senderFrame: { url: FILE, parent: null }, sender: {} }, T, P)).toEqual({ ok: false, reason: 'child_frame' })
    expect(checkSender(mainEvent('https://evil.example/'), T, P)).toEqual({ ok: false, reason: 'foreign_url' })
  })
})
