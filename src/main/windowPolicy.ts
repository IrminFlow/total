// WP 7.2 / D7 Electron hardening — every rule for what a window may do, in one place:
//   - the main window's webPreferences (sandboxed renderer, context isolation, no Node, web security);
//   - window.open / target=_blank: no window is ever opened; only the allow-listed links (help
//     pages, mailto:, a WhatsApp chat — shared/externalLinks.ts) go to the OS, the rest is logged;
//   - navigation: a window never leaves the app (a dropped file, a stray link) — only the dev
//     server's own pages in dev;
//   - webviews are never attached.
// No runtime Electron import (types only), so the policy is unit-tested (windowPolicy.test.ts)
// against a fake web contents. main/index.ts applies it to every web contents created.
import type { WebContents, WebPreferences } from 'electron'
import { allowedExternalUrl } from '@shared/externalLinks'

export interface WindowPolicyDeps {
  openExternal: (url: string) => void
  log: (level: 'warn', event: string, data: Record<string, unknown>) => void
  /** The dev server URL (electron-vite's ELECTRON_RENDERER_URL) in dev, else undefined. */
  devUrl?: string
}

/** The main window's webPreferences. `sandbox: true` — the preload uses only `electron`
 *  (contextBridge / ipcRenderer) and the sandbox's own `process.platform` / `process.argv`. */
export function mainWindowWebPreferences(opts: { preload: string; e2eToday?: string | null }): WebPreferences {
  return {
    preload: opts.preload,
    sandbox: true,
    contextIsolation: true,
    nodeIntegration: false,
    nodeIntegrationInSubFrames: false,
    nodeIntegrationInWorker: false,
    webSecurity: true,
    allowRunningInsecureContent: false,
    webviewTag: false,
    // Scripted runs only (TOTAL_E2E_TODAY, e2eClock.ts): the preload hands the day to the renderer.
    ...(opts.e2eToday ? { additionalArguments: [`--total-e2e-today=${opts.e2eToday}`] } : {})
  }
}

const schemeOf = (url: string): string => String(url ?? '').split(':')[0]?.slice(0, 16) ?? ''

/** window.open: the safe URL to hand to the OS, or null (refused). The window itself is always denied. */
export function windowOpenTarget(url: string): string | null {
  return allowedExternalUrl(url)
}

/** True when the window may navigate to `url` (only within the dev server, in dev). */
export function navigationAllowed(url: string, devUrl?: string): boolean {
  if (!devUrl || typeof url !== 'string') return false
  try {
    const u = new URL(url)
    const d = new URL(devUrl)
    return (u.protocol === 'http:' || u.protocol === 'https:') && u.origin === d.origin
  } catch {
    return false
  }
}

type PolicyContents = Pick<WebContents, 'setWindowOpenHandler' | 'on'>

/** Wire the policy onto one web contents (the main window, the hidden PDF window, any other). */
export function applyWindowPolicy(contents: PolicyContents, deps: WindowPolicyDeps): void {
  contents.setWindowOpenHandler((details) => {
    const safe = windowOpenTarget(details.url)
    if (safe) deps.openExternal(safe)
    else deps.log('warn', 'window-open-refused', { scheme: schemeOf(details.url) })
    return { action: 'deny' }
  })
  const refuseNavigation = (event: { preventDefault: () => void }, url: string): void => {
    if (navigationAllowed(url, deps.devUrl)) return
    event.preventDefault()
    deps.log('warn', 'navigation-refused', { scheme: schemeOf(url) })
  }
  contents.on('will-navigate', refuseNavigation as never)
  contents.on('will-redirect', refuseNavigation as never)
  contents.on('will-attach-webview', ((event: { preventDefault: () => void }) => {
    event.preventDefault()
    deps.log('warn', 'webview-refused', {})
  }) as never)
}
