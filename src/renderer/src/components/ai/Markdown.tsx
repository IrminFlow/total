// Assistant answers as safe markdown (lib/markdown.ts — elements only, never HTML) with every
// money figure rendered as a chip (WP 5.2): a sourced figure links to the row it came from (the
// ledger's statement, the voucher, the item's movements, else the report); an `ambiguous` one
// (several rows hold the amount) links to the report; an unsourced one is flagged in place — the
// numbers rule, visible where the figure is, code spans included.
//
// Figures are matched to text by OCCURRENCE, not by text: the answer's figures come in document
// order, so the second "₹10,000.00" gets the second figure (and its own source).
import { Fragment, type ReactNode } from 'react'
import type { AiFigure, AiSource } from '@shared/ai'
import { parseMarkdown, type Block, type Inline } from '../../lib/markdown'
import { openLedgerStatement, openVoucher } from '../../lib/drill'
import { useNav } from '../../state/stores'
import { screenFor } from './screenTargets'

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** Navigates to a figure's / source's target. Returns false when it has none. */
export function openSource(s: AiSource): boolean {
  const nav = useNav.getState()
  if (s.kind === 'ledger') openLedgerStatement(s.ledgerId)
  else if (s.kind === 'voucher') openVoucher(s.voucherId)
  else if (s.kind === 'item') nav.go({ name: 'stock-movements', itemId: s.itemId })
  else {
    const target = screenFor(s)
    if (!target) return false
    nav.go(target)
  }
  return true
}

const SOURCE_WORD: Record<AiSource['kind'], string> = { ledger: 'statement', voucher: 'voucher', item: 'stock movements', screen: 'report' }

export function FigureChip({ figure, onNavigate }: { figure: AiFigure; onNavigate?: () => void }): React.JSX.Element {
  if (!figure.sourced) {
    return (
      <span
        className="num rounded-sm bg-danger/10 px-1 text-danger ring-1 ring-danger/40"
        data-testid="ai-figure"
        data-sourced="false"
        title="Not in any report result the assistant saw — it may be its own calculation. Check it before relying on it."
      >
        {figure.text}
        <span aria-hidden="true" className="ml-0.5 text-micro font-semibold">
          ?
        </span>
        <span className="sr-only"> (unsourced)</span>
      </span>
    )
  }
  const s = figure.source
  const label = figure.ambiguous
    ? `${figure.text} — several rows of ${s?.label ?? figure.tool ?? 'the result'} show this amount; open the report`
    : s
      ? `${figure.text} — open the ${SOURCE_WORD[s.kind]}: ${s.label}`
      : `${figure.text} — from ${figure.tool}`
  const ring = figure.ambiguous ? 'border border-dashed border-amber/60' : 'ring-1 ring-amber/40'
  if (!s || (s.kind === 'screen' && !screenFor(s))) {
    return (
      <span
        className="num rounded-sm bg-panel2 px-1 text-ink ring-1 ring-line"
        data-testid="ai-figure"
        data-sourced="true"
        data-ambiguous={figure.ambiguous ? 'true' : undefined}
        title={label}
      >
        {figure.text}
      </span>
    )
  }
  return (
    <button
      type="button"
      className={`num cursor-pointer rounded-sm bg-amberbar/15 px-1 text-ink hover:bg-amberbar/30 focus-visible:ring-amber ${ring}`}
      data-testid="ai-figure"
      data-sourced="true"
      data-ambiguous={figure.ambiguous ? 'true' : undefined}
      data-source-kind={s.kind}
      data-ledger-id={s.kind === 'ledger' ? s.ledgerId : undefined}
      data-voucher-id={s.kind === 'voucher' ? s.voucherId : undefined}
      title={`${label}${figure.approximate ? ' (rounded)' : ''}`}
      aria-label={label}
      onClick={() => {
        if (openSource(s)) onNavigate?.()
      }}
    >
      {figure.text}
    </button>
  )
}

type Part = string | AiFigure

/**
 * Splits each text run into plain text and figures, walking the answer in document order and
 * consuming `figures` in order. A figure text that does not line up with the next expected figure
 * (markdown removed something) takes the next figure with that text. Pure; tested.
 */
export function assignFigures(runs: readonly string[], figures: readonly AiFigure[]): Part[][] {
  if (!figures.length) return runs.map((r) => [r])
  const texts = [...new Set(figures.map((f) => f.text))].sort((a, b) => b.length - a.length)
  const re = new RegExp(texts.map(escapeRe).join('|'), 'g')
  const used = new Set<number>()
  let cursor = 0
  return runs.map((run) => {
    const out: Part[] = []
    let last = 0
    for (const m of run.matchAll(re)) {
      const at = m.index ?? 0
      let k = -1
      for (let j = cursor; j < figures.length; j++) {
        if (!used.has(j) && figures[j]!.text === m[0]) {
          k = j
          break
        }
      }
      if (k < 0) k = figures.findIndex((f, j) => !used.has(j) && f.text === m[0])
      if (k < 0) k = figures.findIndex((f) => f.text === m[0]) // more occurrences than figures
      if (at > last) out.push(run.slice(last, at))
      out.push(figures[k]!)
      used.add(k)
      cursor = Math.max(cursor, k + 1)
      last = at + m[0].length
    }
    if (last < run.length) out.push(run.slice(last))
    return out
  })
}

/** Text runs of the parsed answer in document order — each text / code inline and code block. */
function collectRuns(blocks: readonly Block[]): { runs: string[]; keys: object[] } {
  const runs: string[] = []
  const keys: object[] = []
  const inl = (v: readonly Inline[]): void => {
    for (const x of v) {
      if (x.t === 'text' || x.t === 'code') {
        runs.push(x.v)
        keys.push(x)
      } else inl(x.v)
    }
  }
  for (const b of blocks) {
    if (b.t === 'p' || b.t === 'h') inl(b.v)
    else if (b.t === 'ul' || b.t === 'ol') b.items.forEach(inl)
    else if (b.t === 'table') {
      b.head.forEach(inl)
      b.rows.forEach((r) => r.forEach(inl))
    } else if (b.t === 'code') {
      runs.push(b.v)
      keys.push(b)
    }
  }
  return { runs, keys }
}

interface RenderCtx {
  parts: Map<object, Part[]>
  onNavigate?: () => void
}

function renderParts(key: object, fallback: string, c: RenderCtx): ReactNode {
  const parts = c.parts.get(key) ?? [fallback]
  return parts.map((p, i) => (typeof p === 'string' ? <Fragment key={i}>{p}</Fragment> : <FigureChip key={i} figure={p} onNavigate={c.onNavigate} />))
}

function Inlines({ v, c }: { v: readonly Inline[]; c: RenderCtx }): React.JSX.Element {
  return (
    <>
      {v.map((x, i) => {
        if (x.t === 'text') return <Fragment key={i}>{renderParts(x, x.v, c)}</Fragment>
        if (x.t === 'code') return <code key={i} className="num rounded-sm bg-panel2 px-1 text-caption">{renderParts(x, x.v, c)}</code>
        if (x.t === 'strong') return <strong key={i} className="font-semibold"><Inlines v={x.v} c={c} /></strong>
        return <em key={i}><Inlines v={x.v} c={c} /></em>
      })}
    </>
  )
}

function BlockView({ b, c }: { b: Block; c: RenderCtx }): React.JSX.Element {
  const inl = (v: readonly Inline[]): React.JSX.Element => <Inlines v={v} c={c} />
  switch (b.t) {
    case 'p':
      return <p>{inl(b.v)}</p>
    case 'h':
      return <p className={`font-semibold ${b.level === 1 ? 'text-subtitle' : 'text-body'}`}>{inl(b.v)}</p>
    case 'ul':
      return <ul className="ml-4 list-disc space-y-0.5">{b.items.map((it, i) => <li key={i}>{inl(it)}</li>)}</ul>
    case 'ol':
      return <ol start={b.start} className="ml-5 list-decimal space-y-0.5">{b.items.map((it, i) => <li key={i}>{inl(it)}</li>)}</ol>
    case 'code':
      return <pre className="num overflow-auto rounded-sm bg-panel2 p-2 text-caption whitespace-pre-wrap">{renderParts(b, b.v, c)}</pre>
    case 'hr':
      return <hr className="border-line" />
    case 'table':
      return (
        <div className="max-w-full overflow-x-auto rounded-md border border-line" data-testid="ai-md-table">
          <table className="w-full text-small">
            <thead className="bg-panel2">
              <tr>
                {b.head.map((h, i) => (
                  <th key={i} className={`px-2 py-1 font-semibold text-muted ${b.align[i] === 'right' ? 'text-right' : b.align[i] === 'center' ? 'text-center' : 'text-left'}`}>
                    {inl(h)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {b.rows.map((r, ri) => (
                <tr key={ri} className="border-t border-line">
                  {r.map((cell, ci) => (
                    <td key={ci} className={`px-2 py-1 align-top ${b.align[ci] === 'right' ? 'text-right' : b.align[ci] === 'center' ? 'text-center' : ''}`}>
                      {inl(cell)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )
  }
}

/** An answer: markdown blocks, figures as chips. */
export function AnswerMarkdown({ text, figures = [], onNavigate }: { text: string; figures?: readonly AiFigure[]; onNavigate?: () => void }): React.JSX.Element {
  const blocks = parseMarkdown(text)
  const { runs, keys } = collectRuns(blocks)
  const assigned = assignFigures(runs, figures)
  const c: RenderCtx = { parts: new Map(keys.map((k, i) => [k, assigned[i]!])), onNavigate }
  return (
    <div className="flex flex-col gap-2 text-body-sm text-ink" data-testid="ai-markdown">
      {blocks.map((b, i) => (
        <BlockView key={i} b={b} c={c} />
      ))}
    </div>
  )
}
