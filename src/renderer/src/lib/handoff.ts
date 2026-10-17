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
import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react'
import { create } from 'zustand'
import { useQueryClient } from '@tanstack/react-query'
import type { VoucherKind } from '@shared/domain'
import { INTENT_SCREEN, type HandoffCreate, type HandoffEntry, type HandoffFacts, type HandoffPending, type SimpleHandoff } from '@shared/simple/handoff'
import { CARRY_FLOWS, type CarryDropped, type CarryFlow, type CarryForms } from '@shared/simple/carryBack'
import type { SimpleIntentInput } from '@shared/simple/intents'
import { api } from './client'
import { useT } from './i18n'
import { readRememberedOverride, setViewOverride, useMode } from './mode'
import { screenApplies, screenDef, SIMPLE_ENTRIES, simpleSectionOf } from './screens'
import { nextDraftId, useNav, useScreen, useSession, useToasts, type Screen } from '../state/stores'
import type { IntentDraft } from './simplePost'
import { useTaxLedgers } from '../components/pickers'

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
    // A saved count reopened (Stock → History) opens that count, never a blank one.
    case 'simple-stock-count':
      return screen.voucherId != null ? { name: 'voucher-entry', voucherId: screen.voucherId } : { name: 'voucher-entry', kindHint: 'physical_stock' }
    case 'simple-made-goods':
      return { name: 'manufacture' }
    case 'simple-stock':
      return screen.itemId != null ? { name: 'stock-movements', itemId: screen.itemId } : { name: 'stock-summary' }
    case 'simple-bank':
      return screen.bankId != null ? { name: 'banking', tab: 'import', ledgerId: screen.bankId } : { name: 'banking', tab: 'import' }
    // WP 9.9's plain reports: the accountant report each one's Accountant view opens.
    case 'simple-reports':
      switch (screen.report) {
        case 'cash':
          return { name: 'cash-forecast' }
        case 'owed':
          return { name: 'outstandings', side: screen.side ?? 'receivable' }
        case 'by-month':
          return { name: 'registers', tab: 'sales' }
        default:
          return { name: 'profit-loss' }
      }
    case 'simple-taxes':
      return screen.period ? { name: 'gstr3b', month: screen.period } : { name: 'gstr3b' }
    // People: the Outstandings of the side the list shows (Bills to pay and the supplier filters:
    // payable) — `backTo` brings "Back to simple" to People again, not the Reports page.
    case 'simple-people':
      return {
        name: 'outstandings',
        side: screen.tab === 'bills' || screen.filter === 'suppliers' || screen.filter === 'youOwe' ? 'payable' : 'receivable',
        backTo: 'simple-people',
        // The People list's filter comes back with it (Bills to pay has none).
        ...(screen.tab !== 'bills' && screen.filter && screen.filter !== 'all' ? { backFilter: screen.filter } : {})
      }
    // A person's page: that ledger's statement (Back to simple: the same person).
    case 'simple-person':
      return { name: 'ledger-statement', ledgerId: screen.id }
    // The Reports page: the Trial balance (its "For your CA" group's first report), whose Back
    // to simple lands on this page again.
    case 'simple-section':
      return screen.section === 'reports' ? { name: 'trial-balance' } : null
    default:
      return null
  }
}

/** The name the remembered "Always open the full app for this" is stored under: one per plain
 *  report (the Reports registry screen holds several), else the screen's own name. */
export function alwaysKey(screen: Screen): Name {
  if (screen.name === 'simple-reports') return `simple-reports:${screen.report ?? 'doing'}` as Name // i18n-technical
  if (screen.name === 'simple-section') return `simple-section:${screen.section}` as Name // i18n-technical
  return screen.name
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
    case 'company-info':
      return screen.backTo === 'simple-taxes' ? { name: 'simple-taxes' } : section(screen)
    case 'registers':
      // Reports → "By month" (WP 9.9) — whose Accountant view is the Registers screen.
      return reportEntry('by-month') ?? section(screen)
    case 'outstandings':
      if (screen.backTo === 'simple-people') {
        if (screen.backFilter) return { name: 'simple-people', filter: screen.backFilter }
        return screen.side === 'payable' ? { name: 'simple-people', tab: 'bills' } : { name: 'simple-people' }
      }
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
  const out = new Set<Name>([alwaysKey(target)])
  if (screen.name === 'voucher-entry') {
    if (screen.handoff) out.add(INTENT_SCREEN[screen.handoff.kind] as Name)
    const flow = screen.kindHint ? FLOW_FOR_KIND[screen.kindHint] : undefined
    if (flow) out.add(flow)
  }
  if (screen.name === 'manufacture') out.add('simple-made-goods')
  if (screen.name === 'stock-summary' || screen.name === 'stock-movements') out.add('simple-stock')
  if (screen.name === 'banking') out.add('simple-bank')
  if (screen.name === 'registers') out.add(alwaysKey({ name: 'simple-reports', report: 'by-month' }))
  if (screen.name === 'outstandings' && (screen.side === 'payable' || screen.backTo === 'simple-people')) out.add('simple-people')
  if (screen.name === 'ledger-statement' && target.name === 'simple-person') out.add('simple-person')
  if (screen.name === 'company-info' && screen.backTo === 'simple-taxes') out.add('simple-taxes')
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
  dropKeptForms()
  const top = useNav.getState().stack.at(-1)
  if (top) useLastSaved.getState().set(top, id)
}

// ---------------------------------------------------------------- accounts the editor makes on save

/**
 * The editor's first-use creation for a hand-off's pending accounts (shared/simple/handoff.ts
 * HandoffPending): the walk-in customer as counter.ts ensureWalkIn makes it (found by its name,
 * else created under Sundry Debtors), a GST / round-off ledger as InvoiceEntry's save does
 * (useTaxLedgers). Called on SAVE only — opening the editor writes nothing.
 */
export function useHandoffLedgers(): (pending: HandoffPending) => Promise<number> {
  const queryClient = useQueryClient()
  const { ensure, ensureRoundOff } = useTaxLedgers()
  return useCallback(
    async ({ name, create: how }: HandoffPending): Promise<number> => {
      const c: HandoffCreate = how
      if (c.kind === 'tax') return ensure(c.taxType, c.side)
      if (c.kind === 'roundOff') return ensureRoundOff()
      const found = (await api.ledgers.list()).find((l) => l.name === name)
      if (found) return found.id
      const debtors = (await api.groups.list()).find((g) => g.name === 'Sundry Debtors')
      if (!debtors) throw new Error('Sundry Debtors group missing')
      const created = await api.ledgers.create({
        name, groupId: debtors.id, openingBalance: 0, gstin: null, stateCode: null, address: null, taxType: null,
        gstRate: null, hsn: null, tdsSectionId: null, pan: null, creditDays: null, exportType: null
      })
      await queryClient.invalidateQueries({ queryKey: ['ledgers'] })
      return created.id
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- ensure / ensureRoundOff are rebuilt each render; they only read the client
    [queryClient]
  )
}

// ---------------------------------------------------------------- the simple form left for the editor

/** The answers a simple form held when its "Accountant view" opened the full editor (review of
 *  WP 9.10): Cancel / Esc / "Back to simple" from that editor come back to the SAME nav entry, which
 *  then starts from these answers instead of a blank form. Keyed by the nav entry — the stack entry
 *  object AND its depth (registry entries reuse one Screen object) — and taken once; an entry no
 *  longer in the stack at its depth is dropped, and so is everything once the editor saves
 *  (`rememberSaved`), so a fresh visit is always blank and saved answers never come back. */
interface KeptForm {
  screen: Screen
  depth: number
  /** By slot (`useKeptForm`'s second argument; 'form' by default). */
  slots: Record<string, unknown>
}
let keptForms: KeptForm[] = []

function keepForm(slots: Record<string, unknown>): void {
  const stack = useNav.getState().stack
  const top = stack.at(-1)
  if (!top) return
  const depth = stack.length - 1
  keptForms = [...keptForms.filter((k) => k.depth !== depth), { screen: top, depth, slots }]
}

/** Forget every kept form (the hand-off editor saved). */
export function dropKeptForms(): void {
  keptForms = []
}

useNav.subscribe((s) => {
  if (keptForms.length > 0) keptForms = keptForms.filter((k) => s.stack[k.depth] === k.screen)
})
// Another company (or none): the answers were typed in the one that closed — its ids mean nothing
// here, and the stack is kept when the user chose to stay on an unsaved editor (to-do, shots-96).
useSession.subscribe((s, prev) => {
  if (s.slug !== prev.slug) dropKeptForms()
})

/** The kept answers of one slot at a nav entry (not taken). */
function peekKept(screen: Screen | undefined, depth: number, slot: string): unknown {
  return keptForms.find((k) => k.depth === depth && k.screen === screen)?.slots[slot]
}

/** Replace slots of the answers kept at a nav entry (the carried-back form). */
function rewriteKept(screen: Screen, depth: number, slots: Record<string, unknown>): void {
  keptForms = keptForms.map((k) => (k.depth === depth && k.screen === screen ? { ...k, slots: { ...k.slots, ...slots } } : k))
}

/** True when `screen` at `depth` of the stack holds kept answers (not yet taken). */
export function hasKeptForm(screen: Screen | undefined, depth: number): boolean {
  return screen != null && keptForms.some((k) => k.depth === depth && k.screen === screen)
}

/** `useState` for a simple flow's form: on arrival at the nav entry the form was handed off from,
 *  it starts from the answers kept there (else `init`). */
export function useKeptForm<T>(init: T | (() => T), slot = 'form'): [T, Dispatch<SetStateAction<T>>] {
  const [here] = useState(() => {
    const stack = useNav.getState().stack
    return { screen: stack.at(-1), depth: stack.length - 1 }
  })
  const found = (): KeptForm | undefined => keptForms.find((k) => k.depth === here.depth && k.screen === here.screen)
  // Peeked (pure, StrictMode calls it twice); taken after the mount.
  const state = useState<T>(() => {
    const k = found()
    if (k && slot in k.slots) return k.slots[slot] as T
    return typeof init === 'function' ? (init as () => T)() : init
  })
  useEffect(() => {
    const k = found()
    if (k) keptForms = keptForms.filter((x) => x !== k)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- on mount only
  }, [])
  return state
}

// ---------------------------------------------------------------- the editor's changes, carried back

/** The hand-off editor's form as it stands (its editor reports every change), per hand-off — and
 *  as it FIRST reported it (on mount, before the user touched anything). */
const editorStates = new WeakMap<SimpleHandoff, { first: HandoffEntry; current: HandoffEntry }>()

/** Called by the hand-off's editor (VoucherEntry) with its current state. */
export function reportHandoffEditor(handoff: SimpleHandoff, entry: HandoffEntry): void {
  const was = editorStates.get(handoff)
  editorStates.set(handoff, { first: was?.first ?? entry, current: entry })
}

const sameEntry = (a: HandoffEntry, b: HandoffEntry): boolean => JSON.stringify([a.state, a.pending ?? null]) === JSON.stringify([b.state, b.pending ?? null])

/** Carried lines get fresh keys (carryBack marks them with negative ones). */
let carriedLineSeq = 1_000_000
function rekeyLines<F>(form: F): F {
  const f = form as F & { lines?: { key: number }[] }
  if (!Array.isArray(f.lines)) return form
  return { ...f, lines: f.lines.map((l) => (l.key < 0 ? { ...l, key: ++carriedLineSeq } : l)) }
}

/**
 * The editor's changes back into the simple form kept below it (shared/simple/carryBack.ts, run by
 * simple:carryBack over simple:post's context): 'carried' = the kept form now holds them (and the
 * fields that could not come along, slot `carriedBack`); 'none' = nothing changed there (or
 * nothing to carry); 'refused' = the simple form can't hold this entry.
 */
async function carryEdits(handoff: SimpleHandoff, below: Screen, depth: number, today: string): Promise<'carried' | 'none' | 'refused'> {
  const seen = editorStates.get(handoff)
  if (!seen || !handoff.intent || !(CARRY_FLOWS as readonly string[]).includes(handoff.from)) return 'none'
  const current = seen.current
  // An editor the user did not touch is "Back to simple" exactly as before: nothing to carry (its
  // mount may tidy the state — a blank row, a default — which is no change of the user's).
  if (sameEntry(current, seen.first) || sameEntry(current, handoff.entry)) return 'none'
  const base = peekKept(below, depth, 'form')
  if (base == null) return 'none'
  const flow = handoff.from as CarryFlow
  try {
    const r = await api.simple.carryBack({ flow, intent: handoff.intent, original: handoff.entry, current, base: base as CarryForms[CarryFlow] }, today)
    if (!r.ok) return 'refused'
    if (r.dropped.length === 0 && JSON.stringify(r.form) === JSON.stringify(base)) return 'none'
    rewriteKept(below, depth, { form: rekeyLines(r.form), carriedBack: r.dropped })
    return 'carried'
  } catch {
    return 'refused'
  }
}

/** What a simple flow came back with from the full editor that could not be carried (null = not
 *  carried back). Read once on arrival, like the form. */
export function useCarriedBack(): CarriedBack {
  return useKeptForm<CarriedBack>(null, 'carriedBack')[0]
}

/** What came back: the details that could not ([] = everything did), 'refused' = none of the
 *  editor's changes (the earlier answers are shown), null = not back from a changed editor. */
export type CarriedBack = CarryDropped[] | 'refused' | null

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
  /** The form's own state by `useKeptForm` slot: kept under this nav entry, so coming back from
   *  the editor (Cancel / Esc / Back to simple) shows these answers again. */
  keep?: Record<string, unknown>
}

/**
 * A simple flow's "Accountant view": saved → that voucher; answers → the full editor pre-filled
 * (simple:intentForm), without the discard question (the answers go with it); nothing usable → the
 * blank full counterpart. `always` also stores the choice for this screen.
 */
export function useAccountantView(self: Name | Screen): (req: AccountantViewRequest) => Promise<void> {
  // The simple screen the button is on (by name — params, if any, come with `fallback` — or the
  // screen itself where its params pick the full counterpart, e.g. a plain report).
  const screen = typeof self === 'string' ? ({ name: self } as Screen) : self
  const nav = useNav()
  const t = useT()
  const toast = useToasts()
  const slug = useSession((s) => s.slug)
  const userId = useSession((s) => s.user?.id)
  const today = useSession((s) => s.workingDate)
  return useCallback(
    async (req: AccountantViewRequest) => {
      if (req.always) setViewOverride(slug, userId, alwaysKey(screen), true, true)
      const blank = req.fallback ?? fullCounterpart(screen) ?? section(screen)
      if (req.savedId != null) return nav.go({ name: 'voucher-entry', voucherId: req.savedId })
      if (!req.intent) return nav.go(blank)
      const kept = !!req.keep
      if (req.keep) keepForm(req.keep)
      try {
        const sent = { ...req.intent, clientId: req.clientId ?? HANDOFF_CLIENT_ID } as SimpleIntentInput
        const r = await api.simple.intentForm(sent, today)
        const [entry, ...rest] = r.entries
        if (!entry) return nav.go(blank, { force: kept })
        const handoff: SimpleHandoff = {
          from: screen.name,
          kind: r.kind,
          intent: sent,
          entry,
          others: rest.map((e) => ({ role: e.role, kind: e.kind, amount: e.amount })),
          missing: r.missing,
          ...(r.addedOnSave?.length ? { addedOnSave: r.addedOnSave } : {})
        }
        nav.go({ name: 'voucher-entry', handoff, draftId: nextDraftId() }, { force: true })
      } catch {
        // Answers the mapping can't use yet (no product picked, say): the blank editor, with no
        // discard question when the answers are kept for the way back (the note says they could
        // not be carried; Back / Cancel there return to them).
        toast.push('info', t('simple.handoff.notCarried'))
        nav.go(blank, { force: kept })
      }
    },
    [typeof self === 'string' ? self : JSON.stringify(self), nav, t, toast, slug, userId, today] // eslint-disable-line react-hooks/exhaustive-deps -- `screen` is `self`
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
  const gstType = useSession((s) => s.info?.gstRegistrationType)
  useEffect(() => {
    const cameBack = lastDepth.current != null && depth < lastDepth.current
    lastDepth.current = depth
    if (cameBack) return
    if (mode !== 'simple' || !screenDef(screen.name)?.modes.includes('simple')) return
    if (!readRememberedOverride(slug, userId, alwaysKey(screen))) return
    const full = fullCounterpart(screen)
    // Never into a screen the company can't use (GST returns of an unregistered business).
    const def = full ? screenDef(full.name) : undefined
    if (full && (!def || screenApplies(def, gstType))) useNav.getState().replace(full)
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
  const today = useSession((s) => s.workingDate)
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
    // An unsaved hand-off whose simple form is right below: go BACK to it (its answers are kept
    // there — useKeptForm), not to a new blank copy of the flow.
    const stack = useNav.getState().stack
    const below = stack.at(-2)
    const unsavedEditor = screen.name === 'voucher-entry' && facts?.voucher == null && savedIdFor(screen) == null
    const toBelow =
      unsavedEditor &&
      (screen.handoff
        ? below?.name === screen.handoff.from
        : // The blank counterpart of answers the mapping refused: the form that kept them is right below.
          below?.name === target.name && hasKeptForm(below, stack.length - 2))
    // Cleared before the move (the arrival redirect must not see it); put back when the user
    // chooses to stay on an unsaved editor.
    const names = backToSimpleClears(screen, target)
    const remembered = names.filter((name) => readRememberedOverride(slug, userId, name))
    // The editor's changes go back with it where the simple form can hold them: no discard
    // question then (nothing is lost but what the form's note names).
    const carried = toBelow && screen.handoff && below ? await carryEdits(screen.handoff, below, stack.length - 2, today) : 'none'
    for (const name of names) setViewOverride(slug, userId, name, false)
    if (carried === 'carried') {
      useNav.setState((s) => (s.stack.at(-1) === screen && s.stack.length > 1 ? { stack: s.stack.slice(0, -1) } : s))
      return
    }
    // Refused: the discard question is asked as before, and the flow then says (in its note, which
    // stays until dismissed — never a timed toast) that the editor's changes did not come back.
    if (carried === 'refused' && below) rewriteKept(below, stack.length - 2, { carriedBack: 'refused' })
    if (!(await (toBelow ? nav.tryBack() : nav.tryGo(target)))) {
      for (const name of remembered) setViewOverride(slug, userId, name, true, true)
      if (carried === 'refused' && below) rewriteKept(below, stack.length - 2, { carriedBack: null })
    }
  }, [screen, nav, slug, userId, today])
}
