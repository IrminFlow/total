import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
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

// ---------------------------------------------------------------- Devanagari (WP 10.4)

/** The family name the print CSS puts in front of every stack for a Hindi print. Its
 *  @font-face carries a Devanagari-only unicode-range, so Latin text, digits and ₹ keep the
 *  template's own faces (the English parts of a Hindi print look exactly as before). */
export const DEVANAGARI_FAMILY = 'Noto Sans Devanagari'
const DEVANAGARI_RANGE = 'U+0900-097F, U+1CD0-1CF9, U+200C-200D, U+25CC, U+A830-A839, U+A8E0-A8FF'

/** Where the bundled font files are: the packaged app's resources (package.json extraResources),
 *  else the repo's resources/fonts (dev, e2e, test:db). */
function fontDirs(): string[] {
  const dirs: string[] = []
  const rp = (process as { resourcesPath?: string }).resourcesPath
  if (rp) dirs.push(join(rp, 'fonts'))
  if (typeof __dirname === 'string') dirs.push(join(__dirname, '../../resources/fonts'), join(__dirname, '../../../resources/fonts'))
  dirs.push(join(process.cwd(), 'resources/fonts'))
  return dirs
}

let devanagariCache: string | undefined
let devanagariDirs: () => string[] = fontDirs

/** @font-face CSS for Noto Sans Devanagari 400 + 600, inlined as data URLs (like the Plex faces).
 *  '' when the files can't be read — the caller then prints English labels, never boxes. */
export function devanagariFontFaceCss(): string {
  if (devanagariCache !== undefined) return devanagariCache
  let css = ''
  for (const dir of devanagariDirs()) {
    const regular = join(dir, 'NotoSansDevanagari-400.woff2')
    const semibold = join(dir, 'NotoSansDevanagari-600.woff2')
    if (!existsSync(regular) || !existsSync(semibold)) continue
    try {
      const f = (path: string, weight: string): string =>
        `@font-face { font-family: '${DEVANAGARI_FAMILY}'; font-style: normal; font-weight: ${weight}; src: url(data:font/woff2;base64,${readFileSync(path).toString('base64')}) format('woff2'); unicode-range: ${DEVANAGARI_RANGE}; }`
      css = [f(regular, '400'), f(semibold, '600 700')].join('\n    ')
      break
    } catch {
      css = ''
    }
  }
  devanagariCache = css
  return css
}

/** Tests: forget the cached face, optionally looking in other folders (the missing-font case). */
export function resetDevanagariFontForTests(dirs?: string[]): void {
  devanagariCache = undefined
  devanagariDirs = dirs ? () => dirs : fontDirs
}
