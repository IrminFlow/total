import { describe, it, expect } from 'vitest'
import { roleAllows, type Role } from './roles'

describe('roleAllows', () => {
  it('a null session role never passes, for any minRole', () => {
    const roles: Role[] = ['viewer', 'accountant', 'owner']
    for (const minRole of roles) {
      expect(roleAllows(null, minRole)).toBe(false)
    }
  })

  it('owner passes every gate', () => {
    expect(roleAllows('owner', 'viewer')).toBe(true)
    expect(roleAllows('owner', 'accountant')).toBe(true)
    expect(roleAllows('owner', 'owner')).toBe(true)
  })

  it('accountant passes viewer/accountant gates but not owner', () => {
    expect(roleAllows('accountant', 'viewer')).toBe(true)
    expect(roleAllows('accountant', 'accountant')).toBe(true)
    expect(roleAllows('accountant', 'owner')).toBe(false)
  })

  it('viewer passes only the viewer gate', () => {
    expect(roleAllows('viewer', 'viewer')).toBe(true)
    expect(roleAllows('viewer', 'accountant')).toBe(false)
    expect(roleAllows('viewer', 'owner')).toBe(false)
  })
})
