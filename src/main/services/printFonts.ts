import { readFileSync } from 'fs'
import { createRequire } from 'module'
import type { PlexFamily } from '@shared/print/render'

/**
 * @font-face CSS for the bundled IBM Plex faces (the @fontsource packages are production
 * dependencies, so they ship inside the app). The woff2 files are inlined as data URLs so a
 * printed document stays self-contained — the hidden PDF window loads a data: URL and can't reach
 * the renderer's font files. Latin subset, regular + semibold (semibold also serves <b>); glyphs
 * outside it (₹ lives in latin-ext) fall back per-character to the next face in the stack.
 * Cached per family; any failure yields '' (system fallback faces still apply).
 */
const req = createRequire(typeof __filename === 'string' ? __filename : `${process.cwd()}/index.js`)

const PKG: Record<PlexFamily, { pkg: string; family: string; file: string }> = {
  'plex-sans': { pkg: '@fontsource/ibm-plex-sans', family: 'IBM Plex Sans', file: 'ibm-plex-sans' },
  'plex-serif': { pkg: '@fontsource/ibm-plex-serif', family: 'IBM Plex Serif', file: 'ibm-plex-serif' },
  'plex-mono': { pkg: '@fontsource/ibm-plex-mono', family: 'IBM Plex Mono', file: 'ibm-plex-mono' }
}

const cache = new Map<PlexFamily, string>()

function face(family: string, path: string, weight: string): string {
  const b64 = readFileSync(path).toString('base64')
  return `@font-face { font-family: '${family}'; font-style: normal; font-weight: ${weight}; src: url(data:font/woff2;base64,${b64}) format('woff2'); }`
}

export function plexFontFaceCss(fam: PlexFamily): string {
  const hit = cache.get(fam)
  if (hit !== undefined) return hit
  let css = ''
  try {
    const p = PKG[fam]
    const file = (w: number): string => req.resolve(`${p.pkg}/files/${p.file}-latin-${w}-normal.woff2`)
    css = [face(p.family, file(400), '400'), face(p.family, file(600), '600 700')].join('\n    ')
  } catch {
    css = ''
  }
  cache.set(fam, css)
  return css
}
