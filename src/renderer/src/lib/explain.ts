// "Explain this" and the AI affordances' shared switch (WP 5.2). The kit (StatTile, DataTable,
// StatementTree) only talks to this tiny store — never to the AI client — so the platform stays
// generic: `ready` says whether to show the affordances (AI on for this company, notice accepted,
// key or mock), `explain(figure)` hands a figure to the assistant host (components/ai/AiHost),
// which fills in the screen, opens the panel and asks.
import { create } from 'zustand'
import { formatPaise } from '@shared/money'
import type { ExplainFigure } from '@shared/aiExplain'

/** What an affordance knows; the host adds the screen, its title, parameters and the period. */
export type ExplainInput = Omit<ExplainFigure, 'screen'> & { screen?: string }

interface ExplainState {
  /** Show the AI affordances (false while the assistant is off: they are hidden, not disabled). */
  ready: boolean
  handler: ((f: ExplainInput) => void) | null
  setReady: (ready: boolean) => void
  setHandler: (h: ((f: ExplainInput) => void) | null) => void
}

export const useExplain = create<ExplainState>((set) => ({
  ready: false,
  handler: null,
  setReady: (ready) => set({ ready }),
  setHandler: (handler) => set({ handler })
}))

/** True when Explain-this / Ask-AI affordances should render. */
export const useAiAffordances = (): boolean => useExplain((s) => s.ready && s.handler !== null)

export function requestExplain(f: ExplainInput): void {
  useExplain.getState().handler?.(f)
}

/** "₹1,234.00" / "₹1,234.00 Dr" — the figure as the screen shows it, with the rupee sign. */
export function figureText(paise: number, signed = false): string {
  if (signed) return paise === 0 ? formatPaise(0, { symbol: true }) : `${formatPaise(Math.abs(paise), { symbol: true })} ${paise > 0 ? 'Dr' : 'Cr'}`
  return formatPaise(paise, { symbol: true })
}

const posInt = (v: unknown): number | undefined => (typeof v === 'number' && Number.isInteger(v) && v > 0 ? v : undefined)

/**
 * The ids a report row carries (CLAUDE.md: rows carry ledgerId / itemId / voucherId so names can
 * be links): a voucher row explains as its voucher, else a ledger row as its ledger, else an item.
 * Pure; tested.
 */
export function rowSourceIds(row: unknown): Pick<ExplainInput, 'voucherId' | 'ledgerId' | 'itemId'> {
  if (!row || typeof row !== 'object') return {}
  const r = row as Record<string, unknown>
  const voucherId = posInt(r.voucherId)
  if (voucherId) return { voucherId }
  const ledgerId = posInt(r.ledgerId) ?? posInt(r.partyLedgerId)
  if (ledgerId) return { ledgerId }
  const itemId = posInt(r.itemId) ?? posInt(r.stockItemId)
  if (itemId) return { itemId }
  return {}
}

/** Visible text of a React node (strings, numbers, <Money paise>), for tiles whose label or value
 *  is a node. Elements without text children contribute nothing. */
export function nodeText(node: unknown): string {
  if (node === null || node === undefined || typeof node === 'boolean') return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(nodeText).join('')
  if (typeof node === 'object' && 'props' in (node as object)) {
    const props = (node as { props: Record<string, unknown> }).props ?? {}
    if (typeof props.paise === 'number') return figureText(props.paise, !!props.signed)
    return nodeText(props.children)
  }
  return ''
}

/** A displayed value that is money ("₹1,234.00", "1,23,456.00 Dr", "₹1.2L"), not a count or a date. */
export function looksLikeMoney(text: string): boolean {
  const t = text.trim()
  if (!t) return false
  if (/₹|\bRs\.?\s?\d|\bINR\b/.test(t)) return /\d/.test(t)
  return /^-?\d{1,3}(?:,\d{2,3})*\.\d{2}(?:\s?(?:Dr|Cr))?$/.test(t)
}

/**
 * ⌘⇧E — the keyboard path to "Explain this" (the buttons stay out of the Tab order): the focused
 * row or statement line, else the active (amber-bar) table row of the table used last. Returns
 * the row's first Explain action, or null. Screen-agnostic — reads the DOM like ⌘E does.
 */
export function explainTargetFor(doc: Document): HTMLElement | null {
  const active = doc.activeElement instanceof HTMLElement ? doc.activeElement : null
  const host = active?.closest('.t-explain-host') ?? active?.closest('tr, [data-drill-row]')
  const own = host?.querySelector<HTMLElement>('[data-explain]')
  if (own) return own
  const rows = [...doc.querySelectorAll<HTMLElement>('tr.kbar-row[data-active="true"]')].reverse()
  for (const r of rows) {
    const b = r.querySelector<HTMLElement>('[data-explain]')
    if (b) return b
  }
  return null
}
