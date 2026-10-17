import { describe, expect, it } from 'vitest'
import { checkSender, firstRefusalOf, isTrustedRendererUrl } from './ipcSender'

const FILE = 'file:///Applications/Total.app/Contents/Resources/app.asar/out/renderer/index.html'
const T = { fileUrl: FILE }
const mainEvent = (url: string) => {
  const f = { url, parent: null, processId: 1, routingId: 2 }
  return { senderFrame: f, sender: { id: 1, mainFrame: f } }
}

describe('isTrustedRendererUrl', () => {
  it('accepts the renderer page, ignoring query and hash', () => {
    expect(isTrustedRendererUrl(FILE, T, 'darwin')).toBe(true)
    expect(isTrustedRendererUrl(`${FILE}?x=1#/home`, T, 'darwin')).toBe(true)
  })
  it('handles encoded paths (spaces)', () => {
    const t = { fileUrl: 'file:///Users/a%20b/total/out/renderer/index.html' }
    expect(isTrustedRendererUrl('file:///Users/a%20b/total/out/renderer/index.html', t, 'darwin')).toBe(true)
  })
  it('refuses other files, hosts and schemes', () => {
    for (const u of [
      'file:///Applications/Total.app/Contents/Resources/app.asar/out/renderer/other.html',
      'file:///tmp/index.html',
      'file://evil.host/Applications/Total.app/Contents/Resources/app.asar/out/renderer/index.html',
      'https://evil.example/out/renderer/index.html',
      'data:text/html,hi',
      'about:blank',
      '',
      42
    ]) expect(isTrustedRendererUrl(u, T, 'darwin'), String(u)).toBe(false)
  })
  it('nothing is trusted until configured', () => {
    expect(isTrustedRendererUrl(FILE, null, 'darwin')).toBe(false)
  })
  it('dev: the dev server origin only', () => {
    const dev = { fileUrl: FILE, devOrigin: 'http://localhost:5173' }
    expect(isTrustedRendererUrl('http://localhost:5173/', dev, 'darwin')).toBe(true)
    expect(isTrustedRendererUrl('http://localhost:5173/src/x?y', dev, 'darwin')).toBe(true)
    expect(isTrustedRendererUrl('http://localhost:5174/', dev, 'darwin')).toBe(false)
    expect(isTrustedRendererUrl('http://127.0.0.1:5173/', dev, 'darwin')).toBe(false)
    expect(isTrustedRendererUrl('http://localhost:5173/', T, 'darwin')).toBe(false)
  })
})

describe('checkSender', () => {
  it('main frame of the renderer page = ok', () => {
    expect(checkSender(mainEvent(FILE), T, 'darwin')).toEqual({ ok: true })
  })
  it('matching ids count as the main frame (a fresh wrapper object)', () => {
    const e = { senderFrame: { url: FILE, parent: null, processId: 1, routingId: 2 }, sender: { mainFrame: { url: FILE, parent: null, processId: 1, routingId: 2 } } }
    expect(checkSender(e, T, 'darwin').ok).toBe(true)
  })
  it('refuses a missing frame, a child frame, a frame that is not the sender main frame, a foreign URL', () => {
    expect(checkSender({}, T, 'darwin')).toEqual({ ok: false, reason: 'no_frame' })
    expect(checkSender(null, T, 'darwin')).toEqual({ ok: false, reason: 'no_frame' })
    const main = { url: FILE, parent: null, processId: 1, routingId: 2 }
    expect(checkSender({ senderFrame: { url: FILE, parent: main, processId: 1, routingId: 3 }, sender: { mainFrame: main } }, T, 'darwin')).toEqual({ ok: false, reason: 'child_frame' })
    expect(checkSender({ senderFrame: { url: FILE, parent: null, processId: 1, routingId: 3 }, sender: { mainFrame: main } }, T, 'darwin')).toEqual({ ok: false, reason: 'child_frame' })
    expect(checkSender({ senderFrame: { url: FILE, parent: null }, sender: {} }, T, 'darwin')).toEqual({ ok: false, reason: 'child_frame' })
    expect(checkSender(mainEvent('https://evil.example/'), T, 'darwin')).toEqual({ ok: false, reason: 'foreign_url' })
  })
})

describe('a disposed frame', () => {
  it('is refused, never thrown (Electron throws on every property of a disposed WebFrameMain)', () => {
    const disposed = new Proxy({}, { get: () => { throw new Error('Render frame was disposed before WebFrameMain could be accessed') } })
    const t = { fileUrl: 'file:///app/out/renderer/index.html' }
    expect(checkSender({ senderFrame: disposed, sender: { id: 1, mainFrame: disposed } }, t)).toEqual({ ok: false, reason: 'no_frame' })
    expect(firstRefusalOf({ senderFrame: disposed, sender: { id: 1 } }, 'no_frame').first).toBe(true)
  })
})
