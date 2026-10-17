/**
 * Shapes shared by the auto-updater (main) and its notices / settings (renderer).
 * The update flow asks first: nothing is downloaded until the user says so.
 */

/** App-level update settings (`<dataRoot>/app-settings.json`, never a company DB). */
export interface UpdateSettings {
  /** "Check for updates automatically" — default ON. Off = no request is made at launch. */
  autoCheck: boolean
  /** A version the user chose to skip ("Skip this version"); automatic checks stay quiet about it. */
  skippedVersion: string | null
}

export const DEFAULT_UPDATE_SETTINGS: UpdateSettings = { autoCheck: true, skippedVersion: null }

/** What the notice shows. `via` = how "Download now" gets it: electron-updater ('engine') or the
 *  site / GitHub release page ('site'). */
export interface UpdateNotice {
  phase: 'available' | 'downloading' | 'ready'
  /** Without a leading "v". */
  version: string
  via: 'engine' | 'site'
}

export interface UpdatesView {
  settings: UpdateSettings
  notice: UpdateNotice | null
  current: string
}

/** The user's choices on a notice that need main (the plain "Later" is renderer-only). */
export const UPDATE_ACTIONS = ['download', 'install', 'installOnQuit', 'skip'] as const
export type UpdateAction = (typeof UPDATE_ACTIONS)[number]

export interface UpdateCheckResult {
  status: 'dev' | 'available' | 'up-to-date' | 'error'
  current: string
  latest?: string
}

/** True when `remote` is a newer dotted version than `local` (a leading "v" is ignored). */
export function isNewerVersion(remote: string, local: string): boolean {
  const parse = (v: string): number[] => v.replace(/^v/, '').split('.').map((n) => parseInt(n, 10) || 0)
  const [r, l] = [parse(remote), parse(local)]
  for (let i = 0; i < 3; i++) {
    if ((r[i] ?? 0) !== (l[i] ?? 0)) return (r[i] ?? 0) > (l[i] ?? 0)
  }
  return false
}

export const bareVersion = (v: string): string => v.replace(/^v/, '')

/** Who may change the app-wide update setting / answer a notice (the AI-key rule). */
export type UpdatesCanSet = { allowed: boolean; reason: 'ok' | 'owner_only' | 'other_company_has_users' | 'needs_confirmation' }


/** In a company with users: owner only. Without users: refused while any other company on this
 *  computer has users, else allowed after an explicit confirmation. Pure; tested. */
export function updatesCanSet(o: { companyHasUsers: boolean; isOwner: boolean; anyOtherCompanyHasUsers: boolean }): UpdatesCanSet {
  if (o.companyHasUsers) return o.isOwner ? { allowed: true, reason: 'ok' } : { allowed: false, reason: 'owner_only' }
  if (o.anyOtherCompanyHasUsers) return { allowed: false, reason: 'other_company_has_users' }
  return { allowed: true, reason: 'needs_confirmation' }
}
