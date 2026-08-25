/**
 * Which screens shadow which navigation letters (#21).
 *
 * The layer stack makes shadowing work correctly — a screen layer sits above the nav layer, so
 * while voucher entry is open `C` starts a contra rather than jumping to Cost centres. That is
 * the right behaviour and it is not the complaint.
 *
 * The complaint is that it is invisible. A user who has learned that `C` is Cost centres presses
 * it on voucher entry, gets a contra, and has no way to find out why — the sidebar greys the
 * letter out while the screen is open, which explains it at the exact moment you are no longer
 * looking. Settings is where you go to ask a question about the app rather than about the books,
 * and this is the answer to "why does C sometimes do something else".
 *
 * This is deliberately NOT remapping. Roadmap #22 declined per-user remapping and the reason
 * stands: every surface in the app renders the shortcut it binds *from* the binding, and the one
 * thing a Tally user can rely on is that `V` is voucher entry on every machine in the office.
 * Naming the collisions costs nothing and fixes the actual confusion.
 *
 * Pure data in, pure data out — the Settings panel only renders it, and a renderer test can pin
 * the whole report without mounting anything.
 */

import type { ScreenDef } from './screens'
import { VOUCHER_TYPE_KEYS } from './voucherTypeKeys'

/** One bare key a screen claims for itself while it is open. */
export interface ScreenKeyClaim {
  /** Registry name of the screen doing the claiming. */
  screen: ScreenDef['name']
  /** The bare key, any case. */
  key: string
  /** What it does on that screen. */
  label: string
}

export interface ShortcutConflict {
  /** Uppercase, as every surface renders it. */
  key: string
  /** The screen that takes the key over. */
  screen: ScreenDef['name']
  screenTitle: string
  /** What the key does there. */
  action: string
  /** The navigation destination it shadows while that screen is open. */
  shadows: string
}

/**
 * Every claimed key that also belongs to a navigation accelerator.
 *
 * A claim on a letter no screen navigates to is not a conflict and is not reported: `J` is a
 * journal on voucher entry and nothing anywhere else, and listing it would bury the five that
 * matter in a list of ten that do not.
 *
 * Sorted by key so the report reads the same every time. Two screens claiming the same letter
 * both appear — they are separate facts about separate screens, and collapsing them would hide
 * one of them.
 */
export function shortcutConflicts(screens: ScreenDef[], claims: ScreenKeyClaim[]): ShortcutConflict[] {
  const navByKey = new Map<string, ScreenDef>()
  for (const screen of screens) {
    if (screen.accel) navByKey.set(screen.accel.toUpperCase(), screen)
  }
  const titleOf = new Map(screens.map((s) => [s.name, s.title]))

  const out: ShortcutConflict[] = []
  for (const claim of claims) {
    const key = claim.key.toUpperCase()
    const shadowed = navByKey.get(key)
    if (!shadowed) continue
    // A screen shadowing its OWN accelerator is not a conflict: pressing V on voucher entry
    // doing something voucher-entry-ish is exactly what anyone would expect.
    if (shadowed.name === claim.screen) continue
    out.push({
      key,
      screen: claim.screen,
      screenTitle: titleOf.get(claim.screen) ?? claim.screen,
      action: claim.label,
      shadows: shadowed.title
    })
  }
  return out.sort((a, b) => a.key.localeCompare(b.key) || a.screenTitle.localeCompare(b.screenTitle))
}

/**
 * Every bare key any screen claims, derived rather than listed.
 *
 * Derived from the same array the screen binds, so the report cannot describe a shortcut that no
 * longer exists — which is the specific way a hand-maintained second list goes wrong, quietly and
 * for months. When another screen starts claiming bare letters, add its array here the same way.
 */
export const SCREEN_KEY_CLAIMS: ScreenKeyClaim[] = VOUCHER_TYPE_KEYS.filter((t) => t.key).map((t) => ({
  screen: 'voucher-entry' as const,
  key: t.key!,
  label: t.label
}))
