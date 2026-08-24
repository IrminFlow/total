import { useEffect, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../../lib/client'
import { useSession, useToasts } from '../../state/stores'
import { Button, Field, Panel, SectionTitle, TextInput } from '../../components/ui'
import { DEFAULT_INVOICE_CONFIG, type InvoiceConfig } from '@shared/invoiceConfig'

const MAX_LOGO_BYTES = 200 * 1024
const PREVIEW_DEBOUNCE_MS = 400

export function InvoiceConfigSection(): React.JSX.Element {
  const toast = useToasts()
  const queryClient = useQueryClient()
  const { user, info } = useSession()
  const { data: existing } = useQuery({ queryKey: ['invoiceConfig'], queryFn: api.config.invoice.get })
  const [draft, setDraft] = useState<InvoiceConfig | null>(null)
  const [busy, setBusy] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)
  const value = draft ?? existing ?? DEFAULT_INVOICE_CONFIG
  const canEdit = user?.role === 'owner'

  // A composition dealer prints BILL OF SUPPLY and an unregistered business prints INVOICE, and
  // neither heading is theirs to choose -- so the field is shown as overridden rather than left
  // editable and silently ignored by the printer. A regular dealer's exempt-only supply also
  // prints a bill of supply, but that is per-document, so the field still applies to them.
  const statutoryTitle =
    info?.gstRegistrationType === 'composition'
      ? 'BILL OF SUPPLY'
      : info?.gstRegistrationType === 'unregistered'
        ? 'INVOICE'
        : null

  // Debounce the current (possibly unsaved) draft into the preview query key so the iframe
  // updates as you type, without needing a Save round-trip. The server merges this partial
  // override over the saved config (see invoicePreviewHtml), so it always reflects a full,
  // valid invoice even mid-edit.
  const [debouncedValue, setDebouncedValue] = useState(value)
  useEffect(() => {
    const t = setTimeout(() => setDebouncedValue(value), PREVIEW_DEBOUNCE_MS)
    return () => clearTimeout(t)
  }, [value])
  const { data: preview } = useQuery({
    queryKey: ['invoicePreview', debouncedValue],
    queryFn: () => api.invoice.previewHtml(undefined, debouncedValue)
  })

  const set = (patch: Partial<InvoiceConfig>): void => {
    if (!canEdit) return
    setDraft({ ...value, ...patch })
  }

  const onLogoFile = (file: File | null): void => {
    if (!file) return
    if (file.size > MAX_LOGO_BYTES) {
      toast.push('error', `Logo is ${(file.size / 1024).toFixed(0)}KB — must be under 200KB`)
      if (fileRef.current) fileRef.current.value = ''
      return
    }
    const reader = new FileReader()
    reader.onload = () => set({ logoDataUrl: typeof reader.result === 'string' ? reader.result : null })
    reader.readAsDataURL(file)
  }

  const setCopyLabel = (i: number, label: string): void => {
    const next = [...value.copyLabels]
    next[i] = label
    set({ copyLabels: next })
  }
  const addCopyLabel = (): void => {
    if (value.copyLabels.length >= 3) return
    set({ copyLabels: [...value.copyLabels, `Copy ${value.copyLabels.length + 1}`] })
  }
  const removeCopyLabel = (i: number): void => {
    if (value.copyLabels.length <= 1) return
    set({ copyLabels: value.copyLabels.filter((_, idx) => idx !== i) })
  }

  const save = async (): Promise<void> => {
    if (!value.copyLabels.some((l) => l.trim())) return void toast.push('error', 'At least one copy label is required')
    setBusy(true)
    try {
      await api.config.invoice.set(value)
      await queryClient.invalidateQueries({ queryKey: ['invoiceConfig'] })
      await queryClient.invalidateQueries({ queryKey: ['invoicePreview'] })
      setDraft(null)
      toast.push('success', 'Invoice print settings saved')
    } catch (err) {
      toast.push('error', (err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div>
      <SectionTitle>Invoice print</SectionTitle>
      <div className="grid grid-cols-2 gap-5">
        <Panel className="p-5">
          <div className="flex flex-col gap-3">
            <Field
              label="Title"
              hint={
                statutoryTitle
                  ? `Overridden: this company prints "${statutoryTitle}", which the law fixes and not the company`
                  : 'Printed at the top-right of the invoice'
              }
            >
              <TextInput
                value={value.title}
                onChange={(e) => set({ title: e.target.value })}
                disabled={!canEdit || !!statutoryTitle}
              />
            </Field>
            <Field label="Logo" hint="PNG or JPEG, under 200KB — shown top-left">
              <div className="flex items-center gap-3">
                <input
                  ref={fileRef}
                  type="file"
                  accept="image/png,image/jpeg"
                  disabled={!canEdit}
                  onChange={(e) => onLogoFile(e.target.files?.[0] ?? null)}
                  className="text-small"
                />
                {value.logoDataUrl && (
                  <>
                    <img src={value.logoDataUrl} alt="Logo preview" className="h-8 max-w-24 object-contain" />
                    {canEdit && (
                      <button className="text-hint text-cr hover:underline" onClick={() => set({ logoDataUrl: null })}>
                        Remove
                      </button>
                    )}
                  </>
                )}
              </div>
            </Field>
            <Field label="Declaration">
              <textarea
                value={value.declaration}
                onChange={(e) => set({ declaration: e.target.value })}
                disabled={!canEdit}
                rows={3}
                className="w-full rounded-md border border-line bg-panel2 px-2.5 py-1.5 text-body-sm disabled:opacity-60"
              />
            </Field>
            <Field label="Signatory line">
              <TextInput value={value.signatory} onChange={(e) => set({ signatory: e.target.value })} disabled={!canEdit} />
            </Field>
            <Field label="Terms" hint="Optional — printed under the declaration when non-empty">
              <textarea
                value={value.terms}
                onChange={(e) => set({ terms: e.target.value })}
                disabled={!canEdit}
                rows={2}
                className="w-full rounded-md border border-line bg-panel2 px-2.5 py-1.5 text-body-sm disabled:opacity-60"
              />
            </Field>

            <fieldset className="rounded-md border border-line p-3">
              <label className="flex items-center gap-2 text-body-sm font-medium">
                <input
                  type="checkbox"
                  checked={!!value.bankDetails}
                  disabled={!canEdit}
                  onChange={(e) =>
                    set({ bankDetails: e.target.checked ? { name: '', account: '', ifsc: '', branch: '' } : null })
                  }
                />
                Show bank details on invoice
              </label>
              {value.bankDetails && (
                <div className="mt-3 grid grid-cols-2 gap-2">
                  <Field label="Bank name">
                    <TextInput
                      value={value.bankDetails.name}
                      onChange={(e) => set({ bankDetails: { ...value.bankDetails!, name: e.target.value } })}
                      disabled={!canEdit}
                    />
                  </Field>
                  <Field label="Account no.">
                    <TextInput
                      value={value.bankDetails.account}
                      onChange={(e) => set({ bankDetails: { ...value.bankDetails!, account: e.target.value } })}
                      className="num"
                      disabled={!canEdit}
                    />
                  </Field>
                  <Field label="IFSC">
                    <TextInput
                      value={value.bankDetails.ifsc}
                      onChange={(e) => set({ bankDetails: { ...value.bankDetails!, ifsc: e.target.value.toUpperCase() } })}
                      className="num"
                      disabled={!canEdit}
                    />
                  </Field>
                  <Field label="Branch">
                    <TextInput
                      value={value.bankDetails.branch}
                      onChange={(e) => set({ bankDetails: { ...value.bankDetails!, branch: e.target.value } })}
                      disabled={!canEdit}
                    />
                  </Field>
                </div>
              )}
            </fieldset>

            <div className="flex gap-5">
              <label className="flex items-center gap-2 text-body-sm">
                <input type="checkbox" checked={value.showHsn} disabled={!canEdit} onChange={(e) => set({ showHsn: e.target.checked })} />
                Show HSN column
              </label>
              <label className="flex items-center gap-2 text-body-sm">
                <input
                  type="checkbox"
                  checked={value.showDiscount}
                  disabled={!canEdit}
                  onChange={(e) => set({ showDiscount: e.target.checked })}
                />
                Show discount column
              </label>
              <label className="flex items-center gap-2 text-body-sm">
                <input
                  type="checkbox"
                  checked={value.showQr}
                  disabled={!canEdit}
                  onChange={(e) => set({ showQr: e.target.checked })}
                />
                Show verification QR
              </label>
              <label className="flex items-center gap-2 text-body-sm">
                <input
                  type="checkbox"
                  checked={value.showItemBarcode}
                  disabled={!canEdit}
                  onChange={(e) => set({ showItemBarcode: e.target.checked })}
                />
                Show item barcode column
              </label>
            </div>

            <div>
              <span className="mb-1 block text-caption font-semibold tracking-[0.08em] text-muted uppercase">
                Copies to print (1–3)
              </span>
              <div className="flex flex-col gap-1.5">
                {value.copyLabels.map((label, i) => (
                  <div key={i} className="flex gap-2">
                    <TextInput value={label} onChange={(e) => setCopyLabel(i, e.target.value)} disabled={!canEdit} className="flex-1" />
                    {canEdit && value.copyLabels.length > 1 && (
                      <button className="text-small text-cr" onClick={() => removeCopyLabel(i)}>
                        ×
                      </button>
                    )}
                  </div>
                ))}
                {canEdit && value.copyLabels.length < 3 && (
                  <Button onClick={addCopyLabel} className="self-start">
                    + Add copy
                  </Button>
                )}
              </div>
            </div>

            <div className="mt-2 flex items-center justify-end gap-3">
              {!canEdit && <span className="text-hint text-muted">Only owners can edit invoice print settings</span>}
              {canEdit && (
                <Button variant="primary" disabled={busy || !draft} onClick={() => void save()}>
                  {busy ? 'Saving…' : 'Save'}
                </Button>
              )}
            </div>
          </div>
        </Panel>

        <div>
          <p className="mb-2 text-caption font-semibold tracking-[0.08em] text-muted uppercase">Preview</p>
          <div className="overflow-hidden rounded-lg border border-line bg-white">
            <iframe title="Invoice preview" sandbox="" srcDoc={preview?.html ?? ''} style={{ width: '100%', height: 500, border: 0 }} />
          </div>
          <p className="mt-2 text-hint text-muted">
            Preview updates as you edit — Save to apply.
          </p>
        </div>
      </div>
    </div>
  )
}
