// D7 Electron hardening: every IPC call must come from the app's own renderer — the main frame of
// a window showing out/renderer/index.html (production, file://) or the dev server's origin (dev).
// A child frame, a webview or any other page (there are none, but the check must hold) is refused
// with `not_permitted` BEFORE the payload is parsed, and logged once per sender.
// Pure: no Electron import, so the rule is unit-tested (ipcSender.test.ts) and the dbtests use the
// trusted shim in ipcSender.testutil.ts.
import { fileURLToPath } from 'url'

/** Where the renderer is loaded from: its file:// URL, or the dev server origin (dev only). */
export interface TrustedRenderer {
  fileUrl?: string
  devOrigin?: string
}

/** The shape of an IpcMainInvokeEvent this check reads (WebFrameMain / WebContents fields). */
export interface SenderFrameLike {
  url?: string
  parent?: unknown
  processId?: number
  routingId?: number
}
export interface IpcEventLike {
  senderFrame?: SenderFrameLike | null
  sender?: { id?: number; mainFrame?: SenderFrameLike | null } | null
}

let trusted: TrustedRenderer | null = null

/** Set once by main/index.ts before any window loads (and by the test shim). Unset = refuse all. */
export function configureTrustedRenderer(t: TrustedRenderer | null): void {
  trusted = t
}

function filePath(url: string, platform: string): string | null {
  try {
    const u = new URL(url)
    if (u.protocol !== 'file:' || (u.host && u.host !== 'localhost')) return null
    u.search = ''
    u.hash = ''
    const p = fileURLToPath(u.href)
    return platform === 'win32' ? p.toLowerCase().replace(/\//g, '\\') : p
  } catch {
    return null
  }
}

/** True when `url` is the trusted renderer page (query / hash ignored). */
export function isTrustedRendererUrl(url: unknown, t: TrustedRenderer | null = trusted, platform: string = process.platform): boolean {
  if (!t || typeof url !== 'string' || !url) return false
  if (t.fileUrl) {
    const want = filePath(t.fileUrl, platform)
    const got = filePath(url, platform)
    if (want && got && want === got) return true
  }
  if (t.devOrigin) {
    try {
      const u = new URL(url)
      const d = new URL(t.devOrigin)
      if ((u.protocol === 'http:' || u.protocol === 'https:') && u.origin === d.origin) return true
    } catch {
      return false
    }
  }
  return false
}

/** True when the frame is its window's main frame (no parent, and the sender's own main frame). */
function isMainFrame(event: IpcEventLike): boolean {
  const frame = event.senderFrame
  if (!frame) return false
  if (frame.parent != null) return false
  const main = event.sender?.mainFrame
  if (!main) return false
  if (main === frame) return true
  return typeof frame.processId === 'number' && frame.processId === main.processId && typeof frame.routingId === 'number' && frame.routingId === main.routingId
}

export type SenderVerdict = { ok: true } | { ok: false; reason: 'no_frame' | 'child_frame' | 'foreign_url' }

/** The whole rule: a main frame showing the trusted renderer page. */
export function checkSender(event: unknown, t: TrustedRenderer | null = trusted, platform: string = process.platform): SenderVerdict {
  const e = (event ?? {}) as IpcEventLike
  // A WebFrameMain disposed between the event and this check throws on every property read
  // (Electron: "Render frame was disposed before WebFrameMain could be accessed") — refuse, never throw.
  try {
    if (!e.senderFrame) return { ok: false, reason: 'no_frame' }
    if (!isMainFrame(e)) return { ok: false, reason: 'child_frame' }
    if (!isTrustedRendererUrl(e.senderFrame.url, t, platform)) return { ok: false, reason: 'foreign_url' }
    return { ok: true }
  } catch {
    return { ok: false, reason: 'no_frame' }
  }
}

const logged = new Set<string>()

/** A key for "once per sender": the web contents + what the frame showed (scheme + host only —
 *  never a full URL, which could carry a path or query). Returns true the first time. */
export function firstRefusalOf(event: unknown, reason: string): { first: boolean; scheme: string; host: string; senderId: number | null } {
  const e = (event ?? {}) as IpcEventLike
  let scheme = ''
  let host = ''
  try {
    const u = new URL(String(e.senderFrame?.url ?? ''))
    scheme = u.protocol.replace(/:$/, '').slice(0, 16)
    host = u.host.slice(0, 64)
  } catch {
    // no / unreadable URL
  }
  const senderId = typeof e.sender?.id === 'number' ? e.sender.id : null
  const key = `${senderId ?? '-'}|${reason}|${scheme}|${host}`
  const first = !logged.has(key)
  if (first) {
    if (logged.size > 1000) logged.clear()
    logged.add(key)
  }
  return { first, scheme, host, senderId }
}
