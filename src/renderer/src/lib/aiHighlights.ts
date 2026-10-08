// WP 5.3 — "fields the model set" highlighting in the voucher editors. The draft lists the fields
// it filled ('party', 'date', 'line:0', …); this marks the matching controls with `data-ai-set`
// (styled in app.css) without the editors knowing about drafts: fields are found by their Field
// caption ("Date", "Party (buyer)", "Sales ledger"…) and item / ledger rows by position in the
// editor's line table. Editing a marked control clears its mark — the value is the user's now.
import { useEffect } from 'react'

/** Field caption patterns per draft field (Field renders `<label><span>Caption</span>…</label>`). */
const CAPTIONS: Record<string, RegExp> = {
  date: /^date$/i,
  party: /^(party|consignee|supplier|customer)\b/i,
  account: /^(sales|purchase) ledger$/i,
  narration: /^narration/i,
  reference: /(ref\.|reference)/i,
  purpose: /^purpose$/i,
  validUntil: /^valid until/i,
  dueDate: /^(expected delivery|deliver by)/i,
  godown: /^godown$/i,
  labour: /^labour cost$/i,
  instrumentNo: /^cheque/i,
  bills: /^bill name$/i,
  terms: /^terms/i
}

/** Test ids of controls that are not inside a captioned Field. */
const TEST_IDS: Record<string, string[]> = {
  finishedItem: ['picker-manufacture-item'],
  qty: ['input-manufacture-qty'],
  bom: ['manufacture-bom']
}

const LINE_ROWS = [
  'tbody[data-testid="rows-invoice-lines"] > tr[data-line-key]',
  'tbody[data-testid="rows-voucher-lines"] > tr:not([data-testid])',
  'tr[data-testid="manufacture-raw-row"]'
]

/** The elements a draft field maps to inside `root`. */
export function elementsForField(root: ParentNode, field: string): HTMLElement[] {
  const line = /^line:(\d+)$/.exec(field)
  if (line) {
    for (const sel of LINE_ROWS) {
      const rows = root.querySelectorAll<HTMLElement>(sel)
      if (rows.length) {
        const row = rows[Number(line[1])]
        return row ? [row] : []
      }
    }
    return []
  }
  const out: HTMLElement[] = []
  const caption = CAPTIONS[field]
  if (caption) {
    root.querySelectorAll<HTMLLabelElement>('label').forEach((l) => {
      const span = l.querySelector(':scope > span')
      if (span && caption.test((span.textContent ?? '').replace(/\*$/, '').trim())) out.push(l)
    })
  }
  for (const id of TEST_IDS[field] ?? []) {
    root.querySelectorAll<HTMLElement>(`[data-testid="${id}"]`).forEach((el) => out.push(el.closest('label') ?? el))
  }
  return out
}

/** Mark every field; returns how many fields found at least one element. */
export function markAiFields(root: ParentNode, fields: readonly string[], cleared: ReadonlySet<string>): number {
  let found = 0
  for (const f of fields) {
    if (cleared.has(f)) continue
    const els = elementsForField(root, f)
    if (els.length) found++
    for (const el of els) if (el.getAttribute('data-ai-set') !== f) el.setAttribute('data-ai-set', f)
  }
  return found
}

/** Keep the draft's fields marked while the editor mounts its inputs (masters load async), for a
 *  few seconds; an edit inside a marked control clears that field for good. Pass the editor's
 *  container element (a state-held callback ref, so the hook runs once it mounts). */
export function useAiFieldHighlights(el: HTMLElement | null, fields: readonly string[] | null | undefined): void {
  const key = (fields ?? []).join('|')
  useEffect(() => {
    if (!el || !fields || fields.length === 0) return
    const cleared = new Set<string>()
    const apply = (): void => {
      markAiFields(el, fields, cleared)
    }
    apply()
    const observer = new MutationObserver(apply)
    observer.observe(el, { childList: true, subtree: true })
    const stop = window.setTimeout(() => observer.disconnect(), 5000)
    const onEdit = (e: Event): void => {
      const marked = (e.target as HTMLElement | null)?.closest?.('[data-ai-set]')
      if (!marked) return
      const f = marked.getAttribute('data-ai-set')
      if (f) cleared.add(f)
      marked.removeAttribute('data-ai-set')
    }
    el.addEventListener('input', onEdit, true)
    el.addEventListener('change', onEdit, true)
    return () => {
      observer.disconnect()
      window.clearTimeout(stop)
      el.removeEventListener('input', onEdit, true)
      el.removeEventListener('change', onEdit, true)
      el.querySelectorAll('[data-ai-set]').forEach((n) => n.removeAttribute('data-ai-set'))
    }
    // `key` stands for `fields`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [el, key])
}
