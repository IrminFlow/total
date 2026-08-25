import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api } from '../../lib/client'
import type { Voucher } from '@shared/domain'
import { Field, Panel, Select, TextInput } from '../../components/ui'
import { CUSTOM_FIELD_KIND_LABEL, formatCustomValue } from '@shared/customFields'

/**
 * The company's own fields, on the voucher being entered (roadmap #195).
 *
 * Defined in Settings → Custom fields, per voucher type. They ride on the save payload rather
 * than being written afterwards, so a value that fails validation takes the whole voucher down
 * with it — a saved entry with a half-written extra field is worse than a refused save.
 *
 * A retired field still appears on an ALTERATION that carries a value for it, read-only. What the
 * document said when it was issued is not something a later settings change gets to rewrite.
 */
export function useVoucherCustomFields(
  typeId: number,
  existing?: Voucher | null
): { node: React.JSX.Element | null; values: { fieldId: number; value: string }[] } {
  const { data: defs } = useQuery({
    queryKey: ['customFields', typeId],
    queryFn: () => api.customFields.list(typeId)
  })
  const [typed, setTyped] = useState<Record<number, string>>({})

  const carried = useMemo(() => {
    const map: Record<number, string> = {}
    for (const v of existing?.customFields ?? []) map[v.fieldId] = v.value
    return map
  }, [existing])

  const live = defs ?? []
  const retiredWithValues = (existing?.customFields ?? []).filter(
    (v) => v.retired && !live.some((d) => d.id === v.fieldId)
  )

  const valueOf = (fieldId: number): string => typed[fieldId] ?? carried[fieldId] ?? ''

  const values = [
    ...live.map((d) => ({ fieldId: d.id, value: valueOf(d.id) })),
    // Resubmitted unchanged so that saving an old voucher does not quietly drop what it carries.
    ...retiredWithValues.map((v) => ({ fieldId: v.fieldId, value: v.value }))
  ]

  if (live.length === 0 && retiredWithValues.length === 0) return { node: null, values }

  const node = (
    <Panel className="mt-4 p-3" data-testid="panel-custom-fields">
      <div className="mb-2 text-caption tracking-[0.08em] text-muted uppercase">Other details</div>
      <div className="grid grid-cols-3 gap-3">
        {live.map((d) => (
          <Field
            key={d.id}
            label={d.required ? `${d.label} *` : d.label}
            hint={d.kind === 'number' ? 'A number, not an amount' : d.kind === 'list' ? CUSTOM_FIELD_KIND_LABEL.list : undefined}
          >
            {d.kind === 'list' ? (
              <Select
                data-testid={`input-cf-${d.key}`}
                value={valueOf(d.id)}
                onChange={(e) => setTyped((t) => ({ ...t, [d.id]: e.target.value }))}
              >
                <option value="">—</option>
                {d.options.map((o) => (
                  <option key={o} value={o}>
                    {o}
                  </option>
                ))}
              </Select>
            ) : (
              <TextInput
                data-testid={`input-cf-${d.key}`}
                type={d.kind === 'date' ? 'date' : 'text'}
                className={d.kind === 'number' ? 'num text-right' : undefined}
                value={valueOf(d.id)}
                onChange={(e) => setTyped((t) => ({ ...t, [d.id]: e.target.value }))}
              />
            )}
          </Field>
        ))}
        {retiredWithValues.map((v) => (
          <Field key={v.fieldId} label={v.label} hint="This field was removed — kept as issued">
            <TextInput data-testid={`input-cf-${v.key}`} value={formatCustomValue(v.kind, v.value)} disabled readOnly />
          </Field>
        ))}
      </div>
    </Panel>
  )

  return { node, values }
}
