// WP 10.5: the role / name / label sweep the renderer a11y tests share (no axe in deps).
export const textOf = (el: Element | null): string => (el?.textContent ?? '').replace(/\s+/g, ' ').trim()

/** The element's accessible name, roughly as a browser computes it (enough for these rules). */
function accessibleName(el: Element): string {
  const label = el.getAttribute('aria-label')?.trim()
  if (label) return label
  const by = el.getAttribute('aria-labelledby')
  if (by) {
    const s = by
      .split(/\s+/)
      .map((id) => textOf(document.getElementById(id)))
      .join(' ')
      .trim()
    if (s) return s
  }
  if (el.id) {
    const forLabel = document.querySelector(`label[for="${CSS.escape(el.id)}"]`)
    if (forLabel && textOf(forLabel)) return textOf(forLabel)
  }
  const wrap = el.closest('label')
  if (wrap && wrap !== el && textOf(wrap)) return textOf(wrap)
  const tag = el.tagName
  if (tag !== 'INPUT' && tag !== 'SELECT' && tag !== 'TEXTAREA') {
    // Content, without aria-hidden parts.
    const clone = el.cloneNode(true) as Element
    clone.querySelectorAll('[aria-hidden="true"]').forEach((n) => n.remove())
    if (textOf(clone)) return textOf(clone)
  }
  return el.getAttribute('title')?.trim() ?? ''
}

export function a11yProblems(root: ParentNode = document.body): string[] {
  const out: string[] = []
  const tag = (el: Element): string => `${el.tagName.toLowerCase()}${el.getAttribute('data-testid') ? `[${el.getAttribute('data-testid')}]` : ''}`
  const hidden = (el: Element): boolean => !!el.closest('[hidden], [aria-hidden="true"]')
  const named = 'button, a[href], [role="button"], [role="tab"], [role="radio"], [role="option"], [role="menuitem"], [role="checkbox"], [role="switch"]'
  for (const el of root.querySelectorAll(named)) {
    if (hidden(el)) continue
    if (!accessibleName(el)) out.push(`no name: ${tag(el)}`)
  }
  for (const el of root.querySelectorAll('input:not([type="hidden"]), select, textarea')) {
    if (hidden(el)) continue
    if (!accessibleName(el)) out.push(`no label: ${tag(el)}`)
  }
  for (const attr of ['aria-describedby', 'aria-labelledby']) {
    for (const el of root.querySelectorAll(`[${attr}]`)) {
      for (const id of el.getAttribute(attr)!.split(/\s+/).filter(Boolean)) if (!document.getElementById(id)) out.push(`${attr} → missing #${id}: ${tag(el)}`)
    }
  }
  const inside: [string, string][] = [
    ['[role="tab"]', '[role="tablist"]'],
    ['[role="option"]', '[role="listbox"]'],
    ['[role="radio"]', '[role="radiogroup"]']
  ]
  for (const [child, parent] of inside) for (const el of root.querySelectorAll(child)) if (!el.closest(parent)) out.push(`${child} outside ${parent}: ${tag(el)}`)
  for (const el of root.querySelectorAll('[role="dialog"], [role="alertdialog"], dialog')) if (!accessibleName(el)) out.push(`unnamed dialog: ${tag(el)}`)
  const ids = new Map<string, number>()
  for (const el of root.querySelectorAll('[id]')) ids.set(el.id, (ids.get(el.id) ?? 0) + 1)
  for (const [id, n] of ids) if (n > 1) out.push(`duplicate id #${id} ×${n}`)
  for (const svg of root.querySelectorAll('svg')) {
    if (svg.closest('[aria-hidden="true"]') || svg.getAttribute('role') === 'img' || svg.querySelector('title')) continue
    out.push(`svg not hidden from readers: ${tag(svg.parentElement ?? svg)}`)
  }
  for (const img of root.querySelectorAll('img')) if (!img.hasAttribute('alt')) out.push(`img without alt: ${tag(img)}`)
  for (const table of root.querySelectorAll('table')) if (table.querySelector('tbody tr') && !table.querySelector('th')) out.push(`table without column headers: ${tag(table)}`)
  return out
}

