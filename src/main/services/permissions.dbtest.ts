import { describe, expect, it } from 'vitest'
import { freshDb } from '../db/testdb'
import { DEFAULT_PERMISSION_MATRIX, getPermissionMatrix, permissionAllows, setPermissionMatrix } from './permissions'

describe('role permission matrix', () => {
  it('defaults to least privilege while keeping daily accountant work available', () => {
    const db = freshDb()
    expect(getPermissionMatrix(db)).toEqual(DEFAULT_PERMISSION_MATRIX)
    expect(permissionAllows(db, 'accountant', 'create')).toBe(true)
    expect(permissionAllows(db, 'accountant', 'backup')).toBe(false)
    expect(permissionAllows(db, 'viewer', 'view')).toBe(true)
    expect(permissionAllows(db, 'viewer', 'export')).toBe(false)
  })

  it('persists configurable accountant/viewer rights but never permits owner lockout', () => {
    const db = freshDb()
    const requested = structuredClone(DEFAULT_PERMISSION_MATRIX)
    requested.viewer.export = true
    requested.accountant.approve = true
    for (const action of Object.keys(requested.owner) as (keyof typeof requested.owner)[]) requested.owner[action] = false

    const saved = setPermissionMatrix(db, requested)
    expect(saved.viewer.export).toBe(true)
    expect(saved.accountant.approve).toBe(true)
    expect(Object.values(saved.owner).every(Boolean)).toBe(true)
    expect(getPermissionMatrix(db)).toEqual(saved)
  })

  it('falls back safely when stored JSON is damaged', () => {
    const db = freshDb()
    db.prepare("INSERT INTO meta (key, value) VALUES ('permissions.matrix', '{bad')").run()
    expect(getPermissionMatrix(db)).toEqual(DEFAULT_PERMISSION_MATRIX)
  })
})
