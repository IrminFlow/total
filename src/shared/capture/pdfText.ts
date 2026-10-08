// WP 5.4 — a small PDF text-layer reader, so a PDF bill that HAS a text layer is sent as text
// (smaller, cheaper, and maskable: GSTINs / PANs / account numbers are masked before sending,
// which a page image never can be). No dependency: the caller passes `inflate` (main hands in
// zlib, like the XLSX reader), so this stays pure and unit-tested.
//
// Scope — what Indian accounting / billing software writes: uncompressed or Flate content
// streams, object streams (/ObjStm), simple fonts (WinAnsi / standard encodings, read as Latin-1)
// and Type0 / CID fonts with a /ToUnicode CMap (bfchar + bfrange, 1- or 2-byte codes). Text
// operators Tj, TJ, ', " with Td / TD / T* / Tm line breaks. Anything else (encrypted files,
// fonts without a usable /ToUnicode, scanned images) yields little or no text, and the caller
// falls back to sending the file itself (`textLooksUsable`).

export type Inflate = (data: Uint8Array) => Uint8Array

export interface PdfText {
  pageCount: number
  pages: string[]
  encrypted: boolean
}

interface PdfObject {
  num: number
  dict: string
  /** Raw stream bytes (still encoded) when the object has a stream. */
  stream: Uint8Array | null
}

const latin1 = (b: Uint8Array, from = 0, to = b.length): string => {
  let s = ''
  for (let i = from; i < to; i += 8192) s += String.fromCharCode(...b.subarray(i, Math.min(to, i + 8192)))
  return s
}

function decodeStream(o: PdfObject, inflate: Inflate): Uint8Array | null {
  if (!o.stream) return null
  const filter = /\/Filter\s*(\[[^\]]*\]|\/\w+)/.exec(o.dict)?.[1] ?? ''
  const filters = filter.match(/\/\w+/g) ?? []
  let data = o.stream
  for (const f of filters) {
    if (f === '/FlateDecode' || f === '/Fl') {
      try {
        data = inflate(data)
      } catch {
        return null
      }
    } else return null // images (DCT / JPX / CCITT) and the rest carry no text
  }
  return data
}

/** Every object in the file, including those packed in object streams. */
function readObjects(bytes: Uint8Array, inflate: Inflate): Map<number, PdfObject> {
  const text = latin1(bytes)
  const objs = new Map<number, PdfObject>()
  const re = /(\d+)\s+(\d+)\s+obj\b/g
  const pendingLength: { o: PdfObject; start: number; ref: number }[] = []
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const num = Number(m[1])
    const bodyStart = m.index + m[0].length
    const end = text.indexOf('endobj', bodyStart)
    if (end < 0) break
    let body = text.slice(bodyStart, end)
    const si = body.search(/\bstream\r?\n/)
    let stream: Uint8Array | null = null
    let dict = body
    if (si >= 0) {
      dict = body.slice(0, si)
      const startRel = body.indexOf('\n', si) + 1
      const start = bodyStart + startRel
      const lenDirect = /\/Length\s+(\d+)(?!\s+\d+\s+R)/.exec(dict)
      const lenRef = /\/Length\s+(\d+)\s+\d+\s+R/.exec(dict)
      const o: PdfObject = { num, dict, stream: null }
      if (lenDirect) stream = bytes.subarray(start, start + Number(lenDirect[1]))
      else {
        const es = text.indexOf('endstream', start)
        stream = bytes.subarray(start, es < 0 ? end : es)
        if (lenRef) pendingLength.push({ o, start, ref: Number(lenRef[1]) })
      }
      o.stream = stream
      objs.set(num, o)
      re.lastIndex = end
      continue
    }
    body = body.trim()
    objs.set(num, { num, dict: body, stream: null })
    re.lastIndex = end
  }
  // Streams whose /Length is an indirect number: trim to it once known.
  for (const p of pendingLength) {
    const n = Number(objs.get(p.ref)?.dict.trim())
    if (Number.isInteger(n) && n > 0) p.o.stream = bytes.subarray(p.start, p.start + n)
  }
  // Object streams.
  for (const o of [...objs.values()]) {
    if (!/\/Type\s*\/ObjStm/.test(o.dict)) continue
    const data = decodeStream(o, inflate)
    if (!data) continue
    const n = Number(/\/N\s+(\d+)/.exec(o.dict)?.[1] ?? 0)
    const first = Number(/\/First\s+(\d+)/.exec(o.dict)?.[1] ?? 0)
    const s = latin1(data)
    const head = s.slice(0, first).trim().split(/\s+/).map(Number)
    for (let i = 0; i < n; i++) {
      const num = head[i * 2]!
      const off = head[i * 2 + 1]!
      const next = i + 1 < n ? head[(i + 1) * 2 + 1]! : s.length - first
      if (!objs.has(num)) objs.set(num, { num, dict: s.slice(first + off, first + next).trim(), stream: null })
    }
  }
  return objs
}

const refIn = (dict: string, key: string): number | null => {
  const m = new RegExp(`/${key}\\s+(\\d+)\\s+\\d+\\s+R`).exec(dict)
  return m ? Number(m[1]) : null
}

/** The inner text of `<< ... >>` after `/key` (balanced), or of an indirect ref's object. */
function subDict(dict: string, key: string, objs: Map<number, PdfObject>): string | null {
  const ref = new RegExp(`/${key}\\s+(\\d+)\\s+\\d+\\s+R`).exec(dict)
  if (ref) return objs.get(Number(ref[1]))?.dict ?? null
  const at = dict.search(new RegExp(`/${key}\\s*<<`))
  if (at < 0) return null
  let i = dict.indexOf('<<', at)
  let depth = 0
  const start = i
  for (; i < dict.length - 1; i++) {
    if (dict[i] === '<' && dict[i + 1] === '<') {
      depth++
      i++
    } else if (dict[i] === '>' && dict[i + 1] === '>') {
      depth--
      i++
      if (depth === 0) return dict.slice(start + 2, i - 1)
    }
  }
  return null
}

// ---------- fonts ----------

interface Font {
  bytesPerCode: 1 | 2
  map: Map<number, string> | null
}

function hexToBytes(h: string): number[] {
  const clean = h.replace(/[^0-9a-fA-F]/g, '')
  const out: number[] = []
  for (let i = 0; i < clean.length; i += 2) out.push(parseInt(clean.slice(i, i + 2).padEnd(2, '0'), 16))
  return out
}

function utf16hex(h: string): string {
  const b = hexToBytes(h)
  let s = ''
  for (let i = 0; i + 1 < b.length; i += 2) s += String.fromCharCode((b[i]! << 8) | b[i + 1]!)
  if (b.length % 2) s += String.fromCharCode(b[b.length - 1]!)
  return s
}

export function parseToUnicode(cmap: string): { map: Map<number, string>; bytesPerCode: 1 | 2 } {
  const map = new Map<number, string>()
  let bytesPerCode: 1 | 2 = 1
  const cs = /begincodespacerange\s*<([0-9a-fA-F]+)>/.exec(cmap)
  if (cs && cs[1]!.length >= 4) bytesPerCode = 2
  for (const block of cmap.match(/beginbfchar([\s\S]*?)endbfchar/g) ?? []) {
    for (const m of block.matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]*)>/g)) {
      map.set(parseInt(m[1]!, 16), utf16hex(m[2]!))
      if (m[1]!.length >= 4) bytesPerCode = 2
    }
  }
  for (const block of cmap.match(/beginbfrange([\s\S]*?)endbfrange/g) ?? []) {
    for (const m of block.matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*(<[0-9a-fA-F]*>|\[[^\]]*\])/g)) {
      const lo = parseInt(m[1]!, 16)
      const hi = parseInt(m[2]!, 16)
      if (m[1]!.length >= 4) bytesPerCode = 2
      if (hi < lo || hi - lo > 65535) continue
      if (m[3]!.startsWith('[')) {
        const list = [...m[3]!.matchAll(/<([0-9a-fA-F]*)>/g)].map((x) => utf16hex(x[1]!))
        list.forEach((v, k) => map.set(lo + k, v))
      } else {
        const dst = hexToBytes(m[3]!.slice(1, -1))
        for (let c = lo; c <= hi; c++) {
          const d = [...dst]
          let carry = c - lo
          for (let k = d.length - 1; k >= 0 && carry > 0; k--) {
            const v = d[k]! + carry
            d[k] = v & 0xff
            carry = v >> 8
          }
          let s = ''
          for (let k = 0; k + 1 < d.length; k += 2) s += String.fromCharCode((d[k]! << 8) | d[k + 1]!)
          map.set(c, s)
        }
      }
    }
  }
  return { map, bytesPerCode }
}

function loadFont(dict: string, objs: Map<number, PdfObject>, inflate: Inflate): Font {
  const tu = refIn(dict, 'ToUnicode')
  const isType0 = /\/Subtype\s*\/Type0/.test(dict)
  if (tu != null) {
    const o = objs.get(tu)
    const data = o ? decodeStream(o, inflate) : null
    if (data) {
      const { map, bytesPerCode } = parseToUnicode(latin1(data))
      return { bytesPerCode: isType0 ? 2 : bytesPerCode, map }
    }
  }
  return { bytesPerCode: isType0 ? 2 : 1, map: null }
}

function showText(bytes: number[], font: Font | undefined): string {
  const f = font ?? { bytesPerCode: 1 as const, map: null }
  let s = ''
  for (let i = 0; i < bytes.length; i += f.bytesPerCode) {
    const code = f.bytesPerCode === 2 ? (bytes[i]! << 8) | (bytes[i + 1] ?? 0) : bytes[i]!
    if (f.map) s += f.map.get(code) ?? ''
    else if (f.bytesPerCode === 1) s += code === 0x92 ? '’' : code === 0x96 ? '–' : code === 0x80 ? '€' : String.fromCharCode(code)
  }
  return s
}

// ---------- content streams ----------

type Tok = { t: 'num'; v: number } | { t: 'str'; b: number[] } | { t: 'name'; v: string } | { t: 'op'; v: string } | { t: '[' } | { t: ']' } | { t: 'arr'; items: Tok[] }

function* tokens(s: string): Generator<Tok> {
  const n = s.length
  let i = 0
  while (i < n) {
    const c = s[i]!
    if (c === '%') {
      while (i < n && s[i] !== '\n' && s[i] !== '\r') i++
      continue
    }
    if (/\s/.test(c)) {
      i++
      continue
    }
    if (c === '(') {
      const b: number[] = []
      let depth = 1
      i++
      while (i < n && depth > 0) {
        const d = s[i]!
        if (d === '\\') {
          const e = s[i + 1] ?? ''
          i += 2
          if (e === 'n') b.push(10)
          else if (e === 'r') b.push(13)
          else if (e === 't') b.push(9)
          else if (e === 'b') b.push(8)
          else if (e === 'f') b.push(12)
          else if (e === '\r') {
            if (s[i] === '\n') i++
          } else if (e === '\n') {
            /* line continuation */
          } else if (/[0-7]/.test(e)) {
            let oct = e
            while (oct.length < 3 && /[0-7]/.test(s[i] ?? '')) oct += s[i++]
            b.push(parseInt(oct, 8) & 0xff)
          } else b.push(e.charCodeAt(0))
          continue
        }
        if (d === '(') depth++
        else if (d === ')') {
          depth--
          if (depth === 0) {
            i++
            break
          }
        }
        b.push(d.charCodeAt(0) & 0xff)
        i++
      }
      yield { t: 'str', b }
      continue
    }
    if (c === '<' && s[i + 1] === '<') {
      // A dictionary operand (BDC properties, inline image dict): skip it whole.
      let depth = 0
      while (i < n) {
        if (s[i] === '<' && s[i + 1] === '<') {
          depth++
          i += 2
        } else if (s[i] === '>' && s[i + 1] === '>') {
          depth--
          i += 2
          if (depth === 0) break
        } else i++
      }
      continue
    }
    if (c === '<') {
      const end = s.indexOf('>', i)
      yield { t: 'str', b: hexToBytes(s.slice(i + 1, end < 0 ? n : end)) }
      i = end < 0 ? n : end + 1
      continue
    }
    if (c === '[') {
      yield { t: '[' }
      i++
      continue
    }
    if (c === ']') {
      yield { t: ']' }
      i++
      continue
    }
    if (c === '/') {
      let j = i + 1
      while (j < n && !/[\s/[\]()<>{}%]/.test(s[j]!)) j++
      yield { t: 'name', v: s.slice(i + 1, j) }
      i = j
      continue
    }
    if (/[0-9+\-.]/.test(c)) {
      let j = i + 1
      while (j < n && /[0-9.]/.test(s[j]!)) j++
      yield { t: 'num', v: Number(s.slice(i, j)) || 0 }
      i = j
      continue
    }
    let j = i
    while (j < n && !/[\s/[\]()<>{}%]/.test(s[j]!)) j++
    if (j === i) j++
    const op = s.slice(i, j)
    i = j
    if (op === 'BI') {
      // Inline image: skip to EI.
      const ei = s.indexOf('EI', s.indexOf('ID', i))
      i = ei < 0 ? n : ei + 2
      continue
    }
    yield { t: 'op', v: op }
  }
}

function pageText(content: string, fonts: Map<string, Font>): string {
  let out = ''
  let font: Font | undefined
  let stack: Tok[] = []
  let arr: Tok[] | null = null
  let lastY: number | null = null
  const newline = (): void => {
    if (out && !out.endsWith('\n')) out += '\n'
  }
  const space = (): void => {
    if (out && !/[\s]$/.test(out)) out += ' '
  }
  for (const tok of tokens(content)) {
    if (tok.t === '[') {
      arr = []
      continue
    }
    if (tok.t === ']') {
      stack.push({ t: 'arr', items: arr ?? [] })
      arr = null
      continue
    }
    if (arr) {
      arr.push(tok)
      continue
    }
    if (tok.t !== 'op') {
      stack.push(tok)
      continue
    }
    const nums = stack.filter((x): x is { t: 'num'; v: number } => x.t === 'num').map((x) => x.v)
    switch (tok.v) {
      case 'BT':
        lastY = null
        break
      case 'ET':
        newline()
        break
      case 'Tf': {
        const name = stack.find((x): x is { t: 'name'; v: string } => x.t === 'name')
        if (name) font = fonts.get(name.v)
        break
      }
      case 'Td':
      case 'TD':
        if (nums.length >= 2 && nums[1] !== 0) newline()
        else if (nums.length >= 2 && Math.abs(nums[0]!) > 1) space()
        break
      case 'Tm': {
        const y = nums[5]
        if (y != null && lastY != null && Math.abs(y - lastY) > 0.5) newline()
        else if (lastY != null) space()
        if (y != null) lastY = y
        break
      }
      case 'T*':
        newline()
        break
      case "'":
      case '"':
        newline()
      // falls through
      case 'Tj': {
        const str = [...stack].reverse().find((x): x is { t: 'str'; b: number[] } => x.t === 'str')
        if (str) out += showText(str.b, font)
        break
      }
      case 'TJ': {
        const holder = stack.find((x): x is { t: 'arr'; items: Tok[] } => x.t === 'arr')
        for (const part of holder?.items ?? []) {
          if (part.t === 'str') out += showText(part.b, font)
          else if (part.t === 'num' && part.v < -180) space()
        }
        break
      }
      default:
        break
    }
    stack = []
  }
  return out
    .split('\n')
    .map((l) => l.replace(/[ \t]+/g, ' ').trim())
    .filter(Boolean)
    .join('\n')
}

function pageResources(page: string, objs: Map<number, PdfObject>): string | null {
  let dict: string | undefined = page
  for (let guard = 0; dict && guard < 20; guard++) {
    const r = subDict(dict, 'Resources', objs)
    if (r) return r
    const parent = refIn(dict, 'Parent')
    dict = parent != null ? objs.get(parent)?.dict : undefined
  }
  return null
}

/** Page objects in page-tree order (falls back to file order). */
function orderedPages(objs: Map<number, PdfObject>): PdfObject[] {
  const isPage = (o: PdfObject): boolean => /\/Type\s*\/Page(?!s)\b/.test(o.dict)
  const roots = [...objs.values()].filter((o) => /\/Type\s*\/Pages\b/.test(o.dict) && refIn(o.dict, 'Parent') == null)
  const out: PdfObject[] = []
  const seen = new Set<number>()
  const walk = (o: PdfObject, depth: number): void => {
    if (depth > 30 || seen.has(o.num)) return
    seen.add(o.num)
    if (isPage(o)) {
      out.push(o)
      return
    }
    const kids = /\/Kids\s*\[([^\]]*)\]/.exec(o.dict)?.[1] ?? ''
    for (const m of kids.matchAll(/(\d+)\s+\d+\s+R/g)) {
      const k = objs.get(Number(m[1]))
      if (k) walk(k, depth + 1)
    }
  }
  for (const r of roots) walk(r, 0)
  if (out.length) return out
  return [...objs.values()].filter(isPage)
}

export function extractPdfText(bytes: Uint8Array, inflate: Inflate): PdfText {
  if (latin1(bytes, 0, Math.min(bytes.length, 1024)).indexOf('%PDF') < 0) throw new Error('Not a PDF file')
  const objs = readObjects(bytes, inflate)
  const encrypted = /\/Encrypt\s+\d+\s+\d+\s+R/.test(latin1(bytes, Math.max(0, bytes.length - 4096))) || [...objs.values()].some((o) => /\/Encrypt\s/.test(o.dict) && /\/Root\s/.test(o.dict))
  const pages = orderedPages(objs)
  const fontCache = new Map<number, Font>()
  const texts = encrypted
    ? pages.map(() => '')
    : pages.map((p) => {
        const res = pageResources(p.dict, objs)
        const fontDict = res ? subDict(res, 'Font', objs) : null
        const fonts = new Map<string, Font>()
        for (const m of (fontDict ?? '').matchAll(/\/([^\s/<>[\]()]+)\s+(\d+)\s+\d+\s+R/g)) {
          const num = Number(m[2])
          if (!fontCache.has(num)) fontCache.set(num, loadFont(objs.get(num)?.dict ?? '', objs, inflate))
          fonts.set(m[1]!, fontCache.get(num)!)
        }
        const contents = /\/Contents\s*(\[[^\]]*\]|\d+\s+\d+\s+R)/.exec(p.dict)?.[1] ?? ''
        let content = ''
        for (const m of contents.matchAll(/(\d+)\s+\d+\s+R/g)) {
          const o = objs.get(Number(m[1]))
          const data = o ? decodeStream(o, inflate) : null
          if (data) content += `${latin1(data)}\n`
        }
        try {
          return pageText(content, fonts)
        } catch {
          return ''
        }
      })
  return { pageCount: Math.max(1, pages.length), pages: texts, encrypted }
}

/** Whether a text layer is good enough to send instead of the file: enough letters and digits,
 *  mostly printable, and at least one amount-like figure. */
export function textLooksUsable(text: string): boolean {
  const t = text.trim()
  if (t.length < 40) return false
  const alnum = (t.match(/[\p{L}\p{N}]/gu) ?? []).length
  const printable = (t.match(/[\p{L}\p{N}\p{P}\p{S}\s]/gu) ?? []).length
  if (alnum < 30 || printable / t.length < 0.9) return false
  return /\d[\d,]*\.\d{2}\b/.test(t) || /\d{3,}/.test(t)
}
