// WP 7.2 (PR #112 follow-up): the renderer follows the signed-in user's capability flags
// (shared/capabilities.ts) so a button main would refuse is hidden or disabled with a plain reason
// up front. Main still enforces every flag (capabilities.ts / ipc.ts) — this is only the UI.
//
// Rule: what an owner or a user WITHOUT flags sees never changes. `useCapabilityRefused` is true
// only when the user carries that flag set to false (owners never do), so an unflagged viewer
// keeps today's screens; `useCanManageAi` also opens the AI settings to someone the owner GRANTED
// canManageAi.
import type { Capability } from '@shared/capabilities'
import type { SessionUser } from './client'
import { useSession } from '../state/stores'

/** True when the owner turned this capability off for the signed-in user. */
export function capabilityRefused(user: SessionUser | null | undefined, cap: Capability): boolean {
  if (!user || user.role === 'owner') return false
  return user.capabilities?.[cap] === false
}

export const useCapabilityRefused = (cap: Capability): boolean => useSession((s) => capabilityRefused(s.user, cap))

/** The AI assistant's settings may be changed: an owner, a company without sign-ins, or a user
 *  granted canManageAi. */
export function canManageAi(user: SessionUser | null | undefined): boolean {
  if (!user || user.role === 'owner') return true
  return user.capabilities?.canManageAi === true
}

export const useCanManageAi = (): boolean => useSession((s) => canManageAi(s.user))

/** The plain reasons shown beside a disabled button (accountant screens keep literal English). */
export const CAPABILITY_REFUSED_TEXT: Record<Capability, string> = {
  canPost: 'Your sign-in can’t save entries — ask the owner',
  canExport: 'Your sign-in can’t export — ask the owner',
  canManageAi: 'Your sign-in can’t change the AI assistant’s settings — ask the owner',
  canSeeProfit: 'Profit figures are not shown to your sign-in'
}
