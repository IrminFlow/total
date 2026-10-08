import { useMemo } from 'react'
import { Chip } from './kit/Badge'
import { TypeAhead, type PickerOption } from './pickers'

/**
 * Pick several of a list (report filters): a type-ahead that adds, chips that remove. Values are
 * ids; options carry the labels.
 */
export function MultiPick({
  options,
  value,
  onChange,
  placeholder,
  testId,
  max = 200
}: {
  options: PickerOption[]
  value: number[]
  onChange: (ids: number[]) => void
  placeholder: string
  testId?: string
  max?: number
}): React.JSX.Element {
  const byId = useMemo(() => new Map(options.map((o) => [o.id, o])), [options])
  const remaining = useMemo(() => options.filter((o) => !value.includes(o.id)), [options, value])
  return (
    <div className="flex flex-col gap-1.5">
      {value.length < max && (
        <TypeAhead
          // Remounted after each pick so the box clears for the next one.
          key={value.join(',')}
          options={remaining}
          value={null}
          onPick={(id) => {
            if (id !== null && !value.includes(id)) onChange([...value, id])
          }}
          placeholder={placeholder}
          testId={testId}
        />
      )}
      {value.length > 0 && (
        <div className="flex flex-wrap gap-1" data-testid={testId ? `${testId}-chips` : undefined}>
          {value.map((id) => (
            <Chip key={id} tone="neutral" onRemove={() => onChange(value.filter((v) => v !== id))} removeLabel={`Remove ${byId.get(id)?.label ?? id}`}>
              {byId.get(id)?.label ?? `#${id}`}
            </Chip>
          ))}
        </div>
      )}
    </div>
  )
}
