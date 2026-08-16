/**
 * A minimal, dependency-free Markdown → HTML converter for GitHub release notes.
 * Escapes HTML first, then applies a handful of line-based transforms: headings,
 * bullet lists, bold, inline code, bare URLs and paragraphs. Not a full CommonMark
 * implementation — just enough for the release-note shapes we actually write.
 */
function escapeHtml(src: string): string {
  return src.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function inline(line: string): string {
  return line
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/`(.+?)`/g, '<code>$1</code>')
    .replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" target="_blank" rel="noopener">$1</a>')
}

export function mdToHtml(src: string): string {
  const lines = escapeHtml(src).replace(/\r\n/g, '\n').split('\n')
  const out: string[] = []
  let inList = false
  let para: string[] = []

  const flushPara = (): void => {
    if (para.length) {
      out.push(`<p>${inline(para.join(' '))}</p>`)
      para = []
    }
  }
  const closeList = (): void => {
    if (inList) {
      out.push('</ul>')
      inList = false
    }
  }

  for (const raw of lines) {
    const line = raw.trimEnd()
    if (line.startsWith('### ')) {
      flushPara()
      closeList()
      out.push(`<h4>${inline(line.slice(4))}</h4>`)
    } else if (line.startsWith('## ')) {
      flushPara()
      closeList()
      out.push(`<h3>${inline(line.slice(3))}</h3>`)
    } else if (line.startsWith('- ') || line.startsWith('* ')) {
      flushPara()
      if (!inList) {
        out.push('<ul>')
        inList = true
      }
      out.push(`<li>${inline(line.slice(2))}</li>`)
    } else if (line.trim() === '') {
      flushPara()
      closeList()
    } else {
      para.push(line.trim())
    }
  }
  flushPara()
  closeList()

  return out.join('\n')
}
