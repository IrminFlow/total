import { useRef } from 'react'
import {
  FONT_FAMILIES,
  FONT_LABELS,
  NUMBER_FONT_LABELS,
  NUMBER_FONTS,
  PAGE_SIZES,
  PHASE2_KINDS,
  PRINT_DOC_KIND_LABELS,
  PRINT_DOC_KINDS,
  PRINT_STYLES,
  type PrintDocKind,
  type PrintTemplate
} from '@shared/printTemplates'
import { DOC_DATE_FORMATS, formatDateAs } from '@shared/dates'
import { Button, Field, Select, TextInput } from '../../../components/ui'
import { useToasts } from '../../../state/stores'
import { Check, Group, NumberInput, Row, TextArea } from './fields'

/** Object-valued template sections the editor patches. */
type ObjKey = 'page' | 'header' | 'party' | 'table' | 'totals' | 'footer' | 'einvoice' | 'formats' | 'typography'

export interface SectionProps {
  t: PrintTemplate
  /** Shallow-merge `value` into section `key`. */
  patch: <K extends ObjKey>(key: K, value: Partial<PrintTemplate[K]>) => void
  setTop: (value: Partial<PrintTemplate>) => void
  disabled: boolean
}

const MAX_LOGO_BYTES = 200 * 1024
const STYLE_LABELS: Record<(typeof PRINT_STYLES)[number], string> = { classic: 'Classic (boxed)', compact: 'Compact', modern: 'Modern' }

export function PageSection({ t, patch, disabled }: SectionProps): React.JSX.Element {
  const m = t.page.marginsMm
  const setMargin = (side: keyof typeof m, v: number | null): void => patch('page', { marginsMm: { ...m, [side]: v ?? 0 } })
  return (
    <div className="flex flex-col gap-4">
      <Group title="Paper">
        <Row>
          <Field label="Size">
            <Select value={t.page.size} disabled={disabled} data-testid="input-settings-tpl-page-size" onChange={(e) => patch('page', { size: e.target.value as PrintTemplate['page']['size'] })}>
              {PAGE_SIZES.map((s) => <option key={s} value={s}>{s}</option>)}
            </Select>
          </Field>
          <Field label="Orientation">
            <Select value={t.page.orientation} disabled={disabled} onChange={(e) => patch('page', { orientation: e.target.value as 'portrait' | 'landscape' })}>
              <option value="portrait">Portrait</option>
              <option value="landscape">Landscape</option>
            </Select>
          </Field>
        </Row>
      </Group>
      <Group title="Margins (mm)" hint="Page numbers print inside the bottom margin — keep it at 8 mm or more.">
        <div className="grid grid-cols-4 gap-2">
          {(['top', 'right', 'bottom', 'left'] as const).map((side) => (
            <Field key={side} label={side}>
              <NumberInput label={`${side} margin`} value={m[side]} min={0} max={40} step={0.5} disabled={disabled} onChange={(v) => setMargin(side, v)} />
            </Field>
          ))}
        </div>
      </Group>
      <Group title="Pagination">
        <Check label='"Page x of y" footer' checked={t.page.pageNumbers} disabled={disabled} onChange={(v) => patch('page', { pageNumbers: v })} />
        <Field label="Carried-forward subtotal every N lines" hint="0 = let the table flow across pages (the header row repeats on each page either way).">
          <NumberInput label="Carried-forward every" value={t.table.carryForwardEvery} min={0} max={200} disabled={disabled} onChange={(v) => patch('table', { carryForwardEvery: Math.round(v ?? 0) })} />
        </Field>
      </Group>
    </div>
  )
}

export function HeaderSection({ t, patch, setTop, disabled }: SectionProps): React.JSX.Element {
  const toast = useToasts()
  const fileRef = useRef<HTMLInputElement>(null)
  const h = t.header
  const onLogo = (file: File | null): void => {
    if (!file) return
    if (file.size > MAX_LOGO_BYTES) {
      toast.push('error', `Logo is ${(file.size / 1024).toFixed(0)}KB — must be under 200KB`)
      if (fileRef.current) fileRef.current.value = ''
      return
    }
    const reader = new FileReader()
    reader.onload = () => patch('header', { logoDataUrl: typeof reader.result === 'string' ? reader.result : null })
    reader.readAsDataURL(file)
  }
  const toggleKind = (k: PrintDocKind, on: boolean): void => {
    const kinds = on ? PRINT_DOC_KINDS.filter((x) => x === k || t.kinds.includes(x)) : t.kinds.filter((x) => x !== k)
    setTop({ kinds })
  }
  const setCopy = (i: number, v: string): void => patch('header', { copyLabels: h.copyLabels.map((l, j) => (j === i ? v : l)) })

  return (
    <div className="flex flex-col gap-4">
      <Group title="Template">
        <Field label="Name">
          <TextInput value={t.name} maxLength={60} disabled={disabled} data-testid="input-settings-tpl-name" onChange={(e) => setTop({ name: e.target.value })} />
        </Field>
      </Group>
      <Group title="Applies to" hint="Kinds this template can print. Titles are per kind.">
        {PRINT_DOC_KINDS.map((k) => (
          <div key={k} className="grid grid-cols-[1fr_1.3fr] items-center gap-2">
            <Check
              label={PRINT_DOC_KIND_LABELS[k]}
              hint={PHASE2_KINDS.includes(k) ? 'Coming in a later release' : undefined}
              checked={t.kinds.includes(k)}
              disabled={disabled || (t.kinds.length === 1 && t.kinds.includes(k))}
              onChange={(v) => toggleKind(k, v)}
            />
            <TextInput
              aria-label={`${PRINT_DOC_KIND_LABELS[k]} title`}
              data-testid={`input-settings-tpl-title-${k}`}
              value={h.titles[k]}
              maxLength={80}
              disabled={disabled || !t.kinds.includes(k)}
              onChange={(e) => patch('header', { titles: { ...h.titles, [k]: e.target.value } })}
            />
          </div>
        ))}
      </Group>
      <Group title="Logo">
        <Check label="Print the logo" checked={h.showLogo} disabled={disabled} onChange={(v) => patch('header', { showLogo: v })} />
        <div className="flex items-center gap-3">
          <input ref={fileRef} type="file" aria-label="Logo image" accept="image/png,image/jpeg" disabled={disabled} onChange={(e) => onLogo(e.target.files?.[0] ?? null)} className="text-detail" />
          {h.logoDataUrl && (
            <>
              <img src={h.logoDataUrl} alt="Logo" className="h-8 max-w-24 rounded bg-white object-contain" />
              {!disabled && (
                <button type="button" className="text-detail text-cr hover:underline" onClick={() => patch('header', { logoDataUrl: null })}>
                  Remove
                </button>
              )}
            </>
          )}
        </div>
        <div className="grid grid-cols-3 gap-2">
          <Field label="Position">
            <Select value={h.logoPosition} disabled={disabled} onChange={(e) => patch('header', { logoPosition: e.target.value as 'left' | 'center' | 'right' })}>
              <option value="left">Left, above name</option>
              <option value="center">Centred on top</option>
              <option value="right">Right, above title</option>
            </Select>
          </Field>
          <Field label="Max height px">
            <NumberInput label="Logo max height" value={h.logoMaxHeightPx} min={20} max={160} disabled={disabled} onChange={(v) => patch('header', { logoMaxHeightPx: Math.round(v ?? 20) })} />
          </Field>
          <Field label="Max width px">
            <NumberInput label="Logo max width" value={h.logoMaxWidthPx} min={40} max={400} disabled={disabled} onChange={(v) => patch('header', { logoMaxWidthPx: Math.round(v ?? 40) })} />
          </Field>
        </div>
      </Group>
      <Group title="Company block" hint="Values come from the company profile; CIN and website are template text.">
        <div className="grid grid-cols-2 gap-2">
          <Check label="Address" checked={h.showAddress} disabled={disabled} onChange={(v) => patch('header', { showAddress: v })} />
          <Check label="GSTIN" checked={h.showGstin} disabled={disabled} onChange={(v) => patch('header', { showGstin: v })} />
          <Check label="State" checked={h.showState} disabled={disabled} onChange={(v) => patch('header', { showState: v })} />
          <Check label="PAN" checked={h.showPan} disabled={disabled} onChange={(v) => patch('header', { showPan: v })} />
          <Check label="Phone" checked={h.showPhone} disabled={disabled} onChange={(v) => patch('header', { showPhone: v })} />
          <Check label="Email" checked={h.showEmail} disabled={disabled} onChange={(v) => patch('header', { showEmail: v })} />
          <Check label="CIN" checked={h.showCin} disabled={disabled} onChange={(v) => patch('header', { showCin: v })} />
          <Check label="Website" checked={h.showWebsite} disabled={disabled} onChange={(v) => patch('header', { showWebsite: v })} />
        </div>
        <Row>
          <Field label="CIN">
            <TextInput value={h.cin} maxLength={30} disabled={disabled || !h.showCin} className="num" onChange={(e) => patch('header', { cin: e.target.value.toUpperCase() })} />
          </Field>
          <Field label="Website">
            <TextInput value={h.website} maxLength={120} disabled={disabled || !h.showWebsite} onChange={(e) => patch('header', { website: e.target.value })} />
          </Field>
        </Row>
      </Group>
      <Group title="Copies (1–3)" hint="Each label prints the whole document once, e.g. Original / Duplicate.">
        {h.copyLabels.map((label, i) => (
          <div key={i} className="flex gap-2">
            <TextInput aria-label={`Copy ${i + 1} label`} value={label} maxLength={40} disabled={disabled} className="flex-1" onChange={(e) => setCopy(i, e.target.value)} />
            {!disabled && h.copyLabels.length > 1 && (
              <Button variant="ghost" aria-label={`Remove copy ${i + 1}`} onClick={() => patch('header', { copyLabels: h.copyLabels.filter((_, j) => j !== i) })}>
                ×
              </Button>
            )}
          </div>
        ))}
        {!disabled && h.copyLabels.length < 3 && (
          <Button className="self-start" onClick={() => patch('header', { copyLabels: [...h.copyLabels, `Copy ${h.copyLabels.length + 1}`] })}>
            + Add copy
          </Button>
        )}
      </Group>
    </div>
  )
}

export function PartySection({ t, patch, disabled }: SectionProps): React.JSX.Element {
  const p = t.party
  return (
    <div className="flex flex-col gap-4">
      <Group title="Bill to">
        <Field label="Heading">
          <TextInput value={p.billToLabel} maxLength={40} disabled={disabled} onChange={(e) => patch('party', { billToLabel: e.target.value })} />
        </Field>
        <Check label="Address" checked={p.showAddress} disabled={disabled} onChange={(v) => patch('party', { showAddress: v })} />
        <Check label="GSTIN (or “Unregistered”)" checked={p.showGstin} disabled={disabled} onChange={(v) => patch('party', { showGstin: v })} />
        <Check label="State" checked={p.showState} disabled={disabled} onChange={(v) => patch('party', { showState: v })} />
      </Group>
      <Group title="Ship to" hint="Printed when the voucher's transport details carry a different delivery address.">
        <Check label="Show ship-to block" checked={p.showShipTo} disabled={disabled} testId="input-settings-tpl-shipto" onChange={(v) => patch('party', { showShipTo: v })} />
        <Field label="Heading">
          <TextInput value={p.shipToLabel} maxLength={40} disabled={disabled || !p.showShipTo} onChange={(e) => patch('party', { shipToLabel: e.target.value })} />
        </Field>
      </Group>
      <Group title="Document details">
        <Check label="Place of supply" checked={p.showPlaceOfSupply} disabled={disabled} onChange={(v) => patch('party', { showPlaceOfSupply: v })} />
        <Check label="Vehicle number (when captured)" checked={p.showVehicle} disabled={disabled} onChange={(v) => patch('party', { showVehicle: v })} />
      </Group>
    </div>
  )
}

export function TotalsSection({ t, patch, disabled }: SectionProps): React.JSX.Element {
  const x = t.totals
  return (
    <div className="flex flex-col gap-4">
      <Group title="Tax summary">
        <Field label="Summary table" hint="Bucketed then rounded once per bucket — the same way the GSTR-1 HSN table is computed.">
          <Select value={x.taxSummary} disabled={disabled} data-testid="input-settings-tpl-tax-summary" onChange={(e) => patch('totals', { taxSummary: e.target.value as 'hsn' | 'rate' | 'none' })}>
            <option value="hsn">By HSN/SAC and rate</option>
            <option value="rate">By GST rate</option>
            <option value="none">None</option>
          </Select>
        </Field>
      </Group>
      <Group title="Totals block">
        <Check label="Round-off line (when non-zero)" checked={x.showRoundOff} disabled={disabled} onChange={(v) => patch('totals', { showRoundOff: v })} />
        <Check label="Amount in words (Indian numbering)" checked={x.showAmountInWords} disabled={disabled} onChange={(v) => patch('totals', { showAmountInWords: v })} />
        <Check label="Party's outstanding balance" hint="Ledger balance as on the document date." checked={x.showOutstanding} disabled={disabled} onChange={(v) => patch('totals', { showOutstanding: v })} />
        <Check label="₹ symbol on the grand total" checked={t.formats.currencySymbolOnTotal} disabled={disabled} onChange={(v) => patch('formats', { currencySymbolOnTotal: v })} />
      </Group>
    </div>
  )
}

export function FooterSection({ t, patch, disabled }: SectionProps): React.JSX.Element {
  const f = t.footer
  const bank = f.bankDetails
  const setBank = (p: Partial<NonNullable<typeof bank>>): void => patch('footer', { bankDetails: { ...(bank ?? { name: '', account: '', ifsc: '', branch: '' }), ...p } })
  return (
    <div className="flex flex-col gap-4">
      <Group title="Text">
        <Field label="Declaration">
          <TextArea label="Declaration" value={f.declaration} disabled={disabled} onChange={(v) => patch('footer', { declaration: v })} />
        </Field>
        <Field label="Terms & conditions" hint="Optional; line breaks are kept.">
          <TextArea label="Terms and conditions" testId="input-settings-tpl-terms" value={f.terms} disabled={disabled} onChange={(v) => patch('footer', { terms: v })} />
        </Field>
      </Group>
      <Group title="Bank details">
        <Check label="Print bank details" checked={!!bank} disabled={disabled} onChange={(v) => patch('footer', { bankDetails: v ? { name: '', account: '', ifsc: '', branch: '' } : null })} />
        {bank && (
          <Row>
            <Field label="Bank name"><TextInput value={bank.name} disabled={disabled} onChange={(e) => setBank({ name: e.target.value })} /></Field>
            <Field label="Account no."><TextInput value={bank.account} className="num" disabled={disabled} onChange={(e) => setBank({ account: e.target.value })} /></Field>
            <Field label="IFSC"><TextInput value={bank.ifsc} className="num" disabled={disabled} onChange={(e) => setBank({ ifsc: e.target.value.toUpperCase() })} /></Field>
            <Field label="Branch"><TextInput value={bank.branch} disabled={disabled} onChange={(e) => setBank({ branch: e.target.value })} /></Field>
          </Row>
        )}
      </Group>
      <Group title="Signatures">
        <Check label="Authorised signature block" checked={f.showSignature} disabled={disabled} onChange={(v) => patch('footer', { showSignature: v })} />
        <Field label="Signatory line">
          <TextInput value={f.signatureLabel} maxLength={80} disabled={disabled || !f.showSignature} onChange={(e) => patch('footer', { signatureLabel: e.target.value })} />
        </Field>
        <Check label="Receiver's signature" checked={f.showReceiverSignature} disabled={disabled} onChange={(v) => patch('footer', { showReceiverSignature: v })} />
        <Field label="Receiver label">
          <TextInput value={f.receiverLabel} maxLength={60} disabled={disabled || !f.showReceiverSignature} onChange={(e) => patch('footer', { receiverLabel: e.target.value })} />
        </Field>
      </Group>
      <Group title="Notes">
        <Check label='"Computer generated" note' checked={f.showComputerGenerated} disabled={disabled} onChange={(v) => patch('footer', { showComputerGenerated: v })} />
        <TextInput aria-label="Computer generated note text" value={f.computerGeneratedText} maxLength={160} disabled={disabled || !f.showComputerGenerated} onChange={(e) => patch('footer', { computerGeneratedText: e.target.value })} />
        <Check label="Entered by / altered by (from the audit trail)" checked={f.showEnteredBy} disabled={disabled} onChange={(v) => patch('footer', { showEnteredBy: v })} />
      </Group>
    </div>
  )
}

export function EinvoiceSection({ t, patch, disabled }: SectionProps): React.JSX.Element {
  const e = t.einvoice
  return (
    <div className="flex flex-col gap-4">
      <Group title="Verification QR" hint="Our own unsigned summary of the invoice (with the IRN once e-invoiced) — never presented as the NIC-signed QR.">
        <Check label="Print the QR" checked={e.showQr} disabled={disabled} onChange={(v) => patch('einvoice', { showQr: v })} />
        <Row>
          <Field label="Placement">
            <Select value={e.qrPlacement} disabled={disabled || !e.showQr} onChange={(ev) => patch('einvoice', { qrPlacement: ev.target.value as 'header' | 'footer' })}>
              <option value="header">Header, under the title</option>
              <option value="footer">Footer, between signatures</option>
            </Select>
          </Field>
          <Field label="Size mm">
            <NumberInput label="QR size" value={e.qrSizeMm} min={16} max={50} disabled={disabled || !e.showQr} onChange={(v) => patch('einvoice', { qrSizeMm: v ?? 16 })} />
          </Field>
        </Row>
      </Group>
      <Group title="Filing details" hint="Printed only on vouchers that actually carry them.">
        <Check label="IRN, Ack no. and Ack date" checked={e.showIrn} disabled={disabled} onChange={(v) => patch('einvoice', { showIrn: v })} />
        <Check label="e-Way bill number" checked={e.showEwb} disabled={disabled} onChange={(v) => patch('einvoice', { showEwb: v })} />
      </Group>
    </div>
  )
}

export function TypographySection({ t, patch, setTop, disabled }: SectionProps): React.JSX.Element {
  const y = t.typography
  const accentOk = /^#[0-9a-fA-F]{6}$/.test(y.accent)
  return (
    <div className="flex flex-col gap-4">
      <Group title="Look">
        <Field label="Style">
          <Select value={t.style} disabled={disabled} data-testid="input-settings-tpl-style" onChange={(e) => setTop({ style: e.target.value as PrintTemplate['style'] })}>
            {PRINT_STYLES.map((s) => <option key={s} value={s}>{STYLE_LABELS[s]}</option>)}
          </Select>
        </Field>
        <Field label="Accent colour" error={accentOk ? null : 'Use a 6-digit hex like #1f4f78'}>
          <div className="flex items-center gap-2">
            <input type="color" aria-label="Accent colour picker" value={accentOk ? y.accent : '#000000'} disabled={disabled} onChange={(e) => patch('typography', { accent: e.target.value })} className="h-8 w-10 rounded border border-line bg-panel2" />
            <TextInput aria-label="Accent colour hex" data-testid="input-settings-tpl-accent" value={y.accent} maxLength={7} className="num w-28" disabled={disabled} onChange={(e) => patch('typography', { accent: e.target.value.trim() })} />
          </div>
        </Field>
      </Group>
      <Group title="Type">
        <Field label="Text font">
          <Select value={y.fontFamily} disabled={disabled} onChange={(e) => patch('typography', { fontFamily: e.target.value as typeof y.fontFamily })}>
            {FONT_FAMILIES.map((f) => <option key={f} value={f}>{FONT_LABELS[f]}</option>)}
          </Select>
        </Field>
        <Field label="Number font">
          <Select value={y.numberFont} disabled={disabled} onChange={(e) => patch('typography', { numberFont: e.target.value as typeof y.numberFont })}>
            {NUMBER_FONTS.map((f) => <option key={f} value={f}>{NUMBER_FONT_LABELS[f]}</option>)}
          </Select>
        </Field>
        <Field label="Base size px" hint="Every other size scales from this.">
          <NumberInput label="Base font size" testId="input-settings-tpl-font-size" value={y.baseFontPx} min={8} max={16} step={0.5} disabled={disabled} onChange={(v) => patch('typography', { baseFontPx: v ?? 12 })} />
        </Field>
      </Group>
      <Group title="Formats">
        <Row>
          <Field label="Dates">
            <Select value={t.formats.date} disabled={disabled} onChange={(e) => patch('formats', { date: e.target.value as typeof t.formats.date })}>
              {DOC_DATE_FORMATS.map((f) => <option key={f} value={f}>{formatDateAs('2026-08-04', f)}</option>)}
            </Select>
          </Field>
          <Field label="Amounts">
            <Select value={t.formats.number} disabled={disabled} onChange={(e) => patch('formats', { number: e.target.value as 'indian' | 'plain' })}>
              <option value="indian">1,23,456.78</option>
              <option value="plain">123456.78</option>
            </Select>
          </Field>
        </Row>
      </Group>
    </div>
  )
}
