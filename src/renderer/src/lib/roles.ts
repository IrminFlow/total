import type { SessionUser } from './client'

// The renderer's mirror of ipc.ts's role gate: a company WITHOUT users has no session user
// (`user == null`) and main lets every channel through, owner-only ones included — so the UI must
// offer them too. (A company with users but nobody signed in shows the lock screen, never these.)
export function isOwnerOrNoUsers(user: SessionUser | null | undefined): boolean {
  return user == null || user.role === 'owner'
}

/** Accountant or owner — or anyone in a company without users. */
export function canWriteOrNoUsers(user: SessionUser | null | undefined): boolean {
  return user == null || user.role !== 'viewer'
}
