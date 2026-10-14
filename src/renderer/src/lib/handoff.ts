// WP 9.10 — the Accountant-view hand-off, both ways (plan 2026-10-13 §0.1 / §2.1).
//
// Simple → full: a simple form's "Accountant view" opens the full editor WITH its answers — the
// editors' own form state from simple:intentForm (simple:post's mapping, rolled back), carried as
// the voucher-entry `handoff` nav param and opened like an AI draft's state (`initial`). A saved
// form opens the saved voucher; answers that can't be mapped yet open the blank editor.
//
// Full → simple: "Back to simple" lands on the simple screen of the SAME object — ONE table here
// (`simpleTargetFor`), fed by simple:handoffTarget (what a voucher / ledger is) and the voucher a
// simple-mode editor just saved (`useLastSaved`, filled by the save card).
//
// The remembered choice: only "Always open the full app for this" stores the per-screen override
// (lib/mode.ts); a simple flow with it set opens its full counterpart (`fullCounterpart`) straight
// away (`useAlwaysFullRedirect`). "Back to simple" clears it (`backToSimpleClears`).
import { useCallback, useEffect, useRef } from 'react'
import { create } from 'zustand'
import type { VoucherKind } from '@shared/domain'
import { INTENT_SCREEN, type HandoffFacts, type SimpleHandoff } from '@shared/simple/handoff'
import type { SimpleIntentInput } from '@shared/simple/intents'
import { api } from './client'
import { useT } from './i18n'
import { readRememberedOverride, setViewOverride, useMode } from './mode'
import { screenDef, SIMPLE_ENTRIES, simpleSectionOf } from './screens'
import { nextDraftId, useNav, useScreen, useSession, useToasts, type Screen } from '../state/stores'
import type { IntentDraft } from './simplePost'

type Name = Screen['name']

const HOME: Screen = { name: 'gateway' }
/** simple:intentForm parses the whole intent (a clientId included); nothing is posted with it. */
const HANDOFF_CLIENT_ID = 'accountant-view-handoff'

/** The blank full counterpart of a simple screen — what "Always open the full app for this" opens,
 *  and the fallback when the answers can't be carried. null = no full counterpart. */
export function fullCounterpart(screen: Screen): Screen | null {
  switch (screen.name) {
    // Started for a customer / supplier (People → Make a bill): the editor starts with them too.
    case 'simple-sell':
      return screen.party != null ? { name: 'voucher-entry', kindHint: 'sales', draft: { partyLedgerId: screen.party } } : { name: 'voucher-entry', kindHint: 'sales' }
    case 'simple-buy':
      return screen.party != null ? { name: 'voucher-entry', kindHint: 'purchase', draft: { partyLedgerId: screen.party } } : { name: 'voucher-entry', kindHint: 'purchase' }
    case 'simple-money-in':
      return { name: 'voucher-entry', kindHint: 'receipt' }
    case 'simple-money-out':
      return { name: 'voucher-entry', kindHint: 'payment' }
    case 'simple-move-money':
      return { name: 'voucher-entry', kindHint: 'contra' }
    case 'simple-return-sale':
      return { name: 'voucher-entry', kindHint: 'credit_note' }
    case 'simple-return-purchase':
      return { name: 'voucher-entry', kindHint: 'debit_note' }
    case 'simple-stock-count':
      return { name: 'voucher-entry', kindHint: 'physical_stock' }
    case 'simple-made-goods':
      return { name: 'manufacture' }
    case 'simple-stock':
      return screen.itemId != null ? { name: 'stock-movements', itemId: screen.itemId } : { name: 'stock-summary' }
    case 'simple-bank':
      return screen.bankId != null ? { name: 'banking', tab: 'import', ledgerId: screen.bankId } : { name: 'banking', tab: 'import' }
    default:
      return null
  }
}

/** The simple flow a NEW entry of this kind is made on. */
const FLOW_FOR_KIND: Partial<Record<VoucherKind, Name>> = {
  sales: 'simple-sell',
  purchase: 'simple-buy',
  receipt: 'simple-money-in',
  payment: 'simple-money-out',
  contra: 'simple-move-money',
  credit_note: 'simple-return-sale',
  debit_note: 'simple-return-purchase',
  physical_stock: 'simple-stock-count'
}

const section = (screen: Screen): Screen => {
  const s = simpleSectionOf(screen)
  return s && s !== 'home' ? { name: 'simple-section', section: s } : HOME
}

/** A saved voucher's simple view (the same object). */
function voucherView(v: NonNullable<HandoffFacts['voucher']>): Screen | null {
  switch (v.kind) {
    case 'sales':
      return { name: 'simple-sales', billId: v.id }
    case 'purchase':
      return { name: 'simple-purchases', billId: v.id }
    case 'receipt':
    case 'payment':
    case 'contra':
      return { name: 'simple-money', entryId: v.id }
    case 'credit_note':
      return v.originalId != null ? { name: 'simple-return-sale', billId: v.originalId } : { name: 'simple-return-sale' }
    case 'debit_note':
      return v.originalId != null ? { name: 'simple-return-purchase', billId: v.originalId } : { name: 'simple-return-purchase' }
    case 'physical_stock':
    case 'stock_journal':
      return { name: 'simple-stock' }
    default:
      return null
  }
}

/** A WP 9.9 Reports entry's screen while it is a simple screen (else null). */
function reportEntry(id: string): Screen | null {
  const e = SIMPLE_ENTRIES.find((x) => x.id === id)
  return e && screenDef(e.screenName)?.modes.includes('simple') ? e.screen : null
}

/** Reports → "How is my business doing" (WP 9.9), else the Reports page. */
function profitView(): Screen {
  return reportEntry('how-am-i-doing') ?? { name: 'simple-section', section: 'reports' }
}

/**
 * THE full → simple table: where "Back to simple" lands for a full-app screen, with the same
 * object. `facts` = simple:handoffTarget for the screen's voucher / ledger (null = not asked or not
 * in the books). Everything not listed → the screen's simple section.
 */
export function simpleTargetFor(screen: Screen, facts: HandoffFacts | null): Screen {
  switch (screen.name) {
    case 'voucher-entry': {
      const view = facts?.voucher ? voucherView(facts.voucher) : null
      if (view) return view
      if (screen.handoff) return { name: INTENT_SCREEN[screen.handoff.kind] } as Screen
      const flow = screen.kindHint ? FLOW_FOR_KIND[screen.kindHint] : undefined
      return flow ? ({ name: flow } as Screen) : section(screen)
    }
    case 'ledger-statement':
      return facts?.ledger?.isParty ? { name: 'simple-person', id: screen.ledgerId } : section(screen)
    case 'masters':
      if (screen.itemId != null) return { name: 'simple-stock', itemId: screen.itemId }
      if (screen.tab === 'items') return { name: 'simple-stock' }
      if (screen.parties) return { name: 'simple-people' }
      return section(screen)
    case 'stock-movements':
      return screen.itemId != null ? { name: 'simple-stock', itemId: screen.itemId } : { name: 'simple-stock' }
    case 'stock-summary':
      return { name: 'simple-stock' }
    case 'outstandings':
      // WP 9.9: the same list in plain words — Reports → "Who owes me" / "Whom I owe" (whose
      // Accountant view is this screen); before it, People.
      return (
        reportEntry(screen.side === 'payable' ? 'whom-i-owe' : 'who-owes-me') ??
        (screen.side === 'payable' ? { name: 'simple-people', tab: 'bills' } : { name: 'simple-people' })
      )
    case 'profit-loss':
      return profitView()
    case 'cash-forecast':
      return reportEntry('cash-next-30') ?? section(screen)
    case 'gstr3b':
      return screenDef('simple-taxes')?.modes.includes('simple') ? { name: 'simple-taxes' } : section(screen)
    case 'manufacture':
      return screen.prefill ? { name: 'simple-made-goods', itemId: screen.prefill.itemId } : { name: 'simple-made-goods' }
    case 'banking':
      return screen.ledgerId != null ? { name: 'simple-bank', bankId: screen.ledgerId } : { name: 'simple-bank' }
    default:
      return section(screen)
  }
}

/** What simple:handoffTarget must be asked for this screen (null = nothing). `savedId` = the
 *  voucher this editor just saved (a new entry's editor keeps its blank form after a save). */
export function factsQuery(screen: Screen, savedId: number | null): { voucherId?: number; ledgerId?: number } | null {
  if (screen.name === 'voucher-entry') {
    const id = screen.voucherId ?? savedId
    return id != null ? { voucherId: id } : null
  }
  if (screen.name === 'ledger-statement') return { ledgerId: screen.ledgerId }
  return null
}

/** The simple screens whose remembered "always full" choice "Back to simple" from `screen` to
 *  `target` clears: the one it lands on, and the simple flow this full screen stands for. */
export function backToSimpleClears(screen: Screen, target: Screen): Name[] {
  const out = new Set<Name>([target.name])
  if (screen.name === 'voucher-entry') {
    if (screen.handoff) out.add(INTENT_SCREEN[screen.handoff.kind] as Name)
    const flow = screen.kindHint ? FLOW_FOR_KIND[screen.kindHint] : undefined
    if (flow) out.add(flow)
  }
  if (screen.name === 'manufacture') out.add('simple-made-goods')
  if (screen.name === 'stock-summary' || screen.name === 'stock-movements') out.add('simple-stock')
  if (screen.name === 'banking') out.add('simple-bank')
  return [...out]
}

// ---------------------------------------------------------------- the voucher an editor just saved

/** A NEW entry's editor resets to a blank form after a save (in a simple-mode company the save
 *  card shows its ids); "Back to simple" still means that voucher. Keyed by the nav entry. */
export const useLastSaved = create<{ screen: Screen | null; id: number | null; set: (screen: Screen, id: number) => void }>((set) => ({
  screen: null,
  id: null,
  set: (screen, id) => set({ screen, id })
}))

export function savedIdFor(screen: Screen): number | null {
  const s = useLastSaved.getState()
  return s.screen === screen ? s.id : null
}

/** Record the voucher saved on the visible screen (the save card calls this). */
export function rememberSaved(id: number): void {
  const top = useNav.getState().stack.at(-1)
  if (top) useLastSaved.getState().set(top, id)
}

// ---------------------------------------------------------------- hooks

export interface AccountantViewRequest {
  /** The screen's current answers (null = nothing usable yet). */
  intent: IntentDraft | null
  /** The screen's clientId (simple:intentForm parses the whole intent; nothing is posted). */
  clientId?: string
  /** What the screen saved (its first voucher opens). */
  savedId?: number | null
  /** "Always open the full app for this". */
  always?: boolean
  /** Opened when there is nothing to carry (default: the screen's blank full counterpart). */
  fallback?: Screen
}

/**
 * A simple flow's "Accountant view": saved → that voucher; answers → the full editor pre-filled
 * (simple:intentForm), without the discard question (the answers go with it); nothing usable → the
 * blank full counterpart. `always` also stores the choice for this screen.
 */
export function useAccountantView(self: Name): (req: AccountantViewRequest) => Promise<void> {
  // The simple screen the button is on (by name — params, if any, come with `fallback`).
  const screen = { name: self } as Screen
  const nav = useNav()
  const t = useT()
  const toast = useToasts()
  const slug = useSession((s) => s.slug)
  const userId = useSession((s) => s.user?.id)
  const today = useSession((s) => s.workingDate)
  return useCallback(
    async (req: AccountantViewRequest) => {
      if (req.always) setViewOverride(slug, userId, screen.name, true, true)
      const blank = req.fallback ?? fullCounterpart(screen) ?? section(screen)
      if (req.savedId != null) return nav.go({ name: 'voucher-entry', voucherId: req.savedId })
      if (!req.intent) return nav.go(blank)
      try {
        const r = await api.simple.intentForm({ ...req.intent, clientId: req.clientId ?? HANDOFF_CLIENT_ID } as SimpleIntentInput, today)
        const [entry, ...rest] = r.entries
        if (!entry) return nav.go(blank)
        const handoff: SimpleHandoff = {
          from: screen.name,
          kind: r.kind,
          entry,
          others: rest.map((e) => ({ role: e.role, kind: e.kind, amount: e.amount })),
          missing: r.missing
        }
        nav.go({ name: 'voucher-entry', handoff, draftId: nextDraftId() }, { force: true })
      } catch {
        // Answers the mapping can't use yet (no product picked, say): the blank editor.
        toast.push('info', t('simple.handoff.notCarried'))
        nav.go(blank)
      }
    },
    [self, nav, t, toast, slug, userId, today] // eslint-disable-line react-hooks/exhaustive-deps -- `screen` is `self`
  )
}

/** A simple flow the user chose "Always open the full app for this" for opens its full
 *  counterpart instead (only on arrival — never while the user is on it, nor when coming back to
 *  it with Back / Esc from the full editor the choice opened: the stack got shorter then, and the
 *  user would only bounce into another blank editor). Registry entries reuse one Screen object,
 *  so arrival is told by the stack's length, not by the object. */
export function useAlwaysFullRedirect(): void {
  const screen = useScreen()
  const depth = useNav((s) => s.stack.length)
  const lastDepth = useRef<number | null>(null)
  const mode = useMode()
  const slug = useSession((s) => s.slug)
  const userId = useSession((s) => s.user?.id)
  useEffect(() => {
    const cameBack = lastDepth.current != null && depth < lastDepth.current
    lastDepth.current = depth
    if (cameBack) return
    if (mode !== 'simple' || !screenDef(screen.name)?.modes.includes('simple')) return
    if (!readRememberedOverride(slug, userId, screen.name)) return
    const full = fullCounterpart(screen)
    if (full) useNav.getState().replace(full)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- on arrival only (the screen entry)
  }, [screen])
}

/** "Back to simple" from a full screen: the matching simple screen with the same object, and the
 *  remembered choice cleared. */
export function useBackToSimple(): () => Promise<void> {
  const screen = useScreen()
  const nav = useNav()
  const slug = useSession((s) => s.slug)
  const userId = useSession((s) => s.user?.id)
  return useCallback(async () => {
    const q = factsQuery(screen, savedIdFor(screen))
    let facts: HandoffFacts | null = null
    if (q) {
      try {
        facts = await api.simple.handoffTarget(q)
      } catch {
        facts = null
      }
    }
    const target = simpleTargetFor(screen, facts)
    // Cleared before the move (the arrival redirect must not see it); put back when the user
    // chooses to stay on an unsaved editor.
    const names = backToSimpleClears(screen, target)
    const remembered = names.filter((name) => readRememberedOverride(slug, userId, name))
    for (const name of names) setViewOverride(slug, userId, name, false)
    if (!(await nav.tryGo(target))) for (const name of remembered) setViewOverride(slug, userId, name, true, true)
  }, [screen, nav, slug, userId])
}
