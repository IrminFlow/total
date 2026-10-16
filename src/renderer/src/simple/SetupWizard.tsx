import { useEffect, useRef, useState } from 'react'
import { hasStoredLanguage, osLanguage, useLanguage, useLanguagePending, useT } from '../lib/i18n'
import { Button, Segmented } from '../components/ui'
import { LANGUAGES, languagePickerLabel, type Language } from '@shared/i18n'
import { SimpleKitLabels } from './kitLabels'
import { TotalLogo } from '../components/TotalLogo'
import { handleRadioArrows, syncRovingRadios, useRovingRadios } from '../lib/simpleKeys'
import { todayISO } from '@shared/dates'
import { PRESETS } from '@shared/simple/presets'
import {
  SETUP_STEPS, emptySetupDraft, setupPayload, setupStepErrors, type SetupDraft, type SetupErrorKey, type SetupStep, type SimpleSetupInput
} from '@shared/simple/setup'
import { BusinessStep, GstStep, StartStep, StockStep, TallyStep, TypeStep } from './SetupSteps'

/**
 * WP 8.3 (plan 2026-10-13 §4): the plain-language setup wizard — the first-run company creation.
 * Name + state, business type, GST, stock, when to start (and fresh vs continuing), then
 * "Coming from Tally?". Each step checks its own answers (shared/simple/setup.ts) and shows the
 * problem under the field; Finish sends one `simple:setup` (services/companySetup.ts). The
 * accountant ways in stay on the same screen: "New company (full form)", the sample data in the
 * full app, and opening a backup.
 */
export interface SetupWizardProps {
  /** The answers are ready: create the company. Rejects with a message to show. */
  onFinish: (input: SimpleSetupInput, opts: { tally: boolean }) => Promise<void>
  onSample: () => void
  onFullForm: () => void
  onSampleFull: () => void
  onImportBackup: () => void
  /** Back to the company list (only when there is one). */
  onCancel?: () => void
  sampleLoading?: boolean
  /** For tests. */
  today?: string
}

export function SetupWizard({
  onFinish, onSample, onFullForm, onSampleFull, onImportBackup, onCancel, sampleLoading = false, today = todayISO()
}: SetupWizardProps): React.JSX.Element {
  const t = useT()
  // WP 10.4: the language is asked FIRST (top of the first step) and applies at once — the
  // wizard re-renders in it. Nothing chosen on this Mac yet + a Hindi OS → Hindi to start with.
  const [language, setLanguage] = useLanguage()
  const languagePending = useLanguagePending()
  useEffect(() => {
    if (hasStoredLanguage()) return
    const os = osLanguage()
    if (os) setLanguage(os)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  const languageName = (v: Language): string =>
    languagePickerLabel(v, v === 'hi' ? t('simple.looks.lang.hi') : v === 'hinglish' ? t('simple.looks.lang.hinglish') : t('simple.looks.lang.en'))
  const [draft, setDraft] = useState<SetupDraft>(emptySetupDraft)
  const [stepIdx, setStepIdx] = useState(0)
  const [errors, setErrors] = useState<Partial<Record<keyof SetupDraft, SetupErrorKey>>>({})
  const [tally, setTally] = useState(false)
  const [accountant, setAccountant] = useState(false)
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  const step: SetupStep = SETUP_STEPS[stepIdx]!
  const last = stepIdx === SETUP_STEPS.length - 1
  const formRef = useRef<HTMLFormElement>(null)
  // WP 10.5: the wizard is a simple screen outside the shell — the simple token tweaks apply.
  useEffect(() => {
    const root = document.documentElement
    const had = root.dataset.shell
    root.dataset.shell = 'simple'
    return () => {
      if (had) root.dataset.shell = had
      else delete root.dataset.shell
    }
  }, [])
  // WP 10.5: arrow keys move between a question's cards (lib/simpleKeys.ts).
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => void handleRadioArrows(e)
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])
  useRovingRadios(true)
  // WP 10.5: Next / Back moves the keyboard to the new step's first question (not back to the
  // top of the page), so the wizard runs by keyboard alone.
  const firstRender = useRef(true)
  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false
      return
    }
    // (a question's Tab stop — its picked card, else the first: lib/simpleKeys useRovingRadios).
    if (formRef.current) syncRovingRadios(formRef.current)
    formRef.current
      ?.querySelector<HTMLElement>(':is(input, select, textarea, button):not([disabled]):not([tabindex="-1"])') // i18n-technical
      ?.focus()
  }, [stepIdx])

  const set = (patch: Partial<SetupDraft>): void => {
    setDraft((d) => {
      const next = { ...d, ...patch }
      // The stock question starts from the preset's usual answer (the user decides).
      if (patch.businessType && d.stock == null) next.stock = PRESETS[patch.businessType].stockDefault
      return next
    })
    // A fixed field's message goes as soon as it is touched.
    setErrors((e) => {
      const n = { ...e }
      for (const k of Object.keys(patch) as (keyof SetupDraft)[]) delete n[k]
      if (patch.gst) {
        delete n.gstin
        delete n.filing
      }
      return n
    })
  }

  const next = async (): Promise<void> => {
    const e = setupStepErrors(draft, step, today)
    setErrors(e)
    if (Object.keys(e).length) return
    if (!last) {
      setStepIdx((i) => i + 1)
      return
    }
    setBusy(true)
    setFailure(null)
    try {
      await onFinish(setupPayload(draft, today, accountant ? 'accountant' : 'simple', tally, language), { tally })
    } catch (err) {
      setFailure((err as Error).message)
      setBusy(false)
    }
  }

  const back = (): void => {
    setErrors({})
    if (stepIdx === 0) onCancel?.()
    else setStepIdx((i) => i - 1)
  }

  const props = { draft, set, errors, today }
  return (
    <SimpleKitLabels on>
    <div className="w-full max-w-2xl" data-testid="setup-wizard" data-step={step} lang={language === 'hi' ? 'hi' : 'en'}>
      <div className="mb-6 flex items-center gap-3">
        <TotalLogo size={44} />
        <div>
          <h1 className="font-serif text-title font-semibold tracking-tight">{t('simple.setup.title')}</h1>
          <p className="text-small text-muted">{t('simple.setup.intro')}</p>
        </div>
      </div>

      <div className="rounded-xl border border-line bg-panel px-6 py-5">
        <div className="mb-4 flex items-center justify-between">
          <p className="text-caption font-semibold tracking-[0.08em] text-muted uppercase" data-testid="setup-step-label">
            {t('simple.setup.step', { step: stepIdx + 1, total: SETUP_STEPS.length })}
          </p>
          <div className="flex gap-1" aria-hidden="true">
            {SETUP_STEPS.map((s, i) => (
              <span key={s} className={`h-1.5 w-6 rounded-full ${i <= stepIdx ? 'bg-amber' : 'bg-line'}`} />
            ))}
          </div>
        </div>

        {stepIdx === 0 && (
          <div className="mb-5 border-b border-line pb-4" data-testid="setup-language">
            <p className="mb-1.5 text-body font-semibold text-ink">{t('simple.setup.language')}</p>
            <Segmented label={t('simple.setup.language')} options={LANGUAGES.map((value) => ({ value, label: languageName(value) }))} value={language} onChange={setLanguage} testId="setup-language" />
            <p className="mt-1.5 text-hint text-muted">{t('simple.setup.languageHint')}</p>
            {languagePending && (
              <p role="status" className="mt-1 text-hint text-muted" data-testid="language-loading">
                {t('simple.looks.languageLoading')}
              </p>
            )}
          </div>
        )}

        <form
          ref={formRef}
          onSubmit={(e) => {
            e.preventDefault()
            void next()
          }}
        >
          {step === 'business' && <BusinessStep {...props} />}
          {step === 'type' && <TypeStep {...props} />}
          {step === 'gst' && <GstStep {...props} />}
          {step === 'stock' && <StockStep {...props} />}
          {step === 'start' && <StartStep {...props} />}
          {step === 'tally' && <TallyStep {...props} tally={tally} setTally={setTally} accountant={accountant} setAccountant={setAccountant} />}

          {failure && (
            <p role="alert" className="mt-4 rounded-md border border-danger/50 px-3 py-2 text-small text-danger" data-testid="setup-failure">
              {t('errors.generic')} <span className="text-muted">{failure}</span>
            </p>
          )}

          <div className="mt-6 flex items-center justify-between">
            {stepIdx > 0 || onCancel ? (
              <Button type="button" variant="ghost" data-testid="setup-back" onClick={back} disabled={busy}>
                {stepIdx === 0 ? t('common.cancel') : t('common.back')}
              </Button>
            ) : (
              <span />
            )}
            <Button type="submit" variant="primary" data-testid={last ? 'setup-finish' : 'setup-next'} disabled={busy}>
              {busy ? t('simple.setup.creating') : last ? t('simple.setup.finish') : t('common.next')}
            </Button>
          </div>
        </form>
      </div>

      {stepIdx === 0 && (
        <div className="mt-5 flex flex-col items-center gap-3">
          <div className="text-center">
            <Button variant="secondary" data-testid="btn-company-demo" disabled={sampleLoading} onClick={onSample}>
              {sampleLoading ? t('simple.setup.sampleLoading') : t('simple.setup.sample')}
            </Button>
            <p className="mt-1 text-hint text-muted">{t('simple.setup.sampleHint')}</p>
          </div>
          <p className="flex flex-wrap items-center justify-center gap-x-3 gap-y-1 text-small text-muted">
            <span>{t('simple.setup.forAccountants')}</span>
            <button type="button" className="underline-offset-2 hover:text-ink hover:underline" data-testid="btn-company-create" onClick={onFullForm}>
              {t('simple.setup.fullForm')}
            </button>
            <button type="button" className="underline-offset-2 hover:text-ink hover:underline" data-testid="btn-company-demo-full" disabled={sampleLoading} onClick={onSampleFull}>
              {t('simple.setup.sampleFull')}
            </button>
            <button type="button" className="underline-offset-2 hover:text-ink hover:underline" data-testid="btn-company-import-backup" onClick={onImportBackup}>
              {t('simple.setup.importBackup')}
            </button>
          </p>
        </div>
      )}
    </div>
    </SimpleKitLabels>
  )
}
