import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { api, type CustomFieldInput } from '../../lib/client'
import { useToasts } from '../../state/stores'
import { Button, Field, Panel, SectionTitle, Select, TextInput } from '../../components/ui'
import {
  CUSTOM_FIELD_KINDS,
  CUSTOM_FIELD_KIND_LABEL,
  type CustomFieldKind
} from '@shared/customFields'
import { confirmDialog } from '../../lib/dialogs'

/**
 * Fields a company defines for itself, per voucher type (roadmap #195).
 *
 * The rule this screen has to state out loud, because the shape of the form invites the opposite
 * assumption: a number here is a NUMBER. It is not an amount, nothing adds it to a ledger and no
 * report will ever total it. Money belongs in a ledger, or it is not in the trial balance and not
 * in the return.
 */
export function CustomFieldsSection(): React.JSX.Element {
  const toast = useToasts()
  const queryClient = useQueryClient()
  const { data: types } = useQuery({ queryKey: ['voucherTypes'], queryFn: api.voucherTypes.list })
  const { data: fields } = useQuery({ queryKey: ['customFields'], queryFn: () => api.customFields.list() })
  const [typeId, setTypeId] = useState<number | ''>('')
  const [label, setLabel] = useState('')
  const [kind, setKind] = useState<CustomFieldKind>('text')
  const [options, setOptions] = useState('')
  const [required, setRequired] = useState(false)
  const [printed, setPrinted] = useState(true)

  const effectiveType = typeId === '' ? (types?.[0]?.id ?? null) : typeId
  const refresh = async (): Promise<void> => {
    await queryClient.invalidateQueries({ queryKey: ['customFields'] })
  }

  const add = async (): Promise<void> => {
    if (effectiveType == null) return
    const payload: CustomFieldInput = {
      voucherTypeId: effectiveType,
      label: label.trim(),
      kind,
      options: kind === 'list' ? options.split(',').map((o) => o.trim()).filter(Boolean) : [],
      required,
      printed
    }
    try {
      await api.customFields.save(payload)
      await refresh()
      setLabel('')
      setOptions('')
      toast.push('success', `${payload.label} added`)
    } catch (err) {
      toast.push('error', (err as Error).message)
    }
  }

  const remove = async (id: number, fieldLabel: string): Promise<void> => {
    const ok = await confirmDialog({
      title: `Remove ${fieldLabel}`,
      message:
        'It disappears from new entries. Vouchers that already carry a value keep it, and keep printing it — that is what those documents said when they were issued.',
      confirmLabel: 'Remove'
    })
    if (!ok) return
    try {
      const { retained } = await api.customFields.remove(id)
      await refresh()
      toast.push(
        'success',
        retained > 0
          ? `${fieldLabel} removed — ${retained} voucher${retained === 1 ? '' : 's'} keep its value`
          : `${fieldLabel} removed`
      )
    } catch (err) {
      toast.push('error', (err as Error).message)
    }
  }

  const rows = (fields ?? []).filter((f) => f.voucherTypeId === effectiveType)

  return (
    <div>
      <SectionTitle>Custom fields</SectionTitle>
      <p className="mb-3 text-hint text-muted">
        A field you define, on one voucher type, shown on entry and printed on the document. A
        number field holds a number — not an amount. Nothing here reaches a ledger, a total or a
        return; money that matters has to be a ledger line.
      </p>

      <Panel className="p-3">
        <div className="grid grid-cols-4 gap-3">
          <Field label="On voucher type">
            <Select
              data-testid="select-cf-type"
              value={effectiveType ?? ''}
              onChange={(e) => setTypeId(e.target.value ? Number(e.target.value) : '')}
            >
              {(types ?? []).map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Label">
            <TextInput data-testid="input-cf-label" value={label} onChange={(e) => setLabel(e.target.value)} />
          </Field>
          <Field label="Kind">
            <Select data-testid="select-cf-kind" value={kind} onChange={(e) => setKind(e.target.value as CustomFieldKind)}>
              {CUSTOM_FIELD_KINDS.map((k) => (
                <option key={k} value={k}>
                  {CUSTOM_FIELD_KIND_LABEL[k]}
                </option>
              ))}
            </Select>
          </Field>
          {kind === 'list' && (
            <Field label="Choices" hint="Comma separated">
              <TextInput data-testid="input-cf-options" value={options} onChange={(e) => setOptions(e.target.value)} />
            </Field>
          )}
        </div>
        <div className="mt-3 flex items-center gap-4">
          <label className="flex items-center gap-2 text-small">
            <input type="checkbox" data-testid="check-cf-required" checked={required} onChange={(e) => setRequired(e.target.checked)} />
            Required
          </label>
          <label className="flex items-center gap-2 text-small">
            <input type="checkbox" data-testid="check-cf-printed" checked={printed} onChange={(e) => setPrinted(e.target.checked)} />
            Print it on the document
          </label>
          <Button variant="primary" data-testid="btn-cf-add" onClick={() => void add()} disabled={!label.trim()}>
            Add field
          </Button>
        </div>
      </Panel>

      <Panel className="mt-3" data-testid="panel-cf-list">
        {rows.length === 0 ? (
          <p className="p-3 text-hint text-muted">No custom fields on this voucher type.</p>
        ) : (
          <table className="ledger-table">
            <thead>
              <tr>
                <th scope="col">Label</th>
                <th scope="col" className="w-40">Kind</th>
                <th scope="col" className="w-32">Required</th>
                <th scope="col" className="w-32">Printed</th>
                <th scope="col" className="w-40" />
              </tr>
            </thead>
            <tbody data-testid="rows-cf">
              {rows.map((f) => (
                <tr key={f.id} data-testid={`row-cf-${f.key}`}>
                  <td>
                    {f.label}
                    {f.retiredAt && <span className="ml-2 text-hint text-muted">removed</span>}
                  </td>
                  <td className="text-muted">
                    {CUSTOM_FIELD_KIND_LABEL[f.kind]}
                    {f.kind === 'list' && f.options.length > 0 && (
                      <span className="ml-1 text-hint">({f.options.join(', ')})</span>
                    )}
                  </td>
                  <td className="text-muted">{f.required ? 'yes' : '—'}</td>
                  <td className="text-muted">{f.printed ? 'yes' : '—'}</td>
                  <td className="r">
                    {!f.retiredAt && (
                      <button
                        className="row-action text-small text-cr hover:underline"
                        data-testid={`btn-cf-remove-${f.key}`}
                        onClick={() => void remove(f.id, f.label)}
                      >
                        Remove
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Panel>
    </div>
  )
}
