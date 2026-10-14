// WP 10.3: the help articles' markdown — a tiny, SAFE subset parsed to plain data that
// components/help renders as React elements (never innerHTML): headings (#, ##, ###),
// paragraphs, bulleted and numbered lists, **bold** and [links](url). Anything else is text —
// a "<b>" in an article shows as the characters "<b>", and articles.test.ts refuses raw HTML.

export type Inline =
  | { kind: 'text'; text: string }
  | { kind: 'bold'; children: Inline[] }
  | { kind: 'link'; href: string; children: Inline[] }

export type Block =
  | { kind: 'heading'; level: 1 | 2 | 3; children: Inline[] }
  | { kind: 'para'; children: Inline[] }
  | { kind: 'list'; ordered: boolean; items: Inline[][] }

/** Inline markup: **bold** and [text](href); everything else (and an unclosed marker) is text. */
export function parseInline(src: string): Inline[] {
  const out: Inline[] = []
  let text = ''
  const flush = (): void => {
    if (text) out.push({ kind: 'text', text })
    text = ''
  }
  let i = 0
  while (i < src.length) {
    if (src.startsWith('**', i)) {
      const end = src.indexOf('**', i + 2)
      if (end > i + 2) {
        flush()
        out.push({ kind: 'bold', children: parseInline(src.slice(i + 2, end)) })
        i = end + 2
        continue
      }
    }
    if (src[i] === '[') {
      const close = src.indexOf('](', i + 1)
      const end = close >= 0 ? src.indexOf(')', close + 2) : -1
      if (close > i + 1 && end > close + 2 && !src.slice(i + 1, close).includes('[')) {
        flush()
        out.push({ kind: 'link', href: src.slice(close + 2, end).trim(), children: parseInline(src.slice(i + 1, close)) })
        i = end + 1
        continue
      }
    }
    text += src[i]
    i++
  }
  flush()
  return out
}

const BULLET = /^\s*[-*]\s+(.*)$/
const NUMBER = /^\s*\d+[.)]\s+(.*)$/
const HEADING = /^(#{1,3})\s+(.*)$/

export function parseMarkdown(src: string): Block[] {
  const blocks: Block[] = []
  let para: string[] = []
  let list: { ordered: boolean; items: string[] } | null = null
  const endPara = (): void => {
    if (para.length) blocks.push({ kind: 'para', children: parseInline(para.join(' ')) })
    para = []
  }
  const endList = (): void => {
    if (list) blocks.push({ kind: 'list', ordered: list.ordered, items: list.items.map(parseInline) })
    list = null
  }
  for (const raw of src.replace(/\r\n?/g, '\n').split('\n')) {
    const line = raw.trimEnd()
    if (!line.trim()) {
      endPara()
      endList()
      continue
    }
    const h = HEADING.exec(line)
    if (h) {
      endPara()
      endList()
      blocks.push({ kind: 'heading', level: h[1]!.length as 1 | 2 | 3, children: parseInline(h[2]!.trim()) })
      continue
    }
    const b = BULLET.exec(line)
    const n = b ? null : NUMBER.exec(line)
    if (b || n) {
      endPara()
      const ordered = !!n
      if (list && list.ordered !== ordered) endList()
      if (!list) list = { ordered, items: [] }
      list.items.push((b ?? n)![1]!.trim())
      continue
    }
    if (list) {
      // A wrapped line continues the last item.
      list.items[list.items.length - 1] += ` ${line.trim()}`
      continue
    }
    para.push(line.trim())
  }
  endPara()
  endList()
  return blocks
}

/** The plain text of some inline content (search, titles, summaries). */
export function inlineText(nodes: Inline[]): string {
  return nodes.map((n) => (n.kind === 'text' ? n.text : inlineText(n.children))).join('')
}

/** Every link target in an article, in order. */
export function linksIn(blocks: Block[]): string[] {
  const out: string[] = []
  const walk = (nodes: Inline[]): void => {
    for (const n of nodes) {
      if (n.kind === 'link') out.push(n.href)
      if (n.kind !== 'text') walk(n.children)
    }
  }
  for (const b of blocks) {
    if (b.kind === 'list') b.items.forEach(walk)
    else walk(b.children)
  }
  return out
}

/** The whole article as plain text (search). */
export function blocksText(blocks: Block[]): string {
  return blocks.map((b) => (b.kind === 'list' ? b.items.map(inlineText).join('\n') : inlineText(b.children))).join('\n')
}
