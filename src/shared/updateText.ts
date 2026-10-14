/**
 * WP 7.3 — the updater's platform facts (pure, unit-tested): where the data folder is shown and
 * which installer /api/download hands out. (The update notices themselves are in-app since the
 * consent updater, PR #108; the SmartScreen / Gatekeeper steps are in the help article "Total on
 * Windows" and the README.)
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

/** Scripted runs (smoke / e2e / CI) turn the startup update check off: a packaged build would
 *  otherwise ask GitHub and could open a dialog in the middle of a run. */
export function updateCheckDisabled(env: Record<string, string | undefined>): boolean {
  return env.TOTAL_NO_UPDATE_CHECK === '1'
}
