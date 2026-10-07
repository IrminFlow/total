import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useSession } from '../../state/stores'
import {
  applyLegacyReportConfig,
  defaultView,
  parseViewState,
  sameView,
  type ColumnDef,
  type ViewDefaults,
  type ViewState
} from '../../lib/table'

/**
 * Saved table views per company + screen, in localStorage (never the company database — a view
 * is purely a display preference). Key: `total-tableview-<company-slug>-<screenId>`.
 *
 * Stored document (versioned; anything unreadable falls back to defaults):
 *   { v: 2, current: ViewState, active: string | null, saved: { name, view }[] }
 *
 * v2 (WP 1.10a): a view's `density` may be null = follow the app density setting. v1 documents
 * still load: their density was always 'comfortable' unless the user picked compact, so a v1
 * 'comfortable' is read as null (follow the app) and 'compact' stays an explicit choice.
 *
 * `current` is the live view (what the user last saw); `saved` are named views; `active` is the
 * saved view `current` was last switched to/saved as, or null for the default view.
 */
export const TABLE_VIEW_STORE_VERSION = 2

export interface SavedView {
  name: string
  view: ViewState
}

export interface TableViewController {
  view: ViewState
  setView: (next: ViewState | ((v: ViewState) => ViewState)) => void
  /** The screen's default view (derived from columns + defaults). */
  defaults: ViewState
  /** False for an unpersisted table (no screenId) — the saved-views menu is hidden. */
  persistent: boolean
  saved: SavedView[]
  /** Name of the saved view in use, or null for the default. */
  active: string | null
  /** The current view differs from the active saved view (or from the default). */
  modified: boolean
  saveAs: (name: string) => void
  switchTo: (name: string | null) => void
  rename: (from: string, to: string) => void
  remove: (name: string) => void
  /** Back to the screen default (keeps the saved views). */
  reset: () => void
}

export interface UseTableViewOptions {
  defaults?: ViewDefaults
  /** Migration: a `useReportConfig` reportKey whose stored column toggles seed the first view. */
  legacyReportKey?: string
  /** Legacy toggle key → column id(s), when they differ. */
  legacyIdMap?: Record<string, string | string[]>
}

interface StoredDoc {
  current: ViewState
  active: string | null
  saved: SavedView[]
}

export function tableViewStorageKey(slug: string | null, screenId: string): string {
  return `total-tableview-${slug ?? 'nocompany'}-${screenId}`
}

function loadDoc<Row>(
  key: string | null,
  legacyKey: string | null,
  columns: readonly ColumnDef<Row>[],
  defaults: ViewState,
  legacyIdMap?: Record<string, string | string[]>
): StoredDoc {
  const fresh: StoredDoc = { current: defaults, active: null, saved: [] }
  if (!key) return fresh
  let raw: string | null = null
  try {
    raw = localStorage.getItem(key)
  } catch {
    return fresh
  }
  if (!raw) {
    if (!legacyKey) return fresh
    let legacy: string | null = null
    try {
      legacy = localStorage.getItem(legacyKey)
    } catch {
      /* ignore */
    }
    return { ...fresh, current: applyLegacyReportConfig(legacy, columns, defaults, legacyIdMap) }
  }
  try {
    const o = JSON.parse(raw) as Record<string, unknown>
    if (!o || typeof o !== 'object' || (o.v !== TABLE_VIEW_STORE_VERSION && o.v !== 1)) return fresh
    // v1 → v2: the old default 'comfortable' becomes "follow the app density".
    const migrate = o.v === 1 ? (v: ViewState): ViewState => (v.density === 'comfortable' ? { ...v, density: null } : v) : (v: ViewState): ViewState => v
    const saved: SavedView[] = Array.isArray(o.saved)
      ? (o.saved as unknown[])
          .filter((s): s is { name: string; view: unknown } => !!s && typeof (s as SavedView).name === 'string' && (s as SavedView).name.trim() !== '')
          .map((s) => ({ name: s.name, view: migrate(parseViewState(s.view, columns, defaults)) }))
          .filter((s, i, arr) => arr.findIndex((x) => x.name === s.name) === i)
      : []
    const active = typeof o.active === 'string' && saved.some((s) => s.name === o.active) ? o.active : null
    return { current: migrate(parseViewState(o.current, columns, defaults)), active, saved }
  } catch {
    return fresh
  }
}

function writeDoc(key: string | null, doc: StoredDoc): void {
  if (!key) return
  try {
    localStorage.setItem(key, JSON.stringify({ v: TABLE_VIEW_STORE_VERSION, ...doc }))
  } catch {
    /* quota / private mode — the view still works for this session */
  }
}

/**
 * Persistence for a DataTable's view. `screenId` null = unpersisted (in-memory only).
 * Re-loads when the company (slug) or screen changes, like useReportConfig.
 */
export function useTableView<Row>(
  screenId: string | null,
  columns: readonly ColumnDef<Row>[],
  options: UseTableViewOptions = {}
): TableViewController {
  const slug = useSession((s) => s.slug)
  const key = screenId ? tableViewStorageKey(slug, screenId) : null
  const legacyKey = screenId && options.legacyReportKey ? `total-reportcfg-${slug ?? 'nocompany'}-${options.legacyReportKey}` : null

  // Columns are usually declared inline/per render; key derived state on their ids + kinds.
  const colSig = columns.map((c) => `${c.id}:${c.kind}:${c.defaultHidden ? 1 : 0}`).join('|')
  const columnsRef = useRef(columns)
  columnsRef.current = columns
  const defaultsSig = JSON.stringify(options.defaults ?? {})
  const defaults = useMemo(
    () => defaultView(columnsRef.current, options.defaults),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [colSig, defaultsSig]
  )
  const legacyMapRef = useRef(options.legacyIdMap)
  legacyMapRef.current = options.legacyIdMap

  const [doc, setDoc] = useState<StoredDoc>(() => loadDoc(key, legacyKey, columns, defaults, options.legacyIdMap))
  const loadedFor = useRef(`${key}|${colSig}|${defaultsSig}`)
  useEffect(() => {
    const sig = `${key}|${colSig}|${defaultsSig}`
    if (loadedFor.current === sig) return
    loadedFor.current = sig
    setDoc(loadDoc(key, legacyKey, columnsRef.current, defaults, legacyMapRef.current))
  }, [key, legacyKey, colSig, defaultsSig, defaults])

  const keyRef = useRef(key)
  keyRef.current = key
  const update = useCallback((fn: (d: StoredDoc) => StoredDoc) => {
    setDoc((d) => {
      const next = fn(d)
      writeDoc(keyRef.current, next)
      return next
    })
  }, [])

  const setView = useCallback<TableViewController['setView']>(
    (next) => update((d) => ({ ...d, current: typeof next === 'function' ? next(d.current) : next })),
    [update]
  )

  const activeSaved = doc.saved.find((s) => s.name === doc.active)
  const modified = !sameView(doc.current, activeSaved ? activeSaved.view : defaults)

  return {
    view: doc.current,
    setView,
    defaults,
    persistent: key !== null,
    saved: doc.saved,
    active: doc.active,
    modified,
    saveAs: (name) => {
      const n = name.trim()
      if (!n) return
      update((d) => ({
        ...d,
        active: n,
        saved: d.saved.some((s) => s.name === n)
          ? d.saved.map((s) => (s.name === n ? { name: n, view: d.current } : s))
          : [...d.saved, { name: n, view: d.current }]
      }))
    },
    switchTo: (name) =>
      update((d) => {
        if (name === null) return { ...d, active: null, current: defaults }
        const s = d.saved.find((x) => x.name === name)
        return s ? { ...d, active: name, current: s.view } : d
      }),
    rename: (from, to) => {
      const n = to.trim()
      if (!n || from === n) return
      update((d) =>
        d.saved.some((s) => s.name === n)
          ? d // never clobber another saved view by renaming onto it
          : { ...d, active: d.active === from ? n : d.active, saved: d.saved.map((s) => (s.name === from ? { ...s, name: n } : s)) }
      )
    },
    remove: (name) => update((d) => ({ ...d, active: d.active === name ? null : d.active, saved: d.saved.filter((s) => s.name !== name) })),
    reset: () => update((d) => ({ ...d, active: null, current: defaults }))
  }
}
