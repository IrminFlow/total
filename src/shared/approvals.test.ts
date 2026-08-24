import { describe, it, expect } from 'vitest'
import { canDecideApproval, needsApproval, pendingExplanation } from './approvals'
import { formatPaise } from './money'

const base = { threshold: 5000000, amount: 100000, actorRole: 'accountant' as const, hasUsers: true }

describe('needsApproval', () => {
  it('holds an accountant entry above the threshold', () => {
    expect(needsApproval({ ...base, amount: 5000001 })).toBe(true)
  })

  it('lets an entry exactly at the threshold through', () => {
    // "Above ₹50,000" permits ₹50,000. An entry at the limit landing in the queue is the
    // surprise that gets the whole feature switched off.
    expect(needsApproval({ ...base, amount: 5000000 })).toBe(false)
  })

  it('is off when no threshold is set', () => {
    expect(needsApproval({ ...base, threshold: null, amount: 999999999 })).toBe(false)
  })

  it('treats a threshold of zero as "everything waits", not as off', () => {
    expect(needsApproval({ ...base, threshold: 0, amount: 1 })).toBe(true)
    expect(needsApproval({ ...base, threshold: 0, amount: 100000000 })).toBe(true)
  })

  it('does not hold a nil voucher even at a zero threshold', () => {
    expect(needsApproval({ ...base, threshold: 0, amount: 0 })).toBe(false)
  })

  it("never holds the owner's own entry", () => {
    expect(needsApproval({ ...base, actorRole: 'owner', amount: 999999999 })).toBe(false)
  })

  it('is off on a company with no users — one person cannot be a queue', () => {
    expect(needsApproval({ ...base, hasUsers: false, amount: 999999999, actorRole: null })).toBe(false)
  })
})

describe('canDecideApproval', () => {
  it('only the owner decides', () => {
    expect(canDecideApproval({ approverRole: 'accountant', approverName: 'Arun', enteredBy: 'Meena' })).toBe(false)
    expect(canDecideApproval({ approverRole: 'viewer', approverName: 'V', enteredBy: 'Meena' })).toBe(false)
    expect(canDecideApproval({ approverRole: 'owner', approverName: 'Priya', enteredBy: 'Meena' })).toBe(true)
  })

  it('refuses to let anyone approve their own entry', () => {
    expect(canDecideApproval({ approverRole: 'owner', approverName: 'Priya', enteredBy: 'Priya' })).toBe(false)
  })

  it('allows an owner to decide an entry whose author was not recorded', () => {
    expect(canDecideApproval({ approverRole: 'owner', approverName: 'Priya', enteredBy: null })).toBe(true)
  })
})

describe('pendingExplanation', () => {
  it('names the threshold in rupees', () => {
    expect(pendingExplanation(5000000, formatPaise)).toContain('50,000.00')
  })

  it('still says something when the threshold has since been cleared', () => {
    expect(pendingExplanation(null, formatPaise)).toMatch(/owner/i)
  })
})
