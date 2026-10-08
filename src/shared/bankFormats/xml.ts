/**
 * Minimal, dependency-free XML reader for the bank-statement importers (CAMT.053, and the XLSX
 * reader's sharedStrings / sheet parts). Builds a small element tree; `local` strips any
 * namespace prefix so callers match `Ntry` whatever prefix the document uses. Handles
 * attributes, self-closing tags, comments, processing instructions, CDATA, DOCTYPE and the five
 * predefined entities plus numeric character references. Not a validating parser — malformed
 * input degrades (unclosed tags close at end of input) instead of throwing, except when there is
 * no root element at all.
 */
export interface XmlNode {
  name: string
  /** Name without a namespace prefix (`ns:Ntry` → `Ntry`). */
  local: string
  attrs: Record<string, string>
  children: XmlNode[]
  /** Concatenated direct text content (entities decoded). */
  text: string
}

export function decodeEntities(s: string): string {
  if (!s.includes('&')) return s
  return s.replace(/&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);/g, (_, e: string) => {
    if (e === 'amp') return '&'
    if (e === 'lt') return '<'
    if (e === 'gt') return '>'
    if (e === 'quot') return '"'
    if (e === 'apos') return "'"
    const code = e[1] === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)
    return Number.isFinite(code) ? String.fromCodePoint(code) : ''
  })
}

const localOf = (name: string): string => {
  const i = name.indexOf(':')
  return i >= 0 ? name.slice(i + 1) : name
}

export function parseXml(src: string): XmlNode {
  const root: XmlNode = { name: '#document', local: '#document', attrs: {}, children: [], text: '' }
  const stack: XmlNode[] = [root]
  let i = 0
  const n = src.length
  while (i < n) {
    const lt = src.indexOf('<', i)
    if (lt < 0) {
      stack[stack.length - 1]!.text += decodeEntities(src.slice(i))
      break
    }
    if (lt > i) stack[stack.length - 1]!.text += decodeEntities(src.slice(i, lt))
    if (src.startsWith('<!--', lt)) {
      const end = src.indexOf('-->', lt + 4)
      i = end < 0 ? n : end + 3
      continue
    }
    if (src.startsWith('<![CDATA[', lt)) {
      const end = src.indexOf(']]>', lt + 9)
      stack[stack.length - 1]!.text += src.slice(lt + 9, end < 0 ? n : end)
      i = end < 0 ? n : end + 3
      continue
    }
    if (src.startsWith('<?', lt)) {
      const end = src.indexOf('?>', lt + 2)
      i = end < 0 ? n : end + 2
      continue
    }
    if (src.startsWith('<!', lt)) {
      // DOCTYPE (possibly with an internal subset in [...]).
      let depth = 0
      let j = lt + 2
      for (; j < n; j++) {
        const c = src[j]
        if (c === '[') depth++
        else if (c === ']') depth--
        else if (c === '>' && depth <= 0) break
      }
      i = j + 1
      continue
    }
    // Find the tag end, honouring quoted attribute values.
    let j = lt + 1
    let quote: string | null = null
    for (; j < n; j++) {
      const c = src[j]!
      if (quote) {
        if (c === quote) quote = null
      } else if (c === '"' || c === "'") quote = c
      else if (c === '>') break
    }
    const body = src.slice(lt + 1, j)
    i = j + 1
    if (body.startsWith('/')) {
      const name = body.slice(1).trim()
      // Pop to the matching open element (tolerates missing close tags in between).
      for (let k = stack.length - 1; k > 0; k--) {
        if (stack[k]!.name === name) {
          stack.length = k
          break
        }
      }
      continue
    }
    const selfClosing = body.endsWith('/')
    const inner = selfClosing ? body.slice(0, -1) : body
    const m = inner.match(/^\s*([^\s/>]+)/)
    if (!m) continue
    const name = m[1]!
    const attrs: Record<string, string> = {}
    const attrRe = /([^\s=]+)\s*=\s*("([^"]*)"|'([^']*)')/g
    let a: RegExpExecArray | null
    const rest = inner.slice(m[0].length)
    while ((a = attrRe.exec(rest))) attrs[a[1]!] = decodeEntities(a[3] ?? a[4] ?? '')
    const node: XmlNode = { name, local: localOf(name), attrs, children: [], text: '' }
    stack[stack.length - 1]!.children.push(node)
    if (!selfClosing) stack.push(node)
  }
  const top = root.children[0]
  if (!top) throw new Error('Not an XML document (no root element)')
  return top
}

/** First direct child with this local name. */
export function child(node: XmlNode | undefined, local: string): XmlNode | undefined {
  return node?.children.find((c) => c.local === local)
}

/** All direct children with this local name. */
export function childrenOf(node: XmlNode | undefined, local: string): XmlNode[] {
  return node ? node.children.filter((c) => c.local === local) : []
}

/** Follow a path of local names through first-matching children. */
export function path(node: XmlNode | undefined, ...locals: string[]): XmlNode | undefined {
  let cur = node
  for (const l of locals) cur = child(cur, l)
  return cur
}

/** Every descendant (depth-first) with this local name. */
export function descendants(node: XmlNode, local: string, out: XmlNode[] = []): XmlNode[] {
  for (const c of node.children) {
    if (c.local === local) out.push(c)
    descendants(c, local, out)
  }
  return out
}

/** Full text content of a node and all descendants. */
export function textOf(node: XmlNode | undefined): string {
  if (!node) return ''
  return node.text + node.children.map(textOf).join('')
}
