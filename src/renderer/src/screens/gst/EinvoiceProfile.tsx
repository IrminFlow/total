import { fyFromStartYear, fyOf, toDisplayDate } from '@shared/dates'
import type { EinvoiceStatus } from '@shared/compliance'
import {
  EINVOICE_APPLICABILITY_UNVERIFIED,
  EINVOICE_EXEMPTIONS,
  EINVOICE_EXEMPTION_LABELS,
  EINVOICE_FIRST_COUNTED_FY,
  describeEinvoiceApplicability,
  type EinvoiceExemption,
  type GstTurnover
} from '@shared/gst/einvoiceApplicability'
import { AmountInput, Banner, Button, Checkbox, Field, Select } from '../../components/ui'

/** One turnover row while the form edits it (paise null = typed but not an amount yet). */
export interface TurnoverRow {
  fy: string
  paise: number | null
}

export interface EinvoiceProfileDraft {
  rows: TurnoverRow[]
  otherGstins: boolean
  exemption: EinvoiceExemption | ''
}

export function draftFromProfile(turnover: GstTurnover | undefined, exemption: EinvoiceExemption | undefined): EinvoiceProfileDraft {
  return {
    rows: (turnover?.years ?? []).map((y) => ({ fy: y.fy, paise: y.paise })),
    otherGstins: turnover?.otherGstins ?? false,
    exemption: exemption ?? ''
  }
}

/** The draft as gstProfile:set's patch values (empty table = no turnover). Rows without an
 *  amount are dropped; newest FY first, as the table shows them. */
export function profileFromDraft(d: EinvoiceProfileDraft): { turnover: GstTurnover | null; einvoiceExemption: EinvoiceExemption | null } {
  const years = d.rows.filter((r) => r.paise != null).map((r) => ({ fy: r.fy, paise: r.paise! }))
  return {
    turnover: years.length ? { years, ...(d.otherGstins ? { otherGstins: true } : {}) } : null,
    einvoiceExemption: d.exemption || null
  }
}

/** FYs the turnover can be entered for: 2017-18 (Notification 70/2020-CT) to the current one. */
function fyChoices(today: string): string[] {
  const out: string[] = []
  for (let y = fyOf(today).startYear; y >= EINVOICE_FIRST_COUNTED_FY; y--) out.push(fyFromStartYear(y).label)
  return out
}

/**
 * To-do §4 — Company details → GST: the business profile e-invoice applicability is worked out
 * from (shared/gst/einvoiceApplicability.ts). Saved with the form (owner only, through
 * gstProfile:set); the "turn it on" banner only ticks the switch — the owner still saves.
 */
export function EinvoiceProfileSection({
  draft,
  onDraft,
  status,
  switchOn,
  onTurnOn,
  today
}: {
  draft: EinvoiceProfileDraft
  onDraft: (d: EinvoiceProfileDraft) => void
  status: EinvoiceStatus | undefined
  /** The switch as the form shows it (ticked, maybe not yet saved). */
  switchOn: boolean
  onTurnOn: () => void
  today: string
}): React.JSX.Element {
  const used = new Set(draft.rows.map((r) => r.fy))
  const free = fyChoices(today).filter((fy) => !used.has(fy))
  const setRow = (i: number, patch: Partial<TurnoverRow>): void => onDraft({ ...draft, rows: draft.rows.map((r, j) => (j === i ? { ...r, ...patch } : r)) })
  const a = status?.applicability
  return (
    <div className="flex flex-col gap-2 rounded-md border border-line p-3" data-testid="company-einvoice-profile">
      <div className="text-body-sm font-semibold text-ink">E-invoice applicability</div>
      {status?.turnOn && !switchOn && (
        <Banner
          tone="warning"
          testId="banner-einvoice-turn-on"
          title={`E-invoicing applies to you from ${toDisplayDate(status.turnOn.since)} — turn it on`}
          action={<Button onClick={onTurnOn} data-testid="btn-einvoice-turn-on">Turn it on</Button>}
        >
          FY {status.turnOn.fy} aggregate turnover exceeds ₹{status.turnOn.thresholdPaise / 1_000_000_000} crore (Notification {status.turnOn.notification}). Save the details to keep it on.
        </Banner>
      )}
      <p className="text-hint text-muted">
        Aggregate turnover of the PAN — every GSTIN together, all of India, before tax — per financial year from 2017-18. E-invoicing applies above the threshold in force (₹5 crore since 1 Aug 2023) in ANY earlier year.
      </p>
      {draft.rows.length > 0 && (
        <table className="ledger-table" data-testid="table-einvoice-turnover">
          <thead>
            <tr>
              <th>Financial year</th>
              <th className="text-right">Aggregate turnover</th>
              <th aria-label="Remove" />
            </tr>
          </thead>
          <tbody>
            {draft.rows.map((r, i) => (
              <tr key={r.fy}>
                <td>
                  <Select value={r.fy} aria-label="Financial year" onChange={(e) => setRow(i, { fy: e.target.value })} data-testid={`select-turnover-fy-${i}`}>
                    {[r.fy, ...free].sort().reverse().map((fy) => <option key={fy} value={fy}>FY {fy}</option>)}
                  </Select>
                </td>
                <td>
                  <AmountInput paise={r.paise} onPaise={(p) => setRow(i, { paise: p })} testId={`input-turnover-${i}`} ariaLabel={`Aggregate turnover FY ${r.fy}`} />
                </td>
                <td>
                  <Button variant="ghost" onClick={() => onDraft({ ...draft, rows: draft.rows.filter((_, j) => j !== i) })} data-testid={`btn-turnover-remove-${i}`}>Remove</Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {free.length > 0 && (
        <div>
          <Button variant="ghost" onClick={() => onDraft({ ...draft, rows: [...draft.rows, { fy: free[0]!, paise: null }] })} data-testid="btn-turnover-add">
            + Add a year’s turnover
          </Button>
        </div>
      )}
      <Checkbox
        testId="input-turnover-other-gstins"
        label="The same PAN has other GSTINs"
        hint="Then the figures above must be all of them together — the threshold is on the PAN’s aggregate turnover."
        checked={draft.otherGstins}
        onChange={(v) => onDraft({ ...draft, otherGstins: v })}
      />
      <Field label="Left out of e-invoicing as" hint="Notification 13/2020-CT does not apply to these registrants, whatever the turnover.">
        <Select value={draft.exemption} onChange={(e) => onDraft({ ...draft, exemption: e.target.value as EinvoiceExemption | '' })} data-testid="select-einvoice-exemption">
          <option value="">None of these</option>
          {EINVOICE_EXEMPTIONS.map((x) => (
            <option key={x} value={x}>{EINVOICE_EXEMPTION_LABELS[x].label} — {EINVOICE_EXEMPTION_LABELS[x].source}</option>
          ))}
        </Select>
      </Field>
      {a && (
        <p className="text-hint text-muted" data-testid="company-einvoice-applicability" title={EINVOICE_APPLICABILITY_UNVERIFIED.join(' · ')}>
          As saved: {describeEinvoiceApplicability(a, toDisplayDate)} Unverified points on hover.
        </p>
      )}
    </div>
  )
}
