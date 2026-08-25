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
  /**
   * The assistant run that proposed this draft, when one did.
   *
   * Carried so that a SAVED voucher can be joined back to the question that produced it
   * (roadmap #217). The link is written after the save succeeds, by the entry screen — never by
   * the assistant, which has no way to write anything.
   */
  aiRunId?: string
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
  | { name: 'khata' }
  | { name: 'collections' }
  | { name: 'assets' }
  | { name: 'counter' }
  | { name: 'sales-chain' }
  | { name: 'job-work' }
  | { name: 'borrowing' }
  | { name: 'disclosure' }
  | { name: 'filings' }
  | { name: 'composition' }
  | { name: 'tds' }
  | { name: 'cost-centres' }
  | { name: 'budgets' }
  | { name: 'company-info' }
  | { name: 'year-end' }
  | {
      name: 'settings'
      tab?:
        | 'appearance' | 'backups' | 'bin' | 'users' | 'audit' | 'approvals' | 'auditor' | 'nic'
        | 'features' | 'invoice' | 'collections' | 'schedules' | 'agents' | 'ai' | 'license'
        | 'customFields' | 'about'
    }

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

// ---------- the ask drawer ----------

/**
 * Whether the assistant drawer is open, and a question waiting to be asked in it.
 *
 * A store rather than Shell state because three places open it and only one of them is Shell:
 * ⌘J, the command palette when a typed question has no deterministic report behind it, and the
 * GST screen's "explain these issues". Passing a callback down to all three would put the
 * drawer's state in everyone's props for the sake of one boolean.
 *
 * `pending` is taken exactly once, by the drawer, on mount. A question that stayed in the store
 * would be re-asked every time the drawer reopened.
 */
interface AskState {
  open: boolean
  pending: string | null
  openAsk: (question?: string) => void
  closeAsk: () => void
  toggleAsk: () => void
  takePending: () => string | null
}

export const useAsk = create<AskState>((set, get) => ({
  open: false,
  pending: null,
  openAsk: (question) => set({ open: true, pending: question ?? null }),
  closeAsk: () => set({ open: false, pending: null }),
  toggleAsk: () => set((s) => ({ open: !s.open, pending: null })),
  takePending: () => {
    const pending = get().pending
    if (pending) set({ pending: null })
    return pending
  }
}))

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

/** 'contrast' is the high-contrast theme (#278) — see the token block in app.css. */
export type Theme = 'light' | 'dark' | 'contrast'

/** The order the header button cycles through. High contrast is last: it is a destination, not
 *  something to land on by accident while flipping between light and dark. */
export const THEME_ORDER: Theme[] = ['light', 'dark', 'contrast']

export const THEME_LABEL: Record<Theme, string> = {
  light: 'Light',
  dark: 'Dark',
  contrast: 'High contrast'
}

interface ThemeState {
  theme: Theme
  /** Advance to the next theme in THEME_ORDER — what the header button does. */
  toggle: () => void
  set: (theme: Theme) => void
}

export function applyTheme(theme: Theme): void {
  document.documentElement.dataset.theme = theme
  localStorage.setItem('total-theme', theme)
}

export function initialTheme(): Theme {
  const stored = localStorage.getItem('total-theme')
  return (THEME_ORDER as string[]).includes(stored ?? '') ? (stored as Theme) : 'light'
}

export const useTheme = create<ThemeState>((set) => ({
  theme: initialTheme(),
  toggle: () =>
    set((s) => {
      const next = THEME_ORDER[(THEME_ORDER.indexOf(s.theme) + 1) % THEME_ORDER.length]!
      applyTheme(next)
      return { theme: next }
    }),
  set: (theme) =>
    set(() => {
      applyTheme(theme)
      return { theme }
    })
}))

// ---------- accessibility preferences ----------

/**
 * Text size (#279) and motion (#277).
 *
 * Both are machine-level, not company-level: they describe the eyes and the vestibular system in
 * front of the screen, and those do not change when the user switches to their second company.
 * So: localStorage, applied to <html>, same as the theme.
 */
export type TextSize = 'small' | 'default' | 'large' | 'largest'

/** The multiplier fed to --t-font-scale. `largest` is 1.3, which is the WCAG 1.4.4 "200% of a
 *  16px baseline" target measured from this app's 13px body step (13 × 1.3 ≈ 17, and the browser
 *  zoom the user still has on top of it does the rest). */
export const TEXT_SIZE_SCALE: Record<TextSize, number> = {
  small: 0.92,
  default: 1,
  large: 1.15,
  largest: 1.3
}

export const TEXT_SIZE_LABEL: Record<TextSize, string> = {
  small: 'Small',
  default: 'Default',
  large: 'Large',
  largest: 'Largest'
}

/** 'system' defers to prefers-reduced-motion; 'reduced' forces it on regardless. There is no
 *  'full' — an app has no business overriding an OS accessibility setting to add motion back. */
export type MotionPref = 'system' | 'reduced'

interface A11yState {
  textSize: TextSize
  motion: MotionPref
  setTextSize: (size: TextSize) => void
  setMotion: (motion: MotionPref) => void
}

export function applyTextSize(size: TextSize): void {
  document.documentElement.style.setProperty('--t-font-scale', String(TEXT_SIZE_SCALE[size]))
  localStorage.setItem('total-text-size', size)
}

export function applyMotion(motion: MotionPref): void {
  // Absent rather than 'system' when off: the CSS keys off the attribute existing, and an
  // attribute that is always present would need a second selector to say "but not that value".
  if (motion === 'reduced') document.documentElement.dataset.motion = 'reduced'
  else delete document.documentElement.dataset.motion
  localStorage.setItem('total-motion', motion)
}

export function initialTextSize(): TextSize {
  const stored = localStorage.getItem('total-text-size')
  return stored != null && stored in TEXT_SIZE_SCALE ? (stored as TextSize) : 'default'
}

export function initialMotion(): MotionPref {
  return localStorage.getItem('total-motion') === 'reduced' ? 'reduced' : 'system'
}

export const useA11y = create<A11yState>((set) => ({
  textSize: initialTextSize(),
  motion: initialMotion(),
  setTextSize: (textSize) =>
    set(() => {
      applyTextSize(textSize)
      return { textSize }
    }),
  setMotion: (motion) =>
    set(() => {
      applyMotion(motion)
      return { motion }
    })
}))

// ---------- keyboard preferences ----------

/**
 * The two keyboard preferences that change what other keys mean, so neither can be the default.
 *
 * `keyboardOnly` stops hover from being the only way to discover a row's actions. Hover is a
 * pointer idiom; an operator who never touches the trackpad sees a table of rows with invisible
 * buttons on them and reasonably concludes there are none. Turning this on takes the reveal off
 * `:hover` entirely, so the only thing that lights up a row's actions is the accent keyboard bar
 * or Tab — which means what is on screen is exactly what the keyboard can reach.
 *
 * `vimKeys` adds `gg` / `G` to lists. It is off by default and has to stay off by default,
 * because `G` is the Gateway accelerator and a list layer claiming it shadows the single most
 * used key in the app. Anyone who wants it knows what `gg` is and will not miss `G`; anyone who
 * does not must never lose their way home. ⌘1 still reaches the Gateway either way.
 *
 * Machine-level, like the theme: they describe the hands at the keyboard, not the books.
 */
interface KeyPrefsState {
  keyboardOnly: boolean
  vimKeys: boolean
  setKeyboardOnly: (on: boolean) => void
  setVimKeys: (on: boolean) => void
}

export function applyKeyboardOnly(on: boolean): void {
  // Absent rather than 'false' when off, so the CSS can key off the attribute existing — the
  // same shape `applyMotion` uses, for the same reason.
  if (on) document.documentElement.dataset.kbdOnly = 'true'
  else delete document.documentElement.dataset.kbdOnly
  localStorage.setItem('total-keyboard-only', on ? '1' : '0')
}

export function initialKeyboardOnly(): boolean {
  return localStorage.getItem('total-keyboard-only') === '1'
}

export function initialVimKeys(): boolean {
  return localStorage.getItem('total-vim-keys') === '1'
}

export const useKeyPrefs = create<KeyPrefsState>((set) => ({
  keyboardOnly: initialKeyboardOnly(),
  vimKeys: initialVimKeys(),
  setKeyboardOnly: (keyboardOnly) =>
    set(() => {
      applyKeyboardOnly(keyboardOnly)
      return { keyboardOnly }
    }),
  setVimKeys: (vimKeys) =>
    set(() => {
      localStorage.setItem('total-vim-keys', vimKeys ? '1' : '0')
      return { vimKeys }
    })
}))

// ---------- recently visited screens (⌘` ring) ----------

/**
 * The MRU ring behind ⌘`.
 *
 * The nav stack answers "where did I come from"; it does not answer "what am I working between",
 * which for a bookkeeper is nearly always two screens — the Day Book and voucher entry, or a
 * report and the ledger it drills into. ⌘[ walks history one step at a time and passes through
 * everything in between; this jumps straight to the other screen, and holding ⌘ walks further
 * back exactly as ⌘-Tab does between apps.
 *
 * Screens are keyed by name only. Two visits to the Day Book with different filters are the same
 * destination as far as "switch back to the Day Book" is concerned, and keeping both would fill
 * the ring with entries that look identical.
 */
interface RecentState {
  /** Most recent first. The screen currently on view is always index 0. */
  ring: Screen[]
  visit: (screen: Screen) => void
}

/** How far back the ring remembers. Eight is more than anyone walks by holding a key down, and
 *  short enough that the overlay never needs to scroll. */
const RING_MAX = 8

export const useRecentScreens = create<RecentState>((set) => ({
  ring: [],
  visit: (screen) =>
    set((s) => {
      if (s.ring[0]?.name === screen.name) return s
      return { ring: [screen, ...s.ring.filter((r) => r.name !== screen.name)].slice(0, RING_MAX) }
    })
}))

// ---------- screen-reader announcements ----------

interface AnnouncerState {
  /** The current polite message. Rendered by <LiveAnnouncer/> into an sr-only live region. */
  message: string
  announce: (message: string) => void
}

/**
 * One app-wide polite live region (#275).
 *
 * Row selection moves with the arrow keys and repaints an accent bar — which says nothing at all
 * to a screen reader, because nothing in the accessibility tree changed. The row has to be read
 * out, and it has to be read out politely: an assertive region would interrupt the user mid-word
 * on every single arrow press.
 *
 * A store rather than a DOM write so React owns the node, and one region rather than one per
 * list because two live regions racing is how announcements get dropped.
 */
export const useAnnouncer = create<AnnouncerState>((set) => ({
  message: '',
  announce: (message) =>
    set((s) =>
      // Re-announcing identical text needs the node to actually change, or the reader stays
      // silent. A trailing zero-width space is the cheapest way to make "same row" audible when
      // the user arrows down into a duplicate line.
      s.message === message ? { message: `${message}\u200b` } : { message }
    )
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
