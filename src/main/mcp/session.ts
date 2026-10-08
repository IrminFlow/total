// Who an MCP session acts as (WP 5.7). No SDK import — tested directly.
//
// Threat model. The server is a local stdio process started by whoever runs `total-cli mcp` —
// that person can already read (and overwrite) the company's SQLite file, so the role check is
// not a barrier against them; it protects against the AGENT they connect. The rules:
//   - default role viewer: read tools and resources only; no credential (it adds nothing the
//     files do not already give — use the kill switch to refuse MCP for a company altogether);
//   - accountant / owner (draft tools) need the explicit `--role` flag, AND — when the company
//     has users — `--user <name>` plus the PIN in TOTAL_MCP_PIN, verified by users.login (same
//     throttle, `login` / `login_failed` audit rows), and the user's own role must cover it;
//   - nothing any role can do over MCP writes the books: draft tools only write ai_drafts.
// A running session re-checks before every request that MCP is still allowed for the company and
// that a signed-in user is still active, with a role that covers the session's and the same PIN
// (a PIN change ends the session — the old PIN may sit in a client's config file).
import { createHash } from 'crypto'
import type { DB } from '../db/connection'
import { roleAllows, type Role } from '../services/roles'
import { login, usersExist } from '../services/users'

export const MCP_ROLES: readonly Role[] = ['viewer', 'accountant', 'owner']

export interface McpSessionRequest {
  role: Role
  user: string | null
  /** From TOTAL_MCP_PIN (stdin is the protocol channel, so it cannot be prompted for). */
  pin: string | null
}

export interface McpIdentity {
  role: Role
  /** The verified user, or null (viewer without --user, or a company without users). */
  userName: string | null
  userId: number | null
  /** Fingerprint of the user's PIN hash at sign-in; a different one later ends the session. */
  pinStamp?: string | null
}

const pinStampOf = (db: DB, userId: number): string | null => {
  const r = db.prepare('SELECT pin_hash FROM users WHERE id = ?').get(userId) as { pin_hash: string } | undefined
  return r ? createHash('sha256').update(r.pin_hash).digest('hex') : null
}

export function parseRole(raw: string | undefined): Role {
  const r = (raw ?? 'viewer').toLowerCase()
  if (!(MCP_ROLES as readonly string[]).includes(r)) throw new Error(`--role must be viewer, accountant or owner (got '${raw}')`)
  return r as Role
}

function findUser(db: DB, name: string): { id: number; name: string; role: Role } | null {
  return (
    (db.prepare('SELECT id, name, role FROM users WHERE active = 1 AND name = ? COLLATE NOCASE').get(name.trim()) as
      | { id: number; name: string; role: Role }
      | undefined) ?? null
  )
}

/** Resolve (and for signed-in roles, authenticate) the identity a session runs as. Throws with a
 *  message for the person starting the server when the request is not allowed. */
export function resolveMcpIdentity(db: DB, req: McpSessionRequest): McpIdentity {
  const hasUsers = usersExist(db)
  if (!hasUsers) {
    if (req.user) throw new Error('This company has no users — start without --user')
    return { role: req.role, userName: null, userId: null }
  }
  if (!req.user) {
    if (req.role === 'viewer') return { role: 'viewer', userName: null, userId: null }
    throw new Error(`--role ${req.role} needs --user <name> and the PIN in TOTAL_MCP_PIN (this company has users)`)
  }
  const u = findUser(db, req.user)
  if (!u) throw new Error(`No active user named '${req.user}'`)
  if (!req.pin) throw new Error(`Set TOTAL_MCP_PIN to ${u.name}'s PIN (it is read from the environment — stdin carries the MCP protocol)`)
  const who = login(db, u.id, req.pin) // throttled + audited exactly like the lock screen
  if (!roleAllows(who.role, req.role)) throw new Error(`${who.name} is ${who.role} — cannot start the MCP server as ${req.role}`)
  return { role: req.role, userName: who.name, userId: who.id, pinStamp: pinStampOf(db, who.id) }
}

/** Before every request: a signed-in user must still be active with a role covering the session. */
export function identityStillValid(db: DB, id: McpIdentity): string | null {
  if (id.userId === null) {
    // A viewer session without a user stays valid; a higher role started in a company without
    // users is refused once users are added (it would now need a credential).
    return id.role !== 'viewer' && usersExist(db) ? 'This company now has users — restart the MCP server with --user and TOTAL_MCP_PIN' : null
  }
  const row = db.prepare('SELECT role, active FROM users WHERE id = ?').get(id.userId) as { role: Role; active: number } | undefined
  if (!row || !row.active) return `${id.userName} is no longer an active user`
  if (!roleAllows(row.role, id.role)) return `${id.userName} is now ${row.role} — the session needs ${id.role}`
  if (id.pinStamp && pinStampOf(db, id.userId) !== id.pinStamp) return `${id.userName}'s PIN has changed — restart the MCP server with the new PIN`
  return null
}
