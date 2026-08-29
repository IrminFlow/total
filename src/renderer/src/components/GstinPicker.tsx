import { useQuery } from '@tanstack/react-query'
import type { GstRegistration } from '@shared/gst/registrations'
import { api } from '../lib/client'
import { Select } from './ui'

/**
 * The company's GST registrations (roadmap #108).
 *
 * Almost every company has exactly one, and for those the whole feature must be invisible: no
 * picker, no default to choose, no new decision on any screen. That is why `<GstinPicker>`
 * renders nothing below two registrations rather than rendering a select with one option in it.
 */
export function useGstRegistrations(): GstRegistration[] {
  const { data } = useQuery({ queryKey: ['gstRegistrations'], queryFn: api.gstReg.list })
  return data ?? []
}

/** The registration a screen should start on: the primary, which is what a one-GSTIN book has. */
export function usePrimaryRegistrationId(): number | null {
  const regs = useGstRegistrations()
  return regs.find((r) => r.isPrimary)?.id ?? regs[0]?.id ?? null
}

export function GstinPicker({
  value,
  onChange,
  testId = 'select-gstin'
}: {
  value: number | null
  onChange: (id: number) => void
  testId?: string
}): React.JSX.Element | null {
  const regs = useGstRegistrations()
  if (regs.length < 2) return null
  const current = value ?? regs.find((r) => r.isPrimary)?.id ?? regs[0]!.id
  return (
    <label className="flex items-center gap-2">
      <span className="text-micro font-semibold tracking-[0.08em] text-muted uppercase">GSTIN</span>
      {/* Compact on purpose: this sits in a toolbar beside the period and the export buttons, and
          the full "27 · Maharashtra — 27AAA…" label pushed them onto a second line. The state name
          is redundant next to the code anyway. */}
      <Select
        data-testid={testId}
        className="w-[15rem]"
        value={String(current)}
        onChange={(e) => onChange(Number(e.target.value))}
      >
        {regs.map((r) => (
          <option key={r.id} value={r.id}>
            {r.stateCode} · {r.gstin ?? 'unregistered'}
            {r.surrenderedOn ? ' (surrendered)' : ''}
          </option>
        ))}
      </Select>
    </label>
  )
}
