import { useEffect, useMemo, useRef, useState } from 'react'
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  PAGE_MM,
  PHASE2_KINDS,
  PRINT_DOC_KIND_LABELS,
  printTemplateSchema,
  type PrintDocKind,
  type PrintTemplate,
  type TemplateList
} from '@shared/printTemplates'
import { api } from '../../../lib/client'
import { confirmDialog } from '../../../lib/dialogs'
import { useSession, useToasts } from '../../../state/stores'
import { Button, Panel, SectionTitle, Select } from '../../../components/ui'
import { TabBar } from '../../../components/TabBar'
import { PaperPreview } from '../../../components/print/PaperPreview'
import { ColumnsEditor } from './ColumnsEditor'
import {
  EinvoiceSection,
  FooterSection,
  HeaderSection,
  PageSection,
  PartySection,
  TotalsSection,
  TypographySection,
  type SectionProps
} from './sections'

const PREVIEW_DEBOUNCE_MS = 250
const ZOOMS = [0.35, 0.5, 0.6, 0.75, 1, 1.25] as const
const PX_PER_MM = 96 / 25.4

const SECTIONS = [
  { id: 'page', label: 'Page' },
  { id: 'header', label: 'Header' },
  { id: 'party', label: 'Party' },
  { id: 'columns', label: 'Columns' },
  { id: 'totals', label: 'Totals' },
  { id: 'footer', label: 'Footer' },
  { id: 'einvoice', label: 'e-Invoice' },
  { id: 'typography', label: 'Typography' }
] as const
type SectionId = (typeof SECTIONS)[number]['id']

const STYLE_NAME: Record<PrintTemplate['style'], string> = { classic: 'Classic', compact: 'Compact', modern: 'Modern', receipt: 'Receipt 80mm' }

/** First validation issue, phrased for a person. */
function firstIssue(t: PrintTemplate): string | null {
  const r = printTemplateSchema.safeParse(t)
  if (r.success) return null
  const i = r.error.issues[0]!
  return `${i.path.join(' › ')}: ${i.message}`
}

/**
 * Settings → Invoice templates (WP 1.10c). Template list, a sectioned editor, and a live preview
 * that renders the unsaved draft through the SAME renderer the PDFs use (template:previewHtml).
 */
export function TemplateDesigner(): React.JSX.Element {
  const toast = useToasts()
  const qc = useQueryClient()
  const { user } = useSession()
  // No users yet = the company is ungated; otherwise viewers read, accountants+ edit.
  const canEdit = !user || user.role !== 'viewer'

  const { data: list } = useQuery({ queryKey: ['printTemplates'], queryFn: api.templates.list })
  const [selectedId, setSelectedId] = useState('classic')
  const { data: saved } = useQuery({ queryKey: ['printTemplate', selectedId], queryFn: () => api.templates.get(selectedId) })
  const [draft, setDraft] = useState<PrintTemplate | null>(null)
  const [section, setSection] = useState<SectionId>('page')
  // 'fit' = scale the paper to the preview column's width (default); otherwise a fixed step.
  const [zoomPick, setZoomPick] = useState<number | 'fit'>('fit')
  const previewBox = useRef<HTMLDivElement>(null)
  // The preview box mounts once the template has loaded — (re)attach the observer then.
  const hasValue = !!(draft ?? saved)
  const [boxW, setBoxW] = useState(0)
  useEffect(() => {
    const el = previewBox.current
    if (!el) return
    const read = (): void => setBoxW(el.clientWidth)
    read()
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(read)
    ro.observe(el)
    return () => ro.disconnect()
  }, [hasValue])
  const [busy, setBusy] = useState(false)
  const value = draft ?? saved ?? null
  const issue = value ? firstIssue(value) : null
  const [previewKind, setPreviewKind] = useState<PrintDocKind>('sales')
  const kind: PrintDocKind = value && !value.kinds.includes(previewKind) ? (value.kinds[0] ?? 'sales') : previewKind
  const pageMm = value ? PAGE_MM[value.page.size] : PAGE_MM.A4
  const pageWpx = (value?.page.orientation === 'landscape' ? pageMm.h : pageMm.w) * PX_PER_MM
  const fitZoom = boxW > 0 ? Math.min(1.25, Math.max(0.3, (boxW - 34) / pageWpx)) : 0.5
  const zoom = zoomPick === 'fit' ? fitZoom : zoomPick
  const stepZoom = (dir: 1 | -1): void => {
    const next = dir > 0 ? ZOOMS.find((z) => z > zoom + 0.001) : [...ZOOMS].reverse().find((z) => z < zoom - 0.001)
    if (next !== undefined) setZoomPick(next)
  }

  // Debounce only VALID drafts into the preview; an invalid edit keeps the last good render.
  const [debounced, setDebounced] = useState<PrintTemplate | null>(null)
  useEffect(() => {
    if (!value || issue) return
    const t = setTimeout(() => setDebounced(value), PREVIEW_DEBOUNCE_MS)
    return () => clearTimeout(t)
  }, [value, issue])
  const previewKey = useMemo(() => (debounced ? JSON.stringify(debounced) : ''), [debounced])
  const { data: preview } = useQuery({
    queryKey: ['printPreview', previewKey, kind],
    queryFn: () => api.templates.previewHtml(debounced!, { kind }),
    enabled: !!debounced,
    placeholderData: keepPreviousData
  })

  const dirty = draft !== null
  const refresh = async (id?: string): Promise<void> => {
    await qc.invalidateQueries({ queryKey: ['printTemplates'] })
    await qc.invalidateQueries({ queryKey: ['printTemplate', id ?? selectedId] })
  }

  const select = async (id: string): Promise<void> => {
    if (id === selectedId) return
    if (dirty && !(await confirmDialog({ title: 'Discard changes?', message: `Unsaved changes to “${value?.name}” will be lost.`, confirmLabel: 'Discard' }))) return
    setDraft(null)
    setDebounced(null)
    setSelectedId(id)
  }

  const update = (next: PrintTemplate): void => {
    if (canEdit) setDraft(next)
  }
  const props: SectionProps | null = value
    ? {
        t: value,
        disabled: !canEdit,
        setTop: (p) => update({ ...value, ...p }),
        patch: (key, p) => update({ ...value, [key]: { ...value[key], ...p } })
      }
    : null

  const run = async (label: string, fn: () => Promise<void>): Promise<void> => {
    setBusy(true)
    try {
      await fn()
    } catch (err) {
      toast.push('error', `${label}: ${(err as Error).message}`)
    } finally {
      setBusy(false)
    }
  }

  const save = (): Promise<void> =>
    run('Save failed', async () => {
      if (!value || issue) return
      await api.templates.save(value)
      setDraft(null)
      await refresh()
      toast.push('success', `“${value.name}” saved`)
    })
  const duplicate = (): Promise<void> =>
    run('Duplicate failed', async () => {
      const copy = await api.templates.duplicate(selectedId)
      await refresh(copy.id)
      setDraft(null)
      setSelectedId(copy.id)
      toast.push('success', `Created “${copy.name}”`)
    })
  const remove = (): Promise<void> =>
    run('Delete failed', async () => {
      if (!value || !(await confirmDialog({ title: 'Delete template?', message: `“${value.name}” will be deleted. Kinds that used it go back to Classic.`, confirmLabel: 'Delete', danger: true }))) return
      await api.templates.remove(selectedId)
      setDraft(null)
      setSelectedId('classic')
      await refresh('classic')
    })
  const reset = (): Promise<void> =>
    run('Reset failed', async () => {
      if (!value || !(await confirmDialog({ title: 'Reset to defaults?', message: `Every customisation of “${value.name}” will be lost.`, confirmLabel: 'Reset' }))) return
      await api.templates.reset(selectedId)
      setDraft(null)
      await refresh()
      toast.push('success', `“${value.name}” reset to its defaults`)
    })
  const setDefault = (k: PrintDocKind): Promise<void> =>
    run('Could not set default', async () => {
      await api.templates.setDefault(k, selectedId)
      await qc.invalidateQueries({ queryKey: ['printTemplates'] })
      toast.push('success', `${PRINT_DOC_KIND_LABELS[k]}s now print with “${value?.name}”`)
    })
  const testPage = (): Promise<void> =>
    run('Test page failed', async () => {
      if (!value || issue) return
      const { path } = await api.templates.testPdf(value, kind)
      toast.push('success', `Test page saved — ${path.split(/[\\/]/).pop()}`)
    })
  const exportJson = (): Promise<void> =>
    run('Export failed', async () => {
      const { path } = await api.templates.exportJson(selectedId)
      toast.push('success', `Exported to ${path.split(/[\\/]/).pop()}`)
    })
  const importJson = (): Promise<void> =>
    run('Import failed', async () => {
      const t = await api.templates.importJson()
      if (!t) return
      await refresh(t.id)
      setDraft(null)
      setSelectedId(t.id)
      toast.push('success', `Imported “${t.name}”`)
    })

  const summary = list?.templates.find((t) => t.id === selectedId)

  return (
    <div
      onKeyDown={(e) => {
        if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
          e.preventDefault()
          if (dirty && !issue && canEdit) void save()
        }
      }}
    >
      <SectionTitle
        right={
          canEdit ? (
            <Button data-testid="btn-settings-tpl-import" disabled={busy} onClick={() => void importJson()}>
              Import…
            </Button>
          ) : undefined
        }
      >
        Invoice templates
      </SectionTitle>

      <TemplateListPanel list={list} selectedId={selectedId} onSelect={(id) => void select(id)} />

      {!value || !props ? (
        <p className="mt-4 text-body text-muted">Loading template…</p>
      ) : (
        <div className="mt-4 grid grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)] items-start gap-4">
          <Panel className="p-4">
            <div className="mb-3 flex flex-wrap items-center gap-2">
              <h3 className="mr-auto text-lead font-semibold" data-testid="settings-tpl-editing">
                {value.name}
                {dirty && <span className="ml-2 text-caption font-normal text-amber">unsaved</span>}
              </h3>
              {canEdit && (
                <>
                  <Button variant="primary" data-testid="btn-settings-tpl-save" disabled={busy || !dirty || !!issue} onClick={() => void save()}>
                    Save
                  </Button>
                  <Button variant="ghost" disabled={busy || !dirty} onClick={() => { setDraft(null) }}>
                    Discard
                  </Button>
                </>
              )}
            </div>
            {issue && (
              <p role="alert" className="mb-3 rounded-md border border-cr/40 bg-cr/10 px-2.5 py-1.5 text-detail text-cr">
                {issue}
              </p>
            )}
            {!canEdit && <p className="mb-3 text-detail text-muted">Viewers can preview templates; accountants and owners edit them.</p>}
            <TabBar screen="settings-tpl" tabs={SECTIONS} active={section} onSelect={setSection} className="mb-4 flex-wrap" />
            <div data-testid={`settings-tpl-section-${section}`}>
              {section === 'page' && <PageSection {...props} />}
              {section === 'header' && <HeaderSection {...props} />}
              {section === 'party' && <PartySection {...props} />}
              {section === 'columns' && <ColumnsEditor columns={value.columns} disabled={!canEdit} onChange={(columns) => props.setTop({ columns })} />}
              {section === 'totals' && <TotalsSection {...props} />}
              {section === 'footer' && <FooterSection {...props} />}
              {section === 'einvoice' && <EinvoiceSection {...props} />}
              {section === 'typography' && <TypographySection {...props} />}
            </div>

            <div className="mt-5 border-t border-line pt-3">
              <p className="mb-2 text-caption font-semibold tracking-[0.08em] text-muted uppercase">Default for</p>
              <div className="flex flex-wrap gap-1.5" role="group" aria-label="Set as default template per document kind">
                {value.kinds
                  .filter((k) => !PHASE2_KINDS.includes(k))
                  .map((k) => {
                    const isDefault = list?.defaults[k] === selectedId
                    const savedKinds = saved?.kinds ?? []
                    return (
                      <Button
                        key={k}
                        variant={isDefault ? 'primary' : 'default'}
                        aria-pressed={isDefault}
                        data-testid={`btn-settings-tpl-default-${k}`}
                        disabled={!canEdit || busy || !savedKinds.includes(k)}
                        disabledTitle={!savedKinds.includes(k) ? 'Save the template first' : undefined}
                        onClick={() => {
                          if (!isDefault) void setDefault(k)
                        }}
                        className="py-1 text-caption"
                      >
                        {isDefault ? '✓ ' : ''}
                        {PRINT_DOC_KIND_LABELS[k]}
                      </Button>
                    )
                  })}
              </div>
            </div>

            <div className="mt-4 flex flex-wrap gap-2 border-t border-line pt-3">
              {canEdit && (
                <Button data-testid="btn-settings-tpl-duplicate" disabled={busy} onClick={() => void duplicate()}>
                  Duplicate
                </Button>
              )}
              <Button data-testid="btn-settings-tpl-export" disabled={busy} onClick={() => void exportJson()}>
                Export JSON
              </Button>
              {canEdit && summary && !summary.builtIn && (
                <Button variant="danger" data-testid="btn-settings-tpl-delete" disabled={busy} onClick={() => void remove()}>
                  Delete
                </Button>
              )}
              {canEdit && summary?.builtIn && (
                <Button variant="ghost" data-testid="btn-settings-tpl-reset" disabled={busy || !summary.customised} disabledTitle="Not customised" onClick={() => void reset()}>
                  Reset to defaults
                </Button>
              )}
            </div>
          </Panel>

          <div className="sticky top-0 flex max-h-[calc(100vh-7rem)] flex-col">
            <div className="mb-2 flex flex-wrap items-center gap-2">
              <span className="mr-auto text-caption font-semibold tracking-[0.08em] text-muted uppercase">Live preview</span>
              <Select aria-label="Sample document" className="max-w-40 py-1 text-detail" value={kind} onChange={(e) => setPreviewKind(e.target.value as PrintDocKind)}>
                {value.kinds.map((k) => <option key={k} value={k}>{PRINT_DOC_KIND_LABELS[k]}</option>)}
              </Select>
              <div className="flex items-center rounded-md border border-line" role="group" aria-label="Zoom">
                <button type="button" aria-label="Zoom out" className="px-2 py-1 text-detail disabled:opacity-30" disabled={zoom <= ZOOMS[0] + 0.001} onClick={() => stepZoom(-1)}>−</button>
                <span className="num w-11 text-center text-detail" data-testid="settings-tpl-zoom">{Math.round(zoom * 100)}%</span>
                <button type="button" aria-label="Zoom in" className="px-2 py-1 text-detail disabled:opacity-30" disabled={zoom >= ZOOMS[ZOOMS.length - 1]! - 0.001} onClick={() => stepZoom(1)}>+</button>
                <button type="button" aria-pressed={zoomPick === 'fit'} className={`border-l border-line px-2 py-1 text-detail ${zoomPick === 'fit' ? 'text-ink' : 'text-muted'}`} onClick={() => setZoomPick('fit')}>Fit</button>
              </div>
              <Button data-testid="btn-settings-tpl-test-page" disabled={busy || !!issue} onClick={() => void testPage()}>
                Print test page
              </Button>
            </div>
            <div ref={previewBox} className="min-h-0 flex-1 overflow-auto rounded-lg border border-line bg-panel2 p-4" data-testid="settings-tpl-preview">
              {preview ? (
                <PaperPreview html={preview.html} page={(debounced ?? value).page} zoom={zoom} title={`Preview of ${value.name}`} />
              ) : (
                <p className="text-body text-muted">Rendering preview…</p>
              )}
            </div>
            <p className="mt-2 text-hint text-muted">
              Sample data · {STYLE_NAME[value.style]} style · the same renderer the PDFs use. Dashed lines ≈ page breaks.
            </p>
          </div>
        </div>
      )}
    </div>
  )
}

function TemplateListPanel({
  list,
  selectedId,
  onSelect
}: {
  list: TemplateList | undefined
  selectedId: string
  onSelect: (id: string) => void
}): React.JSX.Element {
  const defaultsBy = (id: string): PrintDocKind[] =>
    list ? (Object.entries(list.defaults) as [PrintDocKind, string][]).filter(([k, v]) => v === id && !PHASE2_KINDS.includes(k)).map(([k]) => k) : []
  return (
    <Panel>
      <ul className="divide-y divide-line" data-testid="rows-settings-tpl-list" aria-label="Print templates">
        {(list?.templates ?? []).map((t) => {
          const defaults = defaultsBy(t.id)
          const active = t.id === selectedId
          return (
            <li key={t.id}>
              <button
                type="button"
                data-row-id={t.id}
                aria-current={active ? 'true' : undefined}
                onClick={() => onSelect(t.id)}
                className={`flex w-full items-center gap-3 px-4 py-2 text-left text-body hover:bg-panel2 ${active ? 'bg-panel2 shadow-[inset_3px_0_0_var(--t-amber-bar)]' : ''}`}
              >
                <span className="font-medium">{t.name}</span>
                <span className="text-caption text-muted">{STYLE_NAME[t.style]}</span>
                {t.builtIn && <span className="rounded border border-line px-1.5 text-caption text-muted">Built-in{t.customised ? ' · customised' : ''}</span>}
                <span className="ml-auto truncate text-caption text-muted">
                  {defaults.length ? `Default for ${defaults.length === 8 ? 'all documents' : defaults.map((k) => PRINT_DOC_KIND_LABELS[k].toLowerCase()).join(', ')}` : ''}
                </span>
              </button>
            </li>
          )
        })}
      </ul>
    </Panel>
  )
}
