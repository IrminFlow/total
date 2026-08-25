import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { resolve } from 'path'
import { SCREENS } from '../lib/screens'

/**
 * Every screen in the registry is actually rendered by App.tsx.
 *
 * The registry drives the sidebar, the Gateway cards, the command palette, the accelerator
 * letters and query invalidation — so a screen missing only from App's switch still appears
 * everywhere, is reachable by keyboard, and renders nothing. Typescript does not catch it:
 * deleting the one JSX line also deletes the only use of the import, so the file compiles.
 *
 * That happened. A merge took one branch's rewritten App.tsx wholesale — the branch had been
 * written before a screen existed — and the screen disappeared from the app while the typecheck,
 * every unit test and 49 of 50 E2E scenarios stayed green. The one scenario that caught it did so
 * by waiting for a table row, which is a slow and confusing way to be told a screen is not there.
 */

const APP = readFileSync(resolve(__dirname, '../App.tsx'), 'utf8')

describe('App.tsx', () => {
  it('renders every screen the registry knows about', () => {
    const rendered = new Set(
      [...APP.matchAll(/screen\.name === '([a-z0-9-]+)'/g)].map((m) => m[1]!)
    )
    // Screens the registry lists but that are reached another way (a modal, a sub-tab of another
    // screen) would go here with a reason. There are none today, and an empty exception list is
    // the honest state to leave it in.
    const missing = SCREENS.map((s) => s.name).filter((name) => !rendered.has(name))
    expect(missing).toEqual([])
  })

  it('does not render a screen the registry has forgotten', () => {
    // The other direction: a screen still wired into App but dropped from the registry is
    // unreachable — no sidebar entry, no palette hit, no accelerator — and looks like dead code
    // that somebody will eventually delete along with a feature that still worked.
    const known = new Set<string>(SCREENS.map((s) => s.name))
    // These are real screens that are deliberately not registry entries: they are states of the
    // shell rather than destinations you navigate to.
    const NOT_IN_REGISTRY = new Set(['company-select', 'lock'])
    const stray = [...APP.matchAll(/screen\.name === '([a-z0-9-]+)'/g)]
      .map((m) => m[1]!)
      .filter((name) => !known.has(name) && !NOT_IN_REGISTRY.has(name))
    expect([...new Set(stray)]).toEqual([])
  })
})
