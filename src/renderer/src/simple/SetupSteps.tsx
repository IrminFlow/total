import { useId, type ReactNode } from 'react'
import { useT } from '../lib/i18n'
import type { MessageKey } from '@shared/i18n'
import { DateInput, Field, Select, TextInput } from '../components/ui'
import { GST_STATE_LIST } from '@shared/gst/states'
import { toPlainDate, fyOf, fyFromStartYear } from '@shared/dates'
import { BUSINESS_TYPES, type BusinessType } from '@shared/simple/presets'
import type { GstAnswer, SetupDraft, SetupErrorKey, StartChoice } from '@shared/simple/setup'
import { GST_FILING_FREQUENCIES, type GstFilingFrequency } from '@shared/gst/filing'

/** WP 8.3: the setup wizard's steps (SetupWizard.tsx holds the answers and moves between them).
 *  Every word through t(); errors sit under the field they are about. */
export type StepProps = {
  draft: SetupDraft
  set: (patch: Partial<SetupDraft>) => void
  errors: Partial<Record<keyof SetupDraft, SetupErrorKey>>
  today: string
}

/** One choice in a group of cards (role radio). */
export function ChoiceCard({
  on, onPick, title, hint, testId
}: { on: boolean; onPick: () => void; title: string; hint?: string; testId: string }): React.JSX.Element {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={on}
      data-testid={testId}
      onClick={onPick}
      className={`rounded-lg border px-3.5 py-3 text-left transition-colors focus-visible:outline-2 focus-visible:outline-amber/70 ${
        on ? 'border-amber bg-amberbar/15' : 'border-line bg-panel hover:border-amber/60'
      }`}
    >
      <span className="block text-body font-semibold text-ink">{title}</span>
      {hint && <span className="mt-0.5 block text-small text-muted">{hint}</span>}
    </button>
  )
}

function Choices({ label, error, children, cols = 2 }: { label: string; error?: string; children: ReactNode; cols?: 1 | 2 | 3 }): React.JSX.Element {
  const errorId = useId()
  return (
    <div>
      <div
        role="radiogroup"
        aria-label={label}
        aria-describedby={error ? errorId : undefined}
        className={`grid gap-2 ${cols === 1 ? 'grid-cols-1' : cols === 3 ? 'grid-cols-1 md:grid-cols-3' : 'grid-cols-1 md:grid-cols-2'}`}
      >
        {children}
      </div>
      {error && (
        <p id={errorId} role="alert" className="mt-1.5 text-small text-danger" data-testid="setup-choice-error">
          {error}
        </p>
      )}
    </div>
  )
}

/** The message for a field's error (errors.setup.* keys, typed by SetupErrorKey). */
function useErr(errors: StepProps['errors']): Partial<Record<keyof SetupDraft, string>> {
  const t = useT()
  return Object.fromEntries(Object.entries(errors).map(([field, key]) => [field, t(key)])) // i18n-technical: errors.setup.* keys (SetupErrorKey)
}

/** A message key looked up in one of the label tables below. */
function useLabel(): (key: MessageKey) => string {
  const t = useT()
  return (key) => t(key) // i18n-technical: keys from the typed label tables in this file
}

function Question({ children }: { children: ReactNode }): React.JSX.Element {
  return <h2 className="mb-1 text-lead font-semibold text-ink">{children}</h2>
}

function Hint({ children }: { children: ReactNode }): React.JSX.Element {
  return <p className="mb-3 text-small text-muted">{children}</p>
}

export function BusinessStep({ draft, set, errors }: StepProps): React.JSX.Element {
  const t = useT()
  const err = useErr(errors)
  const lbl = useLabel()
  return (
    <div className="flex flex-col gap-4">
      <Field label={t('simple.setup.name')} hint={t('simple.setup.nameHint')} error={err.name ?? null}>
        <TextInput
          autoFocus
          data-testid="setup-name"
          value={draft.name}
          placeholder={t('simple.setup.namePlaceholder')}
          onChange={(e) => set({ name: e.target.value })}
        />
      </Field>
      <Field label={t('simple.setup.state')} hint={t('simple.setup.stateHint')}>
        <Select data-testid="setup-state" value={draft.stateCode} onChange={(e) => set({ stateCode: e.target.value })}>
          {GST_STATE_LIST.map(([code, label]) => (
            <option key={code} value={code}>
              {`${code} · ${label}`}
            </option>
          ))}
        </Select>
      </Field>
    </div>
  )
}

const TYPE_LABEL: Record<BusinessType, MessageKey> = {
  retail: 'simple.setup.type.retail',
  trader: 'simple.setup.type.trader',
  services: 'simple.setup.type.services',
  manufacturer: 'simple.setup.type.manufacturer',
  restaurant: 'simple.setup.type.restaurant',
  other: 'simple.setup.type.other'
}
const TYPE_HINT: Record<BusinessType, MessageKey> = {
  retail: 'simple.setup.typeHint.retail',
  trader: 'simple.setup.typeHint.trader',
  services: 'simple.setup.typeHint.services',
  manufacturer: 'simple.setup.typeHint.manufacturer',
  restaurant: 'simple.setup.typeHint.restaurant',
  other: 'simple.setup.typeHint.other'
}
export const typeLabel = (b: BusinessType): MessageKey => TYPE_LABEL[b]

export function TypeStep({ draft, set, errors }: StepProps): React.JSX.Element {
  const t = useT()
  const err = useErr(errors)
  const lbl = useLabel()
  return (
    <div>
      <Question>{t('simple.setup.businessType')}</Question>
      <Hint>{t('simple.setup.businessTypeHint')}</Hint>
      <Choices label={t('simple.setup.businessType')} error={err.businessType}>
        {BUSINESS_TYPES.map((b) => (
          <ChoiceCard key={b} testId={`setup-type-${b}`} on={draft.businessType === b} onPick={() => set({ businessType: b })} title={lbl(TYPE_LABEL[b])} hint={lbl(TYPE_HINT[b])} />
        ))}
      </Choices>
    </div>
  )
}

const GST_LABEL: Record<GstAnswer, MessageKey> = {
  regular: 'simple.setup.gst.regular',
  composition: 'simple.setup.gst.composition',
  no: 'simple.setup.gst.no',
  not_sure: 'simple.setup.gst.notSure'
}
const GST_HINT: Record<GstAnswer, MessageKey> = {
  regular: 'simple.setup.gstHint.regular',
  composition: 'simple.setup.gstHint.composition',
  no: 'simple.setup.gstHint.no',
  not_sure: 'simple.setup.gstHint.notSure'
}
export const gstLabel = (g: GstAnswer): MessageKey => GST_LABEL[g]
const FILING_LABEL: Record<GstFilingFrequency, MessageKey> = {
  monthly: 'simple.setup.filing.monthly',
  quarterly: 'simple.setup.filing.quarterly'
}
const GST_ANSWERS: GstAnswer[] = ['regular', 'composition', 'no', 'not_sure'] // i18n-technical

export function GstStep({ draft, set, errors }: StepProps): React.JSX.Element {
  const t = useT()
  const err = useErr(errors)
  const lbl = useLabel()
  const registered = draft.gst === 'regular' || draft.gst === 'composition'
  return (
    <div className="flex flex-col gap-4">
      <div>
        <Question>{t('simple.setup.gst')}</Question>
        <Choices label={t('simple.setup.gst')} error={err.gst}>
          {GST_ANSWERS.map((g) => (
            <ChoiceCard key={g} testId={`setup-gst-${g}`} on={draft.gst === g} onPick={() => set({ gst: g })} title={lbl(GST_LABEL[g])} hint={lbl(GST_HINT[g])} />
          ))}
        </Choices>
      </div>
      {registered && (
        <Field
          label={t('simple.setup.gstin')}
          hint={t('simple.setup.gstinHint')}
          error={err.gstin ?? null}
          required
        >
          <TextInput data-testid="setup-gstin" className="num" maxLength={15} value={draft.gstin} onChange={(e) => set({ gstin: e.target.value.toUpperCase() })} />
        </Field>
      )}
      {draft.gst === 'regular' && (
        <div>
          <Question>{t('simple.setup.filing')}</Question>
          <Hint>{t('simple.setup.filingHint')}</Hint>
          <Choices label={t('simple.setup.filing')} error={err.filing}>
            {GST_FILING_FREQUENCIES.map((f) => (
              <ChoiceCard key={f} testId={`setup-filing-${f}`} on={draft.filing === f} onPick={() => set({ filing: f })} title={lbl(FILING_LABEL[f])} />
            ))}
          </Choices>
        </div>
      )}
      {draft.gst === 'not_sure' && (
        <p className="rounded-md border border-line bg-panel2 px-3 py-2 text-small text-ink" data-testid="setup-not-sure-note">
          {t('simple.setup.notSureNote')}
        </p>
      )}
      {draft.gst === 'no' && <p className="text-small text-muted">{t('simple.setup.noGstNote')}</p>}
    </div>
  )
}

export function StockStep({ draft, set, errors }: StepProps): React.JSX.Element {
  const t = useT()
  const err = useErr(errors)
  const lbl = useLabel()
  return (
    <div>
      <Question>{t('simple.setup.stock')}</Question>
      <Hint>{t('simple.setup.stockHint')}</Hint>
      <Choices label={t('simple.setup.stock')} error={err.stock}>
        <ChoiceCard testId="setup-stock-yes" on={draft.stock === true} onPick={() => set({ stock: true })} title={t('simple.setup.stock.yes')} hint={t('simple.setup.stock.yesHint')} />
        <ChoiceCard testId="setup-stock-no" on={draft.stock === false} onPick={() => set({ stock: false })} title={t('simple.setup.stock.no')} hint={t('simple.setup.stock.noHint')} />
      </Choices>
    </div>
  )
}

export function StartStep({ draft, set, errors, today }: StepProps): React.JSX.Element {
  const t = useT()
  const err = useErr(errors)
  const lbl = useLabel()
  const fyStart = fyFromStartYear(fyOf(today).startYear).from
  const [FY, TODAY, EARLIER]: StartChoice[] = ['fy', 'today', 'earlier'] // i18n-technical
  const pick = (start: StartChoice): void => set({ start })
  return (
    <div className="flex flex-col gap-5">
      <div>
        <Question>{t('simple.setup.start')}</Question>
        <Hint>{t('simple.setup.startHint')}</Hint>
        <Choices label={t('simple.setup.start')} cols={3}>
          <ChoiceCard testId="setup-start-fy" on={draft.start === FY} onPick={() => pick(FY!)} title={t('simple.setup.start.fy', { date: toPlainDate(fyStart, t.lang) })} hint={t('simple.setup.start.fyHint')} />
          <ChoiceCard testId="setup-start-today" on={draft.start === TODAY} onPick={() => pick(TODAY!)} title={t('simple.setup.start.today')} hint={t('simple.setup.start.todayHint', { date: toPlainDate(today, t.lang) })} />
          <ChoiceCard testId="setup-start-earlier" on={draft.start === EARLIER} onPick={() => pick(EARLIER!)} title={t('simple.setup.start.earlier')} hint={t('simple.setup.start.earlierHint')} />
        </Choices>
        {draft.start === 'earlier' && (
          <Field className="mt-3 max-w-xs" label={t('simple.setup.start.earlierDate')} error={err.earlierDate ?? null}>
            <DateInput testId="setup-start-date" allowEmpty value={draft.earlierDate} context={today} onChange={(earlierDate) => set({ earlierDate })} />
          </Field>
        )}
      </div>
      <div>
        <Question>{t('simple.setup.fresh')}</Question>
        <Choices label={t('simple.setup.fresh')} error={err.fresh}>
          <ChoiceCard testId="setup-fresh-new" on={draft.fresh === true} onPick={() => set({ fresh: true })} title={t('simple.setup.fresh.new')} hint={t('simple.setup.fresh.newHint')} />
          <ChoiceCard testId="setup-fresh-continuing" on={draft.fresh === false} onPick={() => set({ fresh: false })} title={t('simple.setup.fresh.continuing')} hint={t('simple.setup.fresh.continuingHint')} />
        </Choices>
      </div>
    </div>
  )
}

export function TallyStep({
  draft, today, tally, setTally, accountant, setAccountant
}: StepProps & { tally: boolean; setTally: (v: boolean) => void; accountant: boolean; setAccountant: (v: boolean) => void }): React.JSX.Element {
  const t = useT()
  const lbl = useLabel()
  const startDate = draft.start === 'fy' ? fyFromStartYear(fyOf(today).startYear).from : draft.start === 'today' ? today : draft.earlierDate
  const rows: [MessageKey, string][] = [
    ['simple.setup.summary.type', draft.businessType ? lbl(TYPE_LABEL[draft.businessType]) : ''],
    ['simple.setup.summary.gst', draft.gst ? lbl(GST_LABEL[draft.gst]) : ''],
    ...(draft.gstin.trim() && (draft.gst === 'regular' || draft.gst === 'composition') ? [['simple.setup.summary.gstin', draft.gstin.trim().toUpperCase()] as [MessageKey, string]] : []),
    ...(draft.gst === 'regular' && draft.filing ? [['simple.setup.summary.filing', lbl(FILING_LABEL[draft.filing])] as [MessageKey, string]] : []),
    ['simple.setup.summary.stock', draft.stock ? t('simple.setup.stock.yes') : t('simple.setup.stock.no')],
    ['simple.setup.summary.start', startDate ? toPlainDate(startDate, t.lang) : '']
  ]
  return (
    <div className="flex flex-col gap-5">
      <div>
        <Question>{t('simple.setup.tally.title')}</Question>
        <Hint>{t('simple.setup.tally.intro')}</Hint>
        <Choices label={t('simple.setup.tally.title')}>
          <ChoiceCard testId="setup-tally-no" on={!tally} onPick={() => setTally(false)} title={t('simple.setup.tally.no')} />
          <ChoiceCard testId="setup-tally-yes" on={tally} onPick={() => setTally(true)} title={t('simple.setup.tally.yes')} hint={t('simple.setup.tally.yesHint')} />
        </Choices>
      </div>
      <div className="rounded-lg border border-line bg-panel2 px-4 py-3" data-testid="setup-summary">
        <p className="mb-2 text-detail font-semibold text-ink">{t('simple.setup.summary')}</p>
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-small">
          {rows.map(([k, v]) => (
            <div key={k} className="contents">
              <dt className="text-muted">{lbl(k)}</dt>
              <dd className="text-ink">{v}</dd>
            </div>
          ))}
        </dl>
        <p className="mt-2 text-small text-muted">{t('simple.setup.summary.modules')}</p>
      </div>
      <label className="flex cursor-pointer items-start gap-2.5 text-small">
        <input type="checkbox" className="mt-0.5" data-testid="setup-accountant-mode" checked={accountant} onChange={(e) => setAccountant(e.target.checked)} />
        <span>
          <span className="block font-medium text-ink">{t('simple.setup.accountantMode')}</span>
          <span className="block text-muted">{t('simple.setup.accountantModeHint')}</span>
        </span>
      </label>
    </div>
  )
}
