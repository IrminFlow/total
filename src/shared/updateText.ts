/**
 * WP 7.3 — the updater's words and links per platform (pure, unit-tested). macOS and Windows differ
 * in where the data folder is shown, in the installer that is downloaded, and in the warning an
 * unsigned build meets: Gatekeeper ("right-click → Open") on macOS, SmartScreen ("Windows protected
 * your PC" → More info → Run anyway) on Windows.
 */

export type DesktopPlatform = 'darwin' | 'win32' | 'linux' | string

/** How the data folder is written for the user on this platform. */
export function dataFolderLabel(platform: DesktopPlatform): string {
  return platform === 'win32' ? 'Documents\\total' : '~/Documents/total'
}

/** /api/download picks the installer from ?platform= (else the browser's User-Agent). */
export function downloadUrlFor(url: string, platform: DesktopPlatform): string {
  const p = platform === 'win32' ? 'win' : platform === 'darwin' ? 'mac' : null
  if (!p || !/\/api\/download(\?|$)/.test(url) || /[?&]platform=/.test(url)) return url
  return `${url}${url.includes('?') ? '&' : '?'}platform=${p}`
}

/** The "a new version is available — download it" dialog's detail (the manual path). */
export function updateAvailableDetail(platform: DesktopPlatform, current: string): string {
  const base = `You're on ${current}. Download the new version — your data in ${dataFolderLabel(platform)} is untouched by updates.`
  if (platform === 'win32') {
    return `${base} Total isn't code-signed yet, so Windows may show "Windows protected your PC" (SmartScreen) when you run the installer — choose More info → Run anyway.`
  }
  if (platform === 'darwin') return `${base} The first time you open it, right-click Total → Open (it isn't code-signed yet).`
  return base
}

/** The "update downloaded — restart" dialog's detail (the automatic path). */
export function updateReadyDetail(platform: DesktopPlatform): string {
  return `The update installs when the app restarts. Your data in ${dataFolderLabel(platform)} is untouched.`
}

/** Scripted runs (smoke / e2e / CI) turn the startup update check off: a packaged build would
 *  otherwise ask GitHub and could open a dialog in the middle of a run. */
export function updateCheckDisabled(env: Record<string, string | undefined>): boolean {
  return env.TOTAL_NO_UPDATE_CHECK === '1'
}
