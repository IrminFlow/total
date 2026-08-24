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
  | { name: 'daybook'; span?: { from: string; to: string; label: string }; kind?: string }
  | { name: 'import-tally' }
  // `draftId` forces VoucherEntry to remount when a new draft targets the same 'new' voucher slot
  // (e.g. two "Create purchase" nudges in a row) — App.tsx keys the component on it, see there.
  | { name: 'voucher-entry'; voucherId?: number; kindHint?: VoucherKind; draft?: VoucherDraft; draftId?: number }
  // Like 'settings', the active tab lives in the nav stack (nav.go per tab) so Esc/back
  // retraces tabs and other screens can deep-link straight to one.
  | { name: 'masters'; tab?: 'ledgers' | 'groups' | 'items' | 'units' | 'types' | 'currencies' | 'godowns' | 'stock-groups' }
  | { name: 'trial-balance' }
  | { name: 'profit-loss' }
  | { name: 'balance-sheet' }
  | { name: 'cash-flow' }
  | { name: 'exceptions' }
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
  | { name: 'filings' }
  | { name: 'composition' }
  | { name: 'tds' }
  | { name: 'cost-centres' }
  | { name: 'budgets' }
  | { name: 'company-info' }
  | { name: 'year-end' }
  | { name: 'settings'; tab?: 'backups' | 'bin' | 'users' | 'audit' | 'nic' | 'features' | 'invoice' | 'agents' | 'ai' | 'license' | 'about' }

interface NavState {
  stack: Screen[]
  /**
   * Screens popped off `stack` by `back`, newest last — the forward history.
   *
   * Cleared by `go` and `home`, because navigating somewhere new makes the old forward path
   * unreachable; keeping it would let ⌘] jump to a screen the user never came from.
   */
  forward: Screen[]
  go: (screen: Screen) => void
  replace: (screen: Screen) => void
  back: () => void
  forwardTo: () => void
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
  forward: [],
  go: (screen) => {
    void confirmLeave().then((ok) => {
      if (ok) set((s) => ({ stack: [...s.stack, screen], forward: [] }))
    })
  },
  // No forward bookkeeping: `replace` swaps the current screen for an equivalent one right after
  // a save, so there is nothing to go back or forward to.
  replace: (screen) => set((s) => ({ stack: [...s.stack.slice(0, -1), screen] })),
  back: () => {
    void confirmLeave().then((ok) => {
      if (!ok) return
      set((s) =>
        s.stack.length > 1
          ? { stack: s.stack.slice(0, -1), forward: [...s.forward, s.stack[s.stack.length - 1]!] }
          : s
      )
    })
  },
  forwardTo: () => {
    void confirmLeave().then((ok) => {
      if (!ok) return
      set((s) =>
        s.forward.length > 0
          ? { stack: [...s.stack, s.forward[s.forward.length - 1]!], forward: s.forward.slice(0, -1) }
          : s
      )
    })
  },
  home: () => {
    void confirmLeave().then((ok) => {
      if (ok) set({ stack: [{ name: 'gateway' }], forward: [] })
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
  /**
   * An action offered alongside the message, used for undo.
   *
   * Undo lives on the toast rather than as a separate control because the moment a destructive
   * action completes is the only moment the user is looking for it. Running it dismisses the
   * toast, so the offer cannot be taken twice.
   */
  action?: { label: string; run: () => void | Promise<void> }
}

export interface ToastState {
  toasts: Toast[]
  push: (kind: Toast['kind'], text: string, action?: Toast['action']) => void
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
    push: (kind, text, action) => {
      // Dedupe consecutive identical toasts: just restart the existing one's clock. A toast
      // carrying an action is never deduped -- two deletions need two separate undos, and
      // collapsing them would silently drop one.
      const last = get().toasts[get().toasts.length - 1]
      // An undo is worth reading; give it longer than a routine confirmation.
      const ttl = action ? 9000 : kind === 'error' ? 6000 : 3500
      if (!action && last && last.kind === kind && last.text === text) {
        const entry = toastTimers.get(last.id)
        if (entry) clearTimeout(entry.timer)
        if (toastRemaining) toastRemaining.set(last.id, ttl)
        else arm(last.id, ttl)
        return
      }
      const id = ++toastId
      set((s) => ({ toasts: [...s.toasts, { id, kind, text, action }] }))
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
