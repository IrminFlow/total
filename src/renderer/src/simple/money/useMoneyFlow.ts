import { useEffect, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import type { MessageKey } from '@shared/i18n'
import { errorEntry, mapError, type CaughtError } from '@shared/errors'
import type { SimplePreview } from '@shared/simple/intents'
import type { MoneyIntentDraft } from '@shared/simple/money'
import { useT } from '../../lib/i18n'
import { useSimplePost } from '../../lib/simplePost'
import { useUnsavedGuard } from '../../lib/useUnsavedGuard'
import { confirmDialog } from '../../lib/dialogs'
import { useNav } from '../../state/stores'
import { isAnyModalOpen, type FormErrors } from '../../components/ui'
import { useCanSave } from '../ViewerNote'

const REFRESH = ['simpleMoneySetup', 'simpleMoneyBills', 'simpleMoneyList', 'simpleBankLines', 'ledgers', 'dashboard', 'simpleHome'] // i18n-technical: query families

/** An error from main with its field (and its issues' fields) moved by `mapField` — e.g. a
 *  purchase's party is the GST bill's supplier on Money out. */
function remap(err: unknown, mapField: ((f: string | undefined) => string | undefined) | undefined): unknown {
  if (!mapField || !(err instanceof Error)) return err
  const c = err as CaughtError
  const fieldOf = (code: string | undefined, field: string | undefined): string | undefined => mapField(field ?? (code ? errorEntry(code)?.field : undefined))
  return Object.assign(new Error(c.message), {
    ...(c.code ? { code: c.code } : {}),
    ...(fieldOf(c.code, c.field) ? { field: fieldOf(c.code, c.field) } : {}),
    ...(c.params ? { params: c.params } : {}),
    ...(c.issues ? { issues: c.issues.map((i) => ({ ...i, ...(fieldOf(i.code, i.field) ? { field: fieldOf(i.code, i.field) } : {}) })) } : {})
  })
}

/**
 * WP 9.4 — what Money in / Money out / Move money share: the live preview (simple:preview,
 * rehearsed — nothing saved; its plain sentences say what will be recorded and where the party
 * stands), Save through simple:post (one clientId per entry — a retry never posts twice), errors
 * placed under their question (useFormErrors), the unsaved guard, and ⌘↵ / ⌘N / Esc.
 */
export function useMoneyFlow<F extends string>(opts: {
  /** The intent the answers make (null = not complete). */
  intent: MoneyIntentDraft | null
  clientErrors: Partial<Record<F, MessageKey>>
  errors: FormErrors<F>
  dirty: boolean
  /** Before the post: add an account the answers need (Owner's money / drawings); returns the
   *  intent to send, or null when it could not. */
  prepare?: () => Promise<MoneyIntentDraft | null>
  mapField?: (field: string | undefined) => string | undefined
  onStartNew: () => void
  /** WP 10.1: the Ask Total draft this entry was opened from (its first save consumes it). */
  aiDraftId?: number | null
  /** Where Esc → discard goes (default: back). Opened from a bank line: back to that Bank. */
  leave?: () => void
}): {
  preview: SimplePreview | null
  previewing: boolean
  saving: boolean
  savedIds: number[] | null
  general: { text: string; details: string } | null
  save: () => Promise<void>
  startNew: () => void
  askDiscard: () => Promise<boolean>
  /** WP 10.8: false for a viewer (no Save, no "Create …" rows). */
  canSave: boolean
} {
  const t = useT()
  const canSave = useCanSave()
  const nav = useNav()
  const queryClient = useQueryClient()
  const poster = useSimplePost({ aiDraftId: opts.aiDraftId ?? null })
  const [preview, setPreview] = useState<SimplePreview | null>(null)
  const [savedIds, setSavedIds] = useState<number[] | null>(null)
  const [general, setGeneral] = useState<{ text: string; details: string } | null>(null)
  const [leaving, setLeaving] = useState(false)
  const saving = poster.status === 'posting'
  const { intent, clientErrors, errors } = opts
  const ready = !!intent && Object.keys(clientErrors).length === 0

  const dirty = !savedIds && !leaving && opts.dirty
  useUnsavedGuard(dirty)
  const leaveRef = useRef(opts.leave)
  leaveRef.current = opts.leave
  const left = useRef(false)
  useEffect(() => {
    // Once: `nav` changes with every move, and a screen still mounted must not leave again.
    if (!leaving || left.current) return
    left.current = true
    ;(leaveRef.current ?? nav.back)()
  }, [leaving, nav])

  // ---------- the preview (debounced; a refusal just clears it — Save says why, under its field) ----------
  const intentKey = intent ? JSON.stringify(intent) : ''
  const previewRef = useRef(poster.preview)
  previewRef.current = poster.preview
  const [previewing, setPreviewing] = useState(false)
  useEffect(() => {
    setPreview(null)
    if (!ready || savedIds) return
    setPreviewing(true)
    let stale = false
    const id = window.setTimeout(() => {
      previewRef.current(intent!).then(
        (p) => !stale && (setPreview(p), setPreviewing(false)),
        () => !stale && (setPreview(null), setPreviewing(false))
      )
    }, 300)
    return () => {
      stale = true
      window.clearTimeout(id)
      setPreviewing(false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [intentKey, ready, savedIds])

  const place = (err: unknown): void => {
    setGeneral(null)
    const moved = remap(err, opts.mapField)
    const mapped = errors.apply(moved)
    if (mapped.general || Object.keys(mapped.fields).length === 0) {
      setGeneral({ text: mapped.general || t('simple.money.err.problem'), details: mapError(moved as CaughtError, { simple: true, t }).details })
    }
  }

  const save = async (): Promise<void> => {
    if (saving) return
    setGeneral(null)
    const keys = Object.entries(clientErrors) as [F, MessageKey][]
    if (keys.length || !intent) {
      for (const [f, key] of keys) errors.set(f, t(key as 'simple.money.err.amount')) // i18n-technical: keys from the shared checks
      return
    }
    try {
      const send = opts.prepare ? await opts.prepare() : intent
      if (!send) return
      const r = await poster.post(send)
      setSavedIds(r.voucherIds)
      for (const k of REFRESH) void queryClient.invalidateQueries({ queryKey: [k] })
    } catch (err) {
      place(err)
    }
  }

  const startNew = (): void => {
    poster.reset()
    setSavedIds(null)
    setPreview(null)
    setGeneral(null)
    errors.clear()
    opts.onStartNew()
  }

  const askDiscard = (): Promise<boolean> =>
    confirmDialog({ title: t('simple.money.discardTitle'), message: t('simple.money.discardBody'), confirmLabel: t('simple.money.discard'), cancelLabel: t('simple.money.keepEditing'), danger: true })

  // ⌘↵ save · ⌘N new · Esc asks before discarding (capture phase, ahead of the app's Esc = back).
  const keyRef = useRef<(e: KeyboardEvent) => void>(() => undefined)
  keyRef.current = (e: KeyboardEvent): void => {
    if (isAnyModalOpen()) return
    const mod = e.metaKey || e.ctrlKey
    if (mod && e.key === 'Enter') {
      e.preventDefault()
      e.stopPropagation()
      if (!savedIds && canSave) void save() // WP 10.8 review: a viewer's ⌘↵ saves nothing (the note says why)
      return
    }
    if (mod && !e.shiftKey && e.key.toLowerCase() === 'n') {
      e.preventDefault()
      e.stopPropagation()
      if (savedIds || !dirty) startNew()
      else void askDiscard().then((ok) => ok && startNew())
      return
    }
    if (e.key === 'Escape' && dirty) {
      const tag = (e.target as HTMLElement | null)?.tagName
      if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return
      e.preventDefault()
      e.stopPropagation()
      void askDiscard().then((ok) => ok && setLeaving(true))
    }
  }
  useEffect(() => {
    const h = (e: KeyboardEvent): void => keyRef.current(e)
    window.addEventListener('keydown', h, true)
    return () => window.removeEventListener('keydown', h, true)
  }, [])

  return { preview, previewing, saving, savedIds, general, save, startNew, askDiscard, canSave }
}
