import { create } from 'zustand'
import type { CompanyInfo, VoucherKind } from '@shared/domain'
import { fyOf, todayISO } from '@shared/dates'
import type { SessionUser } from '../lib/client'

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
  | { name: 'daybook' }
  // `draftId` forces VoucherEntry to remount when a new draft targets the same 'new' voucher slot
  // (e.g. two "Create purchase" nudges in a row) — App.tsx keys the component on it, see there.
  | { name: 'voucher-entry'; voucherId?: number; kindHint?: VoucherKind; draft?: VoucherDraft; draftId?: number }
  | { name: 'masters'; tab?: 'ledgers' | 'groups' | 'items' | 'units' | 'types' }
  | { name: 'trial-balance' }
  | { name: 'profit-loss' }
  | { name: 'balance-sheet' }
  | { name: 'stock-summary' }
  | { name: 'ledger-statement'; ledgerId: number }
  | { name: 'gstr1' }
  | { name: 'gstr3b' }
  | { name: 'gstr2b' }
  | { name: 'edocs' }
  | { name: 'registers' }
  | { name: 'outstandings' }
  | { name: 'consolidated' }
  | { name: 'recurring' }
  | { name: 'banking' }
  | { name: 'payroll' }
  | { name: 'tds' }
  | { name: 'cost-centres' }
  | { name: 'budgets' }
  | { name: 'company-info' }
  | { name: 'year-end' }
  | { name: 'settings'; tab?: 'backups' | 'bin' | 'users' | 'audit' | 'nic' | 'features' | 'invoice' | 'about' }

interface NavState {
  stack: Screen[]
  go: (screen: Screen) => void
  replace: (screen: Screen) => void
  back: () => void
  home: () => void
}

export const useNav = create<NavState>((set) => ({
  stack: [{ name: 'gateway' }],
  go: (screen) => set((s) => ({ stack: [...s.stack, screen] })),
  replace: (screen) => set((s) => ({ stack: [...s.stack.slice(0, -1), screen] })),
  back: () => set((s) => (s.stack.length > 1 ? { stack: s.stack.slice(0, -1) } : s)),
  home: () => set({ stack: [{ name: 'gateway' }] })
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

// ---------- theme ----------

export type Theme = 'light' | 'dark'

interface ThemeState {
  theme: Theme
  toggle: () => void
}

export function applyTheme(theme: Theme): void {
  document.documentElement.dataset.theme = theme
  localStorage.setItem('total-theme', theme)
}

export function initialTheme(): Theme {
  const stored = localStorage.getItem('total-theme')
  return stored === 'dark' ? 'dark' : 'light'
}

export const useTheme = create<ThemeState>((set) => ({
  theme: initialTheme(),
  toggle: () =>
    set((s) => {
      const next: Theme = s.theme === 'light' ? 'dark' : 'light'
      applyTheme(next)
      return { theme: next }
    })
}))

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
}

let toastId = 0
export const useToasts = create<ToastState>((set) => ({
  toasts: [],
  push: (kind, text) => {
    const id = ++toastId
    set((s) => ({ toasts: [...s.toasts, { id, kind, text }] }))
    setTimeout(() => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })), kind === 'error' ? 6000 : 3500)
  },
  dismiss: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }))
}))
