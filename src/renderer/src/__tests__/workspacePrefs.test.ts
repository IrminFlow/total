import { beforeEach, describe, expect, it } from 'vitest'
import { readWorkspacePrefs, rememberWorkspaceScreen, saveHomeLayout, saveWorkspaceProfile, screenInWorkspace, toggleWorkspaceFavorite, workspaceIdentity } from '../lib/workspacePrefs'

const empty = { favorites: [], recent: [], homeOrder: [], hiddenHome: [], density: 'comfortable' as const, profile: 'all' as const }

describe('workspace preferences', () => {
  beforeEach(() => localStorage.clear())

  it('keeps pinned and recent screens separate for each company', () => {
    toggleWorkspaceFavorite('alpha', 'action-centre')
    rememberWorkspaceScreen('alpha', 'daybook')

    expect(readWorkspacePrefs('alpha')).toEqual({ ...empty, favorites: ['action-centre'], recent: ['daybook'] })
    expect(readWorkspacePrefs('beta')).toEqual(empty)
  })

  it('deduplicates recent screens and never records the Gateway', () => {
    rememberWorkspaceScreen('alpha', 'daybook')
    rememberWorkspaceScreen('alpha', 'profit-loss')
    rememberWorkspaceScreen('alpha', 'daybook')
    rememberWorkspaceScreen('alpha', 'gateway')

    expect(readWorkspacePrefs('alpha').recent).toEqual(['daybook', 'profit-loss'])
  })

  it('caps each list and ignores obsolete persisted screen names', () => {
    localStorage.setItem('total-workspace-alpha', JSON.stringify({
      favorites: ['removed-screen', 'daybook'],
      recent: ['removed-screen', 'trial-balance']
    }))
    expect(readWorkspacePrefs('alpha')).toEqual({ ...empty, favorites: ['daybook'], recent: ['trial-balance'] })

    for (const screen of ['daybook', 'profit-loss', 'balance-sheet', 'trial-balance', 'cash-flow', 'registers', 'outstandings', 'exceptions', 'action-centre'] as const) {
      toggleWorkspaceFavorite('alpha', screen)
    }
    expect(readWorkspacePrefs('alpha').favorites).toHaveLength(8)
    expect(readWorkspacePrefs('alpha').favorites[0]).toBe('action-centre')
  })

  it('stores a validated company-specific Gateway layout', () => {
    saveHomeLayout('alpha', { homeOrder: ['registers', 'daybook', 'registers'], hiddenHome: ['daybook'], density: 'compact' })
    expect(readWorkspacePrefs('alpha')).toEqual({ ...empty, homeOrder: ['registers', 'daybook'], hiddenHome: ['daybook'], density: 'compact' })
    expect(readWorkspacePrefs('beta')).toEqual(empty)
  })

  it('persists role-oriented sidebar profiles without making screens unreachable globally', () => {
    saveWorkspaceProfile('alpha', 'gst')
    expect(readWorkspacePrefs('alpha').profile).toBe('gst')
    expect(screenInWorkspace('gst', 'gstr1')).toBe(true)
    expect(screenInWorkspace('gst', 'payroll')).toBe(false)
    expect(screenInWorkspace('all', 'payroll')).toBe(true)
  })

  it('carries personal pins and density across companies without leaking them to another user', () => {
    const kavya = workspaceIdentity({ name: 'Kavya Mehta', role: 'accountant' })
    const owner = workspaceIdentity({ name: 'Rohan Jindal', role: 'owner' })
    toggleWorkspaceFavorite('alpha', 'action-centre', kavya)
    saveHomeLayout('alpha', { homeOrder: ['daybook'], hiddenHome: [], density: 'compact' }, kavya)

    expect(readWorkspacePrefs('beta', kavya).favorites).toEqual(['action-centre'])
    expect(readWorkspacePrefs('beta', kavya).density).toBe('compact')
    expect(readWorkspacePrefs('beta', owner).favorites).toEqual([])
    expect(readWorkspacePrefs('beta', owner).density).toBe('comfortable')
    expect(readWorkspacePrefs('beta', kavya).homeOrder).toEqual([])
    expect(readWorkspacePrefs('alpha', kavya).homeOrder).toEqual(['daybook'])
  })
})
