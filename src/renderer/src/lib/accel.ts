/**
 * Accelerator rendering — turning a screen's `accel` letter into the red character users press.
 *
 * Tally's whole navigation model is "one letter of every menu item is highlighted; press it".
 * The letter is not always the first one ("Ba_l_ance Sheet"), so rendering means splitting the
 * label around the first occurrence of the accelerator. Screens whose label has no free letter
 * left carry an accelerator that is not in the label at all; those render as a trailing badge.
 */

import { SCREENS, type ScreenDef } from './screens'

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
