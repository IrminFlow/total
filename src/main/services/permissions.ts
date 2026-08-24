import type { DB } from '../db/connection'
import type { Role } from './roles'
import { writeAudit } from './audit'

export const PERMISSION_ACTIONS = ['view', 'create', 'edit', 'approve', 'export', 'backup', 'settings'] as const
export type PermissionAction = typeof PERMISSION_ACTIONS[number]
export type PermissionMatrix = Record<Role, Record<PermissionAction, boolean>>

export const DEFAULT_PERMISSION_MATRIX: PermissionMatrix = {
  owner: { view: true, create: true, edit: true, approve: true, export: true, backup: true, settings: true },
  accountant: { view: true, create: true, edit: true, approve: false, export: true, backup: false, settings: false },
  viewer: { view: true, create: false, edit: false, approve: false, export: false, backup: false, settings: false }
}

function cloneDefaults(): PermissionMatrix {
  return structuredClone(DEFAULT_PERMISSION_MATRIX)
}

export function getPermissionMatrix(db: DB): PermissionMatrix {
  const row = db.prepare("SELECT value FROM meta WHERE key = 'permissions.matrix'").get() as { value: string } | undefined
  if (!row) return cloneDefaults()
  try {
    const parsed = JSON.parse(row.value) as Partial<PermissionMatrix>
    const result = cloneDefaults()
    for (const role of ['accountant', 'viewer'] as const) {
      for (const action of PERMISSION_ACTIONS) {
        if (typeof parsed[role]?.[action] === 'boolean') result[role][action] = parsed[role]![action]!
      }
    }
    return result
  } catch {
    return cloneDefaults()
  }
}

export function setPermissionMatrix(db: DB, matrix: PermissionMatrix): PermissionMatrix {
  const normalized = cloneDefaults()
  for (const role of ['accountant', 'viewer'] as const) {
    for (const action of PERMISSION_ACTIONS) normalized[role][action] = matrix[role][action] === true
  }
  // Owners are an unrecoverable local authority: their row is deliberately immutable and all-on.
  const before = getPermissionMatrix(db)
  db.prepare("INSERT INTO meta (key, value) VALUES ('permissions.matrix', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .run(JSON.stringify(normalized))
  writeAudit(db, 'permission_matrix', 0, 'update', before, normalized)
  return normalized
}

export function permissionAllows(db: DB, role: Role, action: PermissionAction): boolean {
  return getPermissionMatrix(db)[role][action]
}
