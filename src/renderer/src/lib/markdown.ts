// A small, safe markdown subset for assistant answers (WP 5.2): paragraphs, headings, bullet and
// numbered lists, pipe tables, fenced code, rules, and inline **bold**, *italic*, `code`. Parsed
// into plain data that React renders as elements — never HTML (no dangerouslySetInnerHTML, no
// raw tags, no links: a model or a narration it quotes can never inject markup or a URL to click).
// Pure; tested in __tests__/aiChat.test.tsx.

export type Inline =
  | { t: 'text'; v: string }
  | { t: 'strong'; v: Inline[] }
  | { t: 'em'; v: Inline[] }
  | { t: 'code'; v: string }

export type Block =
  | { t: 'p'; v: Inline[] }
  | { t: 'h'; level: 1 | 2 | 3; v: Inline[] }
  | { t: 'ul'; items: Inline[][] }
  | { t: 'ol'; start: number; items: Inline[][] }
  | { t: 'table'; head: Inline[][]; align: ('left' | 'right' | 'center')[]; rows: Inline[][][] }
  | { t: 'code'; v: string }
  | { t: 'hr' }

/** Inline spans. Unclosed markers stay literal text. */
export function parseInline(src: string): Inline[] {
  const out: Inline[] = []
  let buf = ''
  const flush = (): void => {
    if (buf) out.push({ t: 'text', v: buf })
    buf = ''
  }
  let i = 0
  while (i < src.length) {
    const c = src[i]!
    if (c === '\\' && i + 1 < src.length && /[\\`*_|]/.test(src[i + 1]!)) {
      buf += src[i + 1]
      i += 2
      continue
    }
    if (c === '`') {
      const end = src.indexOf('`', i + 1)
      if (end > i + 1) {
        flush()
        out.push({ t: 'code', v: src.slice(i + 1, end) })
        i = end + 1
        continue
      }
    }
    if ((c === '*' || c === '_') && src[i + 1] === c) {
      const end = src.indexOf(c + c, i + 2)
      if (end > i + 2) {
        flush()
        out.push({ t: 'strong', v: parseInline(src.slice(i + 2, end)) })
        i = end + 2
        continue
      }
    }
    if (c === '*' || c === '_') {
      // *x* — not a lone "*" or a word_with_underscores
      const prev = i > 0 ? src[i - 1]! : ' '
      const end = src.indexOf(c, i + 1)
      if (end > i + 1 && !/\s/.test(src[i + 1]!) && !/\s/.test(src[end - 1]!) && !(c === '_' && /\w/.test(prev))) {
        flush()
        out.push({ t: 'em', v: parseInline(src.slice(i + 1, end)) })
        i = end + 1
        continue
      }
    }
    buf += c
    i++
  }
  flush()
  return out
}

const isTableRow = (l: string): boolean => /^\s*\|.*\|\s*$/.test(l)
const isDivider = (l: string): boolean => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(l)

function splitRow(l: string): string[] {
  const t = l.trim().replace(/^\|/, '').replace(/\|$/, '')
  const cells: string[] = []
  let cur = ''
  for (let i = 0; i < t.length; i++) {
    if (t[i] === '\\' && t[i + 1] === '|') {
      cur += '|'
      i++
    } else if (t[i] === '|') {
      cells.push(cur.trim())
      cur = ''
    } else cur += t[i]
  }
  cells.push(cur.trim())
  return cells
}

/** Block structure. Blank lines separate blocks; a list item continues on indented lines. */
export function parseMarkdown(src: string): Block[] {
  const lines = src.replace(/\r\n?/g, '\n').split('\n')
  const blocks: Block[] = []
  let para: string[] = []
  const flushPara = (): void => {
    if (para.length) blocks.push({ t: 'p', v: parseInline(para.join(' ')) })
    para = []
  }
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    if (/^\s*```/.test(line)) {
      flushPara()
      const body: string[] = []
      i++
      while (i < lines.length && !/^\s*```/.test(lines[i]!)) body.push(lines[i++]!)
      blocks.push({ t: 'code', v: body.join('\n') })
      continue
    }
    if (!line.trim()) {
      flushPara()
      continue
    }
    const h = /^(#{1,3})\s+(.*)$/.exec(line)
    if (h) {
      flushPara()
      blocks.push({ t: 'h', level: h[1]!.length as 1 | 2 | 3, v: parseInline(h[2]!.trim()) })
      continue
    }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      flushPara()
      blocks.push({ t: 'hr' })
      continue
    }
    if (isTableRow(line) && i + 1 < lines.length && isDivider(lines[i + 1]!)) {
      flushPara()
      const head = splitRow(line)
      const align = splitRow(lines[i + 1]!).map((d) => (/^:-+:$/.test(d) ? 'center' : /-:$/.test(d) ? 'right' : 'left')) as ('left' | 'right' | 'center')[]
      i += 2
      const rows: Inline[][][] = []
      while (i < lines.length && isTableRow(lines[i]!)) {
        const cells = splitRow(lines[i]!)
        rows.push(head.map((_, c) => parseInline(cells[c] ?? '')))
        i++
      }
      i--
      blocks.push({ t: 'table', head: head.map(parseInline), align: head.map((_, c) => align[c] ?? 'left'), rows })
      continue
    }
    const bullet = /^\s*[-*•]\s+(.*)$/.exec(line)
    const numbered = /^\s*(\d{1,3})[.)]\s+(.*)$/.exec(line)
    if (bullet || numbered) {
      flushPara()
      const ordered = !!numbered
      const items: string[] = [(bullet ?? numbered)![bullet ? 1 : 2]!]
      while (i + 1 < lines.length) {
        const next = lines[i + 1]!
        const nb = /^\s*[-*•]\s+(.*)$/.exec(next)
        const nn = /^\s*(\d{1,3})[.)]\s+(.*)$/.exec(next)
        if (ordered ? nn : nb) {
          items.push((ordered ? nn![2] : nb![1])!)
          i++
        } else if (/^\s{2,}\S/.test(next)) {
          items[items.length - 1] += ` ${next.trim()}`
          i++
        } else break
      }
      blocks.push(ordered ? { t: 'ol', start: Number(numbered![1]), items: items.map(parseInline) } : { t: 'ul', items: items.map(parseInline) })
      continue
    }
    para.push(line.trim())
  }
  flushPara()
  return blocks
}

/** Plain text of inline spans (copy, tests). */
export function inlineText(v: readonly Inline[]): string {
  return v.map((x) => (x.t === 'text' || x.t === 'code' ? x.v : inlineText(x.v))).join('')
}
