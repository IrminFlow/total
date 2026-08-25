import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { SCREENS } from '../lib/screens'

/**
 * Every react-query family must be refreshed by some screen when you navigate to it.
 *
 * `staleTime` is 5 seconds, so a query whose family nothing invalidates serves a cached answer to
 * anyone who arrives within five seconds of the last visit. That is not theoretical: setting a
 * reorder level and walking straight to Stock summary showed no purchase suggestion, and the E2E
 * suite failed about half the time because half the time the walk took longer than five seconds.
 *
 * This is the same guard shape as accel.test.ts — a list that must stay in step with the code,
 * enforced in CI rather than remembered, with an explicit allowlist so every exemption is a
 * decision somebody made on purpose.
 */

/**
 * Families deliberately not tied to a screen's arrival.
 *
 * Two honest reasons appear here. A query that only ever runs inside a modal is fetched when the
 * modal opens and thrown away when it closes, so navigation has nothing to refresh. A query keyed
 * on something the user just typed (an amount, a date, an id) has a different key per question
 * and cannot serve a stale answer to a new one.
 */
const NOT_NAVIGATION_SCOPED = new Set([
  // Settings panels and their modals — reached by opening the thing, refreshed by saving it.
  // aiSpend rides with aiConfig: both are machine-level, both are refreshed by saving the panel
  // they live in, and neither is a fact about the company a screen could invalidate.
  'aiConfig', 'aiSpend', 'backupKeep', 'backupVerify', 'binPurge', 'license', 'mcpSnippet', 'registry',
  'diagnostics', 'voucherCount',
  // The lock screen is not a screen in the registry — it replaces the shell entirely, and its
  // list of who can sign in is fetched when it appears.
  'auth-users',
  // Audit trails shown inside a record's own modal.
  'employeeAudit', 'voucherAudit',
  // Voucher templates (#27) exist only inside the picker modal on the entry screen: the list is
  // fetched when it opens and thrown away when it closes, so arriving at a screen has nothing to
  // refresh. Saving or deleting one invalidates the family directly.
  'vtemplates',
  // Keyed on what the user is entering right now, so a stale key is a different key.
  'creditCheck', 'settlement', 'search', 'latestOfType', 'ledgerBalances'
])

function walk(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) out.push(...walk(full))
    else if (full.endsWith('.tsx') || full.endsWith('.ts')) out.push(full)
  }
  return out
}

const SRC = join(__dirname, '..')

/** First element of every `queryKey: ['family', ...]` literal under the renderer. */
function usedFamilies(): Map<string, string[]> {
  const families = new Map<string, string[]>()
  for (const file of walk(SRC)) {
    if (file.includes('__tests__')) continue
    const text = readFileSync(file, 'utf8')
    for (const m of text.matchAll(/queryKey: \[\s*'([a-zA-Z0-9_-]+)'/g)) {
      const name = m[1] as string
      families.set(name, [...(families.get(name) ?? []), file.replace(SRC, '')])
    }
  }
  return families
}

describe('query invalidation registry', () => {
  const declared = new Set(SCREENS.flatMap((s) => s.invalidates))

  it('every query family is either invalidated by a screen or explicitly exempt', () => {
    const orphans = [...usedFamilies().entries()]
      .filter(([name]) => !declared.has(name) && !NOT_NAVIGATION_SCOPED.has(name))
      .map(([name, files]) => `${name} (${files.join(', ')})`)
    expect(orphans).toEqual([])
  })

  it('every declared family is actually used by a query somewhere', () => {
    // The other direction: a name nothing uses is a silent no-op, because invalidation matches by
    // prefix and an unknown prefix matches nothing.
    const used = usedFamilies()
    const dead = [...declared].filter((name) => !used.has(name))
    expect(dead).toEqual([])
  })

  it('does not exempt a family that no longer exists', () => {
    const used = usedFamilies()
    const stale = [...NOT_NAVIGATION_SCOPED].filter((name) => !used.has(name))
    expect(stale).toEqual([])
  })
})
