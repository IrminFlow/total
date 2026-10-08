// Assistant answers as safe markdown (lib/markdown.ts — elements only, never HTML) with every
// money figure rendered as a chip (WP 5.2): a sourced figure links to the row it came from (the
// ledger's statement, the voucher, the item's movements, else the report), an unsourced one is
// flagged in place — the numbers rule, visible where the figure is.
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
  const label = s ? `${figure.text} — open the ${SOURCE_WORD[s.kind]}: ${s.label}` : `${figure.text} — from ${figure.tool}`
  if (!s || (s.kind === 'screen' && !screenFor(s))) {
    return (
      <span className="num rounded-sm bg-panel2 px-1 text-ink ring-1 ring-line" data-testid="ai-figure" data-sourced="true" title={label}>
        {figure.text}
      </span>
    )
  }
  return (
    <button
      type="button"
      className="num cursor-pointer rounded-sm bg-amberbar/15 px-1 text-ink ring-1 ring-amber/40 hover:bg-amberbar/30 focus-visible:ring-amber"
      data-testid="ai-figure"
      data-sourced="true"
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

/** Text with each figure occurrence replaced by its chip. */
function withFigures(text: string, figures: readonly AiFigure[], onNavigate?: () => void): ReactNode {
  if (!figures.length) return text
  const texts = [...new Set(figures.map((f) => f.text))].sort((a, b) => b.length - a.length)
  const re = new RegExp(texts.map(escapeRe).join('|'), 'g')
  const out: ReactNode[] = []
  let last = 0
  for (const m of text.matchAll(re)) {
    const at = m.index ?? 0
    if (at > last) out.push(text.slice(last, at))
    const f = figures.find((x) => x.text === m[0])!
    out.push(<FigureChip key={`${at}`} figure={f} onNavigate={onNavigate} />)
    last = at + m[0].length
  }
  if (last < text.length) out.push(text.slice(last))
  return out.map((x, i) => <Fragment key={i}>{x}</Fragment>)
}

function Inlines({ v, figures, onNavigate }: { v: readonly Inline[]; figures: readonly AiFigure[]; onNavigate?: () => void }): React.JSX.Element {
  return (
    <>
      {v.map((x, i) => {
        if (x.t === 'text') return <Fragment key={i}>{withFigures(x.v, figures, onNavigate)}</Fragment>
        if (x.t === 'code') return <code key={i} className="num rounded-sm bg-panel2 px-1 text-caption">{x.v}</code>
        if (x.t === 'strong') return <strong key={i} className="font-semibold"><Inlines v={x.v} figures={figures} onNavigate={onNavigate} /></strong>
        return <em key={i}><Inlines v={x.v} figures={figures} onNavigate={onNavigate} /></em>
      })}
    </>
  )
}

function BlockView({ b, figures, onNavigate }: { b: Block; figures: readonly AiFigure[]; onNavigate?: () => void }): React.JSX.Element {
  const inl = (v: readonly Inline[]): React.JSX.Element => <Inlines v={v} figures={figures} onNavigate={onNavigate} />
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
      return <pre className="num overflow-auto rounded-sm bg-panel2 p-2 text-caption whitespace-pre-wrap">{b.v}</pre>
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
                  {r.map((c, ci) => (
                    <td key={ci} className={`px-2 py-1 align-top ${b.align[ci] === 'right' ? 'text-right' : b.align[ci] === 'center' ? 'text-center' : ''}`}>
                      {inl(c)}
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
  return (
    <div className="flex flex-col gap-2 text-body-sm text-ink" data-testid="ai-markdown">
      {blocks.map((b, i) => (
        <BlockView key={i} b={b} figures={figures} onNavigate={onNavigate} />
      ))}
    </div>
  )
}
