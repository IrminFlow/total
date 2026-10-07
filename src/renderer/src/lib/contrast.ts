/**
 * WCAG 2.x contrast helpers — pure, no DOM. Used by the token contrast test (both themes) and
 * mirrored in scripts/e2e/12-theme-a11y.mjs for the on-screen sweep.
 */

export type RGBA = [number, number, number, number]

/** Parses '#rgb', '#rrggbb', 'rgb(r, g, b)' or 'rgba(r, g, b, a)'. Null when unparseable. */
export function parseColor(css: string): RGBA | null {
  const s = css.trim().toLowerCase()
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/.exec(s)
  if (hex) {
    const h = hex[1]!.length === 3 ? [...hex[1]!].map((c) => c + c).join('') : hex[1]!
    return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16), 1]
  }
  const fn = /^rgba?\(([^)]+)\)$/.exec(s)
  if (fn) {
    const parts = fn[1]!.split(/[\s,/]+/).filter(Boolean).map(Number)
    if (parts.length < 3 || parts.some((n) => Number.isNaN(n))) return null
    return [parts[0]!, parts[1]!, parts[2]!, parts[3] ?? 1]
  }
  return null
}

/** Composites `top` (possibly translucent) over an opaque `bottom`. */
export function blend(top: RGBA, bottom: RGBA): RGBA {
  const a = top[3]
  return [top[0] * a + bottom[0] * (1 - a), top[1] * a + bottom[1] * (1 - a), top[2] * a + bottom[2] * (1 - a), 1]
}

export function luminance([r, g, b]: RGBA): number {
  const f = (c: number): number => {
    const s = c / 255
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4)
  }
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b)
}

/** Contrast ratio (1–21) between two opaque colours. */
export function contrastRatio(a: RGBA, b: RGBA): number {
  const [l1, l2] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number]
  return (l1 + 0.05) / (l2 + 0.05)
}
