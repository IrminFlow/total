// WP 7.2 — finer-grained roles. The three roles stay (viewer / accountant / owner); a user may
// carry a few capability flags on top, each one either GRANTING what the role would not allow or
// TAKING AWAY what it would. A flag that is not set means "as the role says" — so every existing
// user, and every user nobody touched, behaves exactly as before. Owners always have everything
// (an owner can never lock themselves — or the last owner — out of their own books).
//
// Enforced in main (src/main/capabilities.ts maps channels to flags; ipc.ts `handle` gates on
// it); this module is the shared vocabulary (the People & roles toggles read it). Pure.

export const CAPABILITIES = ['canPost', 'canSeeProfit', 'canExport', 'canManageAi'] as const
export type Capability = (typeof CAPABILITIES)[number]

/** Per-user overrides; a missing key = the role's default. */
export type CapabilityFlags = Partial<Record<Capability, boolean>>

export type RoleName = 'viewer' | 'accountant' | 'owner'

/** What each role allows when no flag is set — today's behaviour, written down: posting is
 *  accountant+, a viewer may already save what a report shows to a file (most export channels are
 *  viewer-level; the whole-books exports stay accountant+), profit is visible to every role, AI
 *  settings are the owner's. */
export const ROLE_DEFAULTS: Record<RoleName, Record<Capability, boolean>> = {
  viewer: { canPost: false, canSeeProfit: true, canExport: true, canManageAi: false },
  accountant: { canPost: true, canSeeProfit: true, canExport: true, canManageAi: false },
  owner: { canPost: true, canSeeProfit: true, canExport: true, canManageAi: true }
}

/** The effective set for a user. */
export function effectiveCapabilities(role: RoleName, flags: CapabilityFlags | null | undefined): Record<Capability, boolean> {
  const base = ROLE_DEFAULTS[role]
  if (role === 'owner') return { ...base }
  const out = { ...base }
  for (const c of CAPABILITIES) {
    const v = flags?.[c]
    if (typeof v === 'boolean') out[c] = v
  }
  return out
}

/** Keep only real flags that differ from the role's default (what gets stored); null = none. */
export function normaliseFlags(role: RoleName, flags: CapabilityFlags | null | undefined): CapabilityFlags | null {
  if (!flags || role === 'owner') return null
  const out: CapabilityFlags = {}
  for (const c of CAPABILITIES) {
    const v = flags[c]
    if (typeof v === 'boolean' && v !== ROLE_DEFAULTS[role][c]) out[c] = v
  }
  return Object.keys(out).length ? out : null
}

/** Parse the stored JSON (users.capabilities_json); anything unreadable = no flags. */
export function parseFlags(json: string | null | undefined): CapabilityFlags | null {
  if (!json) return null
  try {
    const v = JSON.parse(json) as unknown
    if (!v || typeof v !== 'object' || Array.isArray(v)) return null
    const out: CapabilityFlags = {}
    for (const c of CAPABILITIES) {
      const x = (v as Record<string, unknown>)[c]
      if (typeof x === 'boolean') out[c] = x
    }
    return Object.keys(out).length ? out : null
  } catch {
    return null
  }
}
