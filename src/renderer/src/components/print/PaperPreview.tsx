import { useCallback, useEffect, useRef, useState } from 'react'
import { PAGE_MM, type PrintTemplate } from '@shared/printTemplates'

/** CSS px per mm at the 96dpi the print engine lays out with. */
const PX_PER_MM = 96 / 25.4

/**
 * A sheet of paper showing a rendered print document (HTML from the ONE renderer, via IPC) at a
 * zoom. The paper is always white — it's the printout, not app chrome — regardless of the app
 * theme. Page size, orientation and margins come from the template so line wraps match the PDF.
 * Pages are shown as one continuous strip; dashed rules mark every page-content height, i.e.
 * roughly where the engine breaks (it also keeps rows whole and repeats the table header, so
 * the real PDF — "Print test page" — is the authority on breaks).
 *
 * The iframe is sandboxed with NO scripts; `allow-same-origin` only so this component can read
 * the content height and size the paper to it.
 */
export function PaperPreview({
  html,
  page,
  zoom,
  title = 'Print preview'
}: {
  html: string
  page: PrintTemplate['page']
  zoom: number
  title?: string
}): React.JSX.Element {
  const frame = useRef<HTMLIFrameElement>(null)
  const dims = PAGE_MM[page.size]
  const landscape = page.orientation === 'landscape'
  const pageW = (landscape ? dims.h : dims.w) * PX_PER_MM
  const pageH = (landscape ? dims.w : dims.h) * PX_PER_MM
  const m = page.marginsMm
  const contentW = pageW - (m.left + m.right) * PX_PER_MM
  const contentH = pageH - (m.top + m.bottom) * PX_PER_MM
  const [docH, setDocH] = useState(contentH)

  const measure = useCallback((): void => {
    const body = frame.current?.contentDocument?.body
    if (body) setDocH(Math.max(contentH, body.scrollHeight))
  }, [contentH])
  useEffect(() => {
    measure()
  }, [html, measure])

  const pages = Math.max(1, Math.ceil(docH / contentH))
  // One continuous strip: top margin, every page's content area back to back, bottom margin.
  const paperH = (m.top + m.bottom) * PX_PER_MM + pages * contentH

  return (
    <div
      data-testid="print-paper"
      data-pages={pages}
      className="relative mx-auto shadow-[0_1px_4px_rgba(0,0,0,0.25)]"
      style={{ width: pageW * zoom, height: paperH * zoom }}
    >
      <div
        style={{
          width: pageW,
          height: paperH,
          transform: `scale(${zoom})`,
          transformOrigin: 'top left',
          background: '#ffffff',
          paddingTop: m.top * PX_PER_MM,
          paddingLeft: m.left * PX_PER_MM,
          position: 'relative'
        }}
      >
        <iframe
          ref={frame}
          title={title}
          sandbox="allow-same-origin"
          srcDoc={html}
          onLoad={measure}
          style={{ width: contentW, height: docH, border: 0, display: 'block', background: '#ffffff' }}
        />
        {Array.from({ length: pages - 1 }, (_, i) => (
          <div
            key={i}
            aria-hidden
            style={{ position: 'absolute', left: 0, right: 0, top: m.top * PX_PER_MM + (i + 1) * contentH, borderTop: '1px dashed #9aa0a6' }}
          />
        ))}
      </div>
    </div>
  )
}
