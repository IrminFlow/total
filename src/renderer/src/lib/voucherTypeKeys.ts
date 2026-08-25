/**
 * The voucher-type accelerators, as plain data.
 *
 * This list used to live inside VoucherEntry.tsx, which was fine while the only thing that read
 * it was the screen that bound it. It is now also read by the shortcut-conflict report in
 * Settings (#21), which has to be able to say "on Voucher entry, C is Contra and shadows Cost
 * centres" WITHOUT the voucher entry screen being mounted. A second, hand-maintained copy of the
 * letters would be exactly the drift the accelerator registry exists to prevent — the report
 * would go on describing a shortcut nobody had bound for months.
 *
 * So: one array, no React, imported by both.
 */

import type { VoucherKind } from '@shared/domain'

export interface VoucherTypeKey {
  kind: VoucherKind
  /** Tally function key. Fires even with the cursor in a field. */
  fkey?: string
  /** Bare letter. Fires only when focus is outside a text field. */
  key?: string
  label: string
  /** The F-key form needs Ctrl or Alt, because it shares a key with another type. */
  ctrlOrAlt?: boolean
}

/**
 * Voucher types reachable by keyboard, each with BOTH a Tally function key and a bare letter.
 *
 * The F-keys are twenty years of muscle memory and are the primary path here, because they fire
 * even with the cursor in a field — which is where it almost always is on this screen. The
 * letters are the "just arrived, or just pressed Esc" path, and they are what makes the screen
 * consistent with every menu in the app. Both are advertised in the footer and in `?`.
 *
 * Letters that collide with a navigation accelerator (C = cost centres, P = P&L, R = registers,
 * S = stock summary, U = budgets; J is free) win while this screen is open, because the screen
 * layer sits above the nav layer. The sidebar greys those letters out so the shadowing is visible
 * rather than surprising, and Settings → Shortcuts lists every one of them.
 */
export const VOUCHER_TYPE_KEYS: VoucherTypeKey[] = [
  { kind: 'contra', fkey: 'F4', key: 'c', label: 'Contra' },
  { kind: 'payment', fkey: 'F5', key: 'p', label: 'Payment' },
  { kind: 'receipt', fkey: 'F6', key: 'r', label: 'Receipt' },
  { kind: 'journal', fkey: 'F7', key: 'j', label: 'Journal' },
  { kind: 'sales', fkey: 'F8', key: 's', label: 'Sales' },
  { kind: 'purchase', fkey: 'F9', key: 'u', label: 'Purchase' },
  // Credit/debit note keep ONLY their Tally modifier keys. A bare letter for them would have to
  // be D and E, which are Day book and Settings — shadowing the two most-used destinations in
  // the app for two rarely-used voucher types is a bad trade. Ctrl/Alt+F8/F9 is what a Tally
  // user reaches for anyway, and the type pills and Cmd-K still work.
  { kind: 'credit_note', fkey: 'F8', label: 'Credit note', ctrlOrAlt: true },
  { kind: 'debit_note', fkey: 'F9', label: 'Debit note', ctrlOrAlt: true },
  // No Tally F-key exists for these two; before the registry they had no keyboard path at all.
  { kind: 'stock_journal', key: 'k', label: 'Stock journal' },
  { kind: 'physical_stock', key: 'y', label: 'Physical stock' }
]
