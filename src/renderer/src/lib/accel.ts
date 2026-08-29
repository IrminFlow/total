/**
 * Accelerator rendering — turning a screen's `accel` letter into the red character users press.
 *
 * Tally's whole navigation model is "one letter of every menu item is highlighted; press it".
 * The letter is not always the first one ("Ba_l_ance Sheet"), so rendering means splitting the
 * label around the first occurrence of the accelerator. Screens whose label has no free letter
 * left carry an accelerator that is not in the label at all; those render as a trailing badge.
 */

import { NAV_SECTIONS, SCREENS, type ScreenDef } from './screens'

export interface AccelSplit {
  before: string
  /** The highlighted character, or null when the accelerator isn't present in the label. */
  hit: string | null
  after: string
}

/**
 * Split `label` around its accelerator. Matching is case-insensitive but the ORIGINAL character
 * is returned, so "Payroll" + "Y" highlights the lowercase "y" that is actually on screen.
 */
export function splitAccel(label: string, accel?: string, at?: number): AccelSplit {
  if (!accel) return { before: label, hit: null, after: '' }
  const index = at ?? label.toLowerCase().indexOf(accel.toLowerCase())
  if (index < 0 || index >= label.length) return { before: label, hit: null, after: '' }
  return {
    before: label.slice(0, index),
    hit: label.charAt(index),
    after: label.slice(index + 1)
  }
}

/**
 * Accelerator -> screen, built once. Uppercase keys; look up with `key.toUpperCase()`.
 * This is the nav layer's entire dispatch table.
 */
export const NAV_ACCEL: ReadonlyMap<string, ScreenDef> = new Map(
  SCREENS.filter((s) => s.accel && s.screen).map((s) => [s.accel!.toUpperCase(), s])
)

/**
 * The sidebar in the order it is drawn, for ⌘1–⌘9.
 *
 * Derived from the same registry and section order the sidebar renders from, so the ninth entry
 * here is the ninth entry on screen. Feature-gated sections are NOT filtered out: the gate
 * depends on the open company, and a positional shortcut that silently means a different screen
 * per company is worse than one that occasionally does nothing. The nav layer checks the gate.
 */
export const NAV_ORDER: readonly ScreenDef[] = NAV_SECTIONS.flatMap((section) =>
  SCREENS.filter((s) => s.navSection === section.id && s.screen)
)
