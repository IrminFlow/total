// Shared bits of the WP 3.4 GST screens: the FY picker, the per-head money cells, and the
// "where this comes from" drawer section + UNVERIFIED banner (Phase 3 sourcing rule: every
// figure cites its source on screen).
import { fyFromStartYear, fyOf, todayISO } from '@shared/dates'
import { GST_SOURCES, GST_UNVERIFIED, type GstSource, type GstSourceId } from '@shared/gst/sources'
import { useSession } from '../../state/stores'
import { Banner, DrawerSection, Money, Select } from '../../components/ui'

export function useFyChoices(): number[] {
  const { info } = useSession()
  const current = fyOf(todayISO()).startYear
  const years: number[] = []
  for (let y = current; y >= Math.min(current, info?.booksFrom ?? current); y--) years.push(y)
  return years
}

export function FySelect({ value, onChange, testId }: { value: number; onChange: (y: number) => void; testId: string }): React.JSX.Element {
  const years = useFyChoices()
  return (
    <Select value={value} onChange={(e) => onChange(Number(e.target.value))} className="w-36" aria-label="Financial year" data-testid={testId}>
      {years.map((y) => (
        <option key={y} value={y}>
          FY {fyFromStartYear(y).label}
        </option>
      ))}
    </Select>
  )
}

export const HEAD_COLUMNS = [
  { key: 'igst', label: 'IGST' },
  { key: 'cgst', label: 'CGST' },
  { key: 'sgst', label: 'SGST' },
  { key: 'cess', label: 'Cess' }
] as const

export type HeadAmounts = { igst: number; cgst: number; sgst: number; cess: number }

export const sumHeads = (h: HeadAmounts): number => h.igst + h.cgst + h.sgst + h.cess

/** One table row of a per-head figure (rule 42 / 43 tables, 3B-style). */
export function HeadsRow({ label, value, strong, negative, testId }: { label: React.ReactNode; value: HeadAmounts; strong?: boolean; negative?: boolean; testId?: string }): React.JSX.Element {
  return (
    <tr className={strong ? 'total-row' : ''} data-testid={testId}>
      <td>{label}</td>
      {HEAD_COLUMNS.map((h) => (
        <td key={h.key} className="r">
          <Money paise={negative ? -value[h.key] : value[h.key]} signed={negative} />
        </td>
      ))}
    </tr>
  )
}

/** Drawer section listing the sources a screen's figures rest on (URL + date accessed). */
export function SourcesSection({ ids }: { ids: readonly GstSourceId[] }): React.JSX.Element {
  return (
    <DrawerSection title="Sources">
      <ul className="flex flex-col gap-2">
        {ids.map((id) => {
          const s: GstSource = GST_SOURCES[id]
          return (
            <li key={id} className="text-hint text-muted">
              <span className="text-ink">{s.title}</span>
              {!s.verified && <span className="ml-1 font-medium text-warning">UNVERIFIED</span>}
              <br />
              <span className="num select-all break-all">{s.url}</span> · accessed {s.accessed}
              {s.note && <><br />{s.note}</>}
            </li>
          )
        })}
      </ul>
      <p className="text-hint text-muted">Rates, thresholds and layouts are taken from these texts — have a CA confirm them before you file.</p>
    </DrawerSection>
  )
}

/** The UNVERIFIED items a screen depends on, as one compact banner. */
export function UnverifiedBanner({ ids, testId }: { ids: string[]; testId: string }): React.JSX.Element | null {
  const items = GST_UNVERIFIED.filter((u) => ids.includes(u.id))
  if (items.length === 0) return null
  return (
    <Banner tone="info" title="UNVERIFIED — check before filing" className="mb-3" testId={testId}>
      <ul className="list-disc pl-4">
        {items.map((u) => (
          <li key={u.id}>{u.text}</li>
        ))}
      </ul>
    </Banner>
  )
}
