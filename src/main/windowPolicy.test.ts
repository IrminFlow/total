import { describe, expect, it } from 'vitest'
import { applyWindowPolicy, mainWindowWebPreferences, navigationAllowed, windowOpenTarget } from './windowPolicy'

function fakeContents() {
  const listeners = new Map<string, (...args: unknown[]) => void>()
  let openHandler: ((d: { url: string }) => { action: string }) | null = null
  return {
    contents: {
      setWindowOpenHandler: (h: (d: { url: string }) => { action: string }) => void (openHandler = h),
      on: (ev: string, fn: (...args: unknown[]) => void) => {
        listeners.set(ev, fn)
        return undefined as never
      }
    },
    open: (url: string) => openHandler!({ url }),
    fire: (ev: string, url?: string) => {
      let prevented = false
      listeners.get(ev)!({ preventDefault: () => void (prevented = true) }, url)
      return prevented
    },
    has: (ev: string) => listeners.has(ev)
  }
}

describe('mainWindowWebPreferences', () => {
  it('sandboxed, isolated, no Node, web security on', () => {
    const p = mainWindowWebPreferences({ preload: '/x/preload/index.js' })
    expect(p).toMatchObject({
      preload: '/x/preload/index.js', sandbox: true, contextIsolation: true, nodeIntegration: false,
      nodeIntegrationInSubFrames: false, nodeIntegrationInWorker: false, webSecurity: true, allowRunningInsecureContent: false, webviewTag: false
    })
    expect(p.additionalArguments).toBeUndefined()
  })
  it('passes the e2e day only when set', () => {
    expect(mainWindowWebPreferences({ preload: 'p', e2eToday: '2026-05-01' }).additionalArguments).toEqual(['--total-e2e-today=2026-05-01'])
  })
})

describe('window policy', () => {
  it('window.open: always denied; only allow-listed links reach the OS', () => {
    const f = fakeContents()
    const opened: string[] = []
    const logged: string[] = []
    applyWindowPolicy(f.contents as never, { openExternal: (u) => opened.push(u), log: (_l, ev) => logged.push(ev) })
    expect(f.open('https://www.gst.gov.in').action).toBe('deny')
    expect(f.open('mailto:a@b.c').action).toBe('deny')
    expect(f.open('https://evil.example/').action).toBe('deny')
    expect(f.open('file:///etc/passwd').action).toBe('deny')
    expect(opened).toEqual(['https://www.gst.gov.in/', 'mailto:a@b.c'])
    expect(logged).toEqual(['window-open-refused', 'window-open-refused'])
    expect(windowOpenTarget('javascript:alert(1)')).toBeNull()
  })

  it('navigation and redirects are refused (dev server origin allowed in dev only)', () => {
    const f = fakeContents()
    applyWindowPolicy(f.contents as never, { openExternal: () => {}, log: () => {} })
    expect(f.fire('will-navigate', 'https://evil.example/')).toBe(true)
    expect(f.fire('will-navigate', 'file:///tmp/dropped.html')).toBe(true)
    expect(f.fire('will-redirect', 'https://evil.example/')).toBe(true)
    const d = fakeContents()
    applyWindowPolicy(d.contents as never, { openExternal: () => {}, log: () => {}, devUrl: 'http://localhost:5173' })
    expect(d.fire('will-navigate', 'http://localhost:5173/x')).toBe(false)
    expect(d.fire('will-navigate', 'http://localhost:5173.evil.example/')).toBe(true)
    expect(d.fire('will-navigate', 'https://evil.example/')).toBe(true)
    expect(navigationAllowed('http://localhost:5173/', undefined)).toBe(false)
  })

  it('webviews are never attached', () => {
    const f = fakeContents()
    const logged: string[] = []
    applyWindowPolicy(f.contents as never, { openExternal: () => {}, log: (_l, ev) => logged.push(ev) })
    expect(f.fire('will-attach-webview')).toBe(true)
    expect(logged).toEqual(['webview-refused'])
  })
})
