import type { Screen } from '../state/stores'
import { SCREENS } from './screens'

export type WorkspaceProfile = 'all' | 'bookkeeper' | 'owner' | 'gst' | 'collections' | 'inventory' | 'payroll'

export const WORKSPACE_PROFILES: { id: WorkspaceProfile; label: string }[] = [
  { id: 'all', label: 'Everything' },
  { id: 'bookkeeper', label: 'Bookkeeper' },
  { id: 'owner', label: 'Owner' },
  { id: 'gst', label: 'GST' },
  { id: 'collections', label: 'Collections' },
  { id: 'inventory', label: 'Inventory' },
  { id: 'payroll', label: 'Payroll' }
]

const PROFILE_SCREENS: Record<Exclude<WorkspaceProfile, 'all'>, Screen['name'][]> = {
  bookkeeper: ['gateway', 'action-centre', 'voucher-entry', 'voucher-drafts', 'entry-templates', 'daybook', 'masters', 'recurring', 'trial-balance', 'profit-loss', 'balance-sheet', 'cash-flow', 'month-close', 'supplier-dues', 'banking', 'outstandings', 'exceptions'],
  owner: ['gateway', 'action-centre', 'daybook', 'trial-balance', 'profit-loss', 'balance-sheet', 'cash-flow', 'month-close', 'registers', 'outstandings', 'budgets', 'exceptions'],
  gst: ['gateway', 'action-centre', 'voucher-entry', 'voucher-drafts', 'daybook', 'registers', 'gstr1', 'gstr3b', 'gstr2b', 'edocs', 'tds', 'exceptions'],
  collections: ['gateway', 'action-centre', 'voucher-entry', 'voucher-drafts', 'daybook', 'collections', 'outstandings', 'registers', 'banking', 'recurring'],
  inventory: ['gateway', 'action-centre', 'voucher-entry', 'voucher-drafts', 'daybook', 'masters', 'stock-summary', 'registers', 'exceptions'],
  payroll: ['gateway', 'action-centre', 'voucher-entry', 'voucher-drafts', 'daybook', 'payroll', 'banking', 'tds', 'cost-centres']
}

export function screenInWorkspace(profile: WorkspaceProfile, name: Screen['name']): boolean {
  return profile === 'all' || PROFILE_SCREENS[profile].includes(name)
}

export interface WorkspacePrefs {
  favorites: Screen['name'][]
  recent: Screen['name'][]
  homeOrder: Screen['name'][]
  hiddenHome: Screen['name'][]
  density: 'compact' | 'comfortable'
  profile: WorkspaceProfile
}

const EMPTY: WorkspacePrefs = { favorites: [], recent: [], homeOrder: [], hiddenHome: [], density: 'comfortable', profile: 'all' }
const SCREEN_NAMES = new Set<string>(SCREENS.map((screen) => screen.name))

function validScreenName(value: unknown): value is Screen['name'] {
  return typeof value === 'string' && SCREEN_NAMES.has(value)
}

function key(slug: string): string {
  return `total-workspace-${slug}`
}

function userKey(identity: string): string {
  return `total-workspace-user-${encodeURIComponent(identity)}`
}

export function workspaceIdentity(user: { name: string; role: string } | null): string {
  return user ? `${user.role}:${user.name.trim().toLocaleLowerCase()}` : 'device'
}

function readPersonalPrefs(identity: string | null): Pick<WorkspacePrefs, 'favorites' | 'density'> | null {
  if (!identity) return null
  try {
    const parsed = JSON.parse(localStorage.getItem(userKey(identity)) ?? 'null') as Partial<WorkspacePrefs> | null
    if (!parsed) return null
    return {
      favorites: Array.isArray(parsed.favorites) ? parsed.favorites.filter(validScreenName).slice(0, 8) : [],
      density: parsed.density === 'compact' ? 'compact' : 'comfortable'
    }
  } catch {
    return null
  }
}

function writePersonalPrefs(identity: string | null, prefs: Pick<WorkspacePrefs, 'favorites' | 'density'>): void {
  if (identity) localStorage.setItem(userKey(identity), JSON.stringify(prefs))
}

export function readWorkspacePrefs(slug: string | null, identity: string | null = null): WorkspacePrefs {
  if (!slug) return EMPTY
  try {
    const parsed = JSON.parse(localStorage.getItem(key(slug)) ?? '{}') as Partial<WorkspacePrefs>
    const companyPrefs: WorkspacePrefs = {
      favorites: Array.isArray(parsed.favorites) ? parsed.favorites.filter(validScreenName).slice(0, 8) : [],
      recent: Array.isArray(parsed.recent) ? parsed.recent.filter(validScreenName).slice(0, 8) : [],
      homeOrder: Array.isArray(parsed.homeOrder) ? parsed.homeOrder.filter(validScreenName) : [],
      hiddenHome: Array.isArray(parsed.hiddenHome) ? parsed.hiddenHome.filter(validScreenName) : [],
      density: parsed.density === 'compact' ? 'compact' : 'comfortable',
      profile: WORKSPACE_PROFILES.some((profile) => profile.id === parsed.profile) ? parsed.profile! : 'all'
    }
    const personal = readPersonalPrefs(identity)
    return personal ? { ...companyPrefs, ...personal } : companyPrefs
  } catch {
    return EMPTY
  }
}

function write(slug: string, prefs: WorkspacePrefs): WorkspacePrefs {
  localStorage.setItem(key(slug), JSON.stringify(prefs))
  return prefs
}

export function rememberWorkspaceScreen(slug: string | null, name: Screen['name'], identity: string | null = null): WorkspacePrefs {
  if (!slug || name === 'gateway') return readWorkspacePrefs(slug, identity)
  const companyPrefs = readWorkspacePrefs(slug)
  write(slug, { ...companyPrefs, recent: [name, ...companyPrefs.recent.filter((x) => x !== name)].slice(0, 8) })
  return readWorkspacePrefs(slug, identity)
}

export function toggleWorkspaceFavorite(slug: string, name: Screen['name'], identity: string | null = null): WorkspacePrefs {
  const prefs = readWorkspacePrefs(slug, identity)
  const favorites = prefs.favorites.includes(name)
    ? prefs.favorites.filter((x) => x !== name)
    : [name, ...prefs.favorites].slice(0, 8)
  if (identity) writePersonalPrefs(identity, { favorites, density: prefs.density })
  else write(slug, { ...prefs, favorites })
  return readWorkspacePrefs(slug, identity)
}

export function saveHomeLayout(
  slug: string,
  input: Pick<WorkspacePrefs, 'homeOrder' | 'hiddenHome' | 'density'>,
  identity: string | null = null
): WorkspacePrefs {
  const prefs = readWorkspacePrefs(slug, identity)
  const companyPrefs = readWorkspacePrefs(slug)
  const dedupe = (values: Screen['name'][]): Screen['name'][] => [...new Set(values.filter(validScreenName))]
  write(slug, {
    ...companyPrefs,
    homeOrder: dedupe(input.homeOrder),
    hiddenHome: dedupe(input.hiddenHome),
    density: identity ? companyPrefs.density : input.density
  })
  writePersonalPrefs(identity, { favorites: prefs.favorites, density: input.density })
  return readWorkspacePrefs(slug, identity)
}

export function saveWorkspaceProfile(slug: string, profile: WorkspaceProfile, identity: string | null = null): WorkspacePrefs {
  write(slug, { ...readWorkspacePrefs(slug), profile })
  return readWorkspacePrefs(slug, identity)
}
