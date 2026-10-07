import { create } from 'zustand'
import type { CompanyInfo, VoucherKind } from '@shared/domain'
import { fyOf, todayISO } from '@shared/dates'
import type { SessionUser } from '../lib/client'
import { confirmDialog } from '../lib/dialogs'
import { hasUnsavedChanges } from '../lib/useUnsavedGuard'

// ---------- navigation ----------

/**
 * Partial prefill for a fresh voucher — e.g. a "Create purchase" nudge from GSTR-2B recon
 * handing over what it already knows (date, narration) while leaving party/lines to the user.
 */
export interface VoucherDraft {
  date?: string
  partyLedgerId?: number
  narration?: string
  lines?: { ledgerId: number; drCr: 'dr' | 'cr'; amount: number }[]
}

/**
 * Monotonic counter for `Screen`'s voucher-entry `draftId` — a plain in-memory counter rather
 * than `Date.now()`, since two drafts navigated within the same millisecond (e.g. rapid double
 * clicks) would otherwise collide and fail to force VoucherEntry's remount.
 */
let draftIdCounter = 0
export function nextDraftId(): number {
  draftIdCounter += 1
  return draftIdCounter
}

export type Screen =
  | { name: 'gateway' }
  // Optional drill params (Registers month rows → filtered Day Book): restrict to one
  // 'YYYY-MM' month and/or one voucher-type kind ('sales' | 'purchase' | …).
  | { name: 'daybook'; month?: string; kind?: string }
  | { name: 'import-tally' }
  // `draftId` forces VoucherEntry to remount when a new draft targets the same 'new' voucher slot
  // (e.g. two "Create purchase" nudges in a row) — App.tsx keys the component on it, see there.
  | { name: 'voucher-entry'; voucherId?: number; kindHint?: VoucherKind; draft?: VoucherDraft; draftId?: number }
  // Like 'settings', the active tab lives in the nav stack (nav.go per tab) so Esc/back
  // retraces tabs and other screens can deep-link straight to one.
  // `itemId` (items tab only) opens that stock item's editor — how search results open an item.
  // WP 2.2: a new manufacture voucher (saved ones open through voucher-entry, same form).
  // WP 2.4: `jobWork` opens it in "Receive from job worker" mode; `prefill` starts it for an item
  // and quantity ("manufacture the sub-assembly first" links).
  | { name: 'manufacture'; jobWork?: boolean; prefill?: { itemId: number; qtyMilli: number } }
  | { name: 'manufacture-register' }
  | { name: 'manufacture-reports'; tab?: 'production' | 'cost-sheet' | 'margin' | 'variance' | 'job-work' }
  | { name: 'masters'; tab?: 'ledgers' | 'groups' | 'items' | 'units' | 'types' | 'currencies' | 'godowns' | 'stock-groups'; itemId?: number }
  // Books search results (⌘⇧F, or "See all" in the ⌘K palette): `q` is the query-language
  // string, `kind` the initially selected tab (omitted = all kinds).
  | { name: 'search'; q?: string; kind?: 'ledger' | 'item' | 'voucher' }
  | { name: 'trial-balance' }
  | { name: 'profit-loss' }
  | { name: 'balance-sheet' }
  | { name: 'cash-flow' }
  | { name: 'exceptions' }
  | { name: 'stock-summary' }
  | { name: 'stock-movements'; itemId?: number; godownId?: number }
  // WP 2.4: `mode` opens a stock-journal kind directly (e.g. 'jobWork' = Send to job worker).
  | { name: 'stock-journal'; mode?: 'transfer' | 'adjust' | 'jobWork' }
  | { name: 'stock-reports'; tab?: 'reorder' | 'ageing' | 'expiry' | 'serials' | 'labels' }
  | { name: 'ledger-statement'; ledgerId: number }
  | { name: 'gstr1' }
  | { name: 'gstr3b' }
  | { name: 'gstr2b' }
  // WP 3.4 — GST expansion: tabs of the GST returns screen family.
  | { name: 'gstr9' }
  | { name: 'itc04' }
  | { name: 'itc-reversal' }
  | { name: 'edocs'; tab?: 'documents' | 'self-invoices' }
  | { name: 'registers' }
  | { name: 'outstandings' }
  // WP 2.5b: delivery challans not invoiced / GRNs not billed.
  | { name: 'pending-challans' }
  | { name: 'pending-grns' }
  | { name: 'consolidated' }
  | { name: 'banking' }
  | { name: 'payroll' }
  | { name: 'tds' }
  | { name: 'tcs' }
  | { name: 'cost-centres' }
  | { name: 'budgets' }
  | { name: 'company-info' }
  | { name: 'year-end' }
  | { name: 'fixed-assets'; tab?: 'register' | 'depreciation' | 'schedule' | 'income-tax' | 'setup' }
  | { name: 'settings'; tab?: 'appearance' | 'backups' | 'bin' | 'users' | 'audit' | 'nic' | 'features' | 'invoice' | 'agents' | 'about' }

interface NavState {
  stack: Screen[]
  go: (screen: Screen) => void
  replace: (screen: Screen) => void
  back: () => void
  home: () => void
}

/** True when navigation may proceed — asks to discard when a screen registered unsaved changes.
 *  `replace` deliberately skips this: it's only used programmatically right after a save. */
async function confirmLeave(): Promise<boolean> {
  if (!hasUnsavedChanges()) return true
  return confirmDialog({
    title: 'Unsaved changes',
    message: 'Leave this screen and discard your unsaved changes?',
    confirmLabel: 'Discard changes',
    cancelLabel: 'Stay',
    danger: true
  })
}

export const useNav = create<NavState>((set) => ({
  stack: [{ name: 'gateway' }],
  go: (screen) => {
    void confirmLeave().then((ok) => {
      if (ok) set((s) => ({ stack: [...s.stack, screen] }))
    })
  },
  replace: (screen) => set((s) => ({ stack: [...s.stack.slice(0, -1), screen] })),
  back: () => {
    void confirmLeave().then((ok) => {
      if (ok) set((s) => (s.stack.length > 1 ? { stack: s.stack.slice(0, -1) } : s))
    })
  },
  home: () => {
    void confirmLeave().then((ok) => {
      if (ok) set({ stack: [{ name: 'gateway' }] })
    })
  }
}))

export const useScreen = (): Screen => useNav((s) => s.stack[s.stack.length - 1]!)

// ---------- session (open company + working period) ----------

interface SessionState {
  slug: string | null
  info: CompanyInfo | null
  from: string
  to: string
  /** Context date for smart date entry — last used voucher date. */
  workingDate: string
  /** The signed-in local user for the open company, or null before login / after Lock. */
  user: SessionUser | null
  /** True when the open company has users and no one has signed in yet — LockScreen shows. */
  locked: boolean
  /** Set immediately (synchronously, alongside the rest of the commit) after a Settings →
   *  Backups restore whose post-restore integrity check found a problem. Deliberately store-level
   *  rather than local component state: a restore very often also flips `locked`, which unmounts
   *  whatever screen triggered it (Settings) in the same render — component-local state would be
   *  discarded right along with it. App.tsx renders the warning once, above both the locked and
   *  unlocked layouts, so no navigation or unmount can make it disappear before it's dismissed. */
  integrityWarning: { quickCheck: string; unbalancedVoucherIds: number[]; context: string } | null
  setCompany: (slug: string, info: CompanyInfo, locked?: boolean) => void
  clearCompany: () => void
  setPeriod: (from: string, to: string) => void
  setWorkingDate: (date: string) => void
  setUser: (user: SessionUser | null) => void
  setLocked: (locked: boolean) => void
  setIntegrityWarning: (warning: SessionState['integrityWarning']) => void
}

const fy = fyOf(todayISO())

export const useSession = create<SessionState>((set) => ({
  slug: null,
  info: null,
  from: fy.from,
  to: fy.to,
  workingDate: todayISO(),
  user: null,
  locked: false,
  integrityWarning: null,
  setCompany: (slug, info, locked = false) => set({ slug, info, locked }),
  clearCompany: () => set({ slug: null, info: null, user: null, locked: false, integrityWarning: null }),
  setPeriod: (from, to) => set({ from, to }),
  setWorkingDate: (workingDate) => set({ workingDate }),
  setUser: (user) => set({ user }),
  setLocked: (locked) => set({ locked }),
  setIntegrityWarning: (integrityWarning) => set({ integrityWarning })
}))

// ---------- working-period picker ----------

/** The header's "Working period" modal — opened from the header button, a screen's Options
 *  drawer, or the command palette. Shell renders it. */
export const usePeriodPicker = create<{ open: boolean; setOpen: (open: boolean) => void }>((set) => ({
  open: false,
  setOpen: (open) => set({ open })
}))

// ---------- appearance: theme, density, motion ----------
//
// Display preferences for the whole app (not per company) — localStorage, applied as attributes
// on <html>: data-theme (light/dark, resolved from the light/dark/system choice), data-density
// (comfortable/compact — app.css density variables, DataTable's default row density) and
// data-motion ("reduce" when the user forces reduced motion; otherwise the OS setting applies).

export type Theme = 'light' | 'dark'
export type ThemePref = Theme | 'system'
export type Density = 'comfortable' | 'compact'

const THEME_KEY = 'total-theme'
const DENSITY_KEY = 'total-density'
const MOTION_KEY = 'total-reduce-motion'

const readStore = (key: string): string | null => {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}
const writeStore = (key: string, value: string): void => {
  try {
    localStorage.setItem(key, value)
  } catch {
    /* private mode / quota — the choice still applies for this session */
  }
}

function systemTheme(): Theme {
  return typeof window !== 'undefined' && window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

export function resolveTheme(pref: ThemePref): Theme {
  return pref === 'system' ? systemTheme() : pref
}

/** Applies a theme choice to <html> and persists it. */
export function applyTheme(pref: ThemePref): void {
  document.documentElement.dataset.theme = resolveTheme(pref)
  writeStore(THEME_KEY, pref)
}

export function initialTheme(): ThemePref {
  const stored = readStore(THEME_KEY)
  return stored === 'dark' || stored === 'system' ? stored : 'light'
}

export function applyDensity(density: Density): void {
  document.documentElement.dataset.density = density
  writeStore(DENSITY_KEY, density)
}

export function initialDensity(): Density {
  return readStore(DENSITY_KEY) === 'compact' ? 'compact' : 'comfortable'
}

export function applyReduceMotion(reduce: boolean): void {
  if (reduce) document.documentElement.dataset.motion = 'reduce'
  else delete document.documentElement.dataset.motion
  writeStore(MOTION_KEY, reduce ? '1' : '0')
}

export function initialReduceMotion(): boolean {
  return readStore(MOTION_KEY) === '1'
}

/** Applies every stored appearance preference — called once at startup (main.tsx). */
export function applyStoredAppearance(): void {
  applyTheme(initialTheme())
  applyDensity(initialDensity())
  applyReduceMotion(initialReduceMotion())
}

interface ThemeState {
  /** The theme in effect (system resolved). */
  theme: Theme
  /** The user's choice. */
  pref: ThemePref
  setPref: (pref: ThemePref) => void
  /** Header button: flips the theme in effect and makes it an explicit choice. */
  toggle: () => void
  /** Re-resolve after the OS theme changed (only matters for 'system'). */
  syncSystem: () => void
}

export const useTheme = create<ThemeState>((set, get) => ({
  theme: resolveTheme(initialTheme()),
  pref: initialTheme(),
  setPref: (pref) => {
    applyTheme(pref)
    set({ pref, theme: resolveTheme(pref) })
  },
  toggle: () => get().setPref(get().theme === 'light' ? 'dark' : 'light'),
  syncSystem: () => {
    if (get().pref !== 'system') return
    applyTheme('system')
    set({ theme: resolveTheme('system') })
  }
}))

// Follow the OS theme while the choice is 'system'.
if (typeof window !== 'undefined' && window.matchMedia) {
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', () => useTheme.getState().syncSystem())
}

interface AppearanceState {
  density: Density
  reduceMotion: boolean
  setDensity: (density: Density) => void
  setReduceMotion: (reduce: boolean) => void
}

export const useAppearance = create<AppearanceState>((set) => ({
  density: initialDensity(),
  reduceMotion: initialReduceMotion(),
  setDensity: (density) => {
    applyDensity(density)
    set({ density })
  },
  setReduceMotion: (reduceMotion) => {
    applyReduceMotion(reduceMotion)
    set({ reduceMotion })
  }
}))

/** The app-wide density (DataTable's default when its view doesn't pick one). */
export const useDensity = (): Density => useAppearance((s) => s.density)

// ---------- toasts ----------

export interface Toast {
  id: number
  kind: 'info' | 'success' | 'error' | 'warning'
  text: string
}

export interface ToastState {
  toasts: Toast[]
  push: (kind: Toast['kind'], text: string) => void
  dismiss: (id: number) => void
  /** Pause auto-dismissal (hovering the toast stack); resume() restarts the remaining time. */
  pause: () => void
  resume: () => void
}

let toastId = 0
/** Per-toast auto-dismiss bookkeeping so hover can pause/resume with the remaining time intact. */
const toastTimers = new Map<number, { timer: ReturnType<typeof setTimeout>; deadline: number }>()
let toastRemaining: Map<number, number> | null = null // non-null while paused

export const useToasts = create<ToastState>((set, get) => {
  const expire = (id: number): void => {
    toastTimers.delete(id)
    set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }))
  }
  const arm = (id: number, ms: number): void => {
    toastTimers.set(id, { timer: setTimeout(() => expire(id), ms), deadline: Date.now() + ms })
  }
  return {
    toasts: [],
    push: (kind, text) => {
      // Dedupe consecutive identical toasts: just restart the existing one's clock.
      const last = get().toasts[get().toasts.length - 1]
      const ttl = kind === 'error' ? 6000 : 3500
      if (last && last.kind === kind && last.text === text) {
        const entry = toastTimers.get(last.id)
        if (entry) clearTimeout(entry.timer)
        if (toastRemaining) toastRemaining.set(last.id, ttl)
        else arm(last.id, ttl)
        return
      }
      const id = ++toastId
      set((s) => ({ toasts: [...s.toasts, { id, kind, text }] }))
      if (toastRemaining) toastRemaining.set(id, ttl)
      else arm(id, ttl)
    },
    dismiss: (id) => {
      const entry = toastTimers.get(id)
      if (entry) clearTimeout(entry.timer)
      toastTimers.delete(id)
      toastRemaining?.delete(id)
      set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }))
      // Dismissing the last toast removes the element under the cursor, so no mouseleave will
      // ever fire — drop the paused state here or the next toast would never auto-expire.
      if (get().toasts.length === 0) toastRemaining = null
    },
    pause: () => {
      if (toastRemaining) return
      toastRemaining = new Map()
      for (const [id, entry] of toastTimers) {
        clearTimeout(entry.timer)
        toastRemaining.set(id, Math.max(500, entry.deadline - Date.now()))
      }
      toastTimers.clear()
    },
    resume: () => {
      if (!toastRemaining) return
      const remaining = toastRemaining
      toastRemaining = null
      for (const [id, ms] of remaining) arm(id, ms)
    }
  }
})
