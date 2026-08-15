// Pure role-ranking logic — zero imports, so it's plain-vitest testable without Electron/DB.
// The IPC layer (src/main/ipc.ts) is the only caller; kept separate so the decision itself
// (as opposed to *when* it's applied) has a direct test.

export type Role = 'viewer' | 'accountant' | 'owner'

const RANK: Record<Role, number> = { viewer: 0, accountant: 1, owner: 2 }

/** True if `sessionRole` meets or exceeds `minRole`. No signed-in user (null) never passes. */
export function roleAllows(sessionRole: Role | null, minRole: Role): boolean {
  if (sessionRole === null) return false
  return RANK[sessionRole] >= RANK[minRole]
}
