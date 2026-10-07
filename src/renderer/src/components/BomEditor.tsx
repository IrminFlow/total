// BOM versions editor (WP 2.4) — inside the stock item form. One item can have several named,
// effective-dated versions; one is the default (what bom:get returns and the fallback when no
// version is in force). Each line: component · quantity per ONE unit · scrap allowance %.
// Saves per version (its own button), independent of "Save item".
import { useMemo, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { BomVersion } from '@shared/bom'
import { toDisplayDate, todayISO } from '@shared/dates'
import { api } from '../lib/client'
import { useToasts } from '../state/stores'
import { confirmDialog } from '../lib/dialogs'
import { Button, Checkbox, DateInput, Field, Select, TextInput } from './ui'
import { useStockItems } from './pickers'

interface LineDraft {
  componentId: number | ''
  qtyText: string
  scrapText: string
}
interface Draft {
  id?: number
  name: string
  effectiveFrom: string | null
  effectiveTo: string | null
  isDefault: boolean
  lines: LineDraft[]
}

const toDraft = (v: BomVersion): Draft => ({
  id: v.id,
  name: v.name,
  effectiveFrom: v.effectiveFrom,
  effectiveTo: v.effectiveTo,
  isDefault: v.isDefault,
  lines: v.lines.map((l) => ({
    componentId: l.componentId,
    qtyText: String(l.qtyMilliPerUnit / 1000),
    scrapText: l.scrapPctBp ? String(l.scrapPctBp / 100) : ''
  }))
})

const rangeText = (v: { effectiveFrom: string | null; effectiveTo: string | null }): string =>
  v.effectiveFrom || v.effectiveTo ? `${v.effectiveFrom ? toDisplayDate(v.effectiveFrom) : '…'} – ${v.effectiveTo ? toDisplayDate(v.effectiveTo) : '…'}` : 'always'

export function BomVersionsEditor({ itemId }: { itemId: number }): React.JSX.Element {
  const toast = useToasts()
  const queryClient = useQueryClient()
  const allItems = useStockItems()
  const { data: versions } = useQuery({ queryKey: ['bomVersions', itemId], queryFn: () => api.bom.versions(itemId) })
  const [selected, setSelected] = useState<number | 'new' | null>(null)
  const [draft, setDraft] = useState<Draft | null>(null)
  const current = useMemo(() => {
    if (draft) return draft
    const list = versions ?? []
    const v = selected === 'new' ? null : (list.find((x) => x.id === selected) ?? list.find((x) => x.isDefault) ?? list[0])
    return v ? toDraft(v) : { name: list.length === 0 ? 'v1' : `v${list.length + 1}`, effectiveFrom: null, effectiveTo: null, isDefault: list.length === 0, lines: [] }
  }, [draft, versions, selected])
  const edit = (patch: Partial<Draft>): void => setDraft({ ...current, ...patch })
  const setLine = (i: number, patch: Partial<LineDraft>): void => {
    const lines = [...current.lines]
    if (i < lines.length) lines[i] = { ...lines[i]!, ...patch }
    else lines.push({ componentId: '', qtyText: '1', scrapText: '', ...patch })
    edit({ lines: lines.filter((l) => l.componentId !== '') })
  }

  const save = async (): Promise<void> => {
    try {
      const lines = current.lines
        .filter((l) => l.componentId !== '' && Number(l.qtyText) > 0)
        .map((l) => ({
          componentId: l.componentId as number,
          qtyMilliPerUnit: Math.round(Number(l.qtyText) * 1000),
          scrapPctBp: l.scrapText.trim() ? Math.round(Number(l.scrapText) * 100) : null
        }))
      const saved = await api.bom.saveVersion({
        ...(current.id ? { id: current.id } : {}), itemId, name: current.name, effectiveFrom: current.effectiveFrom,
        effectiveTo: current.effectiveTo, isDefault: current.isDefault, lines
      })
      setDraft(null)
      setSelected(saved.id)
      await queryClient.invalidateQueries({ queryKey: ['bomVersions'] })
      await queryClient.invalidateQueries({ queryKey: ['bom'] })
      toast.push('success', `BOM version ${saved.name} saved`)
    } catch (err) {
      toast.push('error', (err as Error).message)
    }
  }
  const remove = async (): Promise<void> => {
    if (!current.id) return
    const ok = await confirmDialog({
      title: 'Delete BOM version',
      message: `Delete version “${current.name}”? Manufactures that used it keep their figures.`,
      confirmLabel: 'Delete',
      danger: true
    })
    if (!ok) return
    try {
      await api.bom.deleteVersion(current.id)
      setDraft(null)
      setSelected(null)
      await queryClient.invalidateQueries({ queryKey: ['bomVersions'] })
      await queryClient.invalidateQueries({ queryKey: ['bom'] })
    } catch (err) {
      toast.push('error', (err as Error).message)
    }
  }

  return (
    <div data-testid="bom-editor">
      <span className="mb-1.5 block text-caption font-semibold tracking-[0.08em] text-muted uppercase">Bill of materials — components per 1 unit</span>
      <div className="mb-2 grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] items-end gap-2">
        <Field label="Version">
          <Select
            value={current.id ?? 'new'}
            onChange={(e) => {
              setDraft(null)
              setSelected(e.target.value === 'new' ? 'new' : Number(e.target.value))
            }}
            data-testid="input-bom-version"
          >
            {(versions ?? []).map((v) => (
              <option key={v.id} value={v.id}>
                {v.name}
                {v.isDefault ? ' (default)' : ''} · {rangeText(v)}
              </option>
            ))}
            <option value="new">+ New version</option>
          </Select>
        </Field>
        <Field label="Name">
          <TextInput value={current.name} onChange={(e) => edit({ name: e.target.value })} data-testid="input-bom-version-name" />
        </Field>
        <div className="pb-1.5">
          <Checkbox label="Default" checked={current.isDefault} onChange={(v) => edit({ isDefault: v })} testId="input-bom-default" />
        </div>
      </div>
      <div className="mb-2 grid grid-cols-2 items-end gap-2">
        <Field label="Effective from">
          {current.effectiveFrom ? (
            <DateInput value={current.effectiveFrom} context={todayISO()} onChange={(d) => edit({ effectiveFrom: d })} testId="input-bom-effective-from" />
          ) : (
            <Button size="sm" variant="ghost" data-testid="btn-bom-set-from" onClick={() => edit({ effectiveFrom: todayISO() })}>
              The beginning · set a date
            </Button>
          )}
        </Field>
        <Field label="Effective to">
          {current.effectiveTo ? (
            <DateInput value={current.effectiveTo} context={todayISO()} onChange={(d) => edit({ effectiveTo: d })} testId="input-bom-effective-to" />
          ) : (
            <Button size="sm" variant="ghost" data-testid="btn-bom-set-to" onClick={() => edit({ effectiveTo: current.effectiveFrom ?? todayISO() })}>
              Open-ended · set a date
            </Button>
          )}
        </Field>
      </div>
      {(current.effectiveFrom || current.effectiveTo) && (
        <button type="button" className="mb-2 text-hint text-blue hover:underline" onClick={() => edit({ effectiveFrom: null, effectiveTo: null })}>
          Clear dates (in force always)
        </button>
      )}
      {[...current.lines, { componentId: '' as const, qtyText: '', scrapText: '' }].map((row, i) => (
        <div key={i} className="mb-1.5 flex gap-2" data-testid="bom-line">
          <Select
            value={row.componentId}
            onChange={(e) => setLine(i, { componentId: e.target.value ? Number(e.target.value) : '' })}
            className="flex-1"
            aria-label={`Component ${i + 1}`}
            data-testid={`input-bom-component-${i}`}
          >
            <option value="">— add component —</option>
            {allItems
              .filter((si) => si.id !== itemId)
              .map((si) => (
                <option key={si.id} value={si.id}>
                  {si.name}
                </option>
              ))}
          </Select>
          {i < current.lines.length && (
            <>
              <TextInput
                value={row.qtyText}
                onChange={(e) => setLine(i, { qtyText: e.target.value })}
                className="num w-24 text-right"
                placeholder="Qty"
                aria-label={`Component ${i + 1} quantity per unit`}
                data-testid={`input-bom-qty-${i}`}
              />
              <TextInput
                value={row.scrapText}
                onChange={(e) => setLine(i, { scrapText: e.target.value })}
                className="num w-20 text-right"
                placeholder="Scrap %"
                aria-label={`Component ${i + 1} scrap percent`}
                data-testid={`input-bom-scrap-${i}`}
              />
            </>
          )}
        </div>
      ))}
      <div className="mt-2 flex items-center justify-between gap-2">
        <span className="text-caption text-muted">The Manufacture voucher fills its raw rows from the version in force on its date.</span>
        <div className="flex gap-2">
          {current.id && (
            <Button size="sm" variant="ghost" onClick={() => void remove()} data-testid="btn-bom-delete-version">
              Delete version
            </Button>
          )}
          <Button size="sm" onClick={() => void save()} data-testid="btn-bom-save-version" disabled={!draft && current.id != null}>
            Save BOM version
          </Button>
        </div>
      </div>
    </div>
  )
}
