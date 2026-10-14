import type { ReactNode } from 'react'
import { useT } from '../../lib/i18n'
import type { Block, Inline } from '../../help/markdown'
import { resolveHelpLink, type HelpLink } from '../../help/links'

/**
 * WP 10.3: a help article as React elements — headings, paragraphs, lists, bold and links, from
 * the parsed blocks (help/markdown.ts). Never HTML: every piece of text is a text node. A link
 * that does not resolve (help/links.ts) is shown as its text.
 */
export function Markdown({ blocks, onLink }: { blocks: Block[]; onLink: (link: Exclude<HelpLink, { kind: 'invalid' }>) => void }): React.JSX.Element {
  return (
    <div className="flex flex-col gap-2.5 text-body-sm text-ink" data-testid="help-body">
      {blocks.map((b, i) => {
        if (b.kind === 'heading') {
          return b.level <= 2 ? (
            <h3 key={i} className="mt-2 text-subtitle font-semibold text-ink">
              <Inlines nodes={b.children} onLink={onLink} />
            </h3>
          ) : (
            <h4 key={i} className="mt-1 text-detail font-semibold text-ink">
              <Inlines nodes={b.children} onLink={onLink} />
            </h4>
          )
        }
        if (b.kind === 'list') {
          const items = b.items.map((it, j) => (
            <li key={j} className="pl-1">
              <Inlines nodes={it} onLink={onLink} />
            </li>
          ))
          return b.ordered ? (
            <ol key={i} className="ml-5 flex list-decimal flex-col gap-1.5">
              {items}
            </ol>
          ) : (
            <ul key={i} className="ml-5 flex list-disc flex-col gap-1.5">
              {items}
            </ul>
          )
        }
        return (
          <p key={i} className="leading-relaxed">
            <Inlines nodes={b.children} onLink={onLink} />
          </p>
        )
      })}
    </div>
  )
}

function Inlines({ nodes, onLink }: { nodes: Inline[]; onLink: (link: Exclude<HelpLink, { kind: 'invalid' }>) => void }): React.JSX.Element {
  return <>{nodes.map((n, i) => <InlineNode key={i} node={n} onLink={onLink} />)}</>
}

function InlineNode({ node, onLink }: { node: Inline; onLink: (link: Exclude<HelpLink, { kind: 'invalid' }>) => void }): ReactNode {
  const t = useT()
  if (node.kind === 'text') return node.text
  if (node.kind === 'bold') {
    return (
      <strong className="font-semibold">
        <Inlines nodes={node.children} onLink={onLink} />
      </strong>
    )
  }
  const link = resolveHelpLink(node.href)
  if (link.kind === 'invalid') return <Inlines nodes={node.children} onLink={onLink} />
  const external = link.kind === 'external'
  return (
    <button
      type="button"
      data-testid="help-link"
      data-href={node.href}
      data-kind={link.kind}
      title={external ? t('simple.help.external') : undefined}
      onClick={() => onLink(link)}
      className="inline text-left font-medium text-blue underline decoration-blue/40 underline-offset-2 hover:decoration-blue"
    >
      <Inlines nodes={node.children} onLink={onLink} />
      {external && <span aria-hidden="true"> ↗</span>}
    </button>
  )
}
