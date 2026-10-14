// WP 10.6: Settings → "AI helper" in the simple shell — plain key setup over the existing ai:*
// channels (no new write path; the same owner checks, audits and key rules as Settings → AI):
// what it is, the data notice SUMMARY first (the full notice behind a disclosure), paste a key →
// "Check it" (ai:key:set, then ai:testConnection — the model is picked from the list the key
// returned, shared/simple/aiPlain.ts pickModels), turn on (accepting the notice is the same
// ai:notice:accept), the hiding toggles, "Use what Total remembers", and this month's spend from
// ai_usage (rupees only with the company's own dollar rate). Provider errors in plain words,
// a key error under the key box.
import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { AI_DATA_NOTICE_VERSION, type AiConnectionResult } from '@shared/ai'
import { classifyAiError, modelsListText, monthSpend, monthSpendSentence, pickModels, rateNote, usdRateOn, type AiPlainError } from '@shared/simple/aiPlain'
import { todayISO, toPlainDate } from '@shared/dates'
import type { MessageKey } from '@shared/i18n'
import { aiApi } from '../../lib/aiClient'
import { cfApi } from '../../lib/cashFinanceClient'
import { confirmDialog } from '../../lib/dialogs'
import { useT } from '../../lib/i18n'
import { useCanSetMode } from '../../lib/mode'
import { useNav, useSession, useToasts } from '../../state/stores'
import { Badge, Banner, Button, Checkbox, Field, Page, SkeletonRows, TextInput } from '../../components/ui'

const SETTINGS_KEY = ['aiSettings'] // i18n-technical
const USAGE_KEY = ['aiUsage'] // i18n-technical
const RATES_KEY = ['fxRates'] // i18n-technical

/** A plain error: its own sentence, and the provider's words behind Details. */
function PlainError({ error, testId }: { error: AiPlainError; testId: string }): React.JSX.Element {
  const t = useT()
  return (
    <div className="mt-1.5 text-small text-danger" data-testid={testId} data-kind={error.kind} role="alert">
      <p>{t(error.key) /* i18n-technical: key from classifyAiError */}</p>
      {error.detail && (
        <details className="mt-0.5 text-hint text-muted">
          <summary className="cursor-pointer">{t('common.details')}</summary>
          <p className="num mt-0.5 break-words">{error.detail}</p>
        </details>
      )}
    </div>
  )
}

function Card({ title, right, children, testId }: { title: string; right?: React.ReactNode; children: React.ReactNode; testId?: string }): React.JSX.Element {
  return (
    <section className="rounded-lg border border-line bg-panel px-panel py-4 shadow-elev-1" data-testid={testId}>
      <div className="mb-2 flex items-center justify-between gap-3">
        <h2 className="text-detail font-semibold text-ink">{title}</h2>
        {right}
      </div>
      {children}
    </section>
  )
}

export function AiHelper(): React.JSX.Element {
  const t = useT()
  const nav = useNav()
  const toast = useToasts()
  const queryClient = useQueryClient()
  const canEdit = useCanSetMode()
  const user = useSession((s) => s.user)
  const { data: view } = useQuery({ queryKey: SETTINGS_KEY, queryFn: aiApi.settings })
  const { data: usage } = useQuery({ queryKey: USAGE_KEY, queryFn: aiApi.usage })
  const { data: rates } = useQuery({ queryKey: RATES_KEY, queryFn: cfApi.fx.rates })
  const [key, setKey] = useState('')
  const [busy, setBusy] = useState<null | 'check' | 'on' | 'off' | 'save' | 'remove'>(null)
  const [check, setCheck] = useState<{ result: AiConnectionResult; picked: string | null } | null>(null)
  /** A failed check turned the helper off (it was on, and the key no longer works). */
  const [stoppedByCheck, setStoppedByCheck] = useState(false)
  const [keyError, setKeyError] = useState<AiPlainError | null>(null)
  const [error, setError] = useState<AiPlainError | null>(null)

  const refresh = async (): Promise<void> => {
    await queryClient.invalidateQueries({ queryKey: SETTINGS_KEY })
  }
  /** A thrown error: a provider / key-rule message in plain words (the key box or the screen). */
  const fail = (err: unknown): void => {
    const e = classifyAiError((err as Error)?.message ?? String(err))
    if (e.field === 'key') setKeyError(e)
    // Not a provider / key-rule message: say it could not be saved, with main's words behind
    // Details (never swallowed).
    else if (e.kind === 'other') setError({ ...e, key: 'simple.ai.saveFailed' }) // i18n-technical
    else setError(e)
  }

  if (!view) {
    return (
      <Page width="narrow" data-testid="simple-ai">
        <h1 className="mb-5 font-serif text-heading font-semibold tracking-tight text-ink">{t('simple.ai.title')}</h1>
        <SkeletonRows rows={6} />
      </Page>
    )
  }
  const s = view.settings
  const noticeCurrent = !!s.noticeAcceptedAt && s.noticeVersion === AI_DATA_NOTICE_VERSION
  const on = view.ready
  const canTest = view.keyPresent || view.mock || key.trim().length > 0
  const today = todayISO()
  const rate = usdRateOn(rates, today)
  const spend = monthSpend(usage ?? [], today.slice(0, 7))

  /** The key is shared by every business here: without sign-ins, ask first (main refuses
   *  outright when another business on this computer has sign-ins). */
  const confirmShared = async (): Promise<boolean | null> => {
    if (user) return false
    const ok = await confirmDialog({ title: t('simple.ai.key.confirmTitle'), message: t('simple.ai.key.confirmText'), confirmLabel: t('simple.ai.key.confirmOk') })
    return ok ? true : null
  }

  const checkIt = async (): Promise<void> => {
    setKeyError(null)
    setError(null)
    setCheck(null)
    setStoppedByCheck(false)
    const typed = key.trim()
    if (typed && typed.length < 8) {
      setKeyError({ kind: 'key', field: 'key', key: 'simple.ai.key.tooShort', detail: '' }) // i18n-technical
      return
    }
    setBusy('check') // i18n-technical
    try {
      if (typed) {
        const confirmed = await confirmShared()
        if (confirmed === null) return
        await aiApi.setKey(typed, confirmed)
        setKey('')
        await refresh()
      }
      const result = await aiApi.testConnection()
      if (!result.ok) {
        const e = classifyAiError(result.error ?? '')
        if (e.field === 'key') setKeyError(e)
        else setError(e)
        // A failed check never leaves the helper on: the key was just replaced, or the service
        // refused it. (A busy / unreachable service says nothing about a key already in use.)
        if (s.enabled && (typed || e.kind === 'key')) {
          await aiApi.setSettings({ enabled: false })
          await refresh()
          setStoppedByCheck(true)
        }
        return
      }
      const pick = pickModels(result.models, s)
      if (pick.changed && canEdit) {
        await aiApi.setSettings({ defaultModel: pick.defaultModel, fastModel: pick.fastModel })
        await refresh()
      }
      setCheck({ result, picked: pick.found ? pick.defaultModel : null })
    } catch (err) {
      fail(err)
    } finally {
      setBusy(null)
    }
  }

  const turnOn = async (): Promise<void> => {
    setError(null)
    setBusy('on')
    try {
      if (!noticeCurrent) await aiApi.acceptNotice()
      await aiApi.setSettings({ enabled: true })
      await refresh()
      toast.push('success', t('simple.ai.turnedOn'))
    } catch (err) {
      fail(err)
    } finally {
      setBusy(null)
    }
  }

  const turnOff = async (): Promise<void> => {
    setBusy('off')
    try {
      await aiApi.setSettings({ enabled: false })
      await refresh()
      toast.push('success', t('simple.ai.turnedOff'))
    } catch (err) {
      fail(err)
    } finally {
      setBusy(null)
    }
  }

  const save = async (patch: Parameters<typeof aiApi.setSettings>[0]): Promise<void> => {
    setBusy('save') // i18n-technical
    try {
      await aiApi.setSettings(patch)
      await refresh()
      toast.push('success', t('simple.ai.saved'))
    } catch (err) {
      fail(err)
    } finally {
      setBusy(null)
    }
  }

  const removeKey = async (): Promise<void> => {
    setKeyError(null)
    const confirmed = await confirmShared()
    if (confirmed === null) return
    setBusy('remove') // i18n-technical
    try {
      await aiApi.clearKey(confirmed)
      setCheck(null)
      await refresh()
      toast.push('success', t('simple.ai.key.removed'))
    } catch (err) {
      fail(err)
    } finally {
      setBusy(null)
    }
  }

  const NOTICE_FULL: MessageKey[] = ['simple.ai.notice.full1', 'simple.ai.notice.full2', 'simple.ai.notice.full3', 'simple.ai.notice.full4', 'simple.ai.notice.full5', 'simple.ai.notice.full6'] // i18n-technical

  return (
    <Page width="narrow" data-testid="simple-ai" data-on={on ? 'true' : 'false'}>
      <div className="mb-1 flex items-center gap-3">
        <h1 className="font-serif text-heading font-semibold tracking-tight text-ink">{t('simple.ai.title')}</h1>
        <Badge tone={on ? 'success' : 'neutral'} testId="simple-ai-status">{on ? t('simple.ai.status.on') : t('simple.ai.status.off')}</Badge>
      </div>
      <p className="mb-1 text-body text-ink" data-testid="simple-ai-intro">{t('simple.ai.intro')}</p>
      <p className="mb-5 text-small text-muted">{t('simple.ai.optional')}</p>

      <div className="flex flex-col gap-4">
        {view.mock && <Banner tone="warning" testId="simple-ai-mock">{t('simple.ai.test')}</Banner>}
        {!canEdit && <Banner tone="info" testId="simple-ai-owner-only">{t('simple.ai.ownerOnly')}</Banner>}
        {error && (
          <Banner tone="danger" testId="simple-ai-error">
            <PlainError error={error} testId="simple-ai-error-text" />
          </Banner>
        )}

        <Card title={t('simple.ai.notice.title')} testId="simple-ai-notice">
          <ul className="flex list-disc flex-col gap-1 pl-5 text-body-sm text-ink" data-testid="simple-ai-notice-summary">
            <li>{t('simple.ai.notice.sent')}</li>
            <li>{s.privacy.maskIds ? t('simple.ai.notice.masked') : t('simple.ai.notice.notMasked')}</li>
            <li>{t('simple.ai.notice.where')}</li>
          </ul>
          <details className="mt-2 text-small" data-testid="simple-ai-notice-full">
            <summary className="cursor-pointer text-muted hover:text-ink">{t('simple.ai.notice.readFull')}</summary>
            <ul className="mt-1.5 flex list-disc flex-col gap-1 pl-5 text-ink">
              {NOTICE_FULL.map((k) => (
                <li key={k}>{t(k) /* i18n-technical: keys in NOTICE_FULL */}</li>
              ))}
            </ul>
          </details>
          {s.noticeAcceptedAt && noticeCurrent && (
            <p className="mt-2 text-hint text-muted" data-testid="simple-ai-notice-accepted">{t('simple.ai.notice.accepted', { date: toPlainDate(s.noticeAcceptedAt.slice(0, 10)) })}</p>
          )}
          {s.noticeAcceptedAt && !noticeCurrent && <p className="mt-2 text-hint text-warning">{t('simple.ai.turnOn.noticeChanged')}</p>}
        </Card>

        <Card title={t('simple.ai.key.title')} testId="simple-ai-key">
          <p className="mb-3 text-small text-muted">{t('simple.ai.key.what')}</p>
          {!view.secureStorageAvailable && <Banner tone="warning" className="mb-3">{t('simple.ai.error.noSecureStorage')}</Banner>}
          <div className="flex items-start gap-2">
            <div className="min-w-0 flex-1">
              <Field label={t('simple.ai.key.label')} hint={view.keyPresent && view.keyHint ? t('simple.ai.key.saved', { hint: view.keyHint }) : undefined}>
                <TextInput
                  type="password"
                  autoComplete="off"
                  spellCheck={false}
                  className="num"
                  value={key}
                  invalid={!!keyError}
                  disabled={!canEdit || busy !== null}
                  onChange={(e) => {
                    setKey(e.target.value)
                    setKeyError(null)
                  }}
                  data-testid="simple-ai-key-input"
                />
              </Field>
              {keyError && <PlainError error={keyError} testId="simple-ai-key-error" />}
            </div>
            <div className="mt-[22px] flex shrink-0 gap-2">
              <Button variant="primary" disabled={!canEdit || busy !== null || !canTest} loading={busy === 'check'} onClick={() => void checkIt()} data-testid="simple-ai-check">
                {busy === 'check' ? t('simple.ai.key.checking') : key.trim() || !view.keyPresent ? t('simple.ai.key.check') : t('simple.ai.key.recheck')}
              </Button>
            </div>
          </div>
          {check?.result.ok && (
            <div className="mt-2 rounded-md bg-panel2 px-3 py-2 text-small text-ink" data-testid="simple-ai-check-ok">
              <p>{check.result.models.length ? t('simple.ai.key.works', { models: modelsListText(check.result.models, t) }) : t('simple.ai.key.worksNoList')}</p>
              {check.picked ? (
                <p className="text-muted" data-testid="simple-ai-picked">{t('simple.ai.key.picked', { model: check.picked })}</p>
              ) : (
                <p className="text-warning" data-testid="simple-ai-no-model">{t('simple.ai.key.noModel', { model: s.defaultModel })}</p>
              )}
            </div>
          )}
          {stoppedByCheck && (
            <p className="mt-2 text-small text-warning" data-testid="simple-ai-stopped">{t('simple.ai.key.stopped')}</p>
          )}
          <p className="mt-3 text-hint text-muted">
            {t('simple.ai.key.shared')}
            {!user ? ` ${t('simple.ai.key.noUsers')}` : ''}
          </p>
          {view.keyPresent && canEdit && (
            <Button size="sm" variant="ghost" className="mt-2" disabled={busy !== null} onClick={() => void removeKey()} data-testid="simple-ai-remove-key">
              {t('simple.ai.key.remove')}
            </Button>
          )}
        </Card>

        <Card title={t('simple.ai.turnOn.title')} right={<Badge tone={on ? 'success' : 'neutral'}>{on ? t('simple.ai.status.on') : t('simple.ai.status.off')}</Badge>} testId="simple-ai-switch">
          {on ? (
            <div className="flex items-center justify-between gap-3">
              <p className="text-small text-ink">{t('simple.ai.onNote')}</p>
              {canEdit && (
                <Button variant="ghost" disabled={busy !== null} loading={busy === 'off'} onClick={() => void turnOff()} data-testid="simple-ai-off">
                  {t('simple.ai.turnOff')}
                </Button>
              )}
            </div>
          ) : (
            <div className="flex items-center justify-between gap-3">
              <p className="text-small text-muted">{view.keyPresent || view.mock ? t('simple.ai.panel.off') : t('simple.ai.turnOn.needKey')}</p>
              {canEdit && (
                <Button
                  variant="primary"
                  disabled={busy !== null || (!view.keyPresent && !view.mock)}
                  loading={busy === 'on'}
                  onClick={() => void turnOn()}
                  data-testid="simple-ai-on"
                >
                  {noticeCurrent ? t('simple.ai.turnOn.button') : t('simple.ai.turnOn.agree')}
                </Button>
              )}
            </div>
          )}
        </Card>

        <Card title={t('simple.ai.privacy.title')} testId="simple-ai-privacy">
          <div className="flex flex-col gap-3">
            <Checkbox
              label={t('simple.ai.privacy.maskIds')}
              hint={t('simple.ai.privacy.maskIdsHint')}
              checked={s.privacy.maskIds}
              disabled={!canEdit || busy !== null}
              onChange={(v) => void save({ privacy: { maskIds: v } })}
              testId="simple-ai-mask"
            />
            <Checkbox
              label={t('simple.ai.privacy.names')}
              hint={t('simple.ai.privacy.namesHint')}
              checked={s.privacy.pseudonymiseParties}
              disabled={!canEdit || busy !== null}
              onChange={(v) => void save({ privacy: { pseudonymiseParties: v } })}
              testId="simple-ai-names"
            />
            <Checkbox
              label={t('simple.ai.memory')}
              hint={t('simple.ai.memoryHint')}
              checked={s.useMemory}
              disabled={!canEdit || busy !== null}
              onChange={(v) => void save({ useMemory: v })}
              testId="simple-ai-memory"
            />
          </div>
        </Card>

        <Card title={t('simple.ai.spend.title')} testId="simple-ai-spend">
          <p className="text-body-sm text-ink" data-testid="simple-ai-spend-text">{monthSpendSentence(spend, rate, t)}</p>
          {spend.priced > 0 && <p className="text-hint text-muted">{rateNote(rate, t)}</p>}
          {spend.calls > 0 && (
            <details className="mt-1.5 text-hint text-muted" data-testid="simple-ai-spend-details">
              <summary className="cursor-pointer">{t('common.details')}</summary>
              <p className="num mt-0.5">{t('simple.ai.spend.tokens', { input: spend.inputTokens.toLocaleString('en-IN'), output: spend.outputTokens.toLocaleString('en-IN') })}</p>
              {spend.priced < spend.calls && <p>{t('simple.ai.spend.priceWhere')}</p>}
            </details>
          )}
        </Card>

        <div className="flex items-center justify-between gap-3 text-small text-muted">
          <p>{t('simple.ai.more')}</p>
          <Button size="sm" variant="ghost" onClick={() => nav.go({ name: 'settings', tab: 'ai' }) /* i18n-technical */} data-testid="simple-ai-full">
            {t('simple.ai.openFull')}
          </Button>
        </div>
      </div>
    </Page>
  )
}

